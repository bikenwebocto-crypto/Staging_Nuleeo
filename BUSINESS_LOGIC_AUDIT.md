# Olio Wallet — Business-Logic vs Software-Logic Audit

**Date:** 2026-06-07
**Scope:** Conflicts and inconsistencies between the **intended product behavior** (business rules) and what the **code actually does** — across the agreement/lease lifecycle, the rent amount/cycle/indexation engines, Stripe Connect collection & commission, plans/comp-plans/unit-caps, occupancy & revenue derivation, the transactions ledger, notifications, authorization consistency, data lifecycle (delete/transfer/linking), Firestore/Storage rules, the frontend↔backend contract, and docs/tests/schema drift.

**Method.** Five specialist agent teams ran in parallel, each: fan-out finders → an **independent adversarial verifier per finding** (prompted to _refute_, re-reading the actual source) → dedup & synthesize. ~169 agents total. **138 candidate findings → 120 survived adversarial verification → ~70 unique issues after cross-team dedup.** Auth/IDOR/CSP/performance from the existing `QA_REPORT.md` (QA-01…QA-27) were treated as out of scope except where a genuinely _new_ business-logic dimension was found (flagged inline).

> This document is the consolidated index. The five raw team reports (with full per-finding evidence quotes) live in the workflow task outputs.

---

## Remediation status — updated 2026-06-07

**Fixed + verified (tsc clean across all 4 tsconfigs · 384/384 tests pass), in the working tree (not yet committed):**

- **C-1 (Critical) + H-1/H-7 (admin revenue €0)** — both automated rent writers now write `type:"income"` (`server/services/rentTransaction.ts`, `server/routes/tenant.ts`), with a comment pinning the invariant. Regression tests added: `server/services/rentTransaction.writer.test.ts` (card path) + a `type:"income"` assertion on the offline-log test. Backfill for historical mis-signed rows: `script/backfillRentTransactionType.ts` (dry-run; run with `--commit` after review).
- **H-1 / H-4 (planReconcile deletes leased properties on downgrade)** — `server/services/planReconcile.ts` now derives `occupiedSet` from active tenancies, not `Unit.currentTenantId`.
- **H-2 / H-5 (delete/transfer guard dead; delete orphans agreements)** — `server/routes/properties.ts` delete + transfer guards now use `propertyHasActiveTenancy`; the delete cascade now also deletes agreements. New `DELETE` tests + an updated transfer-occupancy test (now seeds an active tenancy, not the dead field).
- New shared helper **`server/services/occupancy.ts`** (`propertyHasActiveTenancy`, `occupiedPropertyIds`) — the single active-tenancy occupancy source these fixes route through.

**Batch 2 — reporting/AI phantom-unit sites (fixed + verified, tsc clean · 384/384 tests):**

- **H-9 + M-1 (AskOlio)** — `server/services/askOlioContext.ts`: snapshot + `get_property_details` occupancy/rent now from active tenancies; `get_tenant_details`/`list_agreements` monthly rent falls back to `Tenant.rentAmount`, never `agreementValue` (the lease total).
- **M-10 / M-11 (admin dashboard)** — `server/routes/adminQueries.ts`: dashboard occupancy is active-only & unit-granular from tenancies; map markers + city/country `avgRental` include owner-property active tenancies (no longer "Vacant/€0"); units-list unit rows resolve the tenant via `Tenant.unitId` + active status.
- **M-12 (marketing audiences)** — `server/services/audiences.ts`: "Properties rented" now counts properties with an active tenancy.
- **GET `/api/properties/:id`** — `occupied`/`rentAmount` now derive from active tenancies (consistent with the list endpoint).

**Batch 3 — indexation safety (fixed + verified, tsc clean · 390/390 tests, incl. 6 new):**

- **H-6 (unbounded indexation rate)** — new `MAX_INDEXATION_RATE_PCT` (shared); `POST /api/owner/agreements` rejects out-of-range rates; `compoundRent` clamps defensively (and is now exported + tested).
- **H-7 (`nextIncreaseDate` frozen at creation)** — `POST /api/tenant/agreements/:id/respond` re-anchors the indexation clock on approval (rolls past steps forward, no retroactive application).
- **M-7 (apply with no prenotice)** — the sweep now refuses to apply a fixed/custom increase that was never pre-noticed: it sends the prenotice and pushes the effective date out by the lead time, guaranteeing notify-then-apply (also neutralizes the M-4 `delayMonths=0` immediate-apply danger at the engine level).
- New `functions/src/rentIndexation.test.ts` covers compound-off-current-rent, the rate clamp, defer-without-prenotice, apply-after-prenotice, and applied-log idempotency.

**Batch 4 — account-deletion vs subscription (fixed + verified, tsc clean · 394/394 tests, +5 new):**

- **H-3** — `findHardDeleteBlockers` (`server/services/userDelete.ts`) now blocks account deletion while the user has a live Stripe subscription (`customers/{uid}/subscriptions` status `active`/`trialing`). Per the chosen model: cancelling a subscription just stops renewal and the user keeps access until the paid period ends, so deletion becomes available **once the subscription has expired** — no destructive live-Stripe calls in the delete path. Enforced on both self-delete (`profile.ts`) and admin hard-delete (`adminUsers.ts`). Connect: by the time deletion proceeds there's no active lease/sub, so the owner's own Standard account simply loses its Olio reference (correct — the platform shouldn't delete a user-owned account). New tests in `userDelete.test.ts`.

**Batch 5 — AskOlio per-role authZ + comp-plan reconcile (fixed + verified, tsc clean · 400/400 tests, +6 new):**

- **H-8** — `/api/ask` now resolves the caller's per-role privileges after `resolveOwnerScope` and passes them to the snapshot + tools. The deterministic snapshot **redacts** financial/analytics lines a role can't see; `runAskOlioTool` **refuses** each tool by privilege (`list_agreements`/`get_tenant_details` → `agreement.view`; `list_transactions` → `finance.viewHistory`; `get_property_details` → `property.view`) — so a financial contact can't pull lease terms and a legal contact can't pull the money ledger via the assistant. New `server/services/askOlioContext.gating.test.ts`.
- **H-10** — comp-plan **revoke** (`adminUsers.ts`) and **expiry cron** (`functions/src/index.ts`) now call `reconcileAfterPlanChange(uid, grant.plan, "basic")` once the `stripeRole` claim is cleared, so the unit-cap / rent-collection boundary is enforced on a comp downgrade exactly as on a paid Stripe downgrade.

> **All Critical + High findings from the audit are now remediated** (C-1; H-1…H-10).

**Batch 6 — adversarial-review fix-ups (an independent multi-agent review of the fixes found 4 issues; all fixed, tsc clean · 403/403 tests, +3 new):**

- **[High regression] plan-downgrade cascade orphaned agreements** — the HTTP delete route was fixed to cascade agreements, but `deletePropertyCascade` (`planReconcile.ts`) wasn't; a cap-only downgrade left an `active` agreement on a deleted property feeding the rent crons. Now deletes agreements too (symmetric).
- **[High, completes H-8] `get_property_details` leaked revenue/lease terms under a single `property.view` gate** — now threads `access` and redacts money fields (finance) and lease terms (agreement) per role; new `askOlioContext.redaction.test.ts` proves a legal contact can't see revenue and a financial contact can't see lease terms.
- **[Medium regression] tenant dashboard showed rent as green "+income"** — the rent-sign flip is owner-relative; the dashboard preview rendered raw `tx.type`. Now both the dashboard and the Activity page use a shared `tenantActivityDisplayType` mapper (rent = the tenant's expense).
- **[Low] `/admin/portfolios` + users `rentedOut` counted pending invites as rented** — now active-only, matching the unified occupancy definition.

**Batch 7 — Mediums (FIXED + merged to `main`):**

- **M-1 / M-2 (whole-period charge) — FIXED (`5072305`, merged via `51d3308`).** Card checkout + rent reminder now charge the WHOLE billing period (rentAmount × `monthsPerPeriod(frequency)`), matching the cycle clock — quarterly/yearly leases no longer systematically under-collect. The matching offline-side gap (BL-9, below) was closed in batch 9 (`c480b65`): the offline `/log` path now rejects an amount short of the full period and the drawer prefills the whole-period figure (`486704b`), so card + offline + cycle clock now all agree.
- **M-13 (delete-blocker) — FIXED (`61f8b15`, merged via `51d3308`).** `findHardDeleteBlockers` now blocks on `pending_tenant` owner leases too, and queries the tenant side by `tenants.userId` (the old `agreements.tenantId == userId` never matched, so the tenant-side block was dead).

**Batches 1–6 — the full remaining Medium/Low/Info set (fixed + verified, tsc clean · 407/407 tests).** The independent items were parallelized across four file-disjoint "teams" (admin-server, config/rules, client-UX, docs/schema). Highlights:

- **M-9** owner payment-status now derived from the rent ledger; **L-15** move-out clears the due dates; agreement-create negative-deposit guard.
- **Indexation/agreement display:** L-14 (no phantom "Fixed 0%"; blank rate/delay → unset), L-6 (rate-less custom flagged not skipped), L-7 (re-seed on edit), L-8 (endDate clamp), L-3 (status-coloured pill), L-2 (admin "Active" filter by status), L-1 (admin reads exclude draft), L-4 (Athens-local sweep clock).
- **Admin/money:** L-9 (no double rent write), L-11 (Business plan label), L-12 (comp-grant uses the real subscription query), L-17 (audit-log composite indexes).
- **Disclosure:** L-25 (public config docs no longer leak admin UIDs — PUT/GET/cache), L-26/L-24 (rule comments corrected).
- **UX:** negative-deposit + email-format client validation, dead "Download Invoice" button removed, softened "notified" copy, fixed admin-invite copy, added missing tenant notification toggles.
- **Docs/schema:** test counts, deploy.yml/tsx/tsc/diagram/Firestore-surface corrections, .env drift, schema fields added/widened (endedAt, terminatedAt, nullable due-dates) + stale comments fixed, usePlan route comment.

**Deployed / merged to `main`:** the Critical + all 10 High fixes (commits `dec07c4`…`7bc60e7`) are live in production; M-2 (`5072305`) + M-13 (`61f8b15`) merged via `51d3308`; batches 1–6 (`cd0b59f`…`63be412`) are now all merged to `main` (no longer pending). Subsequent campaign work also landed on `main`: offline period prefill + bed/bath inputs (`486704b`, `33c8a3c`, recorded `d1d1e24`), notification taxonomy (`ccc3072`), and the final remediation wave — batch 9 casing/occupancy/bed-bath/offline-clamp (`c480b65`), batch 10 `isRealizedRent` + state-machine/privilege tests (`f52227d`), batch 11 send-time marketing opt-out + plan/commission coverage (`5d7017c`). A later CI/toolchain pass (`e80db69`…`8676277`) added ESLint+Prettier gates and deploy gating but no business-logic changes.

**Batch 8 — deferred user-visible features (now done, tsc clean · 407/407 tests):**

- **Offline-drawer period prefill** — `GET /api/tenant/units` now returns `paymentFrequency`; MakePaymentDrawer prefills + displays the whole-period amount for quarterly/yearly leases, matching the card charge (still editable; owner verifies).
- **Bedrooms/Bathrooms owner inputs** — added to Add/Edit Property drawers + accepted in the properties POST/PATCH allowlists, so the public page / briefing / AskOlio finally show them for owner-created properties.

**Batch 9 — notification taxonomy (signed off + done, tsc clean · 407/407 tests):** every per-persona toggle now gates ≥1 real send, with labels matching behavior.

- Tenant `maintenance` toggle was inert (no tenant maintenance push existed) → the admin ticket PATCH now pushes the ticket's tenant under `maintenance` on a real status change ("Maintenance request updated — now {status}"), scoped to property tickets.
- Owner `documents` toggle was inert (owners receive no document push) → removed from owner Settings; lease responses stay under `propertyActivity` (its desc reworded to "Lease responses, move-outs, and plan changes").
- `NotificationPrefs` schema comments re-annotated with each category's real recipient(s).

**Final remediation wave — Mediums + targeted Lows (FIXED + merged to `main`; `npm run check` clean · 418/418 vitest):** three file-disjoint commits closed out the remaining money/lifecycle Mediums and added the regression coverage the audit flagged as missing.

- **M-3 (`isRealizedRent`) — FIXED (`f52227d`).** The three divergent realized-rent status policies (admin `completed`-only, briefing `!== failed`, owner analytics/property no-filter) now route through one shared predicate `shared/realizedRent.ts` (tested), applied in `adminQueries.ts`, `briefing.ts`, `portfolio.ts`, `PortfolioAnalyticsPage.tsx`, `PropertyDetailsPage.tsx` — unverified offline pending no longer leaks into owner-facing financials. Same commit also added the previously-absent `/respond` lease-state-machine tests (`tenant.respond.test.ts`) and per-role privilege-engine tests (`platformPrivilege.test.ts`, `portfolioPrivilege.test.ts`) — closing the M-25 "state machine untested" coverage gap.
- **M-22 (send-time marketing opt-out) — FIXED (`5d7017c`).** `emailDispatchTick` now re-checks the recipient's marketing opt-out at drain time, so a user who unsubscribes after their row is queued is skipped (CAN-SPAM/GDPR/ePrivacy window closed). New `emailDispatchTick.test.ts`; same commit added real plan/commission coverage (`commission.test.ts`, `planReconcile.test.ts`) addressing L-27/L-28.
- **H-5b (email-casing auto-link) — FIXED (`c480b65`).** Already recorded above; the auto-link query and signup both lowercase now. **M-14 (re-link/backfill of pre-existing mismatches) — VERIFIED-MOOT:** a read-only production count on 2026-06-09 found **0 stuck tenants (0 `invited` tenancies)** — there are no pre-casing-fix mismatches to re-link, so no backfill/DB surgery is required. Tracked-open item closed as moot rather than implemented.
- **BL-9 (offline period clamp) — FIXED (`c480b65`).** The offline payment `/log` path now rejects (400) a logged amount short of the full billing period (rent × `monthsPerPeriod`), matching the card path — a short offline log can no longer full-advance the cycle on owner verify. Completes the M-1/M-2 charge-consistency story across card + offline + reminder + cycle clock.
- **AR-1 (occupancy unification) — FIXED (`c480b65`).** The last two `Unit.currentTenantId` occupancy fallbacks were dropped; occupancy now derives purely from active tenancies via `occupiedPropertyIds` (`properties.ts`, `portfolio.ts`), completing the phantom-unit cleanup begun in batches 1–6 (H-1/H-2/H-9/M-9…M-12).
- **Bed/bath validation (TY-8, completing L-33) — FIXED (`c480b65`, with the inputs added in `33c8a3c`).** Owner Add/Edit Property now collect bedrooms/bathrooms, the POST/PATCH allowlists accept them with server-side range validation (non-negative integer, cap 50) and preserve a real `0` (no longer dropped by `Number()||`). `Property.bedrooms`/`baths` are now actually written for owner properties, so the public page / briefing / AskOlio consumers stop reading `undefined`.

**Accepted / not changed (minor, by-design):** L-10 (reminder uses `monthlyRent` vs charged precedence — kept in sync by `applyRentChange`); L-16 (property delete retains the owner↔tenant conversation thread — intentional thread-outlives-tenancy design; only a stale snapshot field); I-3 fee-disclosure unclamped minimum (owner-favorable cosmetic). Recorded here rather than silently dropped.

---

## 0. Executive Summary

### Severity counts (after cross-team dedup)

| Severity     | Count |
| ------------ | ----- |
| **Critical** | 1     |
| **High**     | 10    |
| **Medium**   | ~22   |
| **Low**      | ~26   |
| **Info**     | ~11   |

### The headline: two root causes drive most of the High/Critical findings

The most important result is **convergence** — independent teams, given different mandates, repeatedly landed on the same two roots:

1. **The rent-sign inversion (1 root → Critical + High).** Collected rent is written to the ledger as `type:"expense"` by _both_ automated payment writers, while the manual UI and every reader assume `income`. Found independently by the **Main** and **SPECDRIFT** teams. It inverts every owner financial surface _and_ zeroes the entire admin platform-revenue/commission dashboard.

2. **The phantom `Unit.currentTenantId` (1 root → 4 High + 4 Medium).** Nothing in the codebase ever writes `Unit.currentTenantId`, and owner-created properties have **no `Unit` docs at all** — yet at least seven code paths still use units as the occupancy/rent source of truth. Found independently by **four teams** (Main, INTEGRITY, CONTRACT, SPECDRIFT). Its manifestations range from cosmetic (AI/dashboard show €0) to destructive (plan-downgrade and delete/transfer treat live leases as vacant and delete them).

### Top 6 systemic issues to fix first

1. **[Critical] Collected rent is booked as an expense** → owner net income, YTD, yield, the PDF briefing, _and_ the admin revenue dashboard are all wrong.
2. **[High] Phantom-unit occupancy** silently deletes actively-leased properties on plan downgrade and on owner delete/transfer.
3. **[High] Account deletion never cancels the Stripe subscription or detaches the Connect account** → continued billing + incomplete GDPR erasure.
4. **[High] The rent-indexation engine** can auto-apply an _unbounded_ increase, with _no prenotice_ in several reachable paths — financially and legally hazardous in Cyprus/EU.
5. **[High] Property transfer creates split-brain ownership** → rent + fees keep flowing to the old owner; the new owner sees nothing.
6. **[High] AskOlio ignores the per-role privilege matrix** → a financial contact can read leases, a legal contact can read the money ledger.

### Highest-leverage fixes (resolve the majority of High/Critical at once)

- **Fix the rent `type` sign** (both writers → `income`) + backfill → resolves C-1 and H-1/H-7.
- **Replace every `Unit.currentTenantId` occupancy/rent read with one shared active-tenancy helper** → resolves H-2, H-4, H-5, M-occupancy×3, M-audiences, the owner payment-status tile, and L-occupancy-denominator at once.
- **Add `authorizePortfolioRead` per AskOlio tool** → closes H-3.
- **Run `reconcileAfterPlanChange` on comp revoke/expiry** and **derive occupancy from tenancies in `planReconcile`** → closes H-6 + H-4.
- **Add Stripe cancel/detach to the user-delete cascade** → closes H-3 (integrity).

---

## 1. CRITICAL

### C-1. Collected rent is written as `type:"expense"`, inverting owner income everywhere — and zeroing the admin revenue dashboard

**Found by:** Main (C-1, H-1, H-7) + SPECDRIFT (H1) — _2 teams, independent._
**Files:** `server/services/rentTransaction.ts:118`, `server/routes/tenant.ts:504` (writers); `client/app/src/components/owner/RecordActivityDialog.tsx:53` (manual UI uses `income`); readers: `client/app/src/pages/owner/PortfolioAnalyticsPage.tsx:103-115`, `PropertyDetailsPage.tsx:146-151`, `OwnerDashboard.tsx:235,244`, `server/services/briefing.ts:834,851-866`, `server/routes/analytics.ts:102`, `server/routes/adminQueries.ts:672-690,1184-1198`.

- **Business rule:** `Transaction.type ∈ {income, expense, neutral}`. Rent an owner collects is **income**. The manual "Record Rent Payment" dialog encodes `type:'income'`; the briefing comment calls it "the income the portfolio actually produces."
- **What the code does:** Both automated writers hardcode `type:"expense", category:"rent"`. So the sign of the _same event_ depends on who recorded it (manual = income, automated = expense). No income-typed rent path exists in production.
- **Impact:** Every owner who collects rent through Olio sees inverted net income, €0 rental income on leased properties, distorted gross yield, and a shareable PDF that lists their rent roll as expenses. Manual+automated rent cancel toward zero. Separately, the admin "Platform revenue / Commission / Volume" charts and all per-property `totalCollected` filter `type==="income"` first, so they read **flat €0** even while commission is actively collected. Underlying Stripe money is correct — this is a deterministic financial _misstatement_. **The bug is masked by tests whose fixtures wrongly seed rent as `income`.**
- **Fix:** Change both writers to `type:"income"`; migrate existing `expense`-typed rent rows; add a regression test asserting card + offline + manual rent share the same type.

---

## 2. HIGH

### H-1. Phantom `Unit.currentTenantId` → plan-downgrade reconcile deletes actively-leased properties first

**Found by:** Main (H-4) + SPECDRIFT (H2) + INTEGRITY (corroborating root).
**Files:** `server/services/planReconcile.ts:255-269,292-319,96-137`; cf. correct pattern `server/routes/portfolio.ts:446-451`.

- **Rule:** On a unit-cap downgrade, delete excess properties **vacant-first**; occupancy derives from active tenancies (Rule 9).
- **Code:** `occupiedSet` is built solely from `Unit.currentTenantId`, which nothing ever writes, and owner-created properties have no `Unit` docs — so the set is always empty and _every_ property is classified vacant. `deletePropertyCascade` then hard-deletes the live `Tenant` + property with no agreement query and no tenant notification.
- **Impact:** On a real over-cap downgrade (e.g. Pro 20 → Growth 5), an owner's **live, paying leases are deleted first**, orphaning the agreement and the tenant (who can no longer view/pay rent). `occupiedDeleted` is always 0.
- **Fix:** Derive `occupiedSet` from active `Tenant`/`Agreement` rows by `propertyId`; route occupied deletions through `terminateOwnerAgreements`.

### H-2. Phantom `Unit.currentTenantId` → DELETE / TRANSFER property guard is dead; delete never cascades agreements

**Found by:** Main (H-5) + INTEGRITY (H1) — _2 teams._
**Files:** `server/routes/properties.ts:457-482,495-572,610-621`.

- **Rule:** Delete/transfer is "refused if any unit is occupied — owner must terminate the lease first so we don't orphan tenants" (the route's own comment).
- **Code:** `const occupied = unitSnap.docs.some(d => !!(d.data() as Unit).currentTenantId)` — empty doc set + never-written field ⇒ always `false`. The delete cascade then deletes Tenant + Document rows but **never queries `COL.agreements`** (despite its comment claiming it cleans agreement rows).
- **Impact:** An owner can hard-delete (or transfer) a property under an `active` lease. The tenancy is destroyed, the active Agreement is orphaned, the tenant's lease silently vanishes from their UI (`if (!property) return null`), and rent reminders silently stop firing.
- **Fix:** Gate both on `tenants where propertyId==id && status in (active,pending)` (and/or active agreements); add agreements to the cascade (delete or terminate), mirroring `userDelete.ts`.

### H-3. Account deletion never cancels the Stripe subscription or detaches the Connect account

**Found by:** INTEGRITY (H2).
**Files:** `server/services/userDelete.ts:19-48,81-92`; `server/routes/profile.ts:257-307`; `server/routes/adminUsers.ts:526-546`; `server/routes/connect.ts:207-225`.

- **Rule:** The UI promises deletion removes "every reference to you" and cites GDPR Art.17. Subscription lives in the Stripe extension's `customers/{uid}`; the Connect account is on the User doc.
- **Code:** Self-delete and admin hard-delete cascade 16 Firestore collections + storage but make **zero Stripe calls**. `findHardDeleteBlockers` never checks for an active subscription. The User doc (holding `connectAccountId`) is deleted with no Connect detach; even the manual disconnect only nulls the field locally.
- **Impact:** A paying subscriber can self-delete → the Stripe subscription **keeps billing** a now-deleted customer with no app record to cancel it; a live Connect Standard account is orphaned (can still take charges/hold payouts); GDPR erasure is incomplete (Stripe retains email/name/PM PII).
- **Fix:** Before removing the user doc, cancel the subscription / delete the Stripe customer and reject/delete the Connect account (or surface for manual offboarding); at minimum cancel the subscription.

### H-4. Property transfer flips only `Property.ownerId` → split-brain ownership; rent routes to the old owner

**Found by:** INTEGRITY (H3).
**Files:** `server/routes/properties.ts:655-684,610-616`; `server/routes/tenant.ts:68,808,872`; `server/routes/messages.ts:27-29`.

- **Rule:** Transfer should move the property _and its operational context_ so the new owner sees everything and the old owner loses access.
- **Code:** The only write is `update(ref, { ownerId: recipient.id })`. Because the occupancy gate (H-2) is dead, a tenanted property transfers freely, leaving Tenant/Agreement/Transactions/Conversation all pointing at the old owner. The direct Connect charge runs on `tenant.ownerId`'s account — the **old** owner.
- **Impact:** After a tenanted transfer: new owner sees 0 tenants / €0 / no lease / no chat and **cannot collect rent**; rent + platform fees keep flowing to the **old** owner's Connect account; the old owner retains _delete_ control of the property's documents (`documents.ts:287`).
- **Fix:** Either enforce vacant-only transfer (fix H-2) or atomically re-write `ownerId` across tenants/agreements/transactions/documents/conversations (and re-key the deterministic conversation id).

### H-5b. Invited tenant is permanently unlinked when signup email casing differs from the stored (lowercased) email — FIXED 2026-06-08

> Renamed from H-5 to disambiguate from the H-2/H-5 delete-guard cluster (above). This is the email-casing auto-link bug.
> **Found by:** INTEGRITY (H4).
> **Files:** `server/routes/portfolio.ts:521,709-715` (write lowercases); `server/auth.ts:50` (token email verbatim); `server/routes/profile.ts:40,67,71` (link runs once, in `if (!profile)`, `where("email","==",email)`); `client/app/src/pages/auth/Home.tsx:270-279` (signup only trims).

- **Rule:** `/api/me` auto-links a pending tenancy by email match the moment the real tenant signs up (`invited → pending`, binds `Tenant.userId`).
- **Code:** Write side lowercases the email; the link query uses the token email verbatim; Firestore `==` is case-sensitive; the link attempt runs **only once** (first sign-in). A tenant invited as `john@x.com` who signs up as `John@X.com` never links.
- **Impact:** Tenancy never binds, status never flips, `Tenant.userId` stays null forever; the tenant sees no lease and gets 403 on accept. No self-service recovery — needs DB surgery.
- **Fix:** Lowercase the token email before the query; lowercase at signup; add a re-link/backfill path.
- **FIXED 2026-06-08:** `profile.ts` auto-link query now compares `email.toLowerCase()` (matches the lowercased invite); `Home.tsx` signup now `trim().toLowerCase()`s the email before `createUserWithEmailAndPassword`. Re-link/backfill for pre-existing mismatches still open (tracked by M-14).

### H-6. Rent-indexation rate has no upper bound — the daily sweep auto-applies an arbitrarily large compound increase

**Found by:** CONTRACT (H1).
**Files:** `client/shared/components/owner/AddTenantDrawer.tsx:604-610`; `server/routes/portfolio.ts:518-519,551,725-726`; `functions/src/rentIndexation.ts:124,239,348-350`.

- **Rule:** A fixed/custom indexation applies a _sane_ % off current rent (schema: "2.5 → 2.5%").
- **Code:** Client captures the rate as free text with no range check; server stores any finite number; the sweep gates only on `rate > 0` and applies it with no clamp (`compoundRent` has no max).
- **Impact:** A typo (`50` meaning €50 into a % field) or a hostile direct POST silently stores an unbounded rate; the sweep then auto-bumps `monthlyRent`/`Tenant.rentAmount`/`Unit.rentAmount` (e.g. rate `9999` → €1,500 becomes ~€151k), which becomes the figure Stripe checkout reads. High not Critical because the tenant must still initiate checkout (amount visible).
- **Fix:** Enforce a shared bound (e.g. `0 < rate ≤ 25` or config-driven) on both client and server, plus a defensive clamp in `compoundRent`.

### H-7. Indexation `nextIncreaseDate` is frozen at creation (while `pending_tenant`) and never re-seeded on approval → an un-prenoticed increase

**Found by:** INTEGRITY (H5); related to Main M-3/M-4.
**Files:** `server/routes/portfolio.ts:781-784` (seed at creation instant); `server/routes/tenant.ts:965-977` (approve — no recompute); `functions/src/rentIndexation.ts:75-78,106-113`; `server/services/leaseDates.ts:36-49` (no-retroactive invariant).

- **Rule:** Notify-then-apply: a prenotice (~30 days) must precede a step; missed pre-feature steps must NOT be retroactively applied (the code's own invariant).
- **Code:** `nextIncreaseDate` is seeded at the creation instant while the lease is `pending_tenant` (invisible to the sweep, which only processes `active`). If the tenant takes longer than the prenotice window to approve, the date is already past at activation; the first sweep sees `daysUntil ≤ 0` and applies immediately — with no prenotice ever sent.
- **Impact:** A first-cycle surprise rent increase with no statutory advance notice (Cyprus/EU exposure).
- **Fix:** Recompute `nextIncreaseDate` in the approve branch (anchor at activation), or gate the apply phase on an existing prenotice log row.

### H-8. AskOlio enforces only the plan gate, never the per-role portfolio matrix (NEW dimension vs QA-01)

**Found by:** Main (H-3).
**Files:** `server/routes/ask.ts:49-52,96-100`; `server/services/askOlioContext.ts:233-261`; `server/services/ownerScope.ts:79-107`.

- **Rule:** Server must call `resolveOwnerScope()` THEN `authorizePortfolioRead(privilege)`. `ownerScope.ts` states verbatim that it does NOT enforce the matrix — "a financial contact must not read agreements, a legal contact must not read the money ledger."
- **Code:** `/api/ask` checks scope + **plan** only; the tool dispatcher does no privilege check before `list_agreements` / `list_transactions` / `get_tenant_details`; `resolveOwnerScope` reads `req.query.ownerId`.
- **Impact:** A **financial** contact can read every lease term; a **legal** contact can read the full money ledger; the deterministic snapshot hands a legal contact portfolio value + rent + occupancy on every call. Same _class_ as QA-01 but a distinct endpoint/mechanism — a new surface.
- **Fix:** After `resolveOwnerScope`, `authorizePortfolioRead` per exposed tool (`list_agreements→agreement.view`, `list_transactions→finance.viewHistory`); gate the snapshot aggregates.

### H-9. AskOlio AI snapshot reports €0 monthly rent / 0% occupancy for owner-created portfolios

**Found by:** Main (H-2). _(Phantom-unit family.)_
**Files:** `server/services/askOlioContext.ts:70-95,283-303`; `server/routes/ask.ts:100-104`.

- **Code:** Occupancy/monthly-rent computed from `units.filter(u => u.currentTenantId)` (never written); the loaded `tenants` array is ignored for rent/occupancy. Snapshot injected into every completion.
- **Impact:** The assistant confidently states "Monthly rent €0 / Occupancy 0%" for the common owner case while the dashboard (correctly tenancy-derived) shows the truth — in the same snapshot that prints correct active-tenant counts.
- **Fix:** Derive from active `Tenant` rows, mirroring `portfolio.ts:446-474`.

### H-10. Comp-plan revoke and expiry drop the owner to `basic` without running plan-downgrade reconciliation

**Found by:** Main (H-6).
**Files:** `server/routes/adminUsers.ts:873-948`; `functions/src/index.ts:109-167`; `server/routes/stripeWebhook.ts:413-459`; `server/services/planReconcile.ts:218-227`.

- **Rule:** A comp plan grants a tier by setting `stripeRole`; revoking/expiring is a downgrade to `basic`. The downgrade must enforce unit-cap and (when `rent.collectStripe` is lost) terminate active agreements.
- **Code:** `reconcileAfterPlanChange` is invoked from exactly one place — the Stripe `customer.subscription.updated` webhook. The comp-revoke route and `expireComplimentaryPlans` cron clear the claim but call **no** reconciliation.
- **Impact:** An owner comped onto Pro/Growth/Business who crosses `basic` limits is dropped to `basic` with over-cap properties surviving and Stripe rent still collected on a plan no longer permitted to — until some unrelated gate trips.
- **Fix:** Call `reconcileAfterPlanChange(uid, grant.plan, 'basic')` in both the comp-revoke route and the cron (when not preserved by an active paid sub).

---

## 3. MEDIUM

### Money / rent correctness

- **M-1. Quarterly/yearly leases are charged ONE month at checkout but `nextPaymentDate` advances a FULL period** (3/12 mo) → systematic under-collection (4 of 12 months on a quarterly lease). Charge + reminder agree with each other but disagree with the cycle clock. _(Main M-2)_ — `server/routes/tenant.ts:720-721`, `server/services/rentCycle.ts:37-48,89`, `functions/src/rentReminders.ts:180`. **FIXED (`5072305` + offline clamp `c480b65`):** card checkout + reminder now charge `rentAmount × monthsPerPeriod(frequency)` and the offline `/log` path rejects a short amount — charge/reminder/offline/cycle now all consistent. (Tracked as M-2/BL-9 above.)
- **M-2. AskOlio substitutes the lease TOTAL (`agreementValue`) for monthly rent** on legacy agreements (`monthlyRent ?? agreementValue`) → reports ~12× the real monthly rent. Every other reader falls back through `unit/tenant.rentAmount`. _(Main M-1)_ — `server/services/askOlioContext.ts:361,399`.
- **M-3. "Realized rent / net / YTD" uses three different status policies** across four readers of one ledger: admin = `completed` only; PDF briefing = `!== failed` (counts unverified pending); owner analytics + property page = **no status filter**. Unverified offline payments leak into owner-facing financials. _(Main M-9)_ — define one `isRealizedRent(tx)` helper. **FIXED (`f52227d`):** one shared `shared/realizedRent.ts` predicate (tested) now applied in `adminQueries.ts`, `briefing.ts`, `portfolio.ts`, `PortfolioAnalyticsPage.tsx`, `PropertyDetailsPage.tsx`.
- **M-4. Admin unit-edit PATCH writes `rentAmount` with no positivity guard** that owner-create/edit both enforce (`≤ 0 → 400`). A negative rent reaches Stripe; a zero rent silently blocks all collection while the lease stays active. _(CONTRACT M9)_ — `server/routes/adminUnits.ts:105,221-239`.
- **M-5. Admin unit edit writes `Unit.nextPaymentDate` directly**, bypassing the shared cycle writer → reminders fire on `Agreement.nextPaymentDate` (old) while the tenant dashboard shows `Unit.nextPaymentDate` (new); for owner properties the write silently no-ops. _(Main M-6)_ — route all `nextPaymentDate` edits through a shared writer.
- **M-6. No one-active-tenancy-per-unit guard** → a re-rent can produce two active tenancies; revenue sums both (un-deduped) while occupancy de-dupes by `unitId`, so headline revenue contradicts occupancy. _(INTEGRITY L3, sev=Medium)_ — `server/routes/portfolio.ts:460-467`.

### Indexation engine

- **M-7. Indexation APPLY phase has no prenotice guard**; a `delayMonths=0` (or blank-delay) lease bumps rent with no advance notice ("apply-then-notify"). _(Main M-3, M-4)_ — `functions/src/rentIndexation.ts:108-117,193-279`; blank delay sent as `0` from `AddTenantDrawer.tsx:187,218`.
- **M-8. Plan downgrade freezes the indexation clock without advancing it**; re-upgrade back-applies the suppressed steps un-prenoticed (effective a past date), violating the no-retroactive principle. _(Main M-5)_ — `functions/src/rentIndexation.ts:130-140`.

### Occupancy / KPI consistency (phantom-unit family)

- **M-9. Owner tenant-card "Status" tile reads `paymentStatus` from a Unit doc owner properties never have** → always shows lifecycle status ("Active") instead of paid/pending/overdue; the field is dead even for admin units. _(CONTRACT M3)_ — `server/routes/portfolio.ts:383,446-451`.
- **M-10. Admin dashboard occupancy counts pending invites + stale `Unit.currentTenantId`** → three definitions of "occupied" (admin = active|pending / `currentTenantId`; owner summary = active-only; PDF = active-only). Same property shows RENTED to admins, VACANT to the owner. _(Main M-7)_ — `server/routes/adminQueries.ts:447-468`.
- **M-11. Admin map markers + per-city/country `avgRental` derive from Unit docs only** → owner properties render "Vacant/€0" and are excluded from rent averages; MRR uses a third source (`Agreement.monthlyRent`). _(Main M-8)_ — `server/routes/adminQueries.ts:610-657,763-770`.
- **M-12. Marketing-audience "Properties rented" filter derives `rentedCount` from never-written `Unit.currentTenantId`** → a "rented ≥ 1" segment matches **zero** owners even when fully leased; the Portfolios table (active|pending) disagrees. _(Main M-10)_ — `server/services/audiences.ts:111-117,209-217`.

### Lifecycle / linking

- **M-13. Hard-delete blocker only counts `active` agreements (pending leases slip through), and the tenant-side blocker queries the wrong id field** (`tenantId == userId`, but `Agreement.tenantId` is the _tenancy doc id_) — so it's dead for all statuses, and a tenant can self-delete with a live lease. _(INTEGRITY M1)_ — `server/services/userDelete.ts:19-48`.
- **M-14. Pending-tenancy auto-link runs only in the profile-CREATE branch** → admin-pre-provisioned (and any pre-existing) users never bind to their invited tenancy; locked out of their lease forever with no auto-recovery. _(INTEGRITY M2)_ — `server/routes/profile.ts:40-89`. **VERIFIED-MOOT (2026-06-09):** the casing fix (H-5b, `c480b65`) covers new signups; M-14 was the residual re-link/backfill of pre-existing mismatches. A read-only production count on 2026-06-09 returned **0 stuck tenants (0 `invited` tenancies)** — there is nothing to re-link, so no backfill/DB surgery is needed. Closed as moot, not via code change.
- **M-15. Admin-invited users stay `status:"invited"` with empty Last-login forever** (no handler performs the "until they sign in" transition) → distorts the admin list **and** silently excludes active users from every marketing/status audience (`audiences.ts` hard-filters `status==="active"`). _(INTEGRITY M3)_ — `server/routes/profile.ts:91-112`, `server/services/audiences.ts:191`.

### Frontend↔backend contract

- **M-16. Owner-selected auto-renewal period (3–36 mo) collapses to a bare `'fixed'` enum and is never persisted** (no `autoRenewalMonths` field exists) → the binding lease/PDF shows "Fixed-term renewal" with no term. _(CONTRACT M4)_ — `AddTenantDrawer.tsx:192-195`, `portfolio.ts:569-574`.
- **M-17. The lease document states "Renews automatically," but no scheduled job ever renews/extends/expires a lease** — `autoRenewal` is write-only. _(CONTRACT M7)_ — `AgreementDocument.tsx:69-73`, `functions/src/index.ts`.
- **M-18. Owner-entered asking rent (`rentPrice`) is persisted but read by no display path** → vacant owner rentals show €0/mo and yield-from-zero across card/dashboard/analytics/detail. _(CONTRACT M5)_ — `properties.ts:193,248`, `portfolio.ts:116-117`.
- **M-19. Create-agreement skips the date-ordering / duration-sign guards that EDIT enforces** → a direct POST with `rentalDurationMonths: -6` persists `endDate` before `startDate`. _(CONTRACT M8)_ — `server/routes/portfolio.ts:518-519,588-598` vs `:939-947`.
- **M-20. Card rent payment never invalidates `/api/tenant/units`** → "Next Rent Due" stays stale all session despite a "Payment confirmed" banner (`staleTime: Infinity`). _(CONTRACT M2)_ — `MakePaymentDrawer.tsx:105`, `TenantDashboard.tsx`.
- **M-21. AddTenantDrawer always shows the wrong success toast** — the "link copied" branch is dead (server hardcodes `inviteLink:null`), so the "tenant already has an account" message fires even for brand-new emails. _(CONTRACT M6 + Main L-13)_ — `AddTenantDrawer.tsx:226-238`.

### Notifications / compliance

- **M-22. Marketing opt-out is not re-checked at send time on the `/send` drain path** → a user who unsubscribes after their row is queued still receives the campaign (CAN-SPAM/GDPR/ePrivacy window). _(Main M-11)_ — `server/jobs/emailDispatchTick.ts:164-258`. **FIXED (`5d7017c`):** `emailDispatchTick` now re-checks the recipient's opt-out at drain time and skips unsubscribed rows; covered by `emailDispatchTick.test.ts`.

### Storage / access

- **M-23. Owner document downloads use permanent `firebaseStorageDownloadTokens` capability URLs, not the documented expiring signed URLs** — bypasses `storage.rules` entirely, never expires, revocable only by token rotation/deletion. The module calls itself a "signed-URL gateway"; `briefing.ts` uses real v4 `getSignedUrl` (24h), so the team knows the difference. _(RULES, Medium)_ — `server/routes/documents.ts:171-189`.

### Tests / docs (regression & operational hazards)

- **M-24. The rent-indexation apply path (compounding, idempotency, plan gate, CPI no-bump, `appliedSteps`) has ZERO behavioral tests**, and `compoundRent` isn't even exported. The app's most consequential money mutation ships unguarded against regression. _(SPECDRIFT M3)_ — `functions/src/rentIndexation.ts`.
- **M-25. The `/respond` lease state machine is untested** (the only reference is a "surface check, not a behavior check"), and the documented "active requires `paymentMethodId`" invariant **does not exist** (the field is written by nothing; the whole `PaymentMethod` entity is dead and `userDelete.ts:126` queries it by the wrong field). _(SPECDRIFT M4 + Main I-1)_ — `server/routes/tenant.ts:908-1006`. **PARTIALLY FIXED (`f52227d`):** the `/respond` state machine now has behavioral coverage (`tenant.respond.test.ts`). The dead `PaymentMethod`/`paymentMethodId` drift (I-1) is still OPEN — recorded but not code-changed.
- **M-26. `QA_REPORT.md` marks QA-03 "Held — not shipped" with a `git stash apply stash@{0}` recovery pointer, but QA-03 shipped in commit `7b7bf49` and `stash@{0}` is unrelated email-marketing WIP** — following the doc pollutes the tree. _(SPECDRIFT M5)_.

---

## 4. LOW (grouped)

**Agreement / status reads**

- **L-1. Admin agreement reads (list + activity feed + dashboard stats) omit the `status !== "draft"` filter** that owner/tenant reads apply — Rule 3 defense-in-depth gap. _(Main L-6 + INTEGRITY L4)_ — `server/routes/adminQueries.ts:333,1474,1500,1949`.
- **L-2. Admin agreements "Active" filter is status-blind** (keys on end date only) → pending/declined/terminated leases with a future end date appear "Active". _(Main L-7)_.
- **L-3. On-screen `AgreementDocument` status pill is hardcoded emerald** for all statuses (the PDF colours it correctly) → a Declined/Pending lease looks active in the drawer. _(Main L-10)_.

**Indexation cosmetics / edge cases**

- **L-4. Indexation cron fires 02:00 Athens but computes "today" in UTC** → during DST a step effective "today" applies one day late. _(Main L-2)_ — `functions/src/rentIndexation.ts:57-72`.
- **L-5. Default-path leases render a phantom "Fixed 0% · Yearly" clause + "Next Increase" date the sweep permanently ignores** (blank rate → `0`, `cpiType` defaults "fixed"). Affects _almost every_ owner-created lease. _(Main L-14)_.
- **L-6. Rate-less `custom` indexation is silently skipped forever** (only `cpi` reaches the owner-flag path), contradicting the file header. _(Main L-15)_.
- **L-7. Owner lease-edit doesn't re-seed `indexation.nextIncreaseDate`** when `startDate` changes (for leases with no signature date). _(Main L-3)_.

**Rent-source drift**

- **L-8. Lease `endDate` is computed with naive `setUTCMonth` instead of the clamped `advanceMonths` helper** → month-end starts show an `endDate` up to ~3 days late (display-only). _(Main L-1)_.
- **L-9. Admin unit PATCH writes `Unit.rentAmount` twice** (direct + `applyRentChange`) — non-atomic if the best-effort sync throws on an occupied unit. _(Main L-4)_.
- **L-10. Rent reminder reads `Agreement.monthlyRent` while checkout charges `unit?.rentAmount ?? tenant.rentAmount`** — diverges only on a logged transient admin-unit sync failure. _(Main L-5)_.
- **L-11. PropertyDetailsPage header rent/yield is Agreement-first; the Properties list is Tenant-first** → two screens show different rent for one property when figures drift. _(CONTRACT L10)_.

**Plans / admin display**

- **L-12. Admin user-table `planLabel()` maps a `business` role to "Free"** while the dashboard counts it as paid → the two admin surfaces can't be reconciled. _(Main L-8)_.
- **L-13. Comp-plan grant guard and revoke/expire use two different definitions of "has a paid subscription"** (grant infers from the claim; revoke queries `customers/{uid}/subscriptions`). _(Main L-9)_.
- **L-14. Owner occupancy % differs between dashboard/analytics (unit denominator) and the PDF briefing (property denominator)** for mixed portfolios. _(Main L-12)_.

**Lifecycle cleanup**

- **L-15. End-tenancy never clears `Tenant.nextPayment` / `Agreement.nextPaymentDate`** → the owner briefing PDF renders a phantom "next payment" beside an "expired/terminated" badge. _(INTEGRITY L2)_.
- **L-16. Property delete leaves conversation docs with a stale `propertyId` and undeleted messages** (user-delete drains them; property-delete doesn't). _(INTEGRITY L1)_.
- **L-17. Audit-log `actorUid`/`targetUid` filters would throw `FAILED_PRECONDITION` (missing composite index)** on first use; the QA-03 coverage script omits both audit collections. _(INTEGRITY L5)_.

**Contract / UX**

- **L-18. Owner agreement CREATE accepts a negative security deposit** (EDIT rejects it; client input has no `min`) → a nonsensical figure persists into the lease/PDF. _(CONTRACT L11)_.
- **L-19. AdminTransactionsPage per-row "Download Invoice" button is inert (no `onClick`)** while labelled as a working action. _(CONTRACT L12)_.
- **L-20. Maintenance-ticket and end-tenancy UIs assert "landlord/tenant has been notified" as fact**, but the push is conditional, preference-gated, best-effort, and has no email fallback. _(CONTRACT L13)_.
- **L-21. Admin invite UI is self-contradictory** — the entry dialog says an email is auto-sent; the success modal/button frame manual link delivery as the only channel. _(CONTRACT L14)_.

**Notifications**

- **L-22. Notification toggles vs server sends — four mismatches:** tenants get `propertyActivity`/`rentPayments` pushes with no toggle; the tenant "Maintenance" toggle and owner "Documents" toggle are inert (those categories only target the other persona). _(Main L-17)_.
- **L-23. `Transaction.verifiedBy` and `status:"failed"` are never populated by any runtime path** despite the schema advertising both. _(Main L-16)_.

**Rules / disclosure**

- **L-24. `config/privileges` streams the full _admin_ role matrix to every signed-in tenant** (the tenant app never gates on it) — least-exposure gap, not escalation. _(RULES)_.
- **L-25. World-readable config docs (`compliance`/`social`/`system`/`planLabels`) leak admin/superadmin UIDs via `updatedBy`/`startedBy`** to anonymous visitors. _(RULES)_.
- **L-26. `config/banners` rule comment says "Admin-only read" but the rule grants read to every signed-in user.** _(RULES)_.

**Tests / docs**

- **L-27. `planReconcile.test.ts` re-implements the delete-ordering instead of importing it** → zero regression coverage of the shipped comparator. _(SPECDRIFT L6)_. **FIXED (`5d7017c`):** `planReconcile.test.ts` now exercises the real comparator.
- **L-28. `resolveOwnerPlan`'s claim-validation / default-to-basic fallbacks have no test coverage** (every commission test pins the claim to `pro`). _(SPECDRIFT L7)_. **FIXED (`5d7017c`):** `commission.test.ts` now covers the claim-validation / default-to-basic fallbacks.
- **L-29. README/SECURITY.md claim `deploy.yml` re-runs typecheck+test on push to main; it actually runs only builds, chained off CI success via `workflow_run`.** _(SPECDRIFT L8)_.
- **L-30. Test-count figures are stale and mutually inconsistent** (README 190/19, SECURITY 232/19, QA*REPORT 318/30 vs actual 377/37); the SECURITY "keep in sync" list omits many security tests. *(SPECDRIFT L9)\_.
- **L-31. README inverts the runtime story** (tsx is local-dev; production Functions run tsc-compiled JS). _(SPECDRIFT L10)_.
- **L-32. `PortfolioAccessContact.inviteLink` and `revoked` status are declared/documented but never written** (the route now 404s unknown emails; DELETE hard-removes). _(INTEGRITY I1 + SPECDRIFT L12)_.
- **L-33. `Property.bedrooms`/`baths` are read by 3 owner-facing consumers but never collected by any owner form or written by POST/PATCH** → always undefined for owner properties. _(CONTRACT I + SPECDRIFT L13)_. **FIXED (`33c8a3c` + range validation `c480b65`):** owner Add/Edit Property collect both; POST/PATCH allowlists accept them with non-negative-integer range validation (cap 50) and preserve a real `0`.
- **L-34. Tenant-invite email format is validated only server-side** (the drawer stage-gate checks non-emptiness) → malformed addresses pass all 6 steps before a round-trip 400. _(CONTRACT I)_.
- **L-35. Owner fee disclosure is hidden during the Connect charges-enabled/payouts-pending window** (`BankingSection` gates on `kind==="active"` = both, while checkout goes live on charges alone). _(Main, Low)_.

---

## 5. INFO (drift / dead code / hygiene)

- **I-1.** `paymentMethodId` documented as an "active-agreement precondition" is vestigial — implemented nowhere. _(Main I-1 — see M-25)_.
- **I-2.** `usePlan.ts` comment references a non-existent route `/api/admin/users/:id/complimentary-plan` (actual: `…/comp-plan`). _(Main I-2)_.
- **I-3.** Owner fee disclosure shows the un-clamped tier minimum; under an absurd flat-minimum misconfig it can exceed the per-charge cap (owner-favorable, cosmetic). _(Main I-3)_.
- **I-4.** `User.entityType` is write-only dead data; its schema comment falsely claims a Stripe-Connect `business_type` consumer that doesn't exist. _(CONTRACT I)_.
- **I-5.** `endedAt` (Tenant) and `terminatedAt` (Agreement) are written but absent from the schema interfaces and read by nothing. _(SPECDRIFT)_.
- **I-6.** `DocumentRecord.tenantId` is written as `null` on tenancy-end but typed `string | undefined`. _(SPECDRIFT)_.
- **I-7.** README architecture diagram omits the `rentIndexationSweep` scheduled function (the one that auto-mutates charged rent); no `.md` mentions indexation. _(SPECDRIFT)_.
- **I-8.** README understates the client-readable Firestore surface (names only `customers/*`; rules expose ~a dozen public/signed-in read paths). _(SPECDRIFT + RULES)_.
- **I-9.** Env-var drift: `VITE_FIREBASE_MEASUREMENT_ID` documented but unread; `FIREBASE_STORAGE_BUCKET` read but undocumented. _(SPECDRIFT)_.
- **I-10.** SECURITY.md/CONTRIBUTING.md pin the audience test to `server/services/audience.test.ts`; it actually lives in the client, and the server file is the differently-purposed `audiences.test.ts`. _(SPECDRIFT)_.
- **I-11.** `checkSortFieldCoverage` counts empty-string/null as "missing" (broader than Firestore `orderBy` excludes) — errs conservative. _(INTEGRITY I2)_.

### Positive confirmations (no defect)

- **The core Firestore trust boundary is sound** — every ledger/PII collection (transactions, agreements, complimentaryPlans, userAudit, impersonations, paymentMethods, users, properties, tenants, documents, …) falls to the deny-by-default catch-all; the only client write path is the allowed Stripe `customers/{uid}/checkout_sessions`. _(RULES)_.
- **The rent-cycle idempotency, commission cents-clamp, and indexation compounding logic are correct as written today** — the risk on those is regression (no tests), not a live bug. _(SPECDRIFT)_.

---

## 6. Appendix — Cross-cutting fixes (highest leverage)

| Fix                                                                                                       | Resolves                                                                             |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Rent `type` → `income`** in both writers + backfill                                                     | C-1, H-1/H-7 (admin revenue), M-3 sub-narrative                                      |
| **One shared active-tenancy occupancy/rent helper**, replacing every `Unit.currentTenantId` read          | H-1, H-2, H-9, M-9, M-10, M-11, M-12, L-14                                           |
| **`authorizePortfolioRead` per AskOlio tool**                                                             | H-8                                                                                  |
| **`reconcileAfterPlanChange` on comp revoke/expiry**                                                      | H-10                                                                                 |
| **Stripe cancel + Connect detach in user-delete cascade**                                                 | H-3                                                                                  |
| **Atomic `ownerId` rewrite (or vacant-only) on transfer**                                                 | H-4                                                                                  |
| **Lowercase token email in auto-link + re-link backfill**                                                 | H-5b FIXED; M-14 re-link backfill VERIFIED-MOOT (0 stuck tenants in prod 2026-06-09) |
| **Bound + clamp indexation rate; require prenotice before apply; re-seed `nextIncreaseDate` on approval** | H-6, H-7, M-7, M-8                                                                   |
| **`monthsPerPeriod`-aware charge path**                                                                   | M-1 / M-2 FIXED (+ offline clamp BL-9)                                               |
| **One `isRealizedRent(tx)` predicate**                                                                    | M-3 FIXED                                                                            |
| **Athens-local "today" in the indexation sweep**                                                          | L-4                                                                                  |

---

## 7. Appendix — Per-team raw results

| Team       | Axis                                            | Agents | Raw → Confirmed |
| ---------- | ----------------------------------------------- | ------ | --------------- |
| Main audit | 9 domains + money/date + status/denorm sweeps   | 80     | 67 → 58         |
| CONTRACT   | frontend↔backend fidelity                       | 24     | 19 → 18         |
| INTEGRITY  | delete/transfer/linking/migration lifecycle     | 25     | 20 → 17         |
| RULES      | Firestore/Storage rules vs server vs client SDK | 15     | 11 → 7          |
| SPECDRIFT  | tests/docs/schema vs code                       | 25     | 21 → 20         |

Each finding above survived an independent adversarial verifier that re-read the source and was prompted to refute it; items already covered by `QA_REPORT.md` were filtered out.
