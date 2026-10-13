// One-off migration: move each owner's banking (IBAN + Stripe Connect state) off
// their user doc onto a dedicated portfolios doc (COL.portfolios).
//
// Background: banking used to live on the owner's User doc. It now belongs to
// the PORTFOLIO so it can survive an ownership change and be edited by an
// authorized financial contact (see server/services/portfolioBanking.ts). The
// service-layer fallbacks (loadPortfolioBanking / loadPortfolioByConnectAccount)
// keep un-migrated owners working and migrate-on-write/-on-read; this script
// does the same migration in bulk so the legacy reads can eventually retire.
//
// For each user with legacy banking (a `bankDetails` OR a `connectAccountId`)
// that does NOT already have a matching portfolio, it creates a portfolios doc
// { id, ownerId, portfolioId?, ...defined legacy banking fields, createdAt } and
// sets users/{id}.portfolioRef to that id. It does NOT strip the legacy fields
// off the user doc — a later phase does that — so the service-layer fallback
// stays correct if this is re-run mid-rollout.
//
// Idempotent — skips any owner that already has a portfolio (queried per user),
// so it is safe to re-run.
//
// Usage:
//   npx tsx script/migrateBankingToPortfolios.ts          # dry-run (no writes)
//   npx tsx script/migrateBankingToPortfolios.ts --commit # actually write
//
// Auth: uses the same Admin SDK init as the server (firebase.ts), so
// GOOGLE_APPLICATION_CREDENTIALS / ADC must be set in the shell.

import "dotenv/config"; // load GOOGLE_APPLICATION_CREDENTIALS + FIREBASE_PROJECT_ID from .env
import { db } from "../server/firebase";
import { COL, type Portfolio, type PortfolioBanking, type User } from "../shared/firestore-schema";

const COMMIT = process.argv.includes("--commit");

// The banking keys were removed from the `User` type but may still be present
// on legacy (un-migrated) user docs. Cast raw doc data to this to read them.
type LegacyUser = User & PortfolioBanking;

const BANKING_KEYS = [
  "connectAccountId",
  "connectChargesEnabled",
  "connectPayoutsEnabled",
  "connectDetailsSubmitted",
  "connectRequirementsDue",
  "connectRequirementsPastDue",
  "connectRequirementsPendingVerification",
  "connectDisabledReason",
  "connectCardPaymentsStatus",
  "connectTransfersStatus",
  "connectLastSyncedAt",
  "bankDetails",
] as const satisfies readonly (keyof PortfolioBanking)[];

// Copy only the DEFINED banking keys out of a legacy user doc. Drops
// `undefined` (Firestore rejects undefined on write) and any non-banking fields.
function pickDefinedBanking(src: LegacyUser): PortfolioBanking {
  const out: Record<string, unknown> = {};
  for (const key of BANKING_KEYS) {
    const value = src[key];
    if (value !== undefined) out[key] = value;
  }
  return out as PortfolioBanking;
}

interface Plan {
  userId: string;
  portfolio: Portfolio;
}

async function main() {
  const nowIso = new Date().toISOString();
  const snap = await db().collection(COL.users).get();
  let scanned = 0;
  let withoutBanking = 0;
  let alreadyMigrated = 0;
  const plans: Plan[] = [];

  for (const doc of snap.docs) {
    scanned++;
    // Banking fields are no longer on the User type — cast the raw data to read
    // the legacy fields that may still be present.
    const user = doc.data() as LegacyUser;
    const hasLegacyBanking = Boolean(user.bankDetails) || Boolean(user.connectAccountId);
    if (!hasLegacyBanking) {
      withoutBanking++;
      continue;
    }
    // Idempotent: skip if this owner already has a portfolio.
    const portfolioSnap = await db()
      .collection(COL.portfolios)
      .where("ownerId", "==", doc.id)
      .limit(1)
      .get();
    if (!portfolioSnap.empty) {
      alreadyMigrated++;
      continue;
    }
    const ref = db().collection(COL.portfolios).doc();
    const portfolio: Portfolio = {
      id: ref.id,
      ownerId: doc.id,
      ...(user.portfolioId ? { portfolioId: user.portfolioId } : {}),
      ...pickDefinedBanking(user),
      createdAt: nowIso,
    };
    plans.push({ userId: doc.id, portfolio });
  }

  for (const p of plans) {
    console.log(
      `  migrate  user=${p.userId}` +
        ` → portfolio=${p.portfolio.id}` +
        ` connectAccountId=${p.portfolio.connectAccountId ?? "—"}` +
        ` bankDetails=${p.portfolio.bankDetails ? "yes" : "no"}`,
    );
  }

  if (COMMIT && plans.length > 0) {
    // Firestore batches cap at 500 writes; each plan is two writes (the
    // portfolio doc + the user's portfolioRef), so chunk at 250 plans.
    for (let i = 0; i < plans.length; i += 250) {
      const batch = db().batch();
      for (const p of plans.slice(i, i + 250)) {
        batch.set(db().collection(COL.portfolios).doc(p.portfolio.id), p.portfolio);
        // Link user → portfolio (don't strip legacy banking — a later phase does).
        batch.set(
          db().collection(COL.users).doc(p.userId),
          { portfolioRef: p.portfolio.id },
          { merge: true },
        );
      }
      await batch.commit();
    }
  }

  console.log(
    `[migrateBankingToPortfolios] scanned=${scanned}` +
      ` wouldCreate=${plans.length}` +
      ` alreadyMigrated=${alreadyMigrated}` +
      ` withoutBanking=${withoutBanking} committed=${COMMIT}`,
  );
  console.log(
    COMMIT
      ? "Done — owners with legacy banking now have a portfolio doc and portfolioRef."
      : "Dry-run only. Re-run with --commit to write.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
