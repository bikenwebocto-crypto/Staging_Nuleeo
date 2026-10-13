# 2. Stripe Connect Standard accounts + DIRECT charges (Model B, owner-liable)

- Status: Accepted — LIVE in production since 2026-06-24 (test→live cutover complete)
- Deciders: platform team
- Tags: payments, stripe-connect, money-path

## Context

Owners collect rent from their tenants through Olio. Stripe Connect offers
several account types (Express / Standard / Custom) and several charge models
(destination charges, separate charges-and-transfers, direct charges). The
choice determines **who is the merchant of record**, **who bears chargeback
and refund liability**, and **how much KYC/onboarding/support burden the
platform takes on**.

Olio is a software tool for landlords, not a payment facilitator that wants to
own the funds flow or the regulatory weight of being merchant of record for
other people's rent. We want owners to be unambiguously responsible for their
own collections, and we want them to have a full Stripe Dashboard so they
self-serve disputes, payouts, and tax docs.

## Decision

Use **Standard** connected accounts with **direct charges** — internally
"Model B, owner-liable":

- Owner onboarding mints a `type: "standard"` account
  (`server/routes/connect.ts`, `account-link` endpoint). We don't request
  capabilities — a Standard account manages its own (`card_payments` activates
  during onboarding; `transfers` isn't needed for direct charges).
- The tenant's rent charge is created **on the owner's account** (direct
  charge). The owner is the merchant of record and **bears chargeback /
  refund liability**. Olio takes an `application_fee_amount` as its cut.
- Account state (`connectChargesEnabled`, `connectPayoutsEnabled`,
  requirements, disabled reason, per-capability status) is **mirrored** onto
  the owner's **portfolio** doc (`COL.portfolios`) by `mirrorConnectAccount()`
  (`server/services/connectMirror.ts`) so the UI can show "Active" without a
  live Stripe call. Banking is portfolio-level so it survives an owner transfer.

Because direct charges fire on the owner's account, payment events reach us
only via a **Connect webhook endpoint** with `event.account` set and signed by
a **separate secret**. We therefore run **two webhook endpoints at the same
URL** (`server/routes/stripeWebhook.ts`):

- **Platform** (`STRIPE_WEBHOOK_SECRET`): `account.updated` (our own account),
  `customer.subscription.created` / `updated` / `deleted` (plan-tier reconcile),
  and `invoice.payment_failed` (surface a delinquent owner subscription).
- **Connect** (`STRIPE_CONNECT_WEBHOOK_SECRET`): `checkout.session.completed`
  - `payment_intent.succeeded` (rent backstops), `charge.refunded` (refund our
    fee proportionally), `account.updated` (mirror owner state).

## Consequences

- **Liability sits with the owner, by design.** Olio is not the merchant of
  record for rent. A chargeback hits the owner's Stripe balance, not ours.
- **Owners get the full Stripe Dashboard.** Standard accounts can't use
  one-time login links, so owners manage their account at `dashboard.stripe.com`
  — this is intentional (`User.connectDetailsSubmitted` comment documents it).
- **Two webhook secrets per Stripe mode (test + live).** Setup is fiddly and had
  to be created in each mode; the handler comment is the runbook. This was
  **completed at the live cutover (2026-06-24)** — production runs on live keys
  and live webhook secrets. Each new platform event (e.g. `invoice.payment_failed`)
  must still be subscribed on the live endpoint; the admin live-health panel flags
  any required event that's missing.
- **Mode is implied by the key, not namespaced in data.** `STRIPE_SECRET_KEY`
  (live vs test) is the only mode switch, and connected-account ids + webhook
  secrets are mode-specific but stored un-namespaced. A live `acct_` won't work
  under a test key (and vice-versa), so flipping modes after go-live would strand
  owners on the other mode's Connect account. `stripeMode()` (server/stripe.ts)
  logs the booted mode as `stripe.mode` so the running mode is observable, not
  assumed.
- **Security: a forged rent event must arrive on the Connect endpoint with the
  right `event.account`.** The handler refuses a rent event that doesn't carry
  the owner's account id; the application fee is derived from the PI's
  authoritative `application_fee_amount`, not client/metadata. All write paths
  are idempotent (deterministic doc id `stripe_${session.id}`). See
  `SECURITY.md` → Money paths and `stripeWebhook.binding.test.ts`.
- **Plan-downgrade reconcile** (`planReconcile.ts`) can terminate agreements
  when the new plan loses `rent.collectStripe` — the Connect dependency is
  load-bearing for entitlement, not just payments.
