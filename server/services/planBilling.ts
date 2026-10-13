// Owner-plan upgrade billing.
//
// This is the ONLY place the server mutates a Stripe subscription. Today the
// rest of the server only LISTENS to Stripe (webhooks). Every function here
// acts on the CALLER's own Stripe customer (resolved from customers/{uid}),
// is idempotent, and never refunds.
//
// Two upgrade paths exist; only the PAID one lives here:
//   • Paid Growth → Pro  — swap the existing subscription to the Pro price with
//     a discounted first cycle (€200) and a fresh 12-month term. The Stripe
//     Customer Portal can apply neither the coupon nor the cycle reset, so it
//     has to be a direct subscriptions.update — that's upgradePaidToPro().
//   • Gifted Growth → Pro — the gifted owner has NO subscription, so they start
//     a brand-new one via the existing client Checkout flow (full price). No
//     server mutation; only the gift record is superseded (supersedeActiveGift).
//
// We use structural casts rather than `Stripe.X` namespace types: the SDK's
// namespace isn't reachable under the functions build's moduleResolution:"node"
// (same reason as server/routes/stripeWebhook.ts).

import { stripe } from "../stripe";
import { db } from "../firebase";
import { COL, type OwnerPlanKey, type ComplimentaryPlan } from "../../shared/firestore-schema";
import { resolveOwnerPlan } from "./commission";
import { loadPlanLabels } from "./configCache";
import { logInfo } from "./log";

// The extension keeps its customer/subscription mirror under this collection,
// keyed by Firebase uid (not in COL — it's owned by the Stripe extension).
const CUSTOMERS_COLLECTION = "customers";

export type PlanSource = "paid" | "gifted" | "none";

export interface PlanSourceInfo {
  source: PlanSource;
  plan: OwnerPlanKey;
  // Subscription renewal date (paid only). ISO 8601 or null.
  renewsAt: string | null;
  // Whether the paid subscription is set to cancel at period end.
  cancelAtPeriodEnd: boolean;
  // Gift hard-expiry (gifted only). ISO 8601 or null.
  giftExpiresAt: string | null;
}

// Normalise the assorted date shapes Stripe / the extension mirror produce:
// Firestore Timestamp (has toDate), unix-seconds number, or an ISO string.
function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return new Date(v * 1000).toISOString();
  if (typeof v === "object" && typeof (v as { toDate?: unknown }).toDate === "function") {
    try {
      return (v as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

// Stripe moved the billing period from the top-level subscription onto each
// item in recent API versions — read item-level first, fall back to top-level.
function subRenewsAt(sub: unknown): string | null {
  const s = sub as {
    items?: { data?: Array<{ current_period_end?: unknown }> };
    current_period_end?: unknown;
  };
  return toIso(s.items?.data?.[0]?.current_period_end ?? s.current_period_end);
}

function isResourceMissing(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number } | null;
  return e?.code === "resource_missing" || e?.statusCode === 404;
}

// Read the extension's mirror for the caller's active/trialing subscription.
// Returns null when there's no paid subscription.
async function readActiveSubMirror(
  uid: string,
): Promise<{ renewsAt: string | null; cancelAtPeriodEnd: boolean } | null> {
  const snap = await db()
    .collection(CUSTOMERS_COLLECTION)
    .doc(uid)
    .collection("subscriptions")
    .where("status", "in", ["active", "trialing"])
    .limit(1)
    .get();
  if (snap.empty) return null;
  const data = snap.docs[0].data() as Record<string, unknown>;
  return {
    renewsAt: subRenewsAt(data),
    cancelAtPeriodEnd: data.cancel_at_period_end === true,
  };
}

async function resolveStripeCustomerId(uid: string): Promise<string | null> {
  const snap = await db().collection(CUSTOMERS_COLLECTION).doc(uid).get();
  if (!snap.exists) return null;
  const id = (snap.data() as { stripeId?: unknown }).stripeId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

// Where the caller's current plan came from — drives the upgrade UI: a paid
// source routes to upgradePaidToPro (subscription swap), a gifted/none source
// routes to a fresh Checkout. Also surfaces the renewal date for honest copy.
export async function getPlanSource(uid: string): Promise<PlanSourceInfo> {
  const plan = await resolveOwnerPlan(uid);

  const sub = await readActiveSubMirror(uid);
  if (sub) {
    return {
      source: "paid",
      plan,
      renewsAt: sub.renewsAt,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      giftExpiresAt: null,
    };
  }

  // No paid subscription — a non-basic plan here is a gift (the grant endpoint
  // refuses to gift over an active subscription, so the two never coexist).
  const giftSnap = await db().collection(COL.complimentaryPlans).doc(uid).get();
  if (giftSnap.exists) {
    const gift = giftSnap.data() as ComplimentaryPlan;
    if (gift.status === "active") {
      return {
        source: "gifted",
        plan,
        renewsAt: null,
        cancelAtPeriodEnd: false,
        giftExpiresAt: gift.expiresAt,
      };
    }
  }

  return { source: "none", plan, renewsAt: null, cancelAtPeriodEnd: false, giftExpiresAt: null };
}

export interface PlanStripePrice {
  productId: string;
  priceId: string;
  unitAmountCents: number;
  currency: string; // lowercase ISO 4217, e.g. "eur"
}

// Find a plan's active Stripe price by its firebaseRole metadata (the same key
// the Payments extension uses). Prefers the product's default_price, else the
// first active recurring price. Returns null if the plan isn't provisioned.
export async function resolvePlanStripePrice(
  role: "advance" | "pro",
): Promise<PlanStripePrice | null> {
  const sdk = stripe();
  const products = await sdk.products.list({ active: true, limit: 100 });
  const product = products.data.find(
    (p) => (p.metadata as Record<string, string> | undefined)?.firebaseRole === role,
  );
  if (!product) return null;

  const defaultPriceId =
    typeof product.default_price === "string"
      ? product.default_price
      : ((product.default_price as { id?: string } | null)?.id ?? null);

  const prices = await sdk.prices.list({ product: product.id, active: true, limit: 10 });
  const chosen =
    prices.data.find((x) => x.id === defaultPriceId) ??
    prices.data.find((x) => x.type === "recurring") ??
    prices.data[0];
  if (!chosen || typeof chosen.unit_amount !== "number" || !chosen.currency) return null;

  return {
    productId: product.id,
    priceId: chosen.id,
    unitAmountCents: chosen.unit_amount,
    currency: chosen.currency,
  };
}

// Idempotently provision the one-time first-Pro-cycle coupon. The target price
// is the admin-editable config/planLabels.proUpgradeFirstCycleAmount. The
// amount_off is encoded into the coupon id so an admin changing the target (or
// the Pro price changing) rolls to a fresh coupon (new delta → new id) instead
// of silently reusing a stale one. Returns the coupon id, or null when no
// discount applies (target unset/0, or target ≥ the full price).
export async function ensureProIntroCoupon(
  fullCents: number,
  currency: string,
): Promise<string | null> {
  const labels = await loadPlanLabels();
  const targetEur = labels.proUpgradeFirstCycleAmount;
  // null / 0 / negative = no intro discount → upgrade at the full Pro price.
  if (targetEur == null || targetEur <= 0) return null;

  const amountOff = fullCents - Math.round(targetEur * 100);
  if (amountOff <= 0) return null;

  const cur = currency.toLowerCase();
  const id = `olio_pro_intro_${amountOff}_${cur}`;
  const sdk = stripe();
  try {
    await sdk.coupons.retrieve(id);
    return id;
  } catch (err) {
    if (!isResourceMissing(err)) throw err;
  }
  await sdk.coupons.create({
    id,
    amount_off: amountOff,
    currency: cur,
    duration: "once",
    name: `Pro upgrade — first year €${targetEur}`,
  });
  logInfo("plan_billing.intro_coupon_created", { id, amountOff, currency: cur });
  return id;
}

export type UpgradeResult =
  { ok: true; renewsAt: string | null } | { ok: false; status: number; error: string };

// Paid Growth → Pro. Swaps the caller's existing subscription to the Pro price
// with a discounted first cycle and a fresh 12-month term. Each parameter maps
// directly to a product rule:
//   proration_behavior:"none"   → forfeit unused Growth time (no credit)
//   billing_cycle_anchor:"now"  → fresh 12-month Pro term starting today
//   discounts:[{coupon}] (once) → €200 this cycle, normal €290 at renewal
export async function upgradePaidToPro(uid: string): Promise<UpgradeResult> {
  // Eligibility: must be a PAID Growth owner — not gifted, not already Pro+.
  const source = await getPlanSource(uid);
  if (source.source !== "paid") {
    return {
      ok: false,
      status: 409,
      error: "No active paid subscription to upgrade. Start a Pro plan via checkout instead.",
    };
  }
  if (source.plan !== "advance") {
    return {
      ok: false,
      status: 409,
      error:
        source.plan === "pro" || source.plan === "business"
          ? "You're already on Pro or higher."
          : "Only a paid Growth plan can be upgraded to Pro here.",
    };
  }

  const stripeId = await resolveStripeCustomerId(uid);
  if (!stripeId) return { ok: false, status: 409, error: "No Stripe customer on file." };

  const sdk = stripe();
  const subs = await sdk.subscriptions.list({ customer: stripeId, status: "active", limit: 10 });
  const sub = subs.data[0];
  if (!sub) return { ok: false, status: 409, error: "No active subscription found." };
  const item = sub.items?.data?.[0];
  if (!item) return { ok: false, status: 500, error: "Subscription has no line item." };

  const proPrice = await resolvePlanStripePrice("pro");
  if (!proPrice) {
    return { ok: false, status: 503, error: "Pro plan is not provisioned in Stripe yet." };
  }
  // Already on the Pro price → nothing to do (keeps this idempotent against a
  // double click that slipped past the Stripe idempotency key).
  if (item.price?.id === proPrice.priceId) {
    return { ok: false, status: 409, error: "You're already on Pro." };
  }

  // Assert the item we're about to swap is actually on the GROWTH (advance)
  // price before applying the €200 intro coupon. resolveOwnerPlan above already
  // gated to plan === "advance", but that derives from the stripeRole claim,
  // which can lag the actual Stripe subscription. The coupon math (full Pro −
  // €200) is only correct migrating FROM Growth — if the live item is on some
  // other price (a stale claim, a manually-edited sub, a renamed product), bail
  // rather than discount an unknown base. Don't block on a missing Growth
  // product (not provisioned yet): only refuse on a positive mismatch.
  const growthPrice = await resolvePlanStripePrice("advance");
  if (growthPrice && item.price?.id !== growthPrice.priceId) {
    logInfo("plan_upgrade.source_price_mismatch", {
      uid,
      subId: sub.id,
      itemPriceId: item.price?.id ?? null,
      expectedGrowthPriceId: growthPrice.priceId,
    });
    return {
      ok: false,
      status: 409,
      error: "Your subscription isn't on the Growth plan price, so it can't be upgraded here.",
    };
  }

  const couponId = await ensureProIntroCoupon(proPrice.unitAmountCents, proPrice.currency);

  const updated = await sdk.subscriptions.update(
    sub.id,
    {
      items: [{ id: item.id, price: proPrice.priceId }],
      proration_behavior: "none",
      billing_cycle_anchor: "now",
      discounts: couponId ? [{ coupon: couponId }] : [],
    },
    { idempotencyKey: `plan-upgrade-pro:${uid}:${sub.id}` },
  );

  logInfo("plan_upgrade.paid_to_pro", { uid, subId: sub.id, couponId: couponId ?? null });
  return { ok: true, renewsAt: subRenewsAt(updated) };
}

// Mark a gifted owner's comp record as superseded once they buy a real
// subscription, so admin views don't show a phantom "active gift" on a paying
// owner and the expiry cron (which filters status=="active") leaves it alone.
// Idempotent; a no-op when there's no active gift.
export async function supersedeActiveGift(uid: string): Promise<boolean> {
  const ref = db().collection(COL.complimentaryPlans).doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const gift = snap.data() as ComplimentaryPlan;
  if (gift.status !== "active") return false;
  await ref.set({ status: "superseded", supersededAt: new Date().toISOString() }, { merge: true });
  logInfo("comp_plan.superseded", { uid, plan: gift.plan });
  return true;
}
