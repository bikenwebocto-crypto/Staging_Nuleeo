// One-off backfill: copy a company-owned property's `entityId` onto its
// tenancies, agreements and property-anchored transactions, so the company's
// ledger (GET /api/owner/entities/:entityId/transactions) includes rent and
// costs booked before entity stamping landed. New rows are stamped at write
// time (agreement create, offline log, Stripe recorder, manual entries).
//
// Only properties with ownershipType "company" and an entityId are used.
// Rows that already carry an entityId are left untouched (never overwritten).
//
// Usage:
//   npx tsx script/backfillPropertyEntityIds.ts          # dry-run (no writes)
//   npx tsx script/backfillPropertyEntityIds.ts --commit # actually write

import "dotenv/config";
import { db } from "../server/firebase";
import { COL, type Property } from "../shared/firestore-schema";

const COMMIT = process.argv.includes("--commit");

async function main() {
  const propSnap = await db()
    .collection(COL.properties)
    .where("ownershipType", "==", "company")
    .get();
  const entityByProperty = new Map<string, string>();
  for (const d of propSnap.docs) {
    const p = d.data() as Property;
    if (p.entityId) entityByProperty.set(d.id, p.entityId);
  }
  console.log(`[backfillPropertyEntityIds] company-owned properties=${entityByProperty.size}`);

  const writes: { col: string; id: string; entityId: string }[] = [];
  for (const col of [COL.tenants, COL.agreements, COL.transactions]) {
    let toStamp = 0;
    let already = 0;
    for (const [propertyId, entityId] of Array.from(entityByProperty)) {
      const snap = await db().collection(col).where("propertyId", "==", propertyId).get();
      for (const d of snap.docs) {
        if ((d.data() as { entityId?: string }).entityId) {
          already++;
          continue;
        }
        writes.push({ col, id: d.id, entityId });
        toStamp++;
      }
    }
    console.log(`  ${col}: toStamp=${toStamp} alreadyStamped=${already}`);
  }

  if (COMMIT && writes.length > 0) {
    for (let i = 0; i < writes.length; i += 400) {
      const batch = db().batch();
      for (const w of writes.slice(i, i + 400)) {
        batch.set(db().collection(w.col).doc(w.id), { entityId: w.entityId }, { merge: true });
      }
      await batch.commit();
    }
  }
  console.log(COMMIT ? "Done." : "Dry-run only. Re-run with --commit to write.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
