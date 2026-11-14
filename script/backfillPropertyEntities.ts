// One-off backfill: link every property to an Entity (COL.entities) built from
// its legacy `ownershipType` + `companyName`, creating the entities it needs.
//
// Classification rules live in shared/entityBackfill.ts (unit-tested):
//   company + companyName    → one COMPANY entity per (ownerId, normalized name)
//   individual, no company   → the owner's single PERSONAL entity
//   anything else            → SKIPPED with a reason (never guessed)
//   existing entityId        → preserved untouched
//
// Purely additive: writes new `entities` docs and sets `entityId` on
// properties. `ownerId`, `portfolioId`, `companyName` and `ownershipType` are
// never changed or removed, and no other collection is touched.
//
// Idempotent + resumable:
//   - Entity ids are deterministic (hash of owner + type + normalized name) and
//     written with create(); an id that already exists is reused, not
//     overwritten. A re-run also matches existing entities (incl. MANUAL ones)
//     before planning a create.
//   - Property links use update() with a lastUpdateTime precondition taken at
//     scan time, so a property edited (or linked) mid-run is not clobbered —
//     that batch fails and a re-run picks the property up fresh.
//   - Entities are written before links, so a link never points at a missing doc.
//
// Usage:
//   npx tsx script/backfillPropertyEntities.ts            # dry-run (default, no writes)
//   npx tsx script/backfillPropertyEntities.ts --verbose  # dry-run + per-property log
//   npx tsx script/backfillPropertyEntities.ts --commit   # actually write
//
// Auth: same Admin SDK init as the server (firebase.ts) — set
// GOOGLE_APPLICATION_CREDENTIALS / ADC + FIREBASE_PROJECT_ID in the shell or .env.

import "dotenv/config";
import { createHash } from "node:crypto";
import type { Timestamp } from "firebase-admin/firestore";
import { db } from "../server/firebase";
import {
  COL,
  type Entity,
  type LegalEntityType as EntityType,
  type Property,
} from "../shared/firestore-schema";
import { planEntityBackfill, type BackfillProperty } from "../shared/entityBackfill";

const COMMIT = process.argv.includes("--commit");
const VERBOSE = process.argv.includes("--verbose");
const TAG = "[backfillPropertyEntities]";
const BATCH = 400; // under Firestore's 500-write cap

function entityIdFor(ownerId: string, entityType: EntityType, key: string): string {
  const h = createHash("sha256").update(`${ownerId}\u0000${entityType}\u0000${key}`).digest("hex");
  return `ent_${h.slice(0, 24)}`;
}

async function main() {
  const nowIso = new Date().toISOString();
  console.log(`${TAG} mode=${COMMIT ? "COMMIT" : "dry-run"} project=${process.env.FIREBASE_PROJECT_ID ?? "(default)"}`);

  // 1. Scan.
  const propSnap = await db().collection(COL.properties).get();
  const updateTimes = new Map<string, Timestamp>();
  const properties: BackfillProperty[] = propSnap.docs.map((d) => {
    updateTimes.set(d.id, d.updateTime);
    const p = d.data() as Partial<Property>;
    return {
      id: d.id,
      ownerId: p.ownerId,
      ownershipType: p.ownershipType,
      companyName: p.companyName,
      entityId: p.entityId,
    };
  });
  const entitySnap = await db().collection(COL.entities).get();
  const existingEntities = entitySnap.docs.map((d) => ({ ...(d.data() as Entity), id: d.id }));
  console.log(`${TAG} scanned properties=${properties.length} existingEntities=${existingEntities.length}`);

  // 2. Plan.
  const plan = planEntityBackfill({ properties, existingEntities, idFor: entityIdFor, nowIso });

  // Dangling preserved links (entityId pointing at no entity) — reported, not fixed.
  const entityIds = new Set(existingEntities.map((e) => e.id));
  const dangling = plan.preserved.filter((p) => !entityIds.has(p.entityId));

  // 3. Report.
  console.log(`\n${TAG} entities to create: ${plan.creates.length}`);
  for (const e of plan.creates) {
    console.log(`  + ${e.id}  owner=${e.ownerId}  ${e.entityType}  "${e.name}"`);
  }
  const skipCounts = new Map<string, number>();
  for (const s of plan.skipped) skipCounts.set(s.reason, (skipCounts.get(s.reason) ?? 0) + 1);
  console.log(`\n${TAG} skipped (ambiguous): ${plan.skipped.length}`);
  for (const [reason, n] of skipCounts) console.log(`  ${reason}: ${n}`);
  if (plan.spellingVariants.length) {
    console.log(`\n${TAG} spelling variants grouped into one entity (please confirm):`);
    for (const v of plan.spellingVariants) {
      console.log(`  owner=${v.ownerId}  ${v.spellings.map((s) => `"${s}"`).join(" | ")}`);
    }
  }
  if (dangling.length) {
    console.log(`\n${TAG} WARNING: ${dangling.length} preserved entityId(s) point at no entity:`);
    for (const d of dangling) console.log(`  property=${d.propertyId} entityId=${d.entityId}`);
  }
  if (VERBOSE) {
    console.log(`\n${TAG} per-property:`);
    for (const l of plan.links) {
      console.log(`  link     ${l.propertyId} → ${l.entityId}${l.existingEntity ? " (existing)" : " (new)"}`);
    }
    for (const p of plan.preserved) console.log(`  keep     ${p.propertyId} → ${p.entityId}`);
    for (const s of plan.skipped) console.log(`  skip     ${s.propertyId} owner=${s.ownerId ?? "—"} (${s.reason})`);
  }

  // 4. Write: entities first, then links.
  let entitiesCreated = 0;
  let entitiesAlreadyPresent = 0;
  let linksWritten = 0;
  let linkBatchesFailed = 0;
  if (COMMIT) {
    for (const e of plan.creates) {
      try {
        await db().collection(COL.entities).doc(e.id).create(e);
        entitiesCreated++;
      } catch (err) {
        if ((err as { code?: number }).code === 6) entitiesAlreadyPresent++; // ALREADY_EXISTS → reuse
        else throw err;
      }
    }
    for (let i = 0; i < plan.links.length; i += BATCH) {
      const chunk = plan.links.slice(i, i + BATCH);
      const batch = db().batch();
      for (const l of chunk) {
        const lastUpdateTime = updateTimes.get(l.propertyId);
        batch.update(
          db().collection(COL.properties).doc(l.propertyId),
          { entityId: l.entityId },
          ...(lastUpdateTime ? [{ lastUpdateTime }] : []),
        );
      }
      try {
        await batch.commit();
        linksWritten += chunk.length;
      } catch (err) {
        // A property changed since the scan — leave the whole chunk for a re-run.
        linkBatchesFailed++;
        console.warn(`${TAG} link batch ${i / BATCH + 1} not applied (re-run to resume): ${(err as Error).message}`);
      }
    }
  }

  console.log(
    `\n${TAG} summary: properties=${properties.length}` +
      ` toLink=${plan.links.length} preserved=${plan.preserved.length} skipped=${plan.skipped.length}` +
      ` entitiesPlanned=${plan.creates.length}` +
      (COMMIT
        ? ` entitiesCreated=${entitiesCreated} entitiesAlreadyPresent=${entitiesAlreadyPresent}` +
          ` linksWritten=${linksWritten} linkBatchesFailed=${linkBatchesFailed}`
        : ""),
  );
  console.log(COMMIT ? "Done." : "Dry-run only. Re-run with --commit to write.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
