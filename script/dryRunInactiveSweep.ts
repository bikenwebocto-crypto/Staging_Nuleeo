// READ-ONLY diagnostic for the 30-day inactive-property sweep
// (functions/src/sweepInactiveUnits.ts). Writes NOTHING — it just reports, for
// every soft-deactivated property, whether the daily sweep WOULD purge it today
// and exactly what it would delete (documents + signed-lease PDFs) and which
// suspended leases it would terminate.
//
// This is the safety net for the one genuinely destructive piece of the
// plan-downgrade lifecycle: run it before trusting the cron, so you can eyeball
// on LIVE data what is about to be permanently deleted. The unit / agreement /
// tenant / transaction ledger are always RETAINED by the sweep — only documents
// are purged — but this lets you confirm that against real rows.
//
// Mirrors isPropertyDueForPurge() in the sweep (status "inactive", deactivated
// for the full GRACE_DAYS window, not already purged). Kept in lockstep with the
// exported GRACE_DAYS so the threshold can never drift from the real cron.
//
// Usage:
//   npx tsx script/dryRunInactiveSweep.ts
//
// Auth: same Admin SDK init as the server (firebase.ts) via dotenv —
// GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_PROJECT_ID must be set in .env.

import "dotenv/config";
import { db } from "../server/firebase";
import {
  COL,
  type Agreement,
  type DocumentRecord,
  type Property,
} from "../shared/firestore-schema";
import { GRACE_DAYS } from "../server/services/planReconcile";

const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

async function main() {
  const nowMs = Date.now();

  const snap = await db().collection(COL.properties).where("status", "==", "inactive").get();
  const inactive = snap.docs.map((d) => d.data() as Property);

  if (inactive.length === 0) {
    console.log("[dryRunInactiveSweep] No inactive properties. Nothing for the sweep to do.");
    process.exit(0);
  }

  let dueCount = 0;
  let totalDocsToDelete = 0;
  let totalLeasesToTerminate = 0;
  let totalSignedLeasesToDelete = 0;

  console.log(`[dryRunInactiveSweep] ${inactive.length} inactive property(ies):\n`);

  for (const p of inactive) {
    const deactivatedMs = p.deactivatedAt ? new Date(p.deactivatedAt).getTime() : NaN;
    const daysInactive = Number.isFinite(deactivatedMs)
      ? Math.floor((nowMs - deactivatedMs) / (24 * 60 * 60 * 1000))
      : null;
    // Mirror isPropertyDueForPurge: inactive + past the full window (strict) +
    // not already purged.
    const due =
      !p.docsPurgedAt && Number.isFinite(deactivatedMs) && deactivatedMs < nowMs - GRACE_MS;

    const status = p.docsPurgedAt
      ? "already purged (skip)"
      : daysInactive === null
        ? "no deactivatedAt (skip — can't prove window elapsed)"
        : due
          ? "DUE — would purge today"
          : `in grace (${GRACE_DAYS - (daysInactive ?? 0)} day(s) left)`;

    let docsForProp = 0;
    let leasesForProp = 0;
    let signedForProp = 0;
    if (due) {
      const [docsSnap, agSnap] = await Promise.all([
        db().collection(COL.documents).where("propertyId", "==", p.id).get(),
        db().collection(COL.agreements).where("propertyId", "==", p.id).get(),
      ]);
      docsForProp = docsSnap.size;
      signedForProp = agSnap.docs.filter(
        (d) => !!(d.data() as Agreement).signedLeaseDocument?.storagePath,
      ).length;
      leasesForProp = agSnap.docs.filter(
        (d) => (d.data() as Agreement).status === "suspended",
      ).length;
      // Sanity: list the storage paths so the operator can see exactly what dies.
      const docPaths = docsSnap.docs
        .map((d) => (d.data() as DocumentRecord).storagePath)
        .filter(Boolean);
      dueCount += 1;
      totalDocsToDelete += docsForProp;
      totalLeasesToTerminate += leasesForProp;
      totalSignedLeasesToDelete += signedForProp;
      console.log(
        `  • ${p.id} (${p.address ?? "—"}) owner=${p.ownerId} — ${status}\n` +
          `      inactive ${daysInactive}d · documents=${docsForProp} · signedLeases=${signedForProp} · leasesToTerminate=${leasesForProp}` +
          (docPaths.length ? `\n      storage: ${docPaths.join(", ")}` : ""),
      );
    } else {
      console.log(`  • ${p.id} (${p.address ?? "—"}) owner=${p.ownerId} — ${status}`);
    }
  }

  console.log(
    `\n[dryRunInactiveSweep] DUE today=${dueCount}/${inactive.length}` +
      ` · documentsWouldDelete=${totalDocsToDelete}` +
      ` · signedLeasesWouldDelete=${totalSignedLeasesToDelete}` +
      ` · leasesWouldTerminate=${totalLeasesToTerminate}`,
  );
  console.log(
    "READ-ONLY — nothing was written. The sweep RETAINS unit/agreement/tenant/transactions.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
