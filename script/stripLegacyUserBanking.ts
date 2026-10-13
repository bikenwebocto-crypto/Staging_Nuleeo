// One-off cleanup: strip the legacy banking fields off user docs now that
// banking lives on the portfolios collection (see server/services/
// portfolioBanking.ts). Pairs with script/migrateBankingToPortfolios.ts, which
// COPIED banking onto portfolios but intentionally left the originals on the
// user docs as a fallback during rollout.
//
// SURGICAL + SAFE BY CONSTRUCTION: a field is only deleted from a user doc when
// the owner's portfolio already holds the authoritative copy —
//   • user.bankDetails       deleted only if portfolio.bankDetails exists
//   • user.connect* (×11)    deleted only if portfolio.connectAccountId exists
// We NEVER delete the only copy. Anything not covered is reported as a GAP and
// left untouched (migration incomplete for that owner → needs a look).
//
// The dry-run output IS the migration-completeness check: 0 gaps ⇒ every
// owner's banking is safely on a portfolio and the strip is safe.
//
// Usage:
//   npx tsx script/stripLegacyUserBanking.ts          # dry-run (no writes) — verify completeness
//   npx tsx script/stripLegacyUserBanking.ts --commit # actually strip
//
// Idempotent — a stripped user has no legacy fields left, so re-running is a
// no-op. Auth: GOOGLE_APPLICATION_CREDENTIALS / ADC via .env (see firebase.ts).

import "dotenv/config";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../server/firebase";
import { COL, type Portfolio, type PortfolioBanking, type User } from "../shared/firestore-schema";

const COMMIT = process.argv.includes("--commit");

// Banking fields removed from the User type but still physically present on
// pre-strip user docs. Cast raw doc data to read them.
type LegacyUser = User & PortfolioBanking;

// The 11 Stripe Connect fields (everything except bankDetails). Deleted as a
// group, gated by the portfolio holding connectAccountId.
const CONNECT_KEYS: (keyof PortfolioBanking)[] = [
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
];

interface Plan {
  userId: string;
  fields: string[]; // user-doc keys to delete
}

async function main() {
  const [usersSnap, portfoliosSnap] = await Promise.all([
    db().collection(COL.users).get(),
    db().collection(COL.portfolios).get(),
  ]);

  // ownerId → portfolio (one per owner today). Also track DUPLICATES: there is
  // no DB uniqueness on ownerId, and the runtime resolver (getPortfolio) reads
  // the FIRST match while this Map keeps the LAST — so if an owner ever had two
  // portfolios, stripping is unsafe (we might delete the user copy while the
  // runtime serves the other, possibly-empty portfolio). Duplicated owners are
  // forced into `gaps` below and never stripped.
  const portfolioByOwner = new Map<string, Portfolio>();
  const dupeOwners = new Set<string>();
  for (const d of portfoliosSnap.docs) {
    const p = d.data() as Portfolio;
    if (!p.ownerId) continue;
    if (portfolioByOwner.has(p.ownerId)) dupeOwners.add(p.ownerId);
    portfolioByOwner.set(p.ownerId, p);
  }

  let scanned = 0;
  let withoutLegacy = 0;
  const plans: Plan[] = [];
  const gaps: string[] = [];

  for (const doc of usersSnap.docs) {
    scanned++;
    const user = doc.data() as LegacyUser;
    const hasLegacyBank = !!user.bankDetails;
    const hasLegacyConnect = !!user.connectAccountId;
    if (!hasLegacyBank && !hasLegacyConnect) {
      withoutLegacy++;
      continue;
    }

    // Multiple portfolios for one owner → can't be sure which the runtime
    // serves; refuse to strip and surface it for manual resolution.
    if (dupeOwners.has(doc.id)) {
      gaps.push(`user=${doc.id}: MULTIPLE portfolios for this owner — resolve before stripping`);
      continue;
    }

    const portfolio = portfolioByOwner.get(doc.id) ?? null;
    const fields: string[] = [];

    if (hasLegacyBank) {
      if (portfolio?.bankDetails) {
        fields.push("bankDetails");
      } else {
        gaps.push(`user=${doc.id}: has bankDetails (IBAN) but portfolio has none — NOT stripping`);
      }
    }
    if (hasLegacyConnect) {
      if (portfolio?.connectAccountId) {
        fields.push(...CONNECT_KEYS);
      } else {
        gaps.push(
          `user=${doc.id}: has connectAccountId=${user.connectAccountId} but portfolio has none — NOT stripping`,
        );
      }
    }

    if (fields.length > 0) plans.push({ userId: doc.id, fields });
  }

  for (const p of plans) {
    const groups = [
      p.fields.includes("bankDetails") ? "bankDetails" : null,
      p.fields.includes("connectAccountId") ? "connect*(11)" : null,
    ]
      .filter(Boolean)
      .join(" + ");
    console.log(`  strip  user=${p.userId}  →  ${groups}`);
  }

  if (gaps.length > 0) {
    console.log(
      `\n  ⚠️  ${gaps.length} GAP(S) — migration NOT complete for these; left untouched:`,
    );
    gaps.forEach((g) => console.log(`     - ${g}`));
  }

  if (COMMIT && plans.length > 0) {
    // Each plan is a single user-doc update; batch in 400s (well under the
    // 500-write cap) even though the live set is tiny.
    for (let i = 0; i < plans.length; i += 400) {
      const batch = db().batch();
      for (const p of plans.slice(i, i + 400)) {
        const patch: Record<string, unknown> = {};
        for (const f of p.fields) patch[f] = FieldValue.delete();
        batch.update(db().collection(COL.users).doc(p.userId), patch);
      }
      await batch.commit();
    }
  }

  console.log(
    `\n[stripLegacyUserBanking] scanned=${scanned}` +
      ` toStrip=${plans.length}` +
      ` gaps=${gaps.length}` +
      ` withoutLegacy=${withoutLegacy}` +
      ` committed=${COMMIT}`,
  );
  console.log(
    gaps.length > 0
      ? "Migration is NOT complete — resolve the gaps (re-run migrateBankingToPortfolios) before stripping."
      : COMMIT
        ? "Stripped — legacy banking fields removed from user docs (portfolios hold the source of truth)."
        : "Dry-run only, 0 gaps = migration complete. Re-run with --commit to strip.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
