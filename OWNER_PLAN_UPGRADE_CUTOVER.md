# Owner-Plan Upgrade — Go-Live Cutover & Live Smoke Test

Companion to `OWNER_PLAN_UPGRADE_SPEC.md`.

**Status: cutover COMPLETE (2026-06-24); upgrade mechanics VERIFIED (2026-07-06).**
The code is deployed, Stripe runs in **Live** mode, the Growth (€69) + Pro (€290)
products and the €200 first-cycle coupon are provisioned live, both webhook
endpoints exist, and the Customer Portal is locked down. The exact upgrade Stripe
calls were replayed end-to-end in the sandbox on 2026-07-06 and produced the
expected €200-now / €290-renewal result (see Part 1). The **one remaining item is
optional**: a single controlled **€200 live upgrade** to confirm the same on the
live account with a real card. This runbook is how to run it, verify it, and undo
it so it costs nothing.

Do every Stripe Dashboard step with the mode toggle on **Live**.

---

## Part 0 · Pre-flight (should already be green — just confirm)

- [ ] **Live-status panel** — Admin (`platform.oliowallet.com`) → **Settings → Owner Plans → "Stripe live status"**. Confirm:
  - Mode badge = **Live**.
  - **Platform account** chip green (charges enabled).
  - **Connect split payments** chip green.
  - **Webhook endpoint** chip green with **no missing events**. If it flags a missing event (e.g. `invoice.payment_failed`, added for owner-plan delinquency visibility), add it in Part 4's event list before proceeding.
- [ ] **Products exist** — Growth + Pro products + the €200 intro coupon are already created in Live. (The old **"Create missing Stripe products"** button was removed on 2026-06-23; provisioning is done. If a product were ever missing, `POST /api/admin/stripe/provision-plan-products` re-creates them.)
- [ ] **Customer Portal locked** — Stripe → Settings → **Billing → Customer portal → Subscriptions**: **"Customers can switch plans" OFF**, **"Customers can cancel subscriptions" ON**. This is what enforces _no self-service downgrades_.
- [ ] **First-year price (optional)** — Admin → Settings → Owner Plans → **"Limits & Fees" → "Pro upgrade — 1st year (€)"**. Default **200**; blank = upgrade at full price. (Fixed in code via `withFixedPlanPrices` — the admin field is informational.)

## Part 1 · Run the PAID path (Growth → Pro, €200 first cycle)

Use a **staff owner account** you can refund afterward. No need to wait 12 months —
Stripe's "upcoming invoice" preview shows the next charge immediately.

- [ ] Put the staff owner on the **paid Growth** plan (real subscription, not a gift).
- [ ] In the app: **Profile → Plans → Pro → Confirm** (the paid path charges immediately on confirm — there's no Stripe Checkout page for the swap).
- [ ] ✓ **Expected in Stripe** (Customer → the subscription):
  - An invoice charged **€200 today** (not €290) — the one-time `olio_pro_intro_9000_eur` coupon applied.
  - **Next renewal ~12 months out at €290**, fresh term (`billing_cycle_anchor:"now"`).
  - **No credit line** for unused Growth time (`proration_behavior:"none"`).

> **Mechanics verified 2026-07-06 (sandbox).** Replaying `upgradePaidToPro`'s exact
> call — swap to the Pro price with `proration_behavior:"none"`,
> `billing_cycle_anchor:"now"`, and a one-time €90 coupon — on a fresh Growth
> subscriber produced: Growth **€69.00** paid → upgrade invoice **€200.00** paid
> (`billing_reason=subscription_update`) → renewal preview **€290.00**, with **0**
> ongoing discounts (the coupon was consumed). Stripe's proration/coupon behavior
> is mode-identical, so only the live real-money charge remains to confirm.

## Part 2 · Run the GIFTED path (full €290 Checkout)

- [ ] Admin → **Users** → grant a _different_ staff owner a **complimentary Growth** plan (gifted owners have no subscription).
- [ ] In the app: **Profile → Plans → Pro** → this routes to a **Stripe Checkout at full €290** (no swap, because there's no sub to modify).
- [ ] Pay with a real card.
- [ ] ✓ **Expected:** after payment, the `customer.subscription.created` webhook fires and the owner's `complimentaryPlans` record flips to **`superseded`** (no lingering "active gift").

## Part 3 · Verify money + entitlement

- [ ] **Admin → Transactions** shows the **€200** (paid path) and **€290** (gifted path) as **subscription** rows (kind = subscription, via "Stripe Billing").
- [ ] **Entitlement:** each staff owner's `stripeRole` claim is now **pro** → unit cap **20**, Pro UI. (The claim reaches the client on token refresh — ~1h, or immediately via the app's `refreshPlan()` after checkout. The server reads the claim directly, so caps/fees are correct immediately.)
- [ ] **Portal:** the staff owner can **cancel** and **update card** but **cannot switch/downgrade** plans.

## Part 4 · Undo — so the smoke test is free

- [ ] **Refund both invoices** — Stripe → **Payments** → open the €200 and €290 charges → **Refund** (full).
  - Note: a refunded owner subscription now surfaces in **Admin → Transactions** as a `−€… refunded` line (the transactions endpoint expands the invoice charge). Refunding does **not** revoke the plan.
- [ ] **Cancel the subscriptions** — in the Stripe Customer Portal (or Dashboard), cancel each. Access stays until period end (`cancel_at_period_end`); at period end `customer.subscription.deleted` reconciles the portfolio **down to basic**.
- [ ] **Remove the gift** — Admin → Users → revoke the complimentary plan you granted in Part 2 (if not already superseded).

---

## Webhook events (both endpoints, Live — reference)

Both post to `https://app.oliowallet.com/api/webhooks/stripe`; Stripe tells them
apart by which signing secret verifies. The live-status panel flags any missing
required event.

- **Platform** — "Events from: Your account" (`STRIPE_WEBHOOK_SECRET`):
  `account.updated`, `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.payment_failed`.
- **Connect** — "Events from: Connected accounts" (`STRIPE_CONNECT_WEBHOOK_SECRET`):
  `checkout.session.completed`, `payment_intent.succeeded`, `charge.refunded`,
  `account.updated`. (Direct-charge rent events + fee refunds — not the upgrade feature.)

## How it works (reference)

- **Paid Growth→Pro:** `usePlanSource()` → `source:"paid"` → confirm → `POST /api/owner/plan/upgrade` → `stripe.subscriptions.update({ proration_behavior:"none", billing_cycle_anchor:"now", discounts:[once-coupon] })` → €200 now, fresh 12-mo term, €290 at renewal.
- **Gifted Growth→Pro:** `source:"gifted"` (no sub) → `createCheckoutSession(proPrice)` at €290 → `customer.subscription.created` webhook → `supersedeActiveGift()` retires the gift.
- **Cancel / no-downgrade / no-refund:** Portal `cancel_at_period_end`; the UI never offers a downgrade and the Portal "Switch plans" toggle is off.
- **Delinquency:** a failed renewal fires `invoice.payment_failed` → staff page + owner nudge (no invoice mirror otherwise). Final cancellation arrives as `customer.subscription.deleted` → reconcile to basic.
