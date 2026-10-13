// One-off migration: seed the auto-application tracking fields on leases that
// already carry indexation terms but predate the rent-indexation feature.
//
// Background: Agreement.indexation ({type, rate, delayMonths, frequency}) has
// been collected at lease creation for a while, but the tracking fields
// (nextIncreaseDate / baseRent / appliedSteps) that drive the daily sweep
// (functions/src/rentIndexation.ts) are new. Without nextIncreaseDate the
// sweep can't pick a lease up, so existing indexed leases would never auto-
// apply. This backfills them.
//
// Conservative by design: nextIncreaseDate is rolled forward to the next step
// that has NOT yet passed (nextIncreaseDateOnOrAfter). We do NOT retroactively
// apply increases that were missed before the feature existed — a tenant was
// never notified or charged for those, so back-billing them would be wrong.
// baseRent is set to the lease's current monthlyRent.
//
// Idempotent — skips any indexation that already has nextIncreaseDate, so
// re-running is safe.
//
// Usage:
//   npx tsx script/seedIndexationDates.ts          # dry-run (no writes)
//   npx tsx script/seedIndexationDates.ts --commit # actually write
//
// Auth: uses the same Admin SDK init as the server (firebase.ts), so
// GOOGLE_APPLICATION_CREDENTIALS / ADC must be set in the shell.

import "dotenv/config"; // load GOOGLE_APPLICATION_CREDENTIALS + FIREBASE_PROJECT_ID from .env
import { db } from "../server/firebase";
import { COL, type Agreement } from "../shared/firestore-schema";
import { nextIncreaseDateOnOrAfter } from "../server/services/leaseDates";

const COMMIT = process.argv.includes("--commit");

interface Seed {
  agreement: Agreement;
  nextIncreaseDate: string;
  baseRent: number;
}

async function main() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const snap = await db().collection(COL.agreements).get();
  let scanned = 0;
  let skippedNotActive = 0;
  let skippedNoIndexation = 0;
  let skippedAlreadySeeded = 0;
  let skippedNoAnchor = 0;
  const seeds: Seed[] = [];

  for (const doc of snap.docs) {
    scanned++;
    const agreement = doc.data() as Agreement;
    // The sweep only ever acts on active leases; don't clutter closed ones.
    if (agreement.status !== "active") {
      skippedNotActive++;
      continue;
    }
    const idx = agreement.indexation;
    if (!idx) {
      skippedNoIndexation++;
      continue;
    }
    if (idx.nextIncreaseDate) {
      skippedAlreadySeeded++;
      continue;
    }
    const nextIncreaseDate = nextIncreaseDateOnOrAfter(agreement, todayIso);
    if (!nextIncreaseDate) {
      // No usable signing/start date to anchor from — leave it for manual review.
      skippedNoAnchor++;
      console.log(`  ⚠ no anchor date  ${agreement.id} (status=${agreement.status})`);
      continue;
    }
    seeds.push({
      agreement,
      nextIncreaseDate,
      baseRent: agreement.monthlyRent ?? 0,
    });
  }

  for (const s of seeds) {
    const idx = s.agreement.indexation!;
    console.log(
      `  seed  ${s.agreement.id}  type=${idx.type}` +
        ` rate=${idx.rate ?? "—"} delay=${idx.delayMonths ?? 0}mo` +
        ` freq=${idx.frequency ?? "yearly"}  baseRent=${s.baseRent}` +
        ` → nextIncreaseDate=${s.nextIncreaseDate}  (status=${s.agreement.status})`,
    );
  }

  if (COMMIT && seeds.length > 0) {
    // Firestore batches cap at 500 writes; chunk to be safe.
    for (let i = 0; i < seeds.length; i += 500) {
      const batch = db().batch();
      for (const s of seeds.slice(i, i + 500)) {
        const idx = s.agreement.indexation!;
        batch.set(
          db().collection(COL.agreements).doc(s.agreement.id),
          {
            indexation: {
              ...idx,
              nextIncreaseDate: s.nextIncreaseDate,
              baseRent: idx.baseRent ?? s.baseRent,
              appliedSteps: idx.appliedSteps ?? 0,
            },
          },
          { merge: true },
        );
      }
      await batch.commit();
    }
  }

  console.log(
    `[seedIndexationDates] scanned=${scanned} seeded=${seeds.length}` +
      ` skippedNotActive=${skippedNotActive}` +
      ` skippedNoIndexation=${skippedNoIndexation}` +
      ` skippedAlreadySeeded=${skippedAlreadySeeded}` +
      ` skippedNoAnchor=${skippedNoAnchor} committed=${COMMIT}`,
  );
  console.log(
    COMMIT
      ? "Done — indexed leases now have nextIncreaseDate and will be picked up by the sweep."
      : "Dry-run only. Re-run with --commit to write.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
