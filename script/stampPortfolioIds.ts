// One-off backfill: stamp `portfolioId` (the STABLE portfolios doc id — not the
// human display label) onto every owner-scoped record that lacks one, across
// the 6 collections that carry the field: properties, tenants, agreements,
// documents, transactions, portfolioAccessContacts.
//
// Background: Phase 1 of the portfolio re-key. New records get portfolioId
// stamped at creation (via server/services/portfolioBanking.ts ensurePortfolio);
// this script back-stamps everything created before that landed. Reads still
// key off ownerId in this phase — the stamp is purely additive.
//
// Owner → portfolio resolution mirrors getPortfolio(): users/{uid}.portfolioRef
// first (deterministic direct get), falling back to a portfolios
// where(ownerId==) query. Owners with records but NO portfolio yet (they never
// touched banking or /api/me) get one created here, mirroring ensurePortfolio's
// shape: fresh doc id, ownerId, portfolioId label carried over from
// users/{uid}.portfolioId when present, createdAt, plus users/{uid}.portfolioRef
// linked. NOTE: unlike ensurePortfolio these creates are plain batched writes,
// not a transaction — run while the affected owners aren't actively racing
// their first banking touch.
//
// Idempotent — docs that already have a portfolioId are skipped, and owner
// resolution finds any previously created portfolio (portfolioRef link or
// ownerId query), so re-running (even after a partial commit) is safe.
// Transactions without an ownerId are skipped and counted (Transaction.ownerId
// is optional).
//
// Usage:
//   npx tsx script/stampPortfolioIds.ts          # dry-run (no writes)
//   npx tsx script/stampPortfolioIds.ts --commit # actually write
//
// Auth: uses the same Admin SDK init as the server (firebase.ts), so
// GOOGLE_APPLICATION_CREDENTIALS / ADC must be set in the shell.

import "dotenv/config"; // load GOOGLE_APPLICATION_CREDENTIALS + FIREBASE_PROJECT_ID from .env
import { db } from "../server/firebase";
import { COL, type Portfolio, type User } from "../shared/firestore-schema";

const COMMIT = process.argv.includes("--commit");

// The 6 owner-scoped collections that carry an optional portfolioId.
const OWNER_SCOPED_COLLECTIONS = [
  COL.properties,
  COL.tenants,
  COL.agreements,
  COL.documents,
  COL.transactions,
  COL.portfolioAccessContacts,
] as const;

// The two fields this script reads off any owner-scoped doc.
interface OwnerScopedDoc {
  ownerId?: string;
  portfolioId?: string;
}

interface StampPlan {
  collection: string;
  docId: string;
  ownerId: string;
}

interface CreatePlan {
  portfolio: Portfolio;
  // Only link users/{uid}.portfolioRef when the user doc actually exists
  // (ghost owners — docs referencing a uid with no user doc — get a portfolio
  // but no link; the ownerId query still resolves it on re-run).
  linkUser: boolean;
}

async function getUser(uid: string): Promise<User | null> {
  const snap = await db().collection(COL.users).doc(uid).get();
  return snap.exists ? (snap.data() as User) : null;
}

// Mirror of getPortfolio (server/services/portfolioBanking.ts) — scripts are
// standalone and import nothing from server/services. Prefer the user's
// portfolioRef link (deterministic direct get, immune to duplicate-doc
// arbitrariness), fall back to the ownerId query on a missing/stale link.
async function resolvePortfolio(ownerId: string, user: User | null): Promise<Portfolio | null> {
  if (user?.portfolioRef) {
    const linked = await db().collection(COL.portfolios).doc(user.portfolioRef).get();
    if (linked.exists) {
      const p = linked.data() as Portfolio;
      if (p.ownerId === ownerId) return p;
    }
  }
  const snap = await db().collection(COL.portfolios).where("ownerId", "==", ownerId).limit(1).get();
  return snap.empty ? null : (snap.docs[0].data() as Portfolio);
}

async function main() {
  const nowIso = new Date().toISOString();

  // 1. Scan the 6 collections: collect every doc missing a portfolioId and the
  //    distinct ownerIds behind them.
  let scanned = 0;
  const stamps: StampPlan[] = [];
  const missingByCollection = new Map<string, number>();
  const skippedNoOwnerByCollection = new Map<string, number>();
  const ownerIds = new Set<string>();

  for (const col of OWNER_SCOPED_COLLECTIONS) {
    const snap = await db().collection(col).get();
    let missing = 0;
    let skippedNoOwner = 0;
    for (const doc of snap.docs) {
      scanned++;
      const data = doc.data() as OwnerScopedDoc;
      if (data.portfolioId) continue; // already stamped — idempotent skip
      if (!data.ownerId) {
        // Transaction.ownerId is optional — nothing to key the stamp on.
        skippedNoOwner++;
        continue;
      }
      missing++;
      ownerIds.add(data.ownerId);
      stamps.push({ collection: col, docId: doc.id, ownerId: data.ownerId });
    }
    missingByCollection.set(col, missing);
    skippedNoOwnerByCollection.set(col, skippedNoOwner);
  }

  // 2. Resolve each distinct owner's portfolio; plan a create for owners that
  //    have none (mirroring ensurePortfolio's created shape).
  const portfolioByOwner = new Map<string, Portfolio>();
  const creates: CreatePlan[] = [];

  for (const ownerId of ownerIds) {
    const user = await getUser(ownerId);
    const existing = await resolvePortfolio(ownerId, user);
    if (existing) {
      portfolioByOwner.set(ownerId, existing);
      continue;
    }
    const ref = db().collection(COL.portfolios).doc();
    const portfolio: Portfolio = {
      id: ref.id,
      ownerId,
      ...(user?.portfolioId ? { portfolioId: user.portfolioId } : {}),
      createdAt: nowIso,
    };
    portfolioByOwner.set(ownerId, portfolio);
    creates.push({ portfolio, linkUser: user !== null });
  }

  // 3. Report the plan.
  console.log(`[stampPortfolioIds] per-collection docs missing portfolioId:`);
  for (const col of OWNER_SCOPED_COLLECTIONS) {
    const skipped = skippedNoOwnerByCollection.get(col) ?? 0;
    console.log(
      `  ${col}: ${missingByCollection.get(col) ?? 0}` +
        (skipped > 0 ? ` (+${skipped} skipped — no ownerId)` : ""),
    );
  }
  for (const c of creates) {
    console.log(
      `  create  owner=${c.portfolio.ownerId}` +
        ` → portfolio=${c.portfolio.id}` +
        ` label=${c.portfolio.portfolioId ?? "—"}` +
        ` linkUser=${c.linkUser ? "yes" : "no (no user doc)"}`,
    );
  }

  // 4. Writes: portfolios first (so every stamp points at an existing doc),
  //    then the stamps. Batches stay ≤400 writes (under the 500-write cap).
  if (COMMIT) {
    // Each create is up to two writes (portfolio doc + user's portfolioRef),
    // so chunk at 200 plans.
    for (let i = 0; i < creates.length; i += 200) {
      const batch = db().batch();
      for (const c of creates.slice(i, i + 200)) {
        batch.set(db().collection(COL.portfolios).doc(c.portfolio.id), c.portfolio);
        if (c.linkUser) {
          // Link user → portfolio for the deterministic direct lookup.
          batch.set(
            db().collection(COL.users).doc(c.portfolio.ownerId),
            { portfolioRef: c.portfolio.id },
            { merge: true },
          );
        }
      }
      await batch.commit();
    }
    // Each stamp is one merge write.
    for (let i = 0; i < stamps.length; i += 400) {
      const batch = db().batch();
      for (const s of stamps.slice(i, i + 400)) {
        const portfolio = portfolioByOwner.get(s.ownerId);
        if (!portfolio) continue; // unreachable — every stamp's owner was resolved above
        batch.set(
          db().collection(s.collection).doc(s.docId),
          { portfolioId: portfolio.id },
          { merge: true },
        );
      }
      await batch.commit();
    }
  }

  const totalSkippedNoOwner = [...skippedNoOwnerByCollection.values()].reduce((a, b) => a + b, 0);
  console.log(
    `\n[stampPortfolioIds] scanned=${scanned}` +
      ` toStamp=${stamps.length}` +
      ` owners=${ownerIds.size}` +
      ` portfoliosToCreate=${creates.length}` +
      ` skippedNoOwner=${totalSkippedNoOwner}` +
      ` committed=${COMMIT}`,
  );
  console.log(
    COMMIT
      ? "Done — every owner-scoped doc now carries its portfolio's stable doc id."
      : "Dry-run only. Re-run with --commit to write.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
