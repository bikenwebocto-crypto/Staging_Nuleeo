// Single source of truth for writing the Transaction doc after a successful
// rent checkout. Called from two places:
//   - /api/tenant/payment/finalize  (tenant returns to the success URL)
//   - the Stripe webhook handler    (backstop in case the tenant never lands)
//
// Idempotent: dedupes on stripeSessionId so simultaneous calls (e.g. webhook
// and redirect racing) are safe.
//
// We use a structural type (`RentCheckoutSession`) for the Stripe Checkout
// Session rather than `Stripe.Checkout.Session` directly. The Stripe SDK's
// namespace types aren't reachable under `moduleResolution: "node"` (used by
// the functions build); spelling out the fields we actually read keeps this
// portable across both root-bundler and functions-node TS configs.

import { db } from "../firebase";
import { logWarn } from "./log";
import { COL, type OwnerPlanKey, type Transaction, type User } from "../../shared/firestore-schema";
import { notifyUser } from "./push";
import { ensurePortfolio } from "./portfolioBanking";
import { advanceAgreementForPayment, advanceMonths } from "./rentCycle";

// Advance a YYYY-MM-DD date by one month (month-end safe — Jan 31 → Feb 28/29).
// Thin back-compat wrapper over the shared advanceMonths so the clamping logic
// lives in one place (server/services/rentCycle). Kept exported for existing
// callers and its unit tests; new code should prefer advanceByFrequency /
// advanceAgreementForPayment.
export function advanceOneMonth(iso: string): string {
  return advanceMonths(iso, 1);
}

// Subset of fields we read off the Checkout Session. Mirrors Stripe's shape
// for the fields we touch — the SDK's wider type is still compatible at the
// call site (structural typing).
export interface RentCheckoutSession {
  id: string;
  amount_total: number | null;
  currency: string | null;
  metadata: { [k: string]: string } | null;
  // Accepts either the unexpanded id, or the expanded object. We read
  // `id` (to link refunds back to this row) and `application_fee_amount`;
  // everything else is intentionally permissive so the Stripe SDK's wider
  // type still satisfies this shape structurally.
  payment_intent: string | null | { id?: string; application_fee_amount?: number | null };
}

// Pure helper — derives the fee + amounts from a checkout session, with
// the fallback priority that matters for correctness:
//   1. expanded payment_intent.application_fee_amount (authoritative —
//      what Stripe actually charged)
//   2. metadata.applicationFeeCents (older callers, redirect-only flow)
//   3. zero (no fee captured — we record the gross but skip the
//      fee/net/ownerPlanAtSend block on the Transaction doc)
// Exported for unit testing — the rest of the module uses it directly.
export interface FeeBreakdown {
  feeCents: number;
  grossCents: number;
  ownerNetCents: number;
  ownerPlanAtSend?: OwnerPlanKey;
}

export function deriveFeeBreakdown(session: RentCheckoutSession): FeeBreakdown {
  let feeCents = 0;
  const piRaw = session.payment_intent;
  if (piRaw && typeof piRaw !== "string") {
    const v = piRaw.application_fee_amount;
    if (typeof v === "number" && v >= 0) feeCents = v;
  }
  if (feeCents === 0) {
    const fromMeta = Number(session.metadata?.applicationFeeCents ?? 0);
    if (Number.isFinite(fromMeta) && fromMeta >= 0) feeCents = Math.floor(fromMeta);
  }
  const grossCents = session.amount_total ?? 0;
  const planRaw = session.metadata?.ownerPlan;
  const ownerPlanAtSend: OwnerPlanKey | undefined =
    planRaw === "basic" || planRaw === "advance" || planRaw === "pro" || planRaw === "business"
      ? planRaw
      : undefined;
  return {
    feeCents,
    grossCents,
    ownerNetCents: Math.max(0, grossCents - feeCents),
    ...(ownerPlanAtSend ? { ownerPlanAtSend } : {}),
  };
}

export async function recordRentTransactionFromSession(
  session: RentCheckoutSession,
): Promise<{ tx: Transaction; created: boolean }> {
  // Deterministic doc id keyed on the Stripe session — three callers can
  // race for the same payment (the /finalize redirect, the
  // checkout.session.completed webhook, and payment_intent.succeeded
  // which re-enters via onCheckoutSessionCompleted). Auto-id + a
  // where-query existence check has a read-then-write window where two
  // callers can both pass the check and create duplicate rows. A
  // deterministic id + Firestore transaction closes that window: only
  // the winner returns created:true, and the side effects below run
  // exactly once.
  const ref = db().collection(COL.transactions).doc(`stripe_${session.id}`);

  // Fee + amount derivation lives in `deriveFeeBreakdown` (pure helper,
  // unit-tested) — see its tests for the PI-then-metadata fallback
  // priority that defines our money-recording correctness.
  const { feeCents, grossCents, ownerNetCents, ownerPlanAtSend } = deriveFeeBreakdown(session);

  // Phase-1 portfolio re-key: prefer the stable portfolio doc id the checkout
  // endpoint stamped into the session metadata; for sessions created before
  // that metadata existed, resolve it from the owner. Best-effort — recording
  // a paid rent must never fail on a portfolio lookup (a webhook 500 forces
  // Stripe replays), so a resolution failure just skips the stamp.
  let portfolioId = session.metadata?.portfolioId;
  if (!portfolioId && session.metadata?.ownerId) {
    try {
      portfolioId = (await ensurePortfolio(session.metadata.ownerId)).id;
    } catch (err) {
      logWarn("rent_tx.portfolio-stamp-failed", {
        ownerId: session.metadata.ownerId,
        err: String(err).slice(0, 200),
      });
    }
  }

  // Bind the row to its lease. Prefer the agreementId stamped into session
  // metadata at checkout; for sessions created before that metadata existed,
  // fall back to the tenancy's active agreement. Best-effort — recording a paid
  // rent must never 500 on a lease lookup (that forces Stripe replays), so a
  // resolution failure just leaves agreementId unset (the backfill catches it).
  let agreementId = session.metadata?.agreementId;
  if (!agreementId && session.metadata?.tenantId) {
    try {
      const agSnap = await db()
        .collection(COL.agreements)
        .where("tenantId", "==", session.metadata.tenantId)
        .where("status", "==", "active")
        .limit(1)
        .get();
      if (!agSnap.empty) agreementId = agSnap.docs[0].id;
    } catch (err) {
      logWarn("rent_tx.agreement-stamp-failed", {
        tenantId: session.metadata.tenantId,
        err: String(err).slice(0, 200),
      });
    }
  }

  // PaymentIntent id — the key a later charge.refunded webhook uses to find
  // this row (the refund event carries the PI, not our session id). Works
  // whether payment_intent arrived as a bare id or an expanded object.
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? undefined);

  const tx: Transaction = {
    id: ref.id,
    propertyId: session.metadata?.propertyId,
    unitId: session.metadata?.unitId,
    tenantId: session.metadata?.tenantId,
    ...(agreementId ? { agreementId } : {}),
    ownerId: session.metadata?.ownerId,
    ...(portfolioId ? { portfolioId } : {}),
    ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    name: "Rent Payment",
    amount: grossCents / 100,
    currency: (session.currency ?? "eur").toUpperCase(),
    // Rent collected by the owner is the owner's INCOME (this Transaction is
    // keyed on ownerId). Must stay "income" to match the manual
    // RecordActivityDialog mapping and every income-based reader — owner net
    // income / yield (PortfolioAnalyticsPage, PropertyDetailsPage, briefing)
    // and the admin platform-revenue/commission dashboard, which filters
    // `type === "income"` before reading applicationFeeCents.
    type: "income",
    category: "rent",
    status: "completed",
    timestamp: new Date().toISOString(),
    paymentMethod: "card",
    stripeSessionId: session.id,
    verifiedAt: new Date().toISOString(),
    // Cycle this card payment covers, captured at checkout creation — lets
    // advancement stay idempotent across payment methods (see rentPeriod).
    ...(session.metadata?.rentPeriod ? { rentPeriod: session.metadata.rentPeriod } : {}),
    ...(feeCents > 0
      ? {
          applicationFeeCents: feeCents,
          ownerNetCents,
          ...(ownerPlanAtSend ? { ownerPlanAtSend } : {}),
        }
      : {}),
  };

  const { result, created } = await db().runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (snap.exists) {
      return { result: snap.data() as Transaction, created: false };
    }
    t.set(ref, tx);
    return { result: tx, created: true };
  });

  // Loser of the race (or webhook replay) — return without re-running
  // side effects so we don't double-advance the agreement or double-push.
  if (!created) {
    return { tx: result, created: false };
  }

  // Advance the active agreement's billing cycle (frequency-aware) so the
  // rent-reminder cron — which reads agreement.nextPaymentDate as its primary
  // signal — keeps firing on the right schedule. Without this the cron would
  // fire only for the first scheduled period, then match "overdue" against
  // the same stale date forever. Idempotency: the session-id dedupe above
  // bails out on retries before reaching here, and passing paidCycle (the
  // cycle captured at checkout) means a card payment for a cycle already
  // advanced by an offline payment — or a second card — is a no-op rather
  // than skipping a month.
  const tenancyId = session.metadata?.tenantId;
  if (tenancyId) {
    try {
      await advanceAgreementForPayment({
        tenantId: tenancyId,
        paidCycle: session.metadata?.rentPeriod,
      });
    } catch (err) {
      // Don't fail the payment record on a reminder-bookkeeping error;
      // the next cron run will simply miss this cycle (better than 500ing
      // the webhook and forcing replay).
      logWarn("rent_tx.advance-next-payment-failed", {
        tenancyId,
        err: String(err).slice(0, 200),
      });
    }
  }

  // Notify the landlord. Gated on `created === true` so retries (webhook +
  // redirect racing, or webhook replays) don't double-push. Look the tenant's
  // display name up from `metadata.payerUid` — `tenantId` points at the
  // tenancy doc, not the user doc, and we want a human-friendly name in the
  // notification body.
  const ownerId = session.metadata?.ownerId;
  const payerUid = session.metadata?.payerUid;
  const amountStr = new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: (session.currency ?? "eur").toUpperCase(),
  }).format(grossCents / 100);
  if (ownerId) {
    let tenantName = "Your tenant";
    if (payerUid) {
      try {
        const userSnap = await db().collection(COL.users).doc(payerUid).get();
        if (userSnap.exists) {
          const u = userSnap.data() as User;
          const full = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
          if (full) tenantName = full;
        }
      } catch {
        // Fall back to the generic label.
      }
    }
    await notifyUser({
      externalUserId: ownerId,
      category: "rentPayments",
      title: "Rent payment received",
      message: `${tenantName} paid ${amountStr} by card.`,
      url: "https://app.oliowallet.com/owner",
    });
  }

  // Confirm receipt to the tenant as well — parity with the offline flow,
  // where the owner verifying a payment pushes the tenant a "Rent payment
  // confirmed". Card payments auto-complete (no owner verification step), so
  // without this the tenant gets no confirmation at all and the "Payment
  // confirmations" toggle never fires on the card path. payerUid is the
  // tenant's User.id (validated at checkout); gated on `created === true`
  // above so webhook/redirect retries don't double-push.
  if (payerUid) {
    await notifyUser({
      externalUserId: payerUid,
      category: "rentPayments",
      title: "Rent payment confirmed",
      message: `Your ${amountStr} rent payment was received.`,
      url: "https://app.oliowallet.com/tenant",
    });
  }

  return { tx, created: true };
}
