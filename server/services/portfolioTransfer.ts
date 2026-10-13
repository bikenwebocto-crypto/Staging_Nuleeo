// Portfolio owner-transfer — hand an entire portfolio (its properties, leases,
// tenants, documents, banking shell) to a new owner. Superadmin-only for now
// (server/routes/adminPortfolios.ts). This is the most destructive single
// operation in the app, so it is guarded by a TRANSACTIONAL lock, ordered
// fail-safe, idempotent, and resumable.
//
// WHY THIS IS SAFE (post Phase-2 re-key): every owner-scoped read keys on the
// STABLE portfolioId, which does NOT change on transfer — so the data "follows"
// the portfolio automatically. We still rewrite the denormalized `ownerId` on
// the live operational docs (properties/tenants/agreements/documents) AND on
// PENDING transactions, so the doc-level `ownerId===uid` checks + the Phase-2→4
// legacy fallbacks resolve to the NEW owner and the OLD owner loses all write
// power. COMPLETED transactions keep their ownerId (historical record of who
// actually collected the money).
//
// LEGACY ROWS: reassignment unions the stamped portfolioId query with a legacy
// `ownerId==fromOwner` query (stamping portfolioId on any unstamped match), so a
// pre-Phase-1 row can't be stranded on the old owner and have its rent later
// route back to them. Symmetric with the grant-drop's legacy leg.
//
// PHASE-1 RESTRICTION (enforced on a FRESH transfer): the recipient must NOT
// already own a portfolio — flipping ownerId onto an existing owner would give
// them two portfolio docs (banking resolution stays deterministic via
// User.portfolioRef, but the product semantics of merging two businesses are
// out of scope). A RESUME skips this check (a portfolio appearing mid-transfer
// is a benign phantom; the pivot sets portfolioRef authoritatively).
//
// STRIPE: a connected account is the OLD owner's legal/KYC'd account and CANNOT
// move. We expire open Checkout sessions on it (paginated) and CLEAR all Connect
// fields + the IBAN on the portfolio (the new owner re-onboards their own),
// BEFORE the ownership flip — so mid-crash, card checkout fails safe (503) and
// bank transfer shows "ask the owner" rather than routing money to the wrong
// person. A payment that lands AFTER the clear can't be auto-recorded (the
// webhook unbinds); we emit an ops alert so a human reconciles. Settling
// in-flight paid sessions automatically is a documented follow-up.
//
// NOT handled (documented limitations, not blockers — tracked for the
// post-launch transfer-hardening pass):
//   • Banking-write race: no endpoint freezes banking writes while
//     transferStatus==='in_progress'. The pivot re-clears banking, covering
//     writes that COMMIT before it; a write that commits AFTER (notably the
//     multi-second Stripe Connect onboarding round-trip in connect.ts) could
//     re-attach the prior owner's payout rails. Fully closing it means making
//     writePortfolioBanking transactional with an in_progress / owner assert.
//   • owner↔tenant message threads (doc id embeds the old owner → new owner
//     starts fresh threads; old threads remain the prior owner's history).
//   • Pre-transfer pending offline-rent receipt attribution edge (a row whose
//     creating request straddles the pivot past the re-sweep).
//   • The ops alerts here depend on a staff member being push-subscribed on
//     platform.oliowallet.com (see the 2026-06-09 push audit).

import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase";
import { isStripeConfigured, stripe } from "../stripe";
import { logWarn } from "./log";
import { notifyUser, notifyStaff } from "./push";
import { resolveUnitCap } from "./planLimits";
import { getPortfolio } from "./portfolioBanking";
import { COL, type Portfolio, type Tenant, type User } from "../../shared/firestore-schema";

// Live operational collections whose denormalized ownerId we rewrite to the new
// owner. Transactions are handled separately (pending-only). Conversations are
// intentionally excluded (doc id embeds ownerId — see header).
const REASSIGN_COLLECTIONS = [COL.properties, COL.tenants, COL.agreements, COL.documents];

export type TransferOutcome = "transferred" | "resumed" | "already-done";

export interface TransferResult {
  outcome: TransferOutcome;
  portfolioId: string;
  fromOwnerId: string;
  toOwnerId: string;
  reassigned: Record<string, number>;
  pendingTransactionsMoved: number;
  grantsDropped: number;
  tenantsNotified: number;
}

export type TransferError =
  | { code: "portfolio_not_found" }
  | { code: "recipient_not_found" }
  | { code: "already_owner" }
  | { code: "recipient_has_portfolio" }
  | { code: "recipient_is_tenant" }
  | { code: "recipient_over_cap"; cap: number; used: number; incoming: number }
  | { code: "in_progress_elsewhere" };

export class PortfolioTransferError extends Error {
  constructor(public detail: TransferError) {
    super(detail.code);
  }
}

// Best-effort: expire still-open Checkout sessions on the old owner's connected
// account so a tenant can't complete a payment into it after the flip (the
// webhook would refuse to record it). Paginated. Returns how many open sessions
// existed (for the ops alert). Never throws.
async function expireOpenSessions(connectAccountId: string): Promise<number> {
  if (!isStripeConfigured()) return 0;
  let count = 0;
  try {
    const open = await stripe()
      .checkout.sessions.list({ status: "open", limit: 100 }, { stripeAccount: connectAccountId })
      .autoPagingToArray({ limit: 1000 });
    for (const s of open) {
      count += 1;
      try {
        await stripe().checkout.sessions.expire(s.id, undefined, {
          stripeAccount: connectAccountId,
        });
      } catch (err) {
        logWarn("portfolio_transfer.session-expire-failed", {
          sessionId: s.id,
          err: String(err).slice(0, 200),
        });
      }
    }
  } catch (err) {
    logWarn("portfolio_transfer.session-list-failed", {
      connectAccountId,
      err: String(err).slice(0, 200),
    });
  }
  return count;
}

// The docs that belong to this portfolio in `collection`: the union of the
// stamped portfolioId query and a legacy ownerId==fromOwner query, with the
// legacy leg filtered to rows that are unstamped or already this portfolio's
// (never steal a row stamped for a DIFFERENT portfolio of the same owner).
// This is THE definition of "the portfolio's docs" while legacy unstamped rows
// can still exist (pre-Phase-1); used by both reassignment and the preflights
// so they can't disagree.
async function unionPortfolioDocs(
  collection: string,
  portfolioId: string,
  fromOwnerId: string,
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const [byPid, byOwner] = await Promise.all([
    db().collection(collection).where("portfolioId", "==", portfolioId).get(),
    db().collection(collection).where("ownerId", "==", fromOwnerId).get(),
  ]);
  const docs = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  byPid.docs.forEach((d) => docs.set(d.id, d));
  byOwner.docs.forEach((d) => {
    const pid = (d.data() as { portfolioId?: string }).portfolioId;
    if (!pid || pid === portfolioId) docs.set(d.id, d);
  });
  return Array.from(docs.values());
}

// Reassign ownerId → newOwner on every doc of this portfolio in `collection`
// (stamping portfolioId on adopted legacy rows). Idempotent: skips rows already
// on the new owner. Batched at 400.
async function reassignCollection(
  collection: string,
  portfolioId: string,
  fromOwnerId: string,
  newOwnerId: string,
): Promise<number> {
  const stale = (await unionPortfolioDocs(collection, portfolioId, fromOwnerId)).filter(
    (d) => (d.data() as { ownerId?: string }).ownerId !== newOwnerId,
  );
  for (let i = 0; i < stale.length; i += 400) {
    const batch = db().batch();
    for (const d of stale.slice(i, i + 400)) {
      batch.update(d.ref, { ownerId: newOwnerId, portfolioId });
    }
    await batch.commit();
  }
  return stale.length;
}

// Reassign ownerId on PENDING transactions only (offline rent awaiting the
// owner's verification — operational, the new owner must own it). Completed
// rows are the historical ledger and keep the old ownerId. Run a SECOND time
// after the pivot to sweep any row that raced the first pass.
async function reassignPendingTransactions(
  portfolioId: string,
  fromOwnerId: string,
  newOwnerId: string,
): Promise<number> {
  const pending = (await unionPortfolioDocs(COL.transactions, portfolioId, fromOwnerId)).filter(
    (d) => {
      const data = d.data() as { status?: string; ownerId?: string };
      return data.status === "pending" && data.ownerId !== newOwnerId;
    },
  );
  for (let i = 0; i < pending.length; i += 400) {
    const batch = db().batch();
    for (const d of pending.slice(i, i + 400)) {
      batch.update(d.ref, { ownerId: newOwnerId, portfolioId });
    }
    await batch.commit();
  }
  return pending.length;
}

function clearedBankingPatch(nowIso: string): Record<string, unknown> {
  return {
    connectAccountId: null,
    connectChargesEnabled: false,
    connectPayoutsEnabled: false,
    connectDetailsSubmitted: false,
    connectRequirementsDue: [],
    connectRequirementsPastDue: [],
    connectRequirementsPendingVerification: [],
    connectDisabledReason: null,
    connectCardPaymentsStatus: null,
    connectTransfersStatus: null,
    connectLastSyncedAt: nowIso,
    bankDetails: FieldValue.delete(),
  };
}

interface ClaimResult {
  portfolio: Portfolio & { connectAccountId?: string | null };
  resuming: boolean;
  alreadyDone: boolean;
  // The marker's phase BEFORE this claim. "executing" means a prior run already
  // passed the preflights and started destructive work → a resume may safely
  // skip preflights. Anything else (undefined / "preflight") means preflights
  // must (re-)run before we touch anything.
  phase: string | undefined;
}

// Acquire the transfer lock TRANSACTIONALLY — the only thing standing between
// two racing superadmins and split ownership. Reads the portfolio inside the
// txn and either: returns alreadyDone (a prior transfer to this same recipient
// already flipped ownership), or throws already_owner / in_progress_elsewhere,
// or writes the in_progress marker. fromOwnerId is taken from the doc, never
// from input.
async function claimTransfer(
  portfolioId: string,
  newOwnerId: string,
  nowIso: string,
): Promise<ClaimResult> {
  const ref = db().collection(COL.portfolios).doc(portfolioId);
  return db().runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new PortfolioTransferError({ code: "portfolio_not_found" });
    const portfolio = snap.data() as Portfolio & {
      connectAccountId?: string | null;
      transferStatus?: string;
      transferTo?: string;
      transferPhase?: string;
      transferredFrom?: string;
    };

    if (portfolio.ownerId === newOwnerId) {
      // Already owned by the recipient. If a prior transfer completed (marker
      // stamped transferredFrom), this is an idempotent no-op success — not an
      // error (covers a crash between the pivot and the audit/notify tail).
      if (portfolio.transferredFrom)
        return { portfolio, resuming: false, alreadyDone: true, phase: undefined };
      throw new PortfolioTransferError({ code: "already_owner" });
    }

    const resuming = portfolio.transferStatus === "in_progress";
    if (resuming && portfolio.transferTo && portfolio.transferTo !== newOwnerId) {
      throw new PortfolioTransferError({ code: "in_progress_elsewhere" });
    }

    // Always (re-)stamp our claim timestamp so the conditional rollback can tell
    // OUR claim from a concurrent one. Phase only advances forward: a FRESH
    // claim starts at "preflight"; a resume preserves whatever phase a prior run
    // reached (so a crash mid-preflight can't masquerade as validated).
    t.set(
      ref,
      {
        transferStatus: "in_progress",
        transferFrom: portfolio.ownerId,
        transferTo: newOwnerId,
        transferStartedAt: nowIso,
        ...(resuming ? {} : { transferPhase: "preflight" }),
      },
      { merge: true },
    );
    return {
      portfolio,
      resuming,
      alreadyDone: false,
      phase: resuming ? portfolio.transferPhase : "preflight",
    };
  });
}

// Conditional, transactional marker rollback — deletes the marker ONLY if it is
// still THIS call's claim (same recipient + same start stamp). Without the
// condition, a failed preflight could erase a concurrent transfer's marker and
// reopen the split-ownership window. Best-effort but loud on failure.
async function rollbackMarker(
  portfolioRef: FirebaseFirestore.DocumentReference,
  newOwnerId: string,
  nowIso: string,
): Promise<void> {
  try {
    await db().runTransaction(async (t) => {
      const snap = await t.get(portfolioRef);
      const p = snap.data() as
        { transferStatus?: string; transferTo?: string; transferStartedAt?: string } | undefined;
      if (
        p?.transferStatus === "in_progress" &&
        p.transferTo === newOwnerId &&
        p.transferStartedAt === nowIso &&
        // Never roll back a marker that has advanced to "executing": a
        // concurrent run for the same recipient may have re-stamped
        // transferStartedAt and started destructive work. Only an un-advanced
        // ("preflight") claim of ours is safe to clear.
        (p as { transferPhase?: string }).transferPhase !== "executing"
      ) {
        t.set(
          portfolioRef,
          {
            transferStatus: FieldValue.delete(),
            transferFrom: FieldValue.delete(),
            transferTo: FieldValue.delete(),
            transferStartedAt: FieldValue.delete(),
            transferPhase: FieldValue.delete(),
          },
          { merge: true },
        );
      }
    });
  } catch (err) {
    logWarn("portfolio_transfer.marker-rollback-failed", {
      portfolioId: portfolioRef.id,
      err: String(err).slice(0, 200),
    });
    await notifyStaff({
      title: "Portfolio transfer: stuck marker",
      message: `Failed to roll back the transfer marker on portfolio ${portfolioRef.id}. It may be wedged in_progress — inspect before retrying.`,
      url: "https://platform.oliowallet.com/admin",
    }).catch(() => undefined);
  }
}

export async function transferPortfolio(args: {
  portfolioId: string;
  newOwnerId: string;
  actorUid: string;
  nowIso: string;
}): Promise<TransferResult> {
  const { portfolioId, newOwnerId, actorUid, nowIso } = args;
  const portfolioRef = db().collection(COL.portfolios).doc(portfolioId);

  const recipientSnap = await db().collection(COL.users).doc(newOwnerId).get();
  if (!recipientSnap.exists) throw new PortfolioTransferError({ code: "recipient_not_found" });

  // ── Acquire the lock (transactional; serializes racing admins) ────────
  const { portfolio, resuming, alreadyDone, phase } = await claimTransfer(
    portfolioId,
    newOwnerId,
    nowIso,
  );
  const fromOwnerId = portfolio.ownerId;

  if (alreadyDone) {
    return {
      outcome: "already-done",
      portfolioId,
      fromOwnerId: (portfolio as { transferredFrom?: string }).transferredFrom ?? fromOwnerId,
      toOwnerId: newOwnerId,
      reassigned: {},
      pendingTransactionsMoved: 0,
      grantsDropped: 0,
      tenantsNotified: 0,
    };
  }

  // ── Preflights ────────────────────────────────────────────────────────
  // Skipped ONLY when a prior run already passed them and advanced the marker
  // to "executing" (destructive work was underway). A fresh claim, OR a resume
  // that crashed mid-preflight (phase still "preflight"), (re-)runs them — so a
  // double-submit-turned-resume can never bypass recipient_has_portfolio etc.
  const skipPreflights = resuming && phase === "executing";
  if (!skipPreflights) {
    try {
      const recipientPortfolio = await getPortfolio(newOwnerId);
      if (recipientPortfolio) throw new PortfolioTransferError({ code: "recipient_has_portfolio" });

      // Recipient must not be an active tenant of THIS portfolio (they'd end up
      // their own landlord). Union the stamped + legacy(ownerId) tenancy rows so
      // a pre-stamping tenancy can't slip the guard.
      const tenancyDocs = await unionPortfolioDocs(COL.tenants, portfolioId, fromOwnerId);
      const selfTenant = tenancyDocs.some((d) => {
        const data = d.data() as { userId?: string; status?: string };
        return data.userId === newOwnerId && data.status === "active";
      });
      if (selfTenant) throw new PortfolioTransferError({ code: "recipient_is_tenant" });

      const incoming = (await unionPortfolioDocs(COL.properties, portfolioId, fromOwnerId)).length;
      const cap = await resolveUnitCap(newOwnerId);
      if (cap.cap !== null && cap.used + incoming > cap.cap) {
        throw new PortfolioTransferError({
          code: "recipient_over_cap",
          cap: cap.cap,
          used: cap.used,
          incoming,
        });
      }
    } catch (err) {
      // Conditional rollback so a failed preflight doesn't wedge the portfolio
      // (and can't erase a concurrent claim's marker).
      await rollbackMarker(portfolioRef, newOwnerId, nowIso);
      throw err;
    }
    // Preflights passed → advance the marker so a later resume can skip them.
    await portfolioRef.set({ transferPhase: "executing" }, { merge: true });
  }

  // ── 1. Stripe quiesce + banking clear (fail-safe FIRST) ───────────────
  if (portfolio.connectAccountId) {
    const openSessions = await expireOpenSessions(portfolio.connectAccountId);
    if (openSessions > 0) {
      await notifyStaff({
        title: "Portfolio transfer: in-flight payments",
        message: `Transfer of portfolio ${portfolioId} expired ${openSessions} open Checkout session(s) on the prior owner's Stripe account. Verify no payment landed unrecorded before the next rent cycle.`,
        url: "https://dashboard.stripe.com/connect/accounts/overview",
      }).catch(() => undefined);
    }
  }
  await portfolioRef.set(clearedBankingPatch(nowIso), { merge: true });

  // ── 2. Reassign live operational docs + pending transactions ──────────
  const reassigned: Record<string, number> = {};
  for (const collection of REASSIGN_COLLECTIONS) {
    reassigned[collection] = await reassignCollection(
      collection,
      portfolioId,
      fromOwnerId,
      newOwnerId,
    );
  }
  const pendingTransactionsMoved = await reassignPendingTransactions(
    portfolioId,
    fromOwnerId,
    newOwnerId,
  );

  // ── 3. Drop the OLD owner's access grants on this portfolio ───────────
  const [grantByPid, grantByOwner] = await Promise.all([
    db().collection(COL.portfolioAccessContacts).where("portfolioId", "==", portfolioId).get(),
    db().collection(COL.portfolioAccessContacts).where("ownerId", "==", fromOwnerId).get(),
  ]);
  const grantDocs = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  grantByPid.docs.forEach((d) => grantDocs.set(d.id, d));
  // Legacy leg: only this portfolio's grants (never another portfolio's of the
  // same owner) — mirrors the ownerScope fallback's portfolioId guard.
  grantByOwner.docs.forEach((d) => {
    const pid = (d.data() as { portfolioId?: string }).portfolioId;
    if (!pid || pid === portfolioId) grantDocs.set(d.id, d);
  });
  const grantList = Array.from(grantDocs.values());
  let grantsDropped = 0;
  for (let i = 0; i < grantList.length; i += 400) {
    const batch = db().batch();
    for (const d of grantList.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
    grantsDropped += grantList.slice(i, i + 400).length;
  }

  // ── 4. Atomic pivot: flip ownership + relink users + clear the marker ─
  const batch = db().batch();
  batch.set(
    portfolioRef,
    {
      // Re-clear banking IN the pivot: the old owner could have re-saved an IBAN
      // or re-attached Connect during the reassignment window (no endpoint
      // freezes banking writes mid-transfer), and the recipient must never
      // inherit the prior owner's payout rails. The recipient can't have set
      // banking pre-pivot (portfolioRef isn't theirs yet), so this is safe.
      ...clearedBankingPatch(nowIso),
      ownerId: newOwnerId,
      updatedAt: nowIso,
      transferStatus: FieldValue.delete(),
      transferFrom: FieldValue.delete(),
      transferTo: FieldValue.delete(),
      transferStartedAt: FieldValue.delete(),
      transferPhase: FieldValue.delete(),
      transferredAt: nowIso,
      transferredFrom: fromOwnerId,
    },
    { merge: true },
  );
  // Recipient owns this portfolio (portfolioRef authoritative — getPortfolio
  // prefers it, so any phantom empty portfolio created mid-transfer is ignored)
  // + is an owner. Old owner's link is cleared (fresh empty portfolio next time).
  batch.set(
    db().collection(COL.users).doc(newOwnerId),
    { portfolioRef: portfolioId, ownerModeEnabled: true },
    { merge: true },
  );
  batch.set(
    db().collection(COL.users).doc(fromOwnerId),
    { portfolioRef: FieldValue.delete() },
    { merge: true },
  );
  await batch.commit();

  // Post-pivot re-sweep: an offline payment logged DURING the reassignment
  // window (tenancy read before its ownerId flip, tx written after the first
  // sweep) would land on the old owner. Idempotent + cheap — catch the stragglers.
  const restragglers = await reassignPendingTransactions(portfolioId, fromOwnerId, newOwnerId);
  const pendingTransactionsMovedTotal = pendingTransactionsMoved + restragglers;

  // ── 5. Audit + notify (best-effort; the transfer is already committed) ─
  await db()
    .collection(COL.userAudit)
    .add({
      action: "portfolio.transfer",
      actorUid,
      portfolioId,
      fromOwnerId,
      toOwnerId: newOwnerId,
      at: nowIso,
    })
    .catch((err) => logWarn("portfolio_transfer.audit-failed", { err: String(err).slice(0, 200) }));

  let tenantsNotified = 0;
  try {
    const tenantSnap = await db()
      .collection(COL.tenants)
      .where("portfolioId", "==", portfolioId)
      .where("status", "==", "active")
      .get();
    const tenantUserIds = Array.from(
      new Set(
        tenantSnap.docs
          .map((d) => (d.data() as Tenant).userId)
          .filter((x): x is string => !!x && x !== newOwnerId),
      ),
    );
    for (const tenantUserId of tenantUserIds) {
      await notifyUser({
        externalUserId: tenantUserId,
        category: "propertyActivity",
        title: "Your landlord has changed",
        message:
          "Management of your rental has been transferred. Your new landlord will set up how you pay rent — check your payment options before the next due date.",
        url: "https://app.oliowallet.com/tenant",
      });
      tenantsNotified += 1;
    }
  } catch (err) {
    logWarn("portfolio_transfer.tenant-notify-failed", { err: String(err).slice(0, 200) });
  }

  const recipient = recipientSnap.data() as User;
  await Promise.all([
    notifyUser({
      externalUserId: newOwnerId,
      category: "propertyActivity",
      title: "A portfolio was transferred to you",
      message:
        "You now manage a transferred portfolio. Set up your own payout method (Stripe or IBAN) in Banking so tenants can pay you.",
      url: "https://app.oliowallet.com/banking",
    }),
    notifyUser({
      externalUserId: fromOwnerId,
      category: "propertyActivity",
      title: "Your portfolio was transferred",
      message: `Your portfolio is now managed by ${recipient.email || "another owner"}.`,
      url: "https://app.oliowallet.com/owner",
    }),
  ]).catch((err) =>
    logWarn("portfolio_transfer.owner-notify-failed", { err: String(err).slice(0, 200) }),
  );

  return {
    outcome: resuming ? "resumed" : "transferred",
    portfolioId,
    fromOwnerId,
    toOwnerId: newOwnerId,
    reassigned,
    pendingTransactionsMoved: pendingTransactionsMovedTotal,
    grantsDropped,
    tenantsNotified,
  };
}
