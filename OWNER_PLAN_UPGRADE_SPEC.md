# Owner Plan Upgrade Scheme — Spec

Status: implemented (server + client + tests) on this branch. **Stripe live cutover steps and a manual test-mode verification are still required before real customers can use it — see §9.**

Last updated: 2026-06-15

---

## 1. Product rules (verbatim intent)

1. **Paid Growth → Pro.** A _paying_ Growth owner who upgrades to Pro pays a discounted **€200 for the current (first) cycle**, **loses unused Growth time** (no credit/refund), starts a **fresh 12-month Pro term now**, and pays the **normal Pro price (€290) at renewal**.
2. **Gifted Growth → Pro.** A _gifted_ Growth owner who upgrades to Pro pays the **normal Pro fee (€290, no discount)**, **loses the remaining gifted Growth time**, and Pro **applies instantly**.
3. **No downgrades. No refunds.** A member may **cancel** any paid membership; cancellation takes effect **at the next renewal** (they keep access until the period ends).

Internal plan keys (stable): `basic`=Starter, `advance`=Growth, `pro`=Pro, `business`=Business. Prices are **annual only** (config `planLabels`: Growth €69, Pro €290).

---

## 2. Why the two paths are mechanically different

The active plan is a single `stripeRole` custom claim on the Firebase Auth token. Two things write it:

- the **Stripe Payments extension** (when a real subscription starts/changes), and
- the admin **gift** endpoint (`POST /api/admin/users/:id/comp-plan`), which hand-writes the claim and records `complimentaryPlans/{uid}`.

A gift and a paid plan are **indistinguishable at read time** — both are just `stripeRole = "pro"`. They differ only in side records:

|                            | Paid owner                                                        | Gifted owner                                |
| -------------------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| Stripe subscription        | **Yes** (`customers/{uid}/subscriptions`, status active/trialing) | **None**                                    |
| `complimentaryPlans/{uid}` | absent                                                            | `status:"active"`, hard `expiresAt` (12 mo) |
| How it ends                | Portal cancel / renewal                                           | daily cron at `expiresAt`                   |

The gift grant endpoint **refuses (409)** when a Stripe subscription already exists, so _gifted and paid are mutually exclusive by construction_. Therefore:

- **Paid → Pro** = modify the existing subscription (a price swap). The Stripe **Customer Portal can't** apply our one-time coupon or reset the billing cycle, so this must be a **server-side `stripe.subscriptions.update`** — the first direct Stripe mutation in our server (today the server only _listens_).
- **Gifted → Pro** = there is **no subscription to swap**, so start a **brand-new** subscription through the existing Stripe **Checkout** flow (full price). A new subscription naturally invoices now and starts a fresh 12-month cycle.

---

## 3. Stripe objects to provision (test + live)

1. **Products/Prices** for `advance` + `pro` with `metadata.firebaseRole` set (already handled by `POST /api/admin/stripe/provision-plan-products`). Pro price = €290/yr.
2. **One-time intro coupon** for the paid-upgrade discount. Created idempotently by the same provisioning endpoint and by the upgrade endpoint on demand:
   - `amount_off = proPriceCents − 20000` (i.e. €90 when Pro = €290), `currency:"eur"`, `duration:"once"`.
   - Deterministic id `olio_pro_intro_<amountOff>_eur` (e.g. `olio_pro_intro_9000_eur`) so it is **reused** across calls and **auto-rolls** to a new coupon if the target or the Pro price ever changes (a new delta → a new id). No stale fixed coupon.
   - The **€200 target is admin-editable** at `config/planLabels.proUpgradeFirstCycleAmount` (edited on `/admin/owner-plans` → Limits & Fees → "Pro upgrade — 1st year"). Default is `DEFAULT_PRO_UPGRADE_FIRST_CYCLE_EUR = 200`. **Blank / null / 0 = no discount** (upgrade at the full Pro price). The figure shown in the confirmation modal is derived from this live value, so the copy stays truthful if it's changed or disabled.
3. **Customer Portal configuration** (Stripe Dashboard, both modes): **disable "Switch plans"**, keep **"Cancel subscription"** + payment-method update. This enforces _no downgrades_ at the Portal so an owner can't self-serve a tier drop. (Plan changes go only through our app, which never offers a downgrade.)
4. **Platform webhook endpoint**: add `customer.subscription.created` to its events (alongside `account.updated`, `customer.subscription.updated`) so a brand-new gifted→paid subscription supersedes the gift record.

---

## 4. Data model changes

- `ComplimentaryPlanStatus` gains **`"superseded"`** — set when a gifted owner buys a real subscription. The expiry cron already filters `status=="active"`, so a superseded gift is ignored (no phantom "active gift" on a paying owner; correctness was already protected by the cron's active-sub skip).
- `PlanLabelsConfig` gains **`proUpgradeFirstCycleAmount: number | null`** (admin-editable first-year upgrade price; default `200`, threaded through `loadPlanLabels` / `usePlanLabels` / the landing `planLabelsPublic` / the `GET`+`PUT /api/admin/plan-labels` route / the `/admin/owner-plans` editor). `DEFAULT_PRO_UPGRADE_FIRST_CYCLE_EUR = 200` is the default constant.

No `User` doc change. No new collection.

---

## 5. Server

New module `server/services/planBilling.ts`:

- `resolvePlanStripePrice(role)` → `{ productId, priceId, unitAmountCents, currency }` by listing Stripe products and matching `metadata.firebaseRole` (mirrors the live-health probe). Used to find the Pro price id + amount server-side.
- `ensureProIntroCoupon(fullCents, currency)` → retrieve-or-create the deterministic `duration:"once"` coupon; returns its id. Returns `null` if no discount applies (target ≥ full price).
- `getPlanSource(uid)` → `{ source: "paid"|"gifted"|"none", plan, renewsAt?, cancelAtPeriodEnd?, giftExpiresAt? }` by reading the `stripeRole` claim + `customers/{uid}/subscriptions` (extension mirror already carries `current_period_end` + `cancel_at_period_end`) + `complimentaryPlans/{uid}`.
- `upgradePaidToPro(uid)` → the core money path. Guards: caller must currently be `advance` **with an active paid subscription** (not gifted, not already pro/business). Then:

  ```ts
  stripe.subscriptions.update(
    subId,
    {
      items: [{ id: itemId, price: PRO_PRICE_ID }],
      proration_behavior: "none", // ← lose unused Growth time, no credit
      billing_cycle_anchor: "now", // ← fresh 12-month Pro term from today
      discounts: couponId ? [{ coupon: couponId }] : [], // ← €200 this cycle only
    },
    { idempotencyKey: `plan-upgrade-pro:${uid}:${subId}` },
  );
  ```

  Returns the new `current_period_end`. The Payments extension then flips `stripeRole→"pro"` and our existing `onSubscriptionUpdated` runs `reactivateAfterPlanUpgrade` (restores anything the lower Growth cap hid).

- `supersedeActiveGift(uid)` → if `complimentaryPlans/{uid}.status==="active"`, set `"superseded"` + `supersededAt`. Idempotent.

New endpoints in `server/routes/plan.ts` (**self-only** — they act on `req.user.uid`'s own Stripe customer, so a granted contact can never touch the owner's billing):

- `GET  /api/owner/plan/source` → `getPlanSource(uid)`.
- `POST /api/owner/plan/upgrade` → `{ to: "pro" }`; validates, calls `upgradePaidToPro`, returns `{ ok, renewsAt }`. 409 if not an eligible paid upgrade (client should route those to Checkout instead).

Webhook (`server/routes/stripeWebhook.ts`):

- New `customer.subscription.created` case → map customer→uid → `supersedeActiveGift(uid)`.
- Defensive `supersedeActiveGift(uid)` inside `onSubscriptionUpdated` too (belt + suspenders).
- Update the setup-doc comment + `PLATFORM_WEBHOOK_EVENTS` in `adminStripe.ts` to include `customer.subscription.created` so live-health flags it until configured.

The paid→paid swap is **owner-authorized server-side** (acts only on the caller's own subscription), **idempotent** (idempotency key), and **never refunds**.

---

## 6. Client

- New `usePlanSource()` hook (`apiRequest("GET","/api/owner/plan/source")`).
- `PricingModal.handlePlanSelect` reworked with rank + source awareness:
  - **Upgrade, paid source** (`advance` paid → `pro`): show a confirmation ("€200 today for a full year of Pro; your Growth time ends now; renews at €290 on <date>"), then `POST /api/owner/plan/upgrade`, then `refreshPlan()` + success note.
  - **Upgrade, gifted/none source** (gifted Growth → Pro, or basic → paid): `createCheckoutSession(priceId)` at **full price** (existing flow; `?checkout=success` already refreshes the claim).
  - **`business`**: unchanged (sales-led mailto).
  - **Lower paid tier** (e.g. pro → advance): **disabled** — "Not available" (no downgrades).
  - **`basic` while on a paid plan**: routes to the Portal as **"Cancel plan"** (cancel-at-period-end). Disabled for gifted owners (nothing to cancel; the gift just expires).
  - **Same tier**: current plan, disabled.
- Renewal/period-end copy comes from `usePlanSource()` (`renewsAt`, `cancelAtPeriodEnd`).

---

## 7. Cancellation / no-downgrade / no-refund mapping

| Rule                          | Mechanism                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cancel effective next renewal | Portal `cancel_at_period_end=true`; extension drops the claim at period end; our webhook deliberately ignores the cancel toggle (no premature reconcile). |
| No refunds                    | Nothing refunds on cancel; never call `refunds` on a subscription invoice.                                                                                |
| No downgrades                 | Client offers no downgrade CTA **and** the Portal "Switch plans" feature is disabled (Dashboard). Server upgrade endpoint also rejects non-upgrades.      |

Gifted plans have no "cancel" — they hard-expire at `expiresAt` via the daily cron.

---

## 8. Risks (carry into review/QA)

1. **First direct `stripe.subscriptions.update` in the server.** Idempotent + self-authorized + unit-tested, but the exact invoice must be confirmed in test mode (see §9).
2. **`billing_cycle_anchor:'now'` + `proration_behavior:'none'` interaction** is the entire "fresh 12 months, no credit" guarantee — verify the resulting invoice and next period in test mode; don't trust code review alone.
3. **Coupon math drift** if Pro price changes — mitigated by computing `amount_off` at runtime and encoding it in the coupon id.
4. **Portal escape hatch** — "no downgrades" depends on disabling Portal plan-switching (Dashboard step, both modes).
5. **Live products + coupon unprovisioned** — per project notes; run provisioning in live before enabling.
6. **Reconcile tail** — a re-upgrade past the 30-day grace leaves previously-suspended leases suspended (pre-existing behavior, unchanged).

---

## 9. Rollout & manual verification (the user drives the Stripe click-throughs)

1. **Provision (test mode):** run `POST /api/admin/stripe/provision-plan-products` → confirm advance/pro products + the `olio_pro_intro_*` coupon exist.
2. **Portal config (test):** disable "Switch plans", keep "Cancel subscription".
3. **Webhook (test):** add `customer.subscription.created` to the platform endpoint.
4. **Test-mode paid→Pro:** as a Growth _paid_ test owner, upgrade in-app. **Verify the invoice charges €200 now**, the new `current_period_end` is ~12 months out, and the **upcoming renewal previews €290**. Confirm no proration credit line for Growth.
5. **Test-mode gifted→Pro:** gift a test owner Growth, upgrade in-app → full **€290** Checkout, Pro applies instantly, and `complimentaryPlans/{uid}.status` becomes `superseded`.
6. **Cancel:** cancel in Portal → access persists to period end; claim drops at renewal.
7. **Repeat 1–3 in live**, then one real smoke test, before announcing.
