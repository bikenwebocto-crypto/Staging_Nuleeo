// Stripe webhook handler. Public route — authenticity is established by
// verifying Stripe's signature (against whichever endpoint secret matches)
// using the raw request body (captured by the JSON parser's `verify` hook
// in server/app.ts).
//
// Because rent runs on DIRECT charges (Standard connected accounts), payment
// events fire on the OWNER's account and only reach us via a CONNECT webhook
// endpoint, with `event.account` set and signed by a SEPARATE secret. So we
// run two endpoints at this same URL:
//
//   Platform endpoint  (STRIPE_WEBHOOK_SECRET, "Events from: Your account"):
//     account.updated              — OUR OWN platform account (if charges get
//                                    disabled, every rent checkout 503s — the
//                                    monitoring branch pages on it).
//     customer.subscription.created — a gifted owner just bought a real plan;
//                                    retire (supersede) their comp grant.
//     customer.subscription.updated — plan-tier reconcile (platform billing).
//     customer.subscription.deleted — paid sub fully canceled/ended; reconcile
//                                    the portfolio DOWN to basic (soft-deactivate
//                                    over-cap properties, suspend rent collect).
//     invoice.payment_failed       — an owner's plan renewal failed to charge.
//                                    The Payments extension mirrors subscription
//                                    STATE but not per-invoice payment results,
//                                    so this is our only signal an owner is going
//                                    delinquent: page staff + nudge the owner.
//
//   Connect endpoint   (STRIPE_CONNECT_WEBHOOK_SECRET, "Connected accounts"):
//     checkout.session.completed   — backstop write of the rent Transaction
//                                    if the tenant never lands on /finalize.
//     payment_intent.succeeded     — secondary backstop (rare; same outcome).
//     charge.refunded              — proportionally refund our application fee.
//                                    The charge lives on the OWNER's account so
//                                    this event is connected-scoped, but the
//                                    ApplicationFee read/refund stays platform-
//                                    side (it's a platform object).
//     account.updated              — mirror owners' connectChargesEnabled /
//                                    connectPayoutsEnabled / requirements.
//
// (account.updated is enabled on BOTH endpoints: the platform delivery is our
//  own account, the Connect delivery is each owner's — the handler tells them
//  apart by whether a user doc holds that account id.)
//
// All write paths are idempotent — re-running on the same event is safe.
//
// Setup (do BOTH, in each Stripe mode — test and live):
//   1. Platform endpoint: Stripe Dashboard → Developers → Webhooks → Add
//      endpoint, "Events from: Your account".
//      URL: https://app.oliowallet.com/api/webhooks/stripe
//      Events: account.updated, customer.subscription.created,
//              customer.subscription.updated, customer.subscription.deleted,
//              invoice.payment_failed
//      → copy the whsec_… into STRIPE_WEBHOOK_SECRET.
//   2. Connect endpoint: Add endpoint, "Events from: Connected accounts"
//      (same URL).
//      Events: checkout.session.completed, payment_intent.succeeded,
//              charge.refunded, account.updated
//      → copy the whsec_… into STRIPE_CONNECT_WEBHOOK_SECRET.
//
// We use structural types (StripeEvent, StripeAccount, StripeCharge) rather
// than `Stripe.X` namespace types: the SDK's namespace isn't reachable
// under the functions build's `moduleResolution: "node"`, and structural
// typing keeps the surface API-shape compatible while compiling everywhere.

import type { Express, Request, Response } from "express";
import { stripe } from "../stripe";
import { db } from "../firebase";
import { loadPortfolioByConnectAccount } from "../services/portfolioBanking";
import {
  recordRentTransactionFromSession,
  type RentCheckoutSession,
} from "../services/rentTransaction";
import { mirrorConnectAccount, type AccountSnapshot } from "../services/connectMirror";
import { reconcileAfterPlanChange, reactivateAfterPlanUpgrade } from "../services/planReconcile";
import { supersedeActiveGift } from "../services/planBilling";
import { notifyUser, notifyStaff } from "../services/push";
import { COL, type OwnerPlanKey } from "../../shared/firestore-schema";
import { logError, logInfo, logWarn } from "../services/log";

// Minimal Stripe-event shape. Stripe sends `{ id, type, data: { object } }`
// across all event types; we only need to inspect `type` and `data.object`.
interface StripeEvent {
  id: string;
  type: string;
  // Set ONLY on connected-account deliveries (direct-charge events from
  // owners' Standard accounts, sent via the Connect webhook endpoint).
  // Undefined for platform-native events (subscriptions, application_fee,
  // our own account.updated).
  account?: string | null;
  data: { object: unknown };
}

interface StripeCheckoutSession extends RentCheckoutSession {
  payment_status?: string | null;
}

interface StripePaymentIntent {
  id: string;
  metadata?: { [k: string]: string } | null;
}

// Reuse the rich snapshot shape from connectMirror so the webhook payload
// and the SDK-retrieved account both flow through identical processing.
type StripeAccount = AccountSnapshot;

interface StripeCharge {
  id?: string;
  amount: number;
  amount_refunded?: number | null;
  application_fee?: string | { id: string } | null;
  // The PaymentIntent this charge belongs to — the link back to our rent
  // Transaction (stored as stripePaymentIntentId at record time).
  payment_intent?: string | { id?: string } | null;
}

interface StripeApplicationFee {
  id: string;
  amount: number;
  amount_refunded?: number | null;
}

// Subscription event shape — Stripe Payments extension owns the
// stripeRole custom claim, but we need the subscription's product +
// previous_attributes so we can detect plan TIER changes and react
// (plan-downgrade reconciliation).
interface StripeSubscription {
  id: string;
  customer: string;
  status?: string;
  items?: {
    data?: Array<{
      price?: { product?: string | null } | null;
    }>;
  };
}
interface StripeSubscriptionEvent extends StripeEvent {
  data: {
    object: StripeSubscription;
    previous_attributes?: {
      items?: {
        data?: Array<{ price?: { product?: string | null } | null }>;
      };
    };
  };
}

// Invoice shape for invoice.payment_failed. We only read enough to identify the
// owner (customer) and confirm it's a SUBSCRIPTION invoice (owner plan renewal),
// then surface the failure — the extension mirrors subscription STATE but not
// per-invoice payment results, so a failed renewal is otherwise invisible in-app.
interface StripeInvoice {
  id?: string;
  customer?: string | { id: string } | null;
  amount_due?: number | null;
  currency?: string | null;
  billing_reason?: string | null;
  attempt_count?: number | null;
  // Post-"basil" invoice model: the subscription link lives on `parent`,
  // not a top-level `subscription` field (matches adminQueries.ts).
  parent?: { subscription_details?: object | null } | null;
}

// Verify a webhook delivery against whichever endpoint secret matches. We run
// two Stripe endpoints at one URL (platform + Connect), each with its own
// signing secret, so a given delivery verifies against exactly one of them.
// `construct` is injected (Stripe's `webhooks.constructEvent`) so this stays
// pure and unit-testable. Throws if no provided secret verifies the signature.
export function selectAndVerify<T>(
  raw: Buffer,
  sigHeader: string,
  secrets: Array<string | undefined>,
  construct: (raw: Buffer, sig: string, secret: string) => T,
): T {
  let lastErr = "no signing secret configured";
  for (const secret of secrets) {
    if (!secret) continue;
    try {
      return construct(raw, sigHeader, secret);
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err.message : "unknown";
    }
  }
  throw new Error(lastErr);
}

// Event types we actively handle. A throw while processing ANY of these is an
// unexpected/transient failure (Firestore contention, a Stripe read hiccup) worth
// retrying, so we return 5xx and let Stripe redeliver — better than silently
// ack'ing 200 and dropping a real state change (a lost ledger row, an un-synced
// Connect flip, a skipped plan reconcile, an un-refunded fee). Every handler is
// safe to replay: rent recording is idempotent on the deterministic
// stripe_<session> id; the fee refund uses a Stripe idempotency key + headroom
// cap; the Connect mirror is an authoritative field replace and its owner-notify
// only fires on the true→false transition (already false on replay); the plan
// reconciles derive from live subscription state; and notify* helpers swallow
// their own errors, so none of them re-fire on a replay. Truly-unhandled event
// types (the switch default) still ack 200 so Stripe stops retrying them.
const HANDLED_EVENTS = new Set<string>([
  "checkout.session.completed",
  "payment_intent.succeeded",
  "account.updated",
  "charge.refunded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
]);

export function registerStripeWebhookRoute(app: Express): void {
  app.post("/api/webhooks/stripe", async (req: Request, res: Response) => {
    // Two endpoints post here, each signed with its OWN secret:
    //   • STRIPE_WEBHOOK_SECRET         — platform endpoint: subscriptions
    //                                     and our own account.updated.
    //   • STRIPE_CONNECT_WEBHOOK_SECRET — Connect endpoint (connect:true):
    //                                     direct-charge events from owners'
    //                                     accounts (event.account is set).
    // A delivery verifies against exactly one secret, so we try each.
    const platformSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const connectSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    if (!platformSecret && !connectSecret) {
      logError("stripe.webhook-secret-missing", new Error("STRIPE_WEBHOOK_SECRET unset"));
      return res.status(503).json({ error: "Webhook not configured" });
    }

    const sigHeader = req.headers["stripe-signature"];
    if (!sigHeader || typeof sigHeader !== "string") {
      return res.status(400).json({ error: "Missing stripe-signature header" });
    }

    // Raw body captured by the json verify hook in app.ts. Stripe's signature
    // is bound to the exact bytes — re-stringifying req.body would break it.
    const raw = (req as Request & { rawBody?: unknown }).rawBody;
    if (!(raw instanceof Buffer)) {
      return res.status(400).json({ error: "Missing raw request body" });
    }

    let event: StripeEvent;
    try {
      event = selectAndVerify(
        raw,
        sigHeader,
        [platformSecret, connectSecret],
        (r, s, secret) => stripe().webhooks.constructEvent(r, s, secret) as unknown as StripeEvent,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown";
      // Structured-log failed/spoofed signatures so they're observable and
      // alertable — a spike usually means a misconfigured endpoint secret
      // (dropping real events) or a spoof attempt against the webhook.
      logWarn("stripe.webhook-signature-failed", { err: msg.slice(0, 200) });
      return res.status(400).json({ error: `Signature verification failed: ${msg}` });
    }

    try {
      switch (event.type) {
        case "checkout.session.completed":
          await onCheckoutSessionCompleted(
            event.data.object as StripeCheckoutSession,
            event.account ?? undefined,
          );
          break;
        case "payment_intent.succeeded":
          await onPaymentIntentSucceeded(
            event.data.object as StripePaymentIntent,
            event.account ?? undefined,
          );
          break;
        case "account.updated":
          await onAccountUpdated(event.data.object as StripeAccount);
          break;
        case "charge.refunded":
          await onChargeRefunded(event.data.object as StripeCharge, event.id);
          break;
        case "customer.subscription.created":
          // A gifted owner who bought a real subscription (gifted → paid
          // upgrade): retire their comp grant so it doesn't linger as an
          // "active gift" and the expiry cron leaves the now-paid claim alone.
          await onSubscriptionCreated(event.data.object as StripeSubscription);
          break;
        case "customer.subscription.updated":
          // Detect plan-tier downgrades at renewal + reconcile the
          // owner's portfolio per policy (delete excess, vacant first,
          // terminate agreements if rent-collect lost). The Stripe
          // Payments extension already updates the stripeRole claim
          // independently; we run AFTER that's settled by reading
          // from the live subscription product → plan mapping.
          await onSubscriptionUpdated(event as StripeSubscriptionEvent);
          break;
        case "customer.subscription.deleted":
          // A PAID subscription was fully canceled (Customer Portal cancel, or a
          // non-renewing sub reaching period end). The Stripe Payments extension
          // clears the stripeRole claim independently → the owner drops to basic,
          // but that alone leaves over-cap properties active and rent still
          // collecting. Run the SAME downgrade reconcile a tier-drop runs so the
          // portfolio is brought within the basic cap. Mirrors gift-expiry and
          // comp-revoke, which already reconcile to basic.
          await onSubscriptionDeleted(event.data.object as StripeSubscription);
          break;
        case "invoice.payment_failed":
          // An owner's plan renewal (or first charge) failed. There's no
          // invoice.* mirror to read, so a delinquent owner is otherwise
          // invisible in-app until the sub is finally canceled — page staff
          // and nudge the owner so they can fix their card before it lapses.
          await onInvoicePaymentFailed(event.data.object as StripeInvoice);
          break;
        default:
          // Unhandled but expected — Stripe sends many event types we don't
          // care about. Acknowledge so Stripe stops retrying.
          break;
      }
      res.json({ received: true });
    } catch (err) {
      logError("stripe.webhook-handler-failed", err, {
        eventType: event.type,
        eventId: event.id,
      });
      // A throw reaching here is an unexpected/transient failure — the EXPECTED
      // "not for us" cases (purpose !== rent, not paid, account unbound, product
      // unknown, customer not yet mirrored) already returned 200 cleanly inside
      // the handler. For every event type we ACTUALLY handle, a genuine failure
      // means a real state change was dropped (ledger row, Connect flip, plan
      // reconcile, fee refund, delinquency signal), so we WANT Stripe's retry:
      // return 5xx and let it redeliver. All handlers are idempotent (see
      // HANDLED_EVENTS), so a replay can't double-book / double-refund / re-notify.
      // Truly-unhandled event types still ack 200 so Stripe stops retrying them.
      if (HANDLED_EVENTS.has(event.type)) {
        return res.status(500).json({ received: false, retry: true });
      }
      res.json({ received: true, handled: false });
    }
  });
}

// ── Event handlers ──────────────────────────────────────────────────────────

// `stripeAccount` is the owner's connected-account id, set when this event
// arrived via the Connect endpoint (direct charge). The session/PaymentIntent
// live ON that account, so every Stripe read must carry the Stripe-Account
// header or Stripe returns 404. Undefined for platform-native deliveries.
async function onCheckoutSessionCompleted(
  sessionFromEvent: StripeCheckoutSession,
  stripeAccount?: string,
) {
  if (sessionFromEvent.metadata?.purpose !== "rent") return;
  if (sessionFromEvent.payment_status !== "paid") return;

  // SECURITY: rent runs on DIRECT charges, so a genuine rent event ALWAYS
  // arrives via the Connect endpoint with event.account = the owner's
  // connected account. The session metadata (ownerId/tenantId/payerUid) is
  // set by our checkout flow, but a malicious owner with API access to their
  // OWN Standard account could craft a paid session carrying ANOTHER owner's
  // ownerId in metadata; Stripe would sign + deliver it, and we'd otherwise
  // record a forged "completed rent" against the victim's portfolio (and
  // advance the victim's agreement schedule). Bind the recorded owner to the
  // account that actually fired the event: refuse unless event.account is
  // present AND held by the metadata.ownerId we're about to write.
  if (!stripeAccount) {
    logWarn("stripe.rent-session-no-account", {
      sessionId: sessionFromEvent.id,
    });
    return;
  }
  const metaOwnerId = sessionFromEvent.metadata?.ownerId;
  // Banking (incl. the Connect account id) lives on the portfolio — bind the
  // event to the portfolio that holds this connected account, then to its
  // current ownerId. Falls back to the legacy users lookup for a not-yet-
  // migrated owner (loadPortfolioByConnectAccount).
  const boundPortfolio = await loadPortfolioByConnectAccount(stripeAccount);
  const boundOwnerId = boundPortfolio?.ownerId ?? null;
  if (!boundPortfolio || !boundOwnerId || boundOwnerId !== metaOwnerId) {
    logWarn("stripe.rent-session-account-mismatch", {
      sessionId: sessionFromEvent.id,
      eventAccount: stripeAccount,
      metadataOwnerId: metaOwnerId ?? null,
      boundOwnerId,
    });
    // A PAID rent session that can't bind = real money moved we won't record.
    // The likely cause is an ownership transfer that cleared the connected
    // account between checkout and this webhook — page staff to reconcile
    // rather than dropping it silently (the funds sit in the prior owner's
    // Stripe balance).
    if ((sessionFromEvent as { payment_status?: string }).payment_status === "paid") {
      await notifyStaff({
        title: "🚨 Unrecorded paid rent (account unbound)",
        message: `A PAID rent checkout (session ${sessionFromEvent.id}) could not be bound to a portfolio (account ${stripeAccount}) — likely a portfolio transfer cleared the account. Reconcile the prior owner's Stripe balance manually.`,
        url: "https://dashboard.stripe.com/connect/accounts/overview",
      }).catch(() => undefined);
    }
    return;
  }

  // DEFENSE IN DEPTH (Phase 2): newer checkout sessions also stamp the STABLE
  // portfolio id into metadata. When present it must ALSO match the portfolio
  // bound to event.account — a forged session can't pair a victim's
  // portfolioId with the attacker's own connected account even where ownerId
  // denorms happen to line up. Sessions created before the stamp deployed
  // carry no metadata.portfolioId and still pass on the ownerId check alone,
  // so no in-flight pre-deploy checkout regresses.
  const metaPortfolioId = sessionFromEvent.metadata?.portfolioId;
  if (metaPortfolioId && metaPortfolioId !== boundPortfolio.id) {
    logWarn("stripe.rent-session-portfolio-mismatch", {
      sessionId: sessionFromEvent.id,
      eventAccount: stripeAccount,
      metadataPortfolioId: metaPortfolioId,
      boundPortfolioId: boundPortfolio.id,
    });
    // Same reconciliation hazard as the unbound branch: a PAID session whose
    // portfolioId no longer matches (e.g. the prior owner re-onboarded the same
    // Stripe account onto a fresh portfolio after a transfer) is real money we
    // won't record — page staff instead of dropping it silently.
    if ((sessionFromEvent as { payment_status?: string }).payment_status === "paid") {
      await notifyStaff({
        title: "🚨 Unrecorded paid rent (portfolio mismatch)",
        message: `A PAID rent checkout (session ${sessionFromEvent.id}) bound to portfolio ${boundPortfolio.id} but its metadata names ${metaPortfolioId} — likely a post-transfer Stripe-account replay. Reconcile manually.`,
        url: "https://dashboard.stripe.com/connect/accounts/overview",
      }).catch(() => undefined);
    }
    return;
  }

  // Re-fetch with PaymentIntent expanded so the recorder reads the
  // authoritative application_fee_amount, not the (older) metadata copy.
  const session = (await stripe().checkout.sessions.retrieve(
    sessionFromEvent.id,
    { expand: ["payment_intent"] },
    { stripeAccount },
  )) as unknown as RentCheckoutSession;
  await recordRentTransactionFromSession(session);
}

async function onPaymentIntentSucceeded(pi: StripePaymentIntent, stripeAccount?: string) {
  // The Checkout Session is the authoritative shape for our flow. Look it up
  // (in the connected account's context for direct charges) and delegate to
  // the same path as checkout.session.completed.
  const sessions = await stripe().checkout.sessions.list(
    { payment_intent: pi.id, limit: 1 },
    stripeAccount ? { stripeAccount } : undefined,
  );
  if (sessions.data.length === 0) return;
  await onCheckoutSessionCompleted(
    sessions.data[0] as unknown as StripeCheckoutSession,
    stripeAccount,
  );
}

async function onAccountUpdated(account: StripeAccount) {
  // Find the owner whose user doc holds this Connect account id and mirror
  // the latest state (capabilities, requirements, disabled reason). Stripe
  // may flip charges_enabled off for verification / fraud / restricted-country
  // reasons; mirroring on every webhook keeps the app aligned with Stripe.
  const portfolio = await loadPortfolioByConnectAccount(account.id);
  if (!portfolio) {
    // No owner doc holds this account id. Most often this means the
    // event is for OUR platform account itself (which Stripe sends
    // account.updated events for too, not just connected sub-accounts).
    // If charges_enabled flipped false on the platform side, EVERY
    // tenant rent-checkout starts 503'ing — log a structured marker
    // so the Cloud Monitoring policy at infra/monitoring-stripe-
    // connect-disabled.yaml can page on it.
    if (account.charges_enabled === false) {
      // Structured log — the Cloud Monitoring metric filter at
      // infra/monitoring-stripe-connect-disabled.yaml matches on
      // jsonPayload.event = "stripe.platform-disabled". Don't change
      // the event id without updating that YAML.
      logWarn("stripe.platform-disabled", {
        accountId: account.id,
        chargesEnabled: false,
        payoutsEnabled: account.payouts_enabled ?? null,
        detailsSubmitted: account.details_submitted ?? null,
        disabledReason:
          (account as { requirements?: { disabled_reason?: string } }).requirements
            ?.disabled_reason ?? "none",
      });
      // Page staff in addition to the Cloud Monitoring marker above — this is
      // the highest-severity ops event (every tenant rent checkout now 503s).
      await notifyStaff({
        title: "🚨 Platform payments disabled",
        message:
          "Stripe disabled charges on the Olio platform account — all rent checkout is failing. Check Stripe now.",
        url: "https://dashboard.stripe.com/account",
      });
    }
    return;
  }
  const prevCharges = portfolio.connectChargesEnabled;
  const prevPayouts = portfolio.connectPayoutsEnabled;
  const patch = await mirrorConnectAccount(portfolio.id, account);

  // Proactively warn the owner the FIRST time Stripe disables their ability to
  // collect rent (or receive payouts) — a true→false transition. Tenant rent
  // checkout is gated on connectChargesEnabled (portfolio.ts / tenant.ts), so a
  // silent flip means tenants suddenly can't pay and payouts halt, yet the
  // owner only learns of it by opening the banking page. Gate strictly on
  // prev === true so this fires exactly once on the flip — not on every
  // account.updated redelivery, and not for owners still completing onboarding
  // whose prior state was undefined. Best-effort: notifyUser swallows failures
  // so a push hiccup never 500s the webhook (which would force Stripe replay).
  const chargesDisabled = prevCharges === true && patch.connectChargesEnabled === false;
  const payoutsDisabled = prevPayouts === true && patch.connectPayoutsEnabled === false;
  if (chargesDisabled || payoutsDisabled) {
    await notifyUser({
      externalUserId: portfolio.ownerId,
      category: "propertyActivity",
      title: chargesDisabled
        ? "Action needed: rent collection paused"
        : "Action needed: payouts paused",
      message: chargesDisabled
        ? "Stripe has paused your ability to collect rent — your tenants can't pay until it's resolved. Open your banking settings to fix it."
        : "Stripe has paused your payouts. Open your banking settings to resolve the outstanding requirements.",
      url: "https://app.oliowallet.com/banking",
    });
  }
}

async function onChargeRefunded(charge: StripeCharge, eventId: string) {
  // No-op if nothing actually went back to the cardholder.
  const refunded = charge.amount_refunded ?? 0;
  if (refunded <= 0) return;

  // ── 1. Refund our application fee proportionally (platform money). ────────
  // Tracks the CUMULATIVE fee refunded so we can stamp the net onto the rent
  // row below. Unchanged refund math; the early-returns became conditionals so
  // the Transaction stamp in step 2 still runs even when the fee needs no
  // (further) refund.
  let feeRefundedTotal: number | undefined;
  const appFeeId =
    typeof charge.application_fee === "string"
      ? charge.application_fee
      : charge.application_fee?.id;
  if (appFeeId) {
    const fee = (await stripe().applicationFees.retrieve(
      appFeeId,
    )) as unknown as StripeApplicationFee;
    const alreadyRefunded = fee.amount_refunded ?? 0;
    const headroom = fee.amount - alreadyRefunded;
    if (headroom > 0) {
      // Proportional refund: refund the same fraction of our fee that was
      // returned to the cardholder. Cap at the unrefunded headroom so duplicate
      // webhook deliveries (after either completed) are no-ops.
      const ratio = refunded / Math.max(1, charge.amount);
      const targetTotalRefund = Math.round(fee.amount * ratio);
      const toRefund = Math.max(0, Math.min(headroom, targetTotalRefund - alreadyRefunded));
      if (toRefund > 0) {
        // Stripe idempotency key keyed off the webhook event id closes the race
        // window where two near-simultaneous deliveries could both pass the
        // headroom check before either createRefund completes. Stripe
        // de-duplicates createRefund calls with the same key within 24h.
        await stripe().applicationFees.createRefund(
          appFeeId,
          { amount: toRefund },
          { idempotencyKey: `refund_${eventId}` },
        );
        feeRefundedTotal = alreadyRefunded + toRefund;
      } else {
        feeRefundedTotal = alreadyRefunded;
      }
    } else {
      feeRefundedTotal = alreadyRefunded;
    }
  }

  // ── 2. Stamp the refund onto our rent Transaction (best-effort). ──────────
  // So the admin Transaction History reflects it instead of showing the full
  // original gross. Located by the PaymentIntent the charge carries (stored as
  // stripePaymentIntentId at record time). Wrapped so a lookup/update failure
  // can never undo the fee refund above or 5xx the webhook ack — a missed stamp
  // just leaves the row un-annotated; a later delivery re-stamps it (the values
  // are cumulative, so it's idempotent).
  try {
    const pi =
      typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : (charge.payment_intent?.id ?? undefined);
    if (pi) {
      const snap = await db()
        .collection(COL.transactions)
        .where("stripePaymentIntentId", "==", pi)
        .limit(1)
        .get();
      if (!snap.empty) {
        await snap.docs[0].ref.update({
          refundedAmountCents: refunded,
          ...(feeRefundedTotal != null ? { feeRefundedCents: feeRefundedTotal } : {}),
        });
      }
    }
  } catch (err: unknown) {
    logWarn("stripe.refund-stamp-failed", { err: String(err).slice(0, 200) });
  }
}

// Map a Stripe product id → our internal OwnerPlanKey by reading the
// product's `firebaseRole` metadata (the same key the Stripe Payments
// extension uses to set the stripeRole custom claim). Returns null if
// the product is unknown or the metadata is missing.
const KNOWN_PLANS = new Set<OwnerPlanKey>(["basic", "advance", "pro", "business"]);
export async function productToPlan(
  productId: string | null | undefined,
): Promise<OwnerPlanKey | null> {
  if (!productId) return null;
  try {
    const product = (await stripe().products.retrieve(productId)) as unknown as {
      metadata?: Record<string, string> | null;
    };
    const role = product.metadata?.firebaseRole;
    if (role && KNOWN_PLANS.has(role as OwnerPlanKey)) {
      return role as OwnerPlanKey;
    }
  } catch (err) {
    logWarn("stripe.product-lookup-failed", { productId, err: String(err).slice(0, 200) });
  }
  return null;
}

// Map a Stripe customer id → Firebase Auth UID. The Stripe Payments extension
// stores customers/{uid} keyed on the Firebase uid with a `stripeId` field
// holding the Stripe customer id. Returns null if no mirror doc holds it (yet).
async function customerToUid(stripeCustomerId: string): Promise<string | null> {
  const snap = await db()
    .collection("customers")
    .where("stripeId", "==", stripeCustomerId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

async function onSubscriptionCreated(sub: StripeSubscription): Promise<void> {
  const uid = await customerToUid(sub.customer);
  if (!uid) {
    // The extension may not have written customers/{uid}.stripeId yet. Harmless:
    // the gift's correctness is already protected (the expiry cron skips users
    // with an active sub); only the cosmetic "active gift" flag would linger.
    logWarn("stripe.sub-created-customer-missing", { stripeCustomerId: sub.customer });
    return;
  }
  await supersedeActiveGift(uid);
}

async function onSubscriptionUpdated(event: StripeSubscriptionEvent): Promise<void> {
  const sub = event.data.object;
  const previous = event.data.previous_attributes;
  // Only react when the subscription's ITEMS changed (plan swap). Other
  // attribute changes (status, cancel_at_period_end, etc.) don't affect
  // the portfolio reconcile. Stripe sends previous_attributes only with
  // the fields that changed, so the items key being present is itself
  // the signal that the plan moved.
  if (!previous?.items) return;

  const currentProductId = sub.items?.data?.[0]?.price?.product ?? null;
  const previousProductId = previous.items.data?.[0]?.price?.product ?? null;
  if (!currentProductId || !previousProductId) return;
  if (currentProductId === previousProductId) return;

  const [newPlan, oldPlan] = await Promise.all([
    productToPlan(currentProductId),
    productToPlan(previousProductId),
  ]);
  if (!newPlan || !oldPlan) return;

  const uid = await customerToUid(sub.customer);
  if (!uid) {
    logWarn("stripe.sub-updated-customer-missing", {
      stripeCustomerId: sub.customer,
    });
    return;
  }

  // Defensive: if a gifted owner reaches a paid-subscription change without the
  // created event having retired their gift, retire it now. Idempotent + a
  // no-op for the common case (a paid owner has no active gift).
  await supersedeActiveGift(uid).catch(() => undefined);

  // Downgrade → soft-deactivate the excess (reconcile no-ops on upgrades).
  const result = await reconcileAfterPlanChange(uid, oldPlan, newPlan);
  if (result) {
    logInfo("plan_reconcile.applied", { ...result });
  }
  // Upgrade → restore previously-deactivated properties/leases within the new
  // cap (reactivate no-ops on downgrades). A re-upgrade within the 30-day grace
  // resumes leases with their original schedule; past it they're terminated and
  // the owner must recreate. Best-effort — a restore failure must not 500 the
  // webhook (Stripe would replay it).
  try {
    const restored = await reactivateAfterPlanUpgrade(uid, oldPlan, newPlan);
    if (
      restored &&
      (restored.propertiesRestored > 0 ||
        restored.agreementsResumed > 0 ||
        restored.agreementsTerminated > 0)
    ) {
      logInfo("plan_reconcile.restored", { ...restored });
    }
  } catch (err) {
    logWarn("plan_reconcile.restore-failed", { uid, err: String(err).slice(0, 200) });
  }
}

// A paid subscription was fully canceled/ended. Stripe only sends
// `customer.subscription.deleted` once the sub is truly gone (an at-period-end
// cancel fires `.updated` with cancel_at_period_end=true first, then `.deleted`
// when the period actually ends), so this is the authoritative "owner is no
// longer paying" signal. The Payments extension drops the stripeRole claim
// around the same time, but that doesn't reconcile the portfolio — so we map
// the deleted sub's product to the old plan and reconcile down to basic.
async function onSubscriptionDeleted(sub: StripeSubscription): Promise<void> {
  const oldPlan = await productToPlan(sub.items?.data?.[0]?.price?.product ?? null);
  // Unknown product or already-basic → nothing to reconcile down to.
  if (!oldPlan || oldPlan === "basic") return;

  const uid = await customerToUid(sub.customer);
  if (!uid) {
    logWarn("stripe.sub-deleted-customer-missing", { stripeCustomerId: sub.customer });
    return;
  }

  const result = await reconcileAfterPlanChange(uid, oldPlan, "basic");
  if (result) {
    logInfo("plan_reconcile.applied", { ...result, trigger: "subscription.deleted" });
  }
}

// An owner subscription invoice failed to charge. Stripe fires this on each
// dunning attempt; the owner keeps their plan until the sub is ultimately
// canceled (which arrives separately as customer.subscription.deleted and
// reconciles them to basic). Because the Payments extension mirrors subscription
// STATE but NOT per-invoice results, this handler is the only in-app signal a
// paying owner is going delinquent — so we make it visible rather than change
// entitlement here: page staff and nudge the owner to fix their card.
async function onInvoicePaymentFailed(invoice: StripeInvoice): Promise<void> {
  // Only subscription (owner-plan) invoices matter. We don't raise one-off
  // invoices, but guard so a stray Dashboard invoice can't trigger a false
  // "your plan payment failed" nudge.
  const isSubscription =
    !!invoice.parent?.subscription_details ||
    (invoice.billing_reason ?? "").startsWith("subscription");
  if (!isSubscription) return;

  const stripeCustomerId =
    typeof invoice.customer === "string" ? invoice.customer : (invoice.customer?.id ?? null);
  const uid = stripeCustomerId ? await customerToUid(stripeCustomerId) : null;

  logWarn("stripe.subscription-payment-failed", {
    invoiceId: invoice.id ?? null,
    stripeCustomerId,
    uid,
    amountDueCents: invoice.amount_due ?? null,
    attemptCount: invoice.attempt_count ?? null,
    billingReason: invoice.billing_reason ?? null,
  });

  // Page staff — a delinquent owner is otherwise invisible until the sub lapses.
  await notifyStaff({
    title: "⚠️ Owner subscription payment failed",
    message: `A Stripe subscription invoice failed to charge (customer ${
      stripeCustomerId ?? "unknown"
    }${invoice.attempt_count ? `, attempt ${invoice.attempt_count}` : ""}). Stripe will retry per its dunning schedule; the owner drops to Starter if it ultimately fails.`,
    url: "https://dashboard.stripe.com/invoices",
  });

  // Nudge the owner directly. best-effort: notifyUser swallows its own errors,
  // so a push hiccup never bubbles up to 5xx the webhook.
  if (uid) {
    await notifyUser({
      externalUserId: uid,
      category: "propertyActivity",
      title: "Action needed: subscription payment failed",
      message:
        "We couldn't charge your Olio plan. Update your payment method to keep your plan — otherwise it will revert to Starter.",
      url: "https://app.oliowallet.com/profile",
    });
  }
}
