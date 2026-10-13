# Olio Wallet — Full QA Report

**Date:** 2026-06-06
**Scope:** `olio-fe` monorepo — 3 Vite/React 19 frontends (`client/landing`, `client/app`, `client/platform`), Express API (`server/`, deployed as the `api` Cloud Function), scheduled functions (`functions/src/`), Firestore + Storage rules, CI.
**Method:** Static review of the full codebase (every `server/routes/*.ts`, the auth/privilege services, money path, all three clients, Firebase config and rules), plus `tsc`, the test suite, and production builds. Five parallel review tracks (auth/IDOR, integrations/secrets, validation/rules/storage, correctness, frontend). All Critical/High findings were re-read end-to-end before inclusion.

---

## 0. Remediation Status — updated 2026-06-07

Fixes were implemented, then **adversarially re-reviewed** (multi-agent + independent skeptic per finding) before commit. The review caught two issues the type-checker/tests missed: a `RequireOwnerExperience` redirect that fired before the plan claim loaded (could strand a legacy paid owner on `/tenant`) and the QA-03 record-hiding risk below — both handled.

**Fixed, verified (tsc clean · 322 tests · 3 builds green in an isolated worktree), committed:**

- **QA-01** (High) — property reads now privilege-matrix gated (`finance.viewHistory` / `property.view`) + 4 regression tests.
- **QA-04** — 15s fetch timeouts on OneSignal/Resend (cron-hang fix).
- **QA-05** — `platform` code-split: 2.19 MB monolith → **269 kB** entry chunk + lazy routes + `manualChunks`.
- **QA-06/07** — loading + error-retry states across admin & owner list views.
- **QA-08** — owner routes gated against tenants (fixed to wait for `planLoading`).
- **QA-09** — ErrorBoundary on `platform`+`landing`; stack traces hidden in prod.
- **QA-10** — keyboard-operable sortable headers (full-cell click target).
- **QA-11** — 1.9 MB `.webp` → 198 kB `.jpg`.
- **QA-16** uniform `{error}` shape · **QA-17** marketplace error state · **QA-19** accessible table search · **QA-21** dead Firestore query removed.

**Partially shipped — QA-02 (CSP):** Flipping the report-only policy fully to enforced _blind_ is unsafe (Firebase Auth reCAPTCHA / OneSignal runtime origins aren't visible in source; a wrong guess breaks login/push). Shipped as a **dual-header rollout**: (1) **enforced now** the zero-risk directives `frame-ancestors 'none'; object-src 'none'; base-uri 'self'` + `X-Frame-Options: DENY` (closes a real clickjacking gap the SPA HTML lacked); (2) **corrected the report-only allowlist** (added `nominatim.openstreetmap.org`, `cdnjs.cloudflare.com`, `*.basemaps.cartocdn.com`, `onesignal.com`) so the eventual full flip won't break address autocomplete/maps. **Now FULLY ENFORCED (2026-06-07):** promoted the full policy to an enforcing `Content-Security-Policy` on all three sites (report-only header removed). Verified first via `firebase functions:log` that `/api/csp-report` showed **zero `csp.violation` entries during active authenticated sessions**, and via a read-only check that no embedded Stripe.js / phone-auth is in play. Kept `script-src 'unsafe-inline'` (OneSignal/3rd-party runtime safety — our own bundles have no inline scripts) and retained `report-uri` so violations keep logging even when enforced. Added defensive origins as insurance: `www.google.com`/`www.gstatic.com` (Firebase-Auth reCAPTCHA, if enabled) and `onesignal.com` (frame). Remaining hardening (optional): drop `script-src 'unsafe-inline'` once a OneSignal smoke-test confirms it injects no inline script.

**Held — QA-03 (admin scalability):** Implemented (list endpoints bounded with Firestore `orderBy + limit`, joins via `getAll`), but **not shipped**. Verification found that `orderBy(joinedAt|createdAt|timestamp)` **silently excludes any doc missing that field**, and the existing `u.joinedAt && …` guards prove such legacy docs exist — so bounding would hide records from prod admin/compliance views. **Requires a sort-field backfill migration (or cursor pagination) first.** Work preserved in `git stash@{0}`; recover with `git stash apply stash@{0}` after the backfill.

---

## 1. Executive Summary

The platform is **well-engineered and security-conscious** — materially above average for a product at this stage. Every authenticated route verifies the Firebase ID token server-side, admin endpoints are uniformly role + privilege-matrix gated, Stripe webhooks are signature-verified with anti-forgery account binding, money is computed server-side in integer cents, secrets are correctly server-only (none leak into client bundles), and storage uploads are confined to per-user object prefixes. `tsc` is clean, **318/318 tests pass**, and all three clients build.

**No Critical vulnerabilities were found** (no unauthenticated data leak, no cross-tenant IDOR, no money-trust bug, no auth bypass). The single **High** issue is an authorization _tier_ bypass: a portfolio "legal" contact can read an owner's financial transaction history through a property endpoint that skips the privilege matrix the rest of the finance surface enforces. The remaining issues are **Medium** correctness/UX/perf items — most notably the admin (`platform`) app ships as one un-code-split 2.1 MB bundle, several Query-driven views render an "empty" state when the API is actually erroring, and a couple of outbound integrations lack request timeouts that could stall the daily crons. Overall risk posture: **low-to-moderate, with one authorization fix worth prioritizing.**

---

## 2. Findings Table

Severity per the brief: **Critical** = exploitable now (auth bypass, money, data leak) · **High** = user-facing breakage or hard-to-exploit security flaw · **Medium** = correctness/UX bug · **Low/Info** = polish, perf, style. Where a review track proposed a higher label for a pure-performance item, it was normalized to this guide (noted inline).

| ID    | Severity | Area                       | Location                                                                                                     | Description                                                                                                                                                                                     |
| ----- | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA-01 | **High** | AuthZ / IDOR               | `server/routes/properties.ts:57-74, 307-329`                                                                 | "Legal" portfolio contact can read owner's full rent/payment history via `/api/properties/:id/transactions`, bypassing the `finance.viewHistory` matrix gate.                                   |
| QA-02 | Medium   | Headers / XSS defense      | `firebase.json:17,46,75`                                                                                     | CSP is `Report-Only` (never enforced) **and** uses `script-src 'unsafe-inline'` → no runtime XSS mitigation, only telemetry.                                                                    |
| QA-03 | Medium   | Firestore scale            | `server/routes/adminQueries.ts` (dashboard, units, agreements, transactions, portfolios, users, activity)    | Admin endpoints read entire collections with no `.limit()`; escalates to **High/outage** as `transactions`/`users` grow.                                                                        |
| QA-04 | Medium   | Reliability                | `server/services/push.ts:119`, `server/services/resend.ts:174`                                               | Outbound `fetch()` to OneSignal/Resend has no timeout; one stalled socket hangs the rent-reminder / email-dispatch cron until the 540 s function kill.                                          |
| QA-05 | Medium   | Perf (FE)                  | `client/platform/src/App.tsx:11-29`, `pages/SuperAdminDashboard.tsx:24-28`, `client/platform/vite.config.ts` | `platform` is a single **2.1 MB** JS chunk — no route `React.lazy`, no `manualChunks`; index route eager-imports Leaflet + Recharts.                                                            |
| QA-06 | Medium   | UX (FE)                    | `client/shared/lib/queryClient.ts:76-89` + most platform/app list pages                                      | Query errors are swallowed (`isError` unused, global `retry:false`) → API failure renders the **empty state** ("no data") instead of an error.                                                  |
| QA-07 | Medium   | UX (FE)                    | `client/app/src/pages/owner/TenantsPage.tsx:42` + several platform pages                                     | Several list views have no loading state and flash the empty state during fetch.                                                                                                                |
| QA-08 | Medium   | UX / defense-in-depth (FE) | `client/app/src/App.tsx:290-352`                                                                             | Owner-only routes (`/properties`, `/tenants`, `/banking`) are not UI role-gated; a tenant deep-link renders owner chrome (server still blocks the data).                                        |
| QA-09 | Medium   | UX / info (FE)             | `client/app/src/main.tsx:33-44`                                                                              | App ErrorBoundary prints raw `error.stack` to end users; `platform` and `landing` have **no** ErrorBoundary (a render throw white-screens them).                                                |
| QA-10 | Medium   | Accessibility (FE)         | `client/platform/.../Admin*Page.tsx` (7 tables), 2 app pages                                                 | Sortable `<th onClick>` headers are not keyboard/screen-reader operable (no `tabIndex`/`role`/keydown).                                                                                         |
| QA-11 | Medium   | Perf (FE)                  | `client/app/src/assets/images/apt-interior.webp`, `client/landing/src/pages/sections/HeroSection.tsx:6-15`   | 1.9 MB unoptimized `.webp` on tenant dashboard (the `.jpg` twin is 198 KB); landing eagerly imports ~3 MB of hero carousel images.                                                              |
| QA-12 | Low      | AuthZ consistency          | `server/routes/adminContent.ts:591,624`                                                                      | `PATCH /admin/suggestion-requests/:id` and `/admin/marketplace-leads/:id` are `requireRole` only — missing the `requirePlatformPrivilege("comm.activityLog")` their read/sibling endpoints use. |
| QA-13 | Low      | Email abuse                | `server/routes/portfolio.ts:416-476`                                                                         | Owner can send a branded "X sent you a lease" email to an arbitrary address with no per-owner rate limit (no credentialed link; quota-bounded).                                                 |
| QA-14 | Low      | Validation                 | `server/routes/adminContent.ts:119-126`                                                                      | Admin partner `contactName/email/phone/location` are type-checked but not length-capped (doc bloat; admin-only).                                                                                |
| QA-15 | Low      | Storage                    | `server/routes/profile.ts:186`                                                                               | Avatar `finalize` lacks the dedicated rate limit that photo/document `finalize` endpoints have.                                                                                                 |
| QA-16 | Low      | API consistency            | `server/app.ts:199`                                                                                          | Fallback handler returns `{message}` while every route returns `{error}`; client tolerates both today.                                                                                          |
| QA-17 | Low      | TanStack Query             | `client/app/src/lib/ownerQueries.ts:427-431`                                                                 | `useMarketplaceListing` drops `isError`; a fetch failure looks identical to "not found."                                                                                                        |
| QA-18 | Low      | TanStack Query             | `client/platform/src/lib/adminQueries.ts:120-135`                                                            | `useAdminDashboard` double-fetches (and flashes zeroed financials) because the `?financial=1` URL isn't gated on `usePrivileges()` readiness.                                                   |
| QA-19 | Low      | Accessibility (FE)         | `client/shared/components/ui/data-table.tsx:81-87`                                                           | Shared table search `<input>` has no `aria-label`/label (reused across most tables).                                                                                                            |
| QA-20 | Low      | Responsive (FE)            | `client/shared/components/common/AskOlioFloating.tsx:82`                                                     | Fixed `w-[380px] h-[600px]` floating panel lacks `max-w-[90vw]`/`max-h` clamp → overflow on ~360 px phones.                                                                                     |
| QA-21 | Low      | Dead code                  | `server/services/planReconcile.ts:245,265`                                                                   | Invalid `where("propertyId","in",[])` placeholder query fires (and is caught/discarded) on every reconcile.                                                                                     |
| QA-22 | Low      | Reliability                | `server/openai.ts:15` (call `server/routes/ask.ts:114`)                                                      | OpenAI client uses the SDK default 10-min timeout; inside the tool-call loop a slow model can hold the request far longer than a user waits.                                                    |
| QA-23 | Info     | Money (display)            | `server/routes/portfolio.ts:373`, `adminQueries.ts:342,1069`                                                 | Display aggregates sum float-euro fields; the **payment path is correctly integer cents**, so no money is affected.                                                                             |
| QA-24 | Info     | Money (edge)               | `server/routes/stripeWebhook.ts:369-371`                                                                     | Fee-refund ratio uses `Math.max(1, charge.amount)` denominator — only mis-behaves for a degenerate zero-amount charge.                                                                          |
| QA-25 | Info     | Storage                    | `server/routes/media.ts`, `documents.ts`                                                                     | Reads use non-expiring Firebase download tokens (revoked only by deleting the object) — standard Firebase pattern; a leaked URL is valid until delete.                                          |
| QA-26 | Info     | Tests                      | vitest run                                                                                                   | `happy-dom` prints an `AsyncTaskManager … destroyed` teardown warning; **all 318 tests still pass** — cosmetic.                                                                                 |
| QA-27 | Info     | Webhook                    | `server/routes/emailMarketing.ts:499-505`                                                                    | Resend webhook raw-body fallback re-stringifies `req.body`; effectively dead code and fails closed (401).                                                                                       |

---

## 3. Finding Details

### QA-01 — High — "Legal" contact can read an owner's financial history (privilege-matrix bypass)

**Where:** `server/routes/properties.ts:57-74` (`loadReadablePropertyOrNull`), used by `GET /api/properties/:id/transactions` (`:307-329`) and `GET /api/properties/:id` (`:222`).

**What.** The portfolio-access model grants tiered roles to contacts an owner invites. The matrix (`shared/firestore-schema.ts:839`) sets `"finance.viewHistory": { owner:true, legacyOwner:true, legal:false, financial:true, tenant:true }` — a **legal** contact must _not_ see money. The canonical finance endpoint enforces this:

```ts
// server/routes/finance.ts:99-103  — GET /api/owner/transactions
const scope = await resolveOwnerScope(req);
if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
const authz = await authorizePortfolioRead(req.user!.uid, scope, "finance.viewHistory");
if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
```

But the property-scoped transactions endpoint authorizes through a helper that checks only that _any_ active grant exists — with **no slot/matrix check**:

```ts
// server/routes/properties.ts:64-72
if (property.ownerId === callerUid) return property;
const grantSnaps = await db()
  .collection(COL.portfolioAccessContacts)
  .where("ownerId", "==", property.ownerId)
  .where("contactUserId", "==", callerUid)
  .where("status", "==", "active")
  .limit(1)
  .get();
if (grantSnaps.empty) return null;
return property; // ← legal contact passes here
// ...:317-323 then returns raw Transaction docs for that property
```

**Why it matters.** `property.view` is `legal:true` (`schema:832`), so a legal contact can legitimately list the owner's properties (`GET /api/owner/properties?ownerId=X`), obtain a property id, then call `/api/properties/:id/transactions` and read the rent/payment ledger the matrix explicitly denies them. `GET /api/properties/:id` similarly exposes unit `rentAmount` to any grant tier. It is a genuine cross-tier financial-data exposure; rated High (not Critical) because the attacker must already be an owner-invited portfolio contact — it is not reachable by an arbitrary or unauthenticated user.

**Suggested fix (described, not applied).** After loading the property in both endpoints, resolve scope for `property.ownerId` and enforce the matrix the same way `finance.ts` does — `authorizePortfolioRead(callerUid, scope, "finance.viewHistory")` for the transactions route, and an appropriate read privilege (e.g. `property.view`/`analytics.viewProperty`) for the single-property route. Self (`ownerId === caller`) keeps passing. Consider deleting `loadReadablePropertyOrNull` in favor of the existing scope+matrix helpers so the lax pattern can't be reused.

---

### QA-02 — Medium — CSP is Report-Only and allows inline scripts

**Where:** `firebase.json:17, 46, 75` (all three hosting targets).

**What.** The policy ships as `Content-Security-Policy-Report-Only`, so the browser only POSTs violations to `/api/csp-report` and **blocks nothing**, and `script-src` includes `'unsafe-inline'`. Net runtime XSS mitigation today ≈ zero.

**Why it matters.** It's a missing defense-in-depth backstop. The risk is currently _latent_ — every actual HTML-injection sink is independently sanitized (all user/admin `dangerouslySetInnerHTML` go through `sanitizeComplianceHtml`/DOMPurify), so there is no known payload the enforced CSP would need to stop. The exposure is "the next sink someone adds."

**Suggested fix.** After confirming the report endpoint is clean against real traffic, flip to the enforcing `Content-Security-Policy` header and remove `'unsafe-inline'` from `script-src` (Vite supports build-time hashes/nonces). `style-src 'unsafe-inline'` is far lower risk and can remain. The report-only rollout looks intentional — the recommendation is to set a date to enforce, not to treat it as a defect.

---

### QA-03 — Medium (→High at scale) — Unbounded full-collection reads on admin endpoints

**Where:** `server/routes/adminQueries.ts` — e.g. `/api/admin/dashboard` (`:232-274`), `/units` (`:1030`), `/agreements` (`:1342`), `/transactions` (`:1435`), `/portfolios` (`:1229`), `/users` (`:915`, + full `auth().listUsers` scan), `/activity` (`:1695`).

**What.** These endpoints `.get()` whole collections with no `.limit()` and filter (e.g. `?range=1d`) in JS _after_ the full read:

```ts
// /api/admin/dashboard
const [usersSnap, propsSnap, unitsSnap, agreementsSnap, tenantsSnap, txSnap] = await Promise.all([
  db().collection(COL.users).get(),
  /* ...properties, units, agreements, tenants... */
  db().collection(COL.transactions).get(), // grows unbounded, 1 row/payment forever
]);
```

**Why it matters.** Read cost, latency, and function memory grow linearly with the platform. `transactions` and `auditLog`/`activity` never stop growing; the dashboard refetches `/admin/users` every 30 s. At a few thousand users / tens of thousands of transactions these endpoints will time out or exceed the function memory limit — i.e. the admin console goes down exactly when the business is succeeding. It's Medium today (small data) but architectural.

**Suggested fix.** Maintain counters on write (or a scheduled rollup doc) for the dashboard tiles; convert list endpoints to Firestore-side date-range + `orderBy(...).limit(n)` pagination instead of read-all-then-filter. At minimum cap `transactions`/`activity` reads.

---

### QA-04 — Medium — Outbound `fetch()` to OneSignal/Resend has no timeout

**Where:** `server/services/push.ts:119`, `server/services/resend.ts:174`.

**What.** Both retry loops call bare `fetch()` with no `AbortController`/`signal`. Node's `fetch` has no default timeout, so a stalled connection hangs indefinitely. `sendPush` is awaited sequentially per active agreement inside `rentReminderSweep`, and `sendEmailViaResend` per recipient inside `emailDispatchTick` — one hung socket stalls the whole batch until the 540 s function timeout kills it. The correct pattern already exists in `server/services/briefing.ts:53-55` (8 s `AbortController`).

**Suggested fix.** Wrap both in an `AbortController` with a per-attempt timeout (~10-15 s) and pass `signal`, mirroring `briefing.ts`.

---

### QA-05 — Medium — `platform` ships as a single 2.1 MB un-split bundle

**Where:** `client/platform/src/App.tsx:11-29`, `client/platform/src/pages/SuperAdminDashboard.tsx:24-28`, `client/platform/vite.config.ts`.

**What.** Every admin page is a static top-level import (no `React.lazy`/`import()` anywhere in `client/platform/src`), and the index route eagerly imports `react-leaflet`, `leaflet`, `react-leaflet-cluster`, and `recharts`. There is no `rollupOptions.manualChunks`. Build output: `dist/platform/assets/index-*.js` = **2,190 kB** (623 kB gzip) in one chunk. (Severity normalized to Medium per the brief's perf guidance, but it's the top perf item.)

**Why it matters.** Admins download the entire admin app + maps + charts before the login screen paints — slow on poor links, and a regression risk as the admin surface grows.

**Suggested fix.** Mirror the **excellent** pattern already in `client/app/src/App.tsx:30-69` (`lazyRoute` + `<Suspense>` + idle prefetch) and add a `manualChunks` block to `client/platform/vite.config.ts`. At minimum lazy-load `SuperAdminDashboard` so Leaflet/Recharts leave the entry chunk.

---

### QA-06 — Medium — Query errors are silently swallowed (shows "empty", not "error")

**Where:** `client/shared/lib/queryClient.ts:76-89` (global `retry:false`, `staleTime:Infinity`, no error handler) + most list pages, e.g. `AdminTransactionsPage.tsx:35`, `AdminActivityLogPage.tsx:25`, `TenantsPage.tsx:42`, `PropertiesPage.tsx:33`.

**What.** Pages destructure `const { data = [] } = useX()` and never read `isError`, so a failed fetch renders the empty state ("No transactions found") indistinguishable from a genuinely empty result. The hooks _do_ expose `isError` — `OwnerDashboard.tsx:26-38` proves the pattern with a retry banner — it's just not consumed elsewhere.

**Why it matters.** Operators can't tell "nothing here" from "the API is down," and there is no retry affordance. Pure UX/observability — server enforcement is unaffected.

**Suggested fix.** Surface `isError` from the query hooks and render an error+retry block (reuse `OwnerDashboard`'s banner). Consider a global `QueryCache` `onError` toast.

---

### QA-07 — Medium — Missing loading states on several list views

**Where:** `client/app/src/pages/owner/TenantsPage.tsx:42`, `OwnerAgreementsPage.tsx`, `common/ActivityPage.tsx`, `NetworkPage.tsx`, `AskOlioPage.tsx`; platform `AdminTransactionsPage`, `AdminActivityLogPage`, `AdminAgreementsPage`, `AdminPortfoliosPage`, `AdminInvestmentLeadsPage`.

**What.** These destructure without `isLoading`, so the first paint shows the empty UI until data arrives (a "no data" flash). `PropertiesPage.tsx:87-104` is the gold standard (skeleton + dual empty states + image `onError`).

**Suggested fix.** Add a skeleton/spinner gated on `isLoading` before the empty branch.

---

### QA-08 — Medium — Owner routes not UI role-gated against tenants

**Where:** `client/app/src/App.tsx:290-352` (`AuthenticatedShell`).

**What.** All owner routes are inside one `<RequireAuth>` with no `roles` prop, so a tenant deep-linking to `/properties` or `/tenants` passes the UI guard and renders owner chrome. The corresponding server endpoints are privilege-gated (they 403), so this is **not a data leak** — the tenant sees owner page shells that then show empty/error states. Only `/marketplace` is UI-gated (via `OwnerOnlyMarketplace`).

**Suggested fix.** Add per-route role/experience guards or a shell-level redirect bouncing non-owner-experience users off owner paths — the mechanism (`isOwnerExperience`, `RequireAuth roles=`) already exists.

---

### QA-09 — Medium — ErrorBoundary leaks stack traces; two apps have none

**Where:** `client/app/src/main.tsx:33-44`.

**What.** On any uncaught render error the app shows `error.message` + full `error.stack` in a red `<pre>` — poor UX and leaks internal paths in production. `platform` and `landing` have no ErrorBoundary at all (a render throw white-screens the whole app).

**Suggested fix.** Render a friendly fallback in production and gate the stack dump behind `import.meta.env.DEV`; add an ErrorBoundary to the `platform` and `landing` entry points.

---

### QA-10 — Medium — Sortable table headers are keyboard-inaccessible

**Where:** `AdminTransactionsPage.tsx:176-193` + `AdminUsersPage`, `AdminUnitsPage`, `AdminPartnersPage`, `AdminPortfoliosPage`, `AdminMarketplacePage`, `AdminAgreementsPage`; app `OwnerAgreementsPage`, `NetworkPage`.

**What.** `<th onClick>` with `cursor-pointer` but no `tabIndex`/`role="button"`/keydown — keyboard and screen-reader users can't sort.

**Suggested fix.** Make the inner header `<span>` a `<button>`, or add `tabIndex={0}` + `role="button"` + Enter/Space handler.

---

### QA-11 — Medium — Oversized images

**Where:** `client/app/src/assets/images/apt-interior.webp` (1.86 MB; the `.jpg` twin is 198 KB) used at `TenantDashboard.tsx:35`; `client/landing/src/pages/sections/HeroSection.tsx:6-15` eagerly imports 10 hero images (~3 MB).

**What.** The `.webp` was exported without compression (a webp should be _smaller_ than the jpg). Landing imports all carousel images at module top though only one shows at a time, and landing has no code-splitting (renders `LandingPage` directly).

**Suggested fix.** Re-export the webp compressed (<100 KB) or just use the existing 198 KB `.jpg` everywhere; lazy-load carousel images beyond the first and preload the rest on idle.

---

### QA-12 → QA-22 — Low

- **QA-12** `adminContent.ts:591,624` — add `requirePlatformPrivilege("comm.activityLog")` to the two lead-status PATCH endpoints to match their read counterparts (`adminQueries.ts:1581,1632`). Impact: a sub-role admin denied `comm.activityLog` can still flip a lead's status.
- **QA-13** `portfolio.ts:416-476` — add a per-owner rate limit on agreement creation (e.g. `rateLimit('agreement-create:${uid}', 30, 86400)`), matching the other email-sending endpoints. The invite email carries no credentialed link and is quota-bounded, hence Low.
- **QA-14** `adminContent.ts:119-126` — `.trim().slice(N)` the partner contact fields (names/location ~200, email ~320, phone ~40), consistent with the rest of the codebase.
- **QA-15** `profile.ts:186` — add `rateLimit('avatar-finalize:${uid}', 60, 3600)` to match the photo/document finalize endpoints.
- **QA-16** `app.ts:199` — return `{ error: "Internal Server Error" }` (not `{message}`) so the API error shape is uniform; clients tolerate both today via `parseApiError`.
- **QA-17** `ownerQueries.ts:427-431` — re-expose `isError` from `useMarketplaceListing` so the detail page can distinguish error from not-found.
- **QA-18** `adminQueries.ts:120-135` — gate `useAdminDashboard`'s `enabled`/URL on `usePrivileges()` readiness to avoid the double-fetch and the flash of zeroed financials.
- **QA-19** `data-table.tsx:81-87` — add `aria-label={placeholder}` to the shared `TableSearchInput` (fixes every table at once).
- **QA-20** `AskOlioFloating.tsx:82` — add `max-w-[90vw] max-h-[85vh]` to the floating panel.
- **QA-21** `planReconcile.ts:245,265` — remove the dead `where("propertyId","in",[])` placeholder; just `await` the real reads.
- **QA-22** `openai.ts:15` — set an explicit `timeout`/`maxRetries` on the OpenAI client.

### QA-23 → QA-27 — Info

Display-only float aggregation (payment path is integer cents); the `charge.refunded` degenerate-denominator note; non-expiring Storage download tokens (standard Firebase); the cosmetic `happy-dom` test-teardown warning; and the dead Resend webhook raw-body fallback (fails closed). No action required; documented to show they were checked.

---

## 4. Route Auth Matrix

Legend — **Auth**: `requireAuth` present · **Gate**: role/privilege middleware or inline check · **Obj-check**: per-object ownership verification.

| Method            | Path                                                                                                                                                                           | Auth | Gate                                                                                                               | Obj-check                                       | Notes                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------- |
| GET               | /api/health/firebase                                                                                                                                                           | –    | public                                                                                                             | –                                               | liveness                                 |
| POST              | /api/csp-report                                                                                                                                                                | –    | public, IP rate-limited                                                                                            | –                                               | CSP sink                                 |
| POST              | /api/auth/forgot-password                                                                                                                                                      | –    | public, anti-enumeration + rate-limit                                                                              | –                                               | constant-time 200                        |
| POST              | /api/webhooks/stripe                                                                                                                                                           | –    | Stripe signature                                                                                                   | event.account↔ownerId bound                     | rent recorder                            |
| POST              | /api/webhooks/resend                                                                                                                                                           | –    | Svix HMAC                                                                                                          | –                                               | email events                             |
| GET/POST          | /api/u/:token                                                                                                                                                                  | –    | token IS auth (single-use)                                                                                         | token→userId                                    | unsubscribe                              |
| GET               | /api/system-config · /compliance · /social · /admin/plan-labels                                                                                                                | –    | public read                                                                                                        | –                                               | non-PII config (matches Firestore rules) |
| GET               | /api/public/properties/:id                                                                                                                                                     | –    | public, whitelisted fields                                                                                         | –                                               | no financials/ownerId                    |
| GET               | /api/me                                                                                                                                                                        | ✓    | self                                                                                                               | self (uid)                                      | creates/backfills profile                |
| POST              | /api/heartbeat                                                                                                                                                                 | ✓    | self, rate-limit                                                                                                   | self                                            |                                          |
| PATCH             | /api/profile                                                                                                                                                                   | ✓    | self, allowlist                                                                                                    | self                                            | allowlist excludes roles/status/plan     |
| DELETE            | /api/me                                                                                                                                                                        | ✓    | self, rate-limit                                                                                                   | self                                            | cascade by uid                           |
| POST              | /api/profile/photo/upload-url · /finalize                                                                                                                                      | ✓    | self                                                                                                               | objectPath prefix = uid                         |                                          |
| GET               | /api/tenant/units · /activity · /agreements                                                                                                                                    | ✓    | self                                                                                                               | `userId==uid` filter                            |                                          |
| POST              | /api/tenant/payment/log · /checkout · /finalize                                                                                                                                | ✓    | self, rate-limit                                                                                                   | loadActiveTenancy / tx.tenantId bound           | amount server-derived                    |
| POST              | /api/owner/payment/verify/:id                                                                                                                                                  | ✓    | self                                                                                                               | `tx.ownerId==uid`                               |                                          |
| POST              | /api/tenant/agreements/:id/respond                                                                                                                                             | ✓    | self                                                                                                               | tenancy.userId==uid                             |                                          |
| GET               | /api/messages/conversations                                                                                                                                                    | ✓    | self                                                                                                               | participant filter                              |                                          |
| POST              | /api/messages/start · /start-with-landlord                                                                                                                                     | ✓    | self                                                                                                               | owns tenancy / own active tenancy               |                                          |
| GET/POST          | /api/messages/conversations/:id/messages · /read                                                                                                                               | ✓    | self                                                                                                               | loadConversationForCaller (participant)         |                                          |
| GET               | /api/owner/properties · /agreements · /tenants · /summary                                                                                                                      | ✓    | resolveOwnerScope + authorizePortfolioRead(matrix)                                                                 | ✓                                               | per-slot matrix                          |
| POST              | /api/owner/agreements                                                                                                                                                          | ✓    | requireOwnerPlanPrivilege ×2                                                                                       | property.ownerId==caller                        |                                          |
| PATCH             | /api/owner/agreements/:id                                                                                                                                                      | ✓    | requireOwnerPlanPrivilege                                                                                          | agreement.ownerId==uid                          |                                          |
| POST              | /api/owner/tenants/:id/end                                                                                                                                                     | ✓    | self                                                                                                               | tenancy.ownerId==uid                            |                                          |
| PUT/DELETE        | /api/owner/bank-details                                                                                                                                                        | ✓    | self                                                                                                               | self                                            |                                          |
| GET               | /api/owner/transactions                                                                                                                                                        | ✓    | resolveOwnerScope + authorizePortfolioRead("finance.viewHistory")                                                  | ✓                                               | matrix enforced                          |
| POST              | /api/owner/transactions                                                                                                                                                        | ✓    | self, rate-limit                                                                                                   | property.ownerId==uid                           |                                          |
| POST              | /api/properties                                                                                                                                                                | ✓    | self, cap-check (txn)                                                                                              | self ownerId                                    |                                          |
| GET               | /api/properties/:id                                                                                                                                                            | ✓    | loadReadablePropertyOrNull                                                                                         | owner OR **any** active grant — **no matrix** ⚠ | **QA-01**                                |
| GET               | /api/properties/:id/transactions                                                                                                                                               | ✓    | loadReadablePropertyOrNull                                                                                         | owner OR **any** active grant — **no matrix** ⚠ | **QA-01 (High)**                         |
| PATCH/DELETE      | /api/properties/:id                                                                                                                                                            | ✓    | self                                                                                                               | existing.ownerId==uid                           |                                          |
| POST              | /api/properties/:id/transfer                                                                                                                                                   | ✓    | self                                                                                                               | ownerId==uid + recipient cap                    |                                          |
| GET               | /api/owner/access-contacts                                                                                                                                                     | ✓    | self                                                                                                               | ownerId==uid                                    |                                          |
| PUT/DELETE        | /api/owner/access-contacts/:type                                                                                                                                               | ✓    | self                                                                                                               | doc id `${uid}_${type}`                         |                                          |
| GET               | /api/access-contacts/invitations                                                                                                                                               | ✓    | self                                                                                                               | contactUserId==uid                              |                                          |
| POST              | /api/access-contacts/invitations/:id/accept · /decline                                                                                                                         | ✓    | self                                                                                                               | contactUserId==uid                              | 404-not-403 leak guard                   |
| GET               | /api/portfolios/accessible                                                                                                                                                     | ✓    | self                                                                                                               | active grants only                              |                                          |
| POST              | /api/owner/stripe-connect/\* (6)                                                                                                                                               | ✓    | self, rate-limit                                                                                                   | profile.connectAccountId (never body)           | safe-redirect guards                     |
| POST              | /api/ask                                                                                                                                                                       | ✓    | requireActivePortfolioPlanPrivilege + resolveOwnerScope                                                            | ✓                                               | scoped tools, 50/day, 4 KB cap           |
| GET               | /api/owner/briefing                                                                                                                                                            | ✓    | resolveOwnerScope + authorizePortfolioRead("analytics.viewPortfolio") + plan                                       | ✓                                               |                                          |
| GET               | /api/owner/analytics/export                                                                                                                                                    | ✓    | requireSelfPortfolioPrivilege("analytics.export")                                                                  | ownerId==uid                                    | CSV-injection safe                       |
| GET               | /api/partners                                                                                                                                                                  | ✓    | requireActivePortfolioPlanPrivilege("network.access")                                                              | –                                               |                                          |
| GET               | /api/marketplace                                                                                                                                                               | ✓    | self                                                                                                               | –                                               |                                          |
| POST              | /api/expert/apply · /owner/suggestion-request · /owner/marketplace-leads                                                                                                       | ✓    | self, rate-limit                                                                                                   | self userId                                     |                                          |
| POST              | /api/tickets                                                                                                                                                                   | ✓    | self, rate-limit                                                                                                   | self userId                                     |                                          |
| GET               | /api/owner/unit-cap · /platform-fee-tier                                                                                                                                       | ✓    | resolveOwnerScope                                                                                                  | ✓                                               |                                          |
| GET/PUT           | /api/privileges-config                                                                                                                                                         | ✓    | GET: auth; PUT: requireRole("superadmin")                                                                          | –                                               | god-mode write superadmin-only           |
| PUT               | /api/system-config                                                                                                                                                             | ✓    | requireRole("superadmin")                                                                                          | –                                               |                                          |
| PUT               | /api/compliance · /social · /admin/banners · /admin/platform-fees · /admin/plan-labels                                                                                         | ✓    | requirePlatformPrivilege("platform.modifySettings")                                                                | –                                               |                                          |
| GET               | /api/admin/banners · /platform-fees                                                                                                                                            | ✓    | requireRole / platform.modifySettings                                                                              | –                                               |                                          |
| POST              | /api/admin/notifications/send · /password-reset · /audience-count                                                                                                              | ✓    | requirePlatformPrivilege("comm.email")                                                                             | server-resolved audience (excludes staff)       |                                          |
| GET/POST          | /api/admin/emails\* (campaigns/templates/send/schedule/cancel/test)                                                                                                            | ✓    | requirePlatformPrivilege("comm.email")                                                                             | –                                               |                                          |
| GET               | /api/admin/integrations/\* · /email-quota                                                                                                                                      | ✓    | requireRole + comm.email                                                                                           | –                                               | booleans only                            |
| GET/POST          | /api/admin/stripe/live-health · provision-plan-products                                                                                                                        | ✓    | requirePlatformPrivilege("platform.modifySettings")                                                                | –                                               |                                          |
| PATCH/POST        | /api/admin/units/:id · /api/admin/units                                                                                                                                        | ✓    | requireRole + properties.editAny (+ finance.viewAll for $ fields)                                                  | –                                               | SSRF guard on image                      |
| POST              | /api/admin/users/invite                                                                                                                                                        | ✓    | requireRole + users.assignRoles                                                                                    | –                                               | refuses existing email                   |
| PATCH             | /api/admin/users/:id                                                                                                                                                           | ✓    | requireRole + users.manage (+ inline suspend/assignRoles + superadmin gate + last-superadmin guard + token revoke) | target id                                       | exemplary                                |
| DELETE            | /api/admin/users/:id                                                                                                                                                           | ✓    | requireRole + users.suspend; last-superadmin guard                                                                 | target id                                       |                                          |
| POST              | /api/admin/users/:id/send-reset-email · /impersonate · /comp-plan; DELETE comp-plan                                                                                            | ✓    | requireRole + users.manage / users.assignRoles                                                                     | target id; impersonate blocks staff targets     |                                          |
| GET               | /api/admin/dashboard · /units · /portfolios · /agreements · /transactions · /partners · /tickets · /suggestion-requests · /marketplace-leads · /audit-log · /activity · /users | ✓    | requireRole + per-endpoint platform privilege; `?financial=1` re-gated on finance.viewAll                          | –                                               | unbounded reads → **QA-03**              |
| POST/PATCH/DELETE | /api/admin/partners* · /marketplace*                                                                                                                                           | ✓    | requireRole + comm.partners                                                                                        | –                                               | XSS/SSRF guards                          |
| PATCH             | /api/admin/tickets/:id; GET/POST /:id/messages                                                                                                                                 | ✓    | requireRole + comm.activityLog                                                                                     | –                                               |                                          |
| PATCH             | /api/admin/suggestion-requests/:id · /marketplace-leads/:id                                                                                                                    | ✓    | requireRole(admin,superadmin) — **no platform privilege** ⚠                                                        | –                                               | **QA-12 (Low)**                          |

---

## 5. What I Couldn't Verify — Recommended Manual Tests

**Phase 5 (runtime exploratory QA) was not executed.** The API requires live Firebase Admin credentials (and Stripe/OpenAI/Resend/OneSignal keys), and the brief forbids touching production data; no local emulator dataset is provisioned in the repo. The following should be exercised by hand against the Firebase **emulator suite** or a dedicated **staging** project (never production):

1. **QA-01 repro (priority).** As an owner, invite a second account as a **legal** contact. From the legal account, call `GET /api/owner/transactions?ownerId=<owner>` (expect 403) and then `GET /api/properties/<id>/transactions` (currently expected to **succeed** and leak the ledger — confirm, then re-test after the fix).
2. **Role boundary fuzzing.** Get a tenant ID token; `curl` owner/admin endpoints directly (`/api/owner/*`, `/api/admin/*`) — confirm 401/403 across the board. Repeat with a non-superadmin admin token against `/api/system-config` and `/api/privileges-config` (PUT).
3. **Auth flows.** Email/password + Google sign-in; wrong password; unverified email; suspended-account token (expect 403 everywhere); token expiry mid-session.
4. **Stripe (test mode).** Tenant rent checkout → webhook delivery → ledger row written once (replay the event; confirm idempotent). Connect onboarding for an owner; attempt to drive another owner's `accountId` (expect rejection). `charge.refunded` proportional fee refund.
5. **XSS/escaping.** Inject `<img src=x onerror=alert(1)>` into property name, ticket text, message body, profile name, partner fields — confirm escaped on render and in the analytics CSV export (open in a spreadsheet to confirm no formula execution).
6. **Over-fetch / response hygiene.** Watch the network tab on tenant + owner dashboards — confirm API responses don't include other users' emails/phones/IBANs (server logging already redacts these; verify the wire payloads too).
7. **Frontend states.** Throttle/network-fail to confirm the QA-06/QA-07 "empty vs error vs loading" gaps on the admin and owner list pages; tab-through the sortable admin tables (QA-10) and the table search box (QA-19) with keyboard + screen reader.
8. **Cron resilience (QA-04).** Simulate a slow OneSignal/Resend endpoint and confirm `rentReminderSweep` / `dispatchEmailCampaigns` don't hang to the 540 s kill.

**Automated-check results (Phase 1):** `npm run check` (tsc, server + 3 clients) — **clean**. `vitest run` — **318/318 passing across 30 files**. `npm run build` — all three clients build; bundle warnings on `dist/platform` (2.19 MB, QA-05), `dist/app/index` (778 KB) and the lazy `html2pdf` chunk (976 KB, acceptable — dynamically imported). No lint script is configured (TypeScript strict mode + tests are the gate).
