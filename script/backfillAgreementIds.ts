// One-off backfill: stamp `agreementId` onto every LEASE-BOUND transaction that
// lacks one, so a rent payment stays attributable to its agreement after the
// lease expires/terminates. New rows already get it stamped at write time
// (tenant offline log, Stripe recorder, synthetic prepaid row); this back-stamps
// everything written before that landed.
//
// SELECTION RULE — only lease-bound rent/income rows get an id:
//   • category === "rent" (the rent ledger) AND a tenantId → resolve the
//     agreement and stamp it.
//   • Everything else — manual owner expenses (no lease), maintenance/neutral
//     rows (amount 0, not a transaction), and rent rows with no tenantId — is
//     SKIPPED and counted.
//
// AGREEMENT MATCH — a tenancy can have more than one agreement over time
// (an old terminated lease + a new active one). We pick the agreement whose
// [startDate, endDate] window contains the transaction's date; failing that,
// the active agreement; failing that, the most recently created. For the common
// single-agreement tenancy this is exact.
//
// Also reports, at the end, how many transactions still lack a `portfolioId`.
// That count MUST be 0 before promoting Transaction.portfolioId to a required
// field (run script/stampPortfolioIds.ts --commit first if it isn't). See the
// note in shared/firestore-schema.ts on the Transaction.portfolioId field.
//
// Usage:
//   npx tsx script/backfillAgreementIds.ts          # dry-run (no writes)
//   npx tsx script/backfillAgreementIds.ts --commit # actually write
//
// Auth: same Admin SDK init as the server (firebase.ts) via dotenv —
// GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_PROJECT_ID must be set in .env.

import "dotenv/config";
import { db } from "../server/firebase";
import { COL, type Agreement, type Transaction } from "../shared/firestore-schema";

const COMMIT = process.argv.includes("--commit");

interface StampPlan {
  txId: string;
  agreementId: string;
}

// Choose the agreement a given transaction belongs to, from all of the
// tenancy's agreements. Prefer the lease whose date window contains the tx
// date; then the active lease; then the most recently created.
function pickAgreement(agreements: Agreement[], txDateIso: string): Agreement | null {
  if (agreements.length === 0) return null;
  if (agreements.length === 1) return agreements[0];

  const txDay = txDateIso.slice(0, 10);
  const within = agreements.find((a) => {
    const start = (a.startDate ?? "").slice(0, 10);
    const end = (a.endDate ?? "").slice(0, 10);
    // endDate is EXCLUSIVE — it's advanceMonths(startDate, durationMonths), i.e.
    // the first day AFTER the lease (portfolio.ts). So a payment on a lease's
    // endDate belongs to the NEXT lease, not this one → strict `<`.
    return start && start <= txDay && (!end || txDay < end);
  });
  if (within) return within;

  const active = agreements.find((a) => a.status === "active");
  if (active) return active;

  return [...agreements].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
}

async function main() {
  // 1. Scan transactions: split into "needs an agreementId" (lease-bound rent
  //    rows missing one) vs skipped, and tally portfolioId completeness.
  const txSnap = await db().collection(COL.transactions).get();
  let scanned = 0;
  let alreadyStamped = 0;
  let skippedNotLeaseBound = 0;
  let missingPortfolioId = 0;

  const needing: { txId: string; tenantId: string; date: string }[] = [];
  for (const doc of txSnap.docs) {
    scanned++;
    const tx = doc.data() as Transaction;
    if (!tx.portfolioId) missingPortfolioId++;
    if (tx.agreementId) {
      alreadyStamped++;
      continue;
    }
    // Lease-bound rent rows only. (source "prepaid" rows are synthetic/never
    // persisted, so they don't appear here.)
    if (tx.category === "rent" && tx.tenantId) {
      needing.push({
        txId: doc.id,
        tenantId: tx.tenantId,
        date: tx.timestamp ?? tx.createdAt ?? "",
      });
    } else {
      skippedNotLeaseBound++;
    }
  }

  // 2. Resolve each distinct tenancy's agreements once.
  const tenantIds = Array.from(new Set(needing.map((n) => n.tenantId)));
  const agreementsByTenant = new Map<string, Agreement[]>();
  for (const tenantId of tenantIds) {
    const snap = await db().collection(COL.agreements).where("tenantId", "==", tenantId).get();
    agreementsByTenant.set(
      tenantId,
      snap.docs.map((d) => d.data() as Agreement),
    );
  }

  // 3. Plan the stamps.
  const stamps: StampPlan[] = [];
  let unresolved = 0;
  for (const n of needing) {
    const ag = pickAgreement(agreementsByTenant.get(n.tenantId) ?? [], n.date);
    if (!ag) {
      unresolved++;
      continue;
    }
    stamps.push({ txId: n.txId, agreementId: ag.id });
  }

  // 4. Report.
  console.log(`[backfillAgreementIds] scanned=${scanned}`);
  console.log(`  alreadyStamped=${alreadyStamped}`);
  console.log(`  toStamp=${stamps.length}`);
  console.log(`  unresolved (rent row, no matching agreement)=${unresolved}`);
  console.log(`  skipped (not lease-bound)=${skippedNotLeaseBound}`);
  // Symmetry with the portfolioId assertion below: after a --commit run this
  // should read 0 — every lease-bound rent row that COULD be attributed now is.
  // A non-zero `unresolved` is the only residue (rent rows whose tenancy has no
  // agreement at all — genuinely orphaned data worth investigating).
  console.log(
    `  AGREEMENT-ID ASSERTION: lease-bound rent rows left without an agreementId after this run=${unresolved}` +
      (unresolved === 0 ? " ✓" : " ✗ (orphaned rent rows — investigate)"),
  );
  console.log(
    `  PORTFOLIO-ID ASSERTION: transactions missing portfolioId=${missingPortfolioId}` +
      (missingPortfolioId === 0
        ? " ✓ (safe to make Transaction.portfolioId required)"
        : " ✗ (run stampPortfolioIds.ts --commit before requiring the field)"),
  );

  // 5. Write in ≤400-doc merge batches (under the 500 cap).
  if (COMMIT && stamps.length > 0) {
    for (let i = 0; i < stamps.length; i += 400) {
      const batch = db().batch();
      for (const s of stamps.slice(i, i + 400)) {
        batch.set(
          db().collection(COL.transactions).doc(s.txId),
          { agreementId: s.agreementId },
          { merge: true },
        );
      }
      await batch.commit();
    }
  }

  console.log(
    COMMIT
      ? "Done — lease-bound transactions now carry their agreementId."
      : "Dry-run only. Re-run with --commit to write.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
