// One-off backfill: stamp `prepaidRentAmount` (the prepaid total FROZEN at the
// rate paid up front) onto every agreement that has prepaidRents > 0 but no
// snapshot yet. New leases get it written at creation (portfolio.ts); this
// back-stamps everything created before that landed, using the agreement's
// CURRENT monthlyRent as the best available proxy for the rate at signing.
//
// Why: the synthetic prepaid-rent activity row (services/prepaidActivity.ts) now
// prefers prepaidRentAmount over live monthlyRent × months, so the historical
// figure stops shifting when rent is later indexed/edited. Until a lease is
// backfilled it falls back to live rent (current behavior), so this is safe to
// run lazily — but run it BEFORE the next indexation sweep to freeze each lease
// at today's rate rather than a post-increase one.
//
// Usage:
//   npx tsx script/backfillPrepaidRentAmount.ts          # dry-run (no writes)
//   npx tsx script/backfillPrepaidRentAmount.ts --commit # actually write
//
// Auth: same Admin SDK init as the server (firebase.ts) via dotenv —
// GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_PROJECT_ID must be set in .env.

import "dotenv/config";
import { db } from "../server/firebase";
import { COL, type Agreement } from "../shared/firestore-schema";

const COMMIT = process.argv.includes("--commit");

interface StampPlan {
  agreementId: string;
  prepaidRentAmount: number;
}

async function main() {
  const snap = await db().collection(COL.agreements).get();
  let scanned = 0;
  let alreadyStamped = 0;
  let noPrepaid = 0;
  let skippedNoRate = 0;

  const stamps: StampPlan[] = [];
  for (const doc of snap.docs) {
    scanned++;
    const ag = doc.data() as Agreement;
    const months = Math.floor(ag.prepaidRents ?? 0);
    if (!(months > 0)) {
      noPrepaid++;
      continue;
    }
    if (typeof ag.prepaidRentAmount === "number" && ag.prepaidRentAmount > 0) {
      alreadyStamped++;
      continue;
    }
    const rate = ag.monthlyRent;
    if (typeof rate !== "number" || !(rate > 0)) {
      // Can't compute a frozen amount — the row keeps falling back to live rent.
      skippedNoRate++;
      continue;
    }
    stamps.push({ agreementId: doc.id, prepaidRentAmount: Math.round(rate * months) });
  }

  console.log(`[backfillPrepaidRentAmount] scanned=${scanned}`);
  console.log(`  alreadyStamped=${alreadyStamped}`);
  console.log(`  toStamp=${stamps.length}`);
  console.log(`  noPrepaid (prepaidRents <= 0 / unset)=${noPrepaid}`);
  console.log(`  skipped (prepaid but no positive monthlyRent)=${skippedNoRate}`);

  if (COMMIT && stamps.length > 0) {
    for (let i = 0; i < stamps.length; i += 400) {
      const batch = db().batch();
      for (const s of stamps.slice(i, i + 400)) {
        batch.set(
          db().collection(COL.agreements).doc(s.agreementId),
          { prepaidRentAmount: s.prepaidRentAmount },
          { merge: true },
        );
      }
      await batch.commit();
    }
  }

  console.log(
    COMMIT
      ? "Done — prepaid leases now carry a frozen prepaidRentAmount."
      : "Dry-run only. Re-run with --commit to write.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
