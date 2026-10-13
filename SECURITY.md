# Security

This document captures the threat model, the controls Olio relies on,
how to report a vulnerability, and how to respond to an incident. It
exists so a new engineer (or a security reviewer) can answer "why is
that code shaped that way?" without spelunking through commit history.

Keep it current. When you add a non-obvious control, write a sentence
here. When you find a gap, file it under [Known gaps](#known-gaps).

## Reporting a vulnerability

Email **security@oliowallet.com** with a description and (ideally) a
proof-of-concept. We'll acknowledge within 48 hours and aim to ship a
fix within 7 days for HIGH/CRITICAL findings. Please don't open a
public GitHub issue for security issues — they're indexed by
attackers within hours.

## Threat model

We assume the attacker has:

- A valid Olio account (signup is free).
- Browser DevTools and full visibility into their own requests.
- Knowledge of this codebase (open-source-style read access).
- A second account they can collude with.

We assume the attacker does NOT have:

- Anyone else's auth credentials.
- A network position MITM-ing other users (HTTPS is assumed intact).
- Physical access to your machine.
- A compromised Firebase/GCP project (if they get this, game over —
  see [Operational security](#operational-security)).

We DO defend against insider threats (compromised admin accounts) up
to the point where actions are auditable + reversible. We do NOT
defend against rogue infrastructure operators who can directly edit
Firestore via the console — that's an operational-trust boundary,
not a technical one.

## Architecture in 1 paragraph

3 SPAs (landing / app / platform) on Firebase Hosting + 1 Cloud
Function (Express, 2nd gen) for the API. Firestore for data; Cloud
Storage for blobs; Firebase Auth for identity; Stripe for payments;
Resend for marketing email; OneSignal for push. The Firestore rules
are deny-by-default — every read/write flows through the API where it
gets gated by `requireAuth`, role checks, and the
admin-editable privilege matrix in `config/privileges`. Storage is
locked down the same way: deny-by-default rules + signed-URL
gateways minted by the server.

## Control surface

### Identity & sessions

- Firebase ID token verified per request in [`server/auth.ts`](server/auth.ts).
- The user's Firestore profile is read FRESH on every authenticated
  request — never trusted from the ID-token snapshot alone.
- `auth().revokeRefreshTokens(uid)` fires on every security-relevant
  state change (suspend / role change / comp-plan revoke) so cached
  ID tokens can't outlive the change for more than ~1 hour.
- `revokeRefreshTokens` also fires on the cron auto-expire path in
  `functions/src/index.ts`.

### Authorization

- 3 privilege matrices live in `config/privileges` (admin-editable):
  - **Portfolio roles** — what a cross-portfolio contact (legacy / legal /
    financial) can do on an owner's portfolio.
  - **Platform roles** — what each admin sub-role (manager / sales /
    support / etc.) can do.
  - **Owner plans** — what each plan tier (basic / advance / pro /
    business) unlocks.
- Three middleware factories enforce each:
  `requirePlatformPrivilege`, `requireActivePortfolioPlanPrivilege`,
  inline `hasPortfolioPrivilege` for cross-cutting reads.
- Role assignment is gated on `users.assignRoles` (admin-only by
  default; NOT granted to manager). Even with that privilege, **only
  an existing superadmin can mint another superadmin** — the gate is
  hard-coded in `PATCH /api/admin/users/:id`.
- Cross-portfolio access (`portfolioAccessContacts`) is **opt-in**:
  invitations start as `status: "pending"` and only grant access
  after the invitee accepts via the dedicated endpoints. Without that
  flow, owner X could spam fake portfolios into anyone's sidebar.

### Input handling

- Per-route allowlists + length caps on every user-mutable field.
- HTTP body size capped at 1MB via `express.json({ limit: "1mb" })`.
- Unicode hygiene on display-name fields (`sanitizeText` in
  `server/services/unicodeSanitize.ts`) — strips C0/C1 controls,
  zero-width chars, bidi overrides, BOM. Defends against admin-list
  spoofing (`John‮gnirT` rendering backwards).
- Email rate-limit keys are NFKC-normalized before lowercasing so
  Unicode variants can't bypass the bucket.
- CSV export escapes formula triggers (`=/+/-/@/\t/\r/\\`) via
  `csvCell` in `server/services/csvSafety.ts` — tenant notes can't
  exfiltrate row data via `=HYPERLINK(...)` when the owner opens
  the CSV in Excel.
- HTML user content goes through DOMPurify on every render site
  (`client/shared/lib/sanitizeHtml.ts`).
- All user-supplied URLs that flow to a third-party redirector or
  server-side fetch go through:
  - `isSafeRedirectUrl` — allowlist of Olio domains for Stripe
    success/cancel URLs.
  - `isPublicHttpsUrl` — blocks SSRF via IPv4 RFC1918, loopback,
    link-local, IPv6 (`[::1]`, `[::ffff:7f00:1]`, etc.),
    cloud-metadata hostnames. Defense in depth at fetch time too
    (`briefing.ts:fetchImageAsDataUrl`).

### Money paths

- Stripe webhook signature verified with `webhooks.constructEvent` +
  the raw body buffer captured by `express.json({ verify })`. Forged
  events with the wrong signature are rejected.
- Every write that could be double-fired by webhook+redirect+retry
  races is idempotent:
  - Rent transactions: deterministic doc id `stripe_${session.id}`
    inside `runTransaction`.
  - Application-fee refunds: `idempotencyKey: refund_${event.id}`
    passed to Stripe SDK.
  - Stripe Connect account links: deterministic
    `idempotencyKey: connect-account:v2:${uid}` (versioned so it can't
    collide with keys minted for prior Express accounts).
- Agreement creation + tenant rent-log both use deterministic doc IDs
  derived from a stable key (`sha256(owner|property|email|date)` /
  `sha256(tenant|unit|day|method|amount)`) so a double-submit creates
  ONE row, not two.
- Plan-downgrade reconcile fires on `customer.subscription.updated`:
  deletes excess properties (vacant first) + terminates agreements
  if the new plan lost the `rent.collectStripe` privilege. See
  `server/services/planReconcile.ts`.
- Unit cap enforced inside `runTransaction` at every write site
  (POST `/api/properties`, POST `/api/properties/:id/transfer`).
- Application fee derivation: PI's authoritative
  `application_fee_amount` wins over checkout-session metadata. See
  `deriveFeeBreakdown` in `server/services/rentTransaction.ts` + its
  tests.

### Rate limiting

Firestore-backed token bucket in `server/services/rateLimit.ts` —
atomic check-and-increment via `runTransaction`. Active on:

- `/api/auth/forgot-password` (IP + email, silent block on cap)
- `/api/ask` (50/day per UID)
- `/api/owner/transactions` (200/day)
- `/api/tickets` (20/day)
- `/api/expert/apply`, `/api/owner/suggestion-request`
- `/api/tenant/payment/log` + `/api/tenant/payment/checkout`
- Photo + property-photo + document upload-URL endpoints
- All 5 Stripe Connect endpoints
- Admin impersonate (30/h), email-test (50/h), broadcast (20/h),
  push-test (50/h), password-reset push (50/h)
- `/api/me` self-delete (5/day)
- `/api/csp-report` (100/h per IP)
- Conversation message send (200/h per UID)

A daily cron `sweepRateLimits` GC's docs older than 7 days so the
collection doesn't grow unbounded.

### Privacy / GDPR

- Proof-of-consent: the Terms/Privacy version a user accepts at signup is
  recorded server-side on `User.consent` (the accepted version, a server
  timestamp, and the request IP/User-Agent) when `/api/me` creates the account —
  signup is gated on the
  acceptance checkbox, so account creation IS the acceptance. Bump
  `TERMS_VERSION` (shared/firestore-schema.ts) on a material Terms/Privacy
  change; re-consent-on-bump is a future flow. Deleted with the user on erasure.
- Right-to-erasure (Art. 17) implemented end-to-end:
  - `deleteUserCascade` in `server/services/userDelete.ts` removes
    every keyed Firestore doc + storage object across 15+ collections
    - 4 storage prefixes + the `emailCampaigns/*/recipients/{uid}`
      subcollections.
  - `DELETE /api/admin/users/:id?hard=true` — admin-initiated.
  - `DELETE /api/me` — user-initiated from Profile → Delete Account.
    Same blocker check (active properties / agreements refuse the
    delete) + typed-email confirm on the client.
- Right-of-access — currently informal; if a user requests their
  data, an admin pulls it via the audit log + raw Firestore queries.
  Building a `GET /api/admin/users/:id/export` is a known gap.
- Request-body logger redacts ~20 sensitive keys before writing to
  Cloud Logging (`server/app.ts:SENSITIVE_KEYS` — credentials, IBAN,
  signed URLs, email, firstName/lastName, address, phone, free-text
  message bodies).
- Forgot-password log line masks email to `ab***@***`.
- Push payloads include only minimal PII (uid for targeting; the
  notification body is generic enough not to leak details to
  OneSignal beyond what they need to deliver).
- Conversation messages persist after tenancy end (design decision —
  thread outlives the tenancy); document download tokens are
  ROTATED on `POST /api/owner/tenants/:id/end` so an ex-tenant who
  saved the URL can no longer access the file.

### Logging & observability

- Structured logger in `server/services/log.ts` — `log({level,
event, fields, err?})` writes one JSON object per call. Cloud
  Logging parses each field as searchable structured data. Use
  `event: "rate_limit.429"` (kebab.case or dotted) so dashboards
  can filter on `jsonPayload.event`.
- CSP violations from the browser land in
  `logWarn("csp.violation", {...})` via `/api/csp-report`.
- Stripe platform-account-disabled logs as
  `[stripe.platform-disabled]` so the alert policy in
  `infra/monitoring-stripe-connect-disabled.yaml` can fire.
- Audit log surfaces at `/admin/audit-log` (gated on `users.viewAll`)
  — combined feed of `impersonations` + `userAudit`.

### Cross-site request forgery (CSRF)

- **Primary control: bearer token, not cookies.** Every authenticated
  request carries a Firebase ID token in the `Authorization: Bearer`
  header, verified per request in [`server/auth.ts`](server/auth.ts).
  The API reads **no** auth cookies. Browsers auto-attach cookies to
  cross-site requests but never the `Authorization` header, so a forged
  cross-site request from `evil.com` simply arrives unauthenticated and
  is rejected by `requireAuth`. This makes the API structurally immune
  to classic CSRF without a token-per-form scheme.
- **Defense-in-depth: soft Origin/Referer allowlist**
  ([`server/originGuard.ts`](server/originGuard.ts), mounted in
  `server/app.ts` before the body parser). On state-changing methods
  (POST/PUT/PATCH/DELETE) it 403s a request whose `Origin` (or, as a
  fallback, `Referer`) host is NOT a first-party Olio host
  (`app.`/`platform.`/`www.`/apex `oliowallet.com`, plus `localhost`/
  `127.0.0.1` and the optional `PUBLIC_APP_URL` host for staging). The
  allowlist intentionally mirrors `safeRedirect.ts` `PROD_HOSTS`.
- This guard is deliberately **conservative** — a false positive blocks
  a real user, so it only rejects a clearly-foreign _browser_ origin:
  - Requests with **no** `Origin` and **no** `Referer` (server-to-
    server, curl, mobile apps, and webhook deliveries) are **allowed**.
  - **Webhook + telemetry endpoints are exempt entirely** — anything
    under `/api/webhooks/` (Stripe, Resend) and `/api/csp-report`.
    Those authenticate via HMAC signature, not Origin, and must never
    be blocked on an Origin technicality.
  - A literal `Origin: null` (sandboxed/privacy contexts) is treated as
    "no usable origin" → allowed; bearer auth still applies.

### HTTP security headers

On both the API (`server/app.ts`) and Firebase Hosting
(`firebase.json`):

- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` — denies camera/mic/geo/payment/USB/sensors
- `X-Frame-Options: DENY` on the API (SPAs allow framing for the Leaflet map tiles)
- `Cross-Origin-Resource-Policy: same-origin` (API)
- `Content-Security-Policy-Report-Only` (SPAs) — strict policy
  covering only what the SPA actually loads. Violations report to
  `/api/csp-report`. Will flip to enforced after a week of clean
  data.

### Infrastructure

- Service-account JSON gitignored. Production Functions use the
  default service account; secrets via `defineSecret` (Firebase Secret
  Manager). No `functions.config()` anywhere.
- `npm audit fix` keeps direct deps current. 0 high/critical at HEAD;
  remaining moderates are transitive Firebase chain (no non-major fix).
- Deployment-protection lien on the GCP project (one-shot via
  [`infra/deletion-protection-lien.sh`](infra/deletion-protection-lien.sh)).
- Storage bucket lifecycle: 7-day soft-delete recovery window only.
  No age-based prefix sweeps — would silently nuke active users' avatars.
  Orphan cleanup is the job of per-property + per-user cascades.
- Two GitHub Actions workflows: `ci.yml` (typecheck + test + build
  on every push/PR) and `deploy.yml`, which triggers via `workflow_run`
  after CI succeeds on main. `deploy.yml` does NOT re-run typecheck/test
  — it trusts the CI gate that triggered it — and runs only the builds +
  `firebase deploy`, gated on the `production` environment for secret
  access.

## Incident response

An incident is anything that breaks the live product, risks data, or runs up
unexpected cost. Classify by **severity** (drives urgency), then follow the
matching **playbook** below (organised by incident type — orthogonal to sev).

### Severity & escalation

| Sev      | Definition                                                                                                                    | Target response                              | Who                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------- |
| **SEV1** | Money or data at risk, or platform down: rent can't be paid, auth broken, suspected breach, or data loss/corruption.          | Begin within minutes; status update ~30 min. | On-call → escalate to a project owner immediately. |
| **SEV2** | Degraded but working: elevated error rate, one subsystem down (email/push), slow responses, a single owner's payouts blocked. | Begin within the hour.                       | On-call; pull in an owner if trending to SEV1.     |
| **SEV3** | Minor / cosmetic / single-user, no money or data risk.                                                                        | Next business day.                           | Normal work.                                       |

Escalation: on-call → project owner(s) (the GCP/Stripe account owners) →
external (Stripe / GCP support) as needed. There is no formal pager rotation yet
(small team), so the alert **notification channel is the de facto pager** — point
it at someone who will see it out of hours.

### Detection — how you find out

- **Cloud Monitoring alerts** routed to a notification channel: platform Stripe
  Connect disabled, **api server-error-rate**, **client-error spike**, and an
  **uptime check** on `/api/health/firebase`. These policies are version-
  controlled in `infra/` but **only page once applied + wired to a channel**
  (see `infra/README.md`); until then detection is manual.
- **Staff push** (`notifyStaff`) fires on the worst money event (platform
  payments disabled) independently of the GCP alert.
- **Manual**: Cloud Logging (filter `severity>=ERROR` or a specific
  `jsonPayload.event`, e.g. `client.error` / `stripe.webhook-handler-failed`),
  the Stripe Dashboard, and the deploy result (Discord webhook on CI/deploy
  failure).

### Tier 1 — production is down or compromised

1. **Activate maintenance mode**: superadmin → Settings → System →
   Maintenance Mode → enable. Locks the UI for everyone except
   superadmins. Webhook + `/api/system-config` + `/api/me` always
   bypass.
2. **Stop the bleeding**: revoke the affected user's tokens via
   `auth().revokeRefreshTokens(uid)` (or suspend them in Admin → Users
   → Edit → Status). Both kill the session within ~1 hour. If a whole
   capability is misfiring (rent checkout, Connect onboarding, plan
   upgrade, AskOlio, rent-indexation), **kill it with its feature flag** —
   `PUT /api/feature-flags` (superadmin) or set the flag to `false` in the
   `config/featureFlags` Firestore doc. Takes effect within ~30s, no deploy,
   and is more surgical than full maintenance mode.
3. **Identify the blast radius**: read `/admin/audit-log` for staff
   actions, Cloud Logging for API events, Stripe Dashboard for any
   payment irregularities.
4. **Communicate**: superadmin sets a maintenance-mode message that
   surfaces in the UI lockout. Email affected users from Resend if
   the incident requires disclosure.

### Tier 2 — suspected key compromise

If a server secret (Stripe, Resend, OneSignal, OpenAI, Firebase
Admin) is suspected to be exposed:

1. Rotate the secret via its respective dashboard.
2. `firebase functions:secrets:set <NAME> --project olio-wallet`
   with the new value.
3. Redeploy: `git push` to main triggers the deploy workflow.
4. For Firebase service account: revoke the old key from GCP IAM
   console; create a new one if local dev needs it.
5. For Stripe webhook secret rotation: also update the endpoint in
   Stripe Dashboard → Developers → Webhooks → Edit.

### Tier 3 — GDPR data-subject request

- **Erasure**: user clicks Settings → Delete Account (synchronous),
  OR admin via `/admin/users` → delete-user → ?hard=true.
- **Access**: pull from Firestore + Cloud Storage by uid. (Building
  a single-endpoint export is a known gap.)
- **Portability**: same as access — provide JSON dump. (Same gap.)
- All admin-initiated actions land in `userAudit` for the trail.

### Tier 4 — data loss or corruption

A bad migration, an erroneous cascade-delete, or a wiped collection.

1. **Stop writes** to the affected area: maintenance mode (Tier 1 step 1), and
   pause the relevant scheduled function if it's the culprit.
2. **Recover** (full procedure in `infra/README.md` → "Disaster recovery
   (Firestore data)" — PITR + daily/weekly managed backups are enabled):
   - Recent (≤7 days), partial: **PITR** — export the DB at a pre-incident
     timestamp and re-import (optionally a single collection).
   - Older / full loss (≤14 weeks): restore a **managed backup** into a new
     database, then export/import back into `(default)`.
3. Verify the restored data before lifting maintenance mode. Storage _files_
   (avatars, photos, docs) are separately recoverable for 7 days (bucket
   soft-delete).

### Tier 5 — runaway cost or abuse

A traffic spike, an abuse flood (rate limiters are per-action, not global), or a
misbehaving job.

1. **Confirm** in Cloud Billing / the budget alert (`infra/README.md` → "Billing
   budget & cost alert") and Cloud Monitoring (function instance count,
   Firestore read volume).
2. The `api` function is capped at `maxInstances: 20`, so spend is bounded — but
   legitimate traffic could be throttled, so check before raising it.
3. Abuse: suspend the offending user(s) (Admin → Users → Status). Note per-user
   rate limits key on UID, so mass-signup can rotate them — block at the source
   if needed.
4. If a specific paid/expensive capability is the cost driver, **kill it with
   its feature flag** (`config/featureFlags` — AskOlio is the usual AI-cost
   suspect; see Tier 1 step 2) rather than taking the whole app down.
5. Runaway job: disable the scheduled function and fix forward.

### Postmortem

For any SEV1 (and any SEV2 that recurs), write a short **blameless** postmortem
within a few days: timeline, root cause, blast radius, and concrete action items
with owners. Track it alongside the relevant `audit/` or `docs/` note so the fix
doesn't get forgotten — the same way the items in "Known gaps" below are tracked.

## Known gaps

These are flagged in `audit/` reports and tracked but not yet shipped.
Listed here so they don't get forgotten.

- **`GET /api/admin/users/:id/export`** for GDPR right-of-access — the
  cascade promise is met (Art. 17); the export promise (Art. 15 / 20)
  is currently informal.
- **Storage download tokens never expire** after issuance unless we
  rotate them explicitly. We rotate on tenancy-end; we don't rotate
  on owner-revokes-document-access (because that flow doesn't exist
  yet).
- **Unsubscribe tokens**: now single-use (via `usedUnsubscribeTokens/
{sha256(token)}` doc) but the doc collection has no TTL — it grows
  one row per unique unsubscribe-click forever. Bounded by unique
  unsubscribers, not total sends; volume is small in practice.
- **CSP enforcement** — currently Report-Only. Flip to enforced after
  the next 7 days of clean violation data.
- **Admin dashboard unbounded scans** — `/api/admin/dashboard` does
  full collection reads. Will OOM around 150k total docs. Move to a
  precomputed `stats/dashboard` doc maintained by a scheduled
  function before that scale hits.
- **`config/privileges` overwrite has no version history** — an admin
  saving an empty matrix locks everyone out. Recovery requires direct
  Firestore console edit. Add per-PUT snapshot subcollection.
- **2FA / TOTP** — Firebase Auth supports it, we haven't enabled the
  flow in the client. Configure in Firebase Console then add the
  enrollment UI.

## Operational security (you, the human)

- **Never paste secrets into Slack, email, or any LLM**. Use
  Firebase Secret Manager.
- **Sign Firebase deployment commits from a machine with full-disk
  encryption**.
- **2FA every account with write access to**:
  - GitHub (org + personal)
  - GCP / Firebase console
  - Stripe Dashboard
  - Resend dashboard
  - The domain registrar for oliowallet.com
- **Rotate service-account JSON every 90 days** if used on a
  developer laptop. Better: use ADC (`gcloud auth
application-default login`) instead.
- **Don't share project-owner roles**. Production project should
  have exactly the people who need delete-the-platform powers —
  everyone else gets least-privilege custom roles.

## Test coverage of security primitives

Every primitive that defends against a specific attack class has a
test file pinned in `server/services/*.test.ts`. If you change one
of them, ensure the test still passes — it's the only thing standing
between a refactor and silently re-opening the hole.

- `safeRedirect.test.ts` — SSRF / open-redirect (IPv6 regressions
  included)
- `originGuard.test.ts` — defense-in-depth CSRF Origin/Referer
  allowlist (allowlisted origin passes, foreign POST 403s, no-origin
  passes, webhook + CSP paths exempt)
- `csvSafety.test.ts` — CSV formula injection
- `unicodeSanitize.test.ts` — bidi / zero-width / control-char stripping
- `storagePath.test.ts` — Firebase URL parsing for cascade-delete
- `rentTransaction.test.ts` + `rentTransaction.writer.test.ts` —
  `advanceOneMonth` + `deriveFeeBreakdown` + idempotent ledger writer
- `rentChange.test.ts` / `rentCycle.test.ts` — rent-change clamping +
  payment-cycle math (indexation guardrails)
- `commission.test.ts` — platform-fee / commission derivation
- `planReconcile.test.ts` — plan-downgrade vacant-first deletion
- `configCache.test.ts` — config-doc cache + invalidation
- `connectMirror.test.ts` — Stripe Connect mirror authoritative-replace
- `stripeWebhook.test.ts` + `stripeWebhook.binding.test.ts` —
  productToPlan + webhook account-binding
- `ownerScope.test.ts` — `resolveOwnerScope` / portfolio scoping
- `userDelete.test.ts` — GDPR Art. 17 cascade-delete coverage
- `rateLimit.test.ts` — token-bucket check-and-increment
- `adminQueries.security.test.ts` + `adminQueries.pagination.test.ts` —
  admin-query authZ + bounded scans
- `properties.authz.test.ts` / `properties.test.ts` /
  `portfolio.test.ts` / `tenant.payment.test.ts` /
  `config.privileges.test.ts` / `routes.integration.test.ts` —
  route-level authZ + privilege gating
- `askOlioContext.gating.test.ts` + `askOlioContext.redaction.test.ts`
  — Ask-Olio plan gating + PII redaction
- `log.test.ts` — structured logger
- `audiences.test.ts` — server-side `resolvePushAudience` (push
  targeting). The email-marketing audience summary is a CLIENT test at
  `client/platform/src/features/email-marketing/model/audience.test.ts`.

The vitest suite currently spans ~511 tests across ~50 files. Keep this
list in sync when you add a security-relevant test file.
