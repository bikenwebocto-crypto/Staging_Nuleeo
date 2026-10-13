// One-off migration: move owner-created agreements that are stuck in the
// legacy "draft" status into "pending_tenant" so they surface for both the
// owner (Agreements page) and the tenant (Approve/Decline on their
// Agreements page).
//
// Background: before the 2026-05-31 fix, POST /api/owner/agreements created
// every agreement as status="draft", but BOTH the owner and tenant agreement
// reads filter out "draft" — so those agreements were invisible everywhere
// even though the invite email went out. That write path was the ONLY producer
// of draft agreements, so every draft currently in the DB is one of these
// stuck records. They become "pending_tenant" here, identical to what a
// freshly-created agreement now gets. The paired Tenant doc is left untouched
// (it's already "pending" / "invited", which aligns with "pending_tenant").
//
// Idempotent — only touches status==="draft", so re-running finds nothing.
//
// Usage:
//   npx tsx script/migrateDraftAgreements.ts          # dry-run (no writes)
//   npx tsx script/migrateDraftAgreements.ts --commit # actually write
//
// Auth: uses the same Admin SDK init as the server (firebase.ts), so
// GOOGLE_APPLICATION_CREDENTIALS / ADC must be set in the shell.

import { db } from "../server/firebase";
import { COL, type Agreement, type Property, type Tenant } from "../shared/firestore-schema";

const COMMIT = process.argv.includes("--commit");

async function main() {
  const snap = await db().collection(COL.agreements).get();
  let scanned = 0;
  const drafts: Agreement[] = [];

  for (const doc of snap.docs) {
    scanned++;
    const agreement = doc.data() as Agreement;
    if (agreement.status === "draft") drafts.push(agreement);
  }

  // Hydrate property address + tenant email for each draft so the dry-run
  // is human-readable (you can recognize "Makariou III Avenue" etc. before
  // committing). Best-effort — a missing join still gets migrated.
  const propertyById = new Map<string, Property>();
  const tenantById = new Map<string, Tenant>();
  if (drafts.length > 0) {
    const propRefs = Array.from(new Set(drafts.map((a) => a.propertyId))).map((id) =>
      db().collection(COL.properties).doc(id),
    );
    const tenantRefs = Array.from(new Set(drafts.map((a) => a.tenantId))).map((id) =>
      db().collection(COL.tenants).doc(id),
    );
    const [propDocs, tenantDocs] = await Promise.all([
      propRefs.length ? db().getAll(...propRefs) : Promise.resolve([]),
      tenantRefs.length ? db().getAll(...tenantRefs) : Promise.resolve([]),
    ]);
    propDocs.forEach((s) => s.exists && propertyById.set(s.id, s.data() as Property));
    tenantDocs.forEach((s) => s.exists && tenantById.set(s.id, s.data() as Tenant));
  }

  for (const a of drafts) {
    const addr = propertyById.get(a.propertyId)?.address ?? "(unknown property)";
    const email = tenantById.get(a.tenantId)?.email ?? "(unknown tenant)";
    console.log(`  draft → pending_tenant  ${a.id}  ${addr}  ${email}  created=${a.createdAt}`);
  }

  if (COMMIT && drafts.length > 0) {
    // Firestore batches cap at 500 writes; chunk to be safe.
    for (let i = 0; i < drafts.length; i += 500) {
      const batch = db().batch();
      for (const a of drafts.slice(i, i + 500)) {
        batch.set(
          db().collection(COL.agreements).doc(a.id),
          { status: "pending_tenant" },
          { merge: true },
        );
      }
      await batch.commit();
    }
  }

  console.log(
    `[migrateDraftAgreements] scanned=${scanned} drafts=${drafts.length} committed=${COMMIT}`,
  );
  console.log(
    COMMIT
      ? "Done — stuck draft agreements are now pending_tenant (awaiting tenant approval)."
      : "Dry-run only. Re-run with --commit to write.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
