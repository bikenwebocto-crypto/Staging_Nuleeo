// Single door to a portfolio's banking (IBAN + Stripe Connect state).
//
// Banking used to live on the owner's user doc; it now belongs to the
// PORTFOLIO (COL.portfolios) so it can survive an owner change and be edited
// by an authorized financial contact. Everything that reads or writes banking
// goes through here, so the "banking belongs to the portfolio, keyed by
// ownerId — never the logged-in user" rule lives in exactly one place.
//
// One portfolio per owner today, resolved by `ownerId`. The legacy banking on
// user docs has been migrated (script/migrateBankingToPortfolios.ts) and
// stripped (script/stripLegacyUserBanking.ts), so the portfolio is the sole
// source of truth — there is no user-doc fallback.

import { db } from "../firebase";
import {
  COL,
  type Portfolio,
  type PortfolioBanking,
  type User,
} from "../../shared/firestore-schema";

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

// Copy only the defined banking keys out of a source. Drops `undefined`
// (Firestore rejects undefined values on write — ignoreUndefinedProperties is
// not enabled) and strips any non-banking fields (id/ownerId/email/…).
function pickDefinedBanking(src: Partial<PortfolioBanking>): PortfolioBanking {
  const out: Record<string, unknown> = {};
  for (const key of BANKING_KEYS) {
    const value = src[key];
    if (value !== undefined) out[key] = value;
  }
  return out as PortfolioBanking;
}

// The portfolio doc for an owner, or null if none exists yet.
//
// Resolution is DETERMINISTIC: prefer the user's `portfolioRef` link (a direct
// doc get — immune to the duplicate-doc hazard where a where().limit(1) query
// would return an arbitrary one of two matches). The ownerId check guards
// against a stale link (e.g. after an ownership transfer rewires the
// portfolio to a new owner); on any mismatch we fall back to the query.
export async function getPortfolio(ownerId: string): Promise<Portfolio | null> {
  const userSnap = await db().collection(COL.users).doc(ownerId).get();
  const refId = userSnap.exists ? (userSnap.data() as User).portfolioRef : undefined;
  if (refId) {
    const linked = await db().collection(COL.portfolios).doc(refId).get();
    if (linked.exists) {
      const p = linked.data() as Portfolio;
      if (p.ownerId === ownerId) return p;
    }
  }
  const snap = await db().collection(COL.portfolios).where("ownerId", "==", ownerId).limit(1).get();
  return snap.empty ? null : (snap.docs[0].data() as Portfolio);
}

// Banking for a portfolio addressed by its STABLE doc id (the already-resolved
// scope key) — used by money endpoints that authorized against scope.portfolioId
// and must read/write that exact doc rather than re-deriving from ownerId.
export async function loadPortfolioBankingById(portfolioId: string): Promise<PortfolioBanking> {
  const snap = await db().collection(COL.portfolios).doc(portfolioId).get();
  return snap.exists ? pickDefinedBanking(snap.data() as Portfolio) : {};
}

// Banking for an owner: the banking fields off their portfolio doc, or an empty
// object when they have no portfolio (e.g. a pure tenant, or an owner who never
// set up banking). Consumers that only need the values (tenant reads, payout
// gates) use this; those that need the doc id use getPortfolio/ensurePortfolio.
export async function loadPortfolioBanking(ownerId: string): Promise<PortfolioBanking> {
  const portfolio = await getPortfolio(ownerId);
  return portfolio ? pickDefinedBanking(portfolio) : {};
}

// Get-or-create the owner's portfolio, linking User.portfolioRef on creation.
// Called by every banking WRITE path (and /api/me) so the doc exists before we
// write to it. Carries over the User's portfolioId label for display.
//
// The doc id is a fresh, owner-independent Firestore id — NOT the owner's uid —
// so a later ownership transfer keeps the same portfolio (and its banking).
//
// Create runs in a TRANSACTION keyed on the user doc: two concurrent calls
// both miss the fast path, but the loser's transaction retries on the user-doc
// write conflict, re-reads portfolioRef, finds the winner's doc and returns it
// — so an owner can never end up with two portfolios. (A user with NO user doc
// has no contention point, but such ghosts can't sign in to race themselves.)
export async function ensurePortfolio(ownerId: string): Promise<Portfolio> {
  // Fast path — almost every call finds an existing portfolio.
  const existing = await getPortfolio(ownerId);
  if (existing) return existing;

  const userRef = db().collection(COL.users).doc(ownerId);
  const newRef = db().collection(COL.portfolios).doc();
  const now = new Date().toISOString();

  return db().runTransaction(async (t) => {
    const userSnap = await t.get(userRef);
    const user = userSnap.exists ? (userSnap.data() as User) : null;
    // Re-check inside the transaction: a concurrent create has already set
    // portfolioRef by the time a retried loser gets here.
    if (user?.portfolioRef) {
      const linked = await t.get(db().collection(COL.portfolios).doc(user.portfolioRef));
      if (linked.exists) {
        const p = linked.data() as Portfolio;
        if (p.ownerId === ownerId) return p;
      }
    }
    const portfolio: Portfolio = {
      id: newRef.id,
      ownerId,
      ...(user?.portfolioId ? { portfolioId: user.portfolioId } : {}),
      createdAt: now,
    };
    t.set(newRef, portfolio);
    // Link user → portfolio for the deterministic direct lookup.
    if (userSnap.exists) t.set(userRef, { portfolioRef: newRef.id }, { merge: true });
    return portfolio;
  });
}

// Find the portfolio that owns a Stripe Connect account — the binding the
// Connect webhooks need. The portfolio is the sole source of truth for
// connectAccountId (onboarding/disconnect write it there), so a single
// equality query suffices.
export async function loadPortfolioByConnectAccount(
  connectAccountId: string,
): Promise<Portfolio | null> {
  const snap = await db()
    .collection(COL.portfolios)
    .where("connectAccountId", "==", connectAccountId)
    .limit(1)
    .get();
  return snap.empty ? null : (snap.docs[0].data() as Portfolio);
}

// Persist a banking patch onto a portfolio doc, stamping updatedAt. The single
// banking writer — connectMirror, the IBAN endpoints, and Connect
// onboarding/disconnect all route through it.
export async function writePortfolioBanking(
  portfolioId: string,
  patch: Partial<PortfolioBanking>,
): Promise<void> {
  await db()
    .collection(COL.portfolios)
    .doc(portfolioId)
    .set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
}
