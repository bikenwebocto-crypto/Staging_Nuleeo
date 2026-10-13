# Messaging QA — Owner ↔ Tenant Direct Messages

> Extreme QA of the entire messaging feature (2026-06-16). Multi-agent review across 6 lenses
> (backend correctness, concurrency/races, security/authz, client state/UX, edge cases/data
> integrity, integration/consistency), with every finding adversarially verified by an independent
> reviewer. 48 raw findings → **39 confirmed, 9 refuted**. Baseline: `messages.test.ts` **13/13 green**,
> `npm run check` **clean**.
>
> Scope files: `server/routes/messages.ts`, `server/routes/messages.test.ts`,
> `client/app/src/pages/common/MessagesPage.tsx`, `firestore.rules`, `server/services/userDelete.ts`,
> `server/services/push.ts`, `server/services/rateLimit.ts`,
> `client/shared/components/owner/OwnerAgreementDrawer.tsx`, `client/app/src/lib/menuItems.ts`.

## 0. Resolution status (2026-06-16)

**All actionable findings fixed and verified.** A second adversarial workflow reviewed the
fixes (caught 1 HIGH regression + correctness/test gaps, all since fixed). Gates: `npm run check`
clean · full suite **801 passed** · message suites **46/46** (13 original + 33 new endpoint tests).

| Finding                                | Status                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| M-1 create()-not-set anti-clobber      | ✅ fixed + race-branch test                                                                                                                 |
| M-2 propertyId guard (400 not 500)     | ✅ fixed + test                                                                                                                             |
| M-3 mark-read watermark (txn)          | ✅ fixed + test (residual ms-boundary documented)                                                                                           |
| M-4 send txn conditional lastMessage\* | ✅ fixed + out-of-order test                                                                                                                |
| M-5 global unread badge                | ✅ fixed (bottom nav + sidebar, owner **and** tenant mobile)                                                                                |
| M-6 conversation-id validation         | ✅ fixed + malformed-id tests                                                                                                               |
| M-7 push `?c=` deep-link               | ✅ fixed + test                                                                                                                             |
| M-8 agreement Message-button gate      | ✅ fixed (server payload + client gate)                                                                                                     |
| L-1 compound message cursor            | ✅ fixed + same-ms pagination test                                                                                                          |
| L-3 rate-limit after validation        | ✅ fixed + quota-not-metered tests                                                                                                          |
| L-6 atomic conversation cleanup        | ✅ fixed (unit test deferred — needs a heavy storage/cascade harness)                                                                       |
| L-8…L-14 client/UX + title fallback    | ✅ fixed                                                                                                                                    |
| **Verification round**                 | optimistic watermark excludes echoes · optimistic reconcile append-if-missing · auto-select reads breakpoint synchronously (regression fix) |

**Deliberately not changed** (rationale in §2/§6): L-2 (back-scroll UI — feature; cursor now ready),
L-4 (global `requireAuth` status — product decision), L-5 (email name-fallback — intentional, tested),
L-7 (tenancyId/propertyId drift — latent/advisory). All INFO items are verified non-defects.

Nothing committed/pushed — all changes in the working tree.

---

## 1. Verdict

Messaging works correctly for the normal path, but it has real (if narrow-window) data-integrity
races and a meaningful set of UX/discoverability gaps — and **five of its six endpoints have no
functional test coverage.** Sending, receiving, the deterministic-id thread model, the
participant-only authorization gate, XSS-safe rendering, and OneSignal push fan-out are all
implemented correctly, and the one tested endpoint (the conversation list/materializer) is
thoroughly covered. The defects that exist are genuine but bounded: the two manual-start endpoints
regressed the codebase's own "use `create()`, never `set()`" anti-clobber contract; mark-read
absolute-zeros a counter that `send` increments (a lost-update race); and there is **no global
unread badge anywhere**, so a recipient with push off only learns of a message by opening Messages.
None of these destroy a stored message — the `messages` subcollection is always intact — but they
can transiently wipe an unread badge or a last-message preview. The riskiest reality is the **test
gap**: `start`, `start-with-landlord`, `send`, list-messages, and `read` have zero behavior tests.

## 2. Confirmed issues

> Consolidated where multiple lenses reported the same root cause.

### MEDIUM

**M-1 — `start` / `start-with-landlord` do read-then-`set()` (TOCTOU); a concurrent send/materialize is clobbered back to empty**
`server/routes/messages.ts:222-241` (start-with-landlord), `:273-292` (start).
Both do `get()` → `if exists return` → bare `.set()` seeding empty `lastMessage*`/`unread*`. If, in
the gap, the counterpart's poll materializer (`.create()`, `:126`) or a `send` (`merge`, `:375`)
populates the doc, the `set()` overwrites it back to empty — wiping preview and zeroing a
just-incremented unread badge. Violates the contract documented at `:59-62`/`:119-123` and pinned by
`messages.test.ts:349`.
**Fix:** mirror the materializer — `try { await ref.create(conversation) } catch (e) { if (e.code === 6) return res.json((await ref.get()).data()); throw e }`. Apply to both.

**M-2 — `start` / `start-with-landlord` write `propertyId: undefined` for legacy tenancies → opaque 500**
`server/routes/messages.ts:233`, `:284`.
Admin SDK rejects `undefined` writes (no `ignoreUndefinedProperties`). The materializer guards this
(`:99-102`, tested at `messages.test.ts:454`); the two start endpoints don't → `set()` throws →
generic 500. Same malformed tenancy the list skips gracefully hard-fails the explicit Chat button.
**Fix:** guard `if (!tenancy.propertyId) return 400`.

**M-3 — Mark-read absolute-zeros the unread counter (lost-update race)**
`server/routes/messages.ts:425-427` vs `:385-387`.
Read does `set({ unreadByX: 0 }, { merge:true })` — absolute write — while send does
`FieldValue.increment(1)`; neither in a transaction. If `increment(1)` commits then `set(0)` lands,
the increment is wiped, and there is no `lastReadAt` to recover from, so the missed message stays
un-badged until the next inbound message. **Message doc is never lost — only the badge.**
**Fix:** `runTransaction` that only zeros if no newer message exists, or store `lastReadAt` and
derive unread from message count after it.

**M-4 — `send` is a batch (not a transaction); `lastMessage*` is last-writer-wins**
`server/routes/messages.ts:359, 375-390`.
`now` is stamped as plain scalars onto `lastMessageText/At/SenderId` (only the counter uses
`increment`). Firestore serializes writes to the doc but not by `now` order; the later-committing
batch may carry the chronologically earlier message → list preview (`MessagesPage.tsx:243`) and
recency sort (`:185`) show a stale message as latest. **Self-heals on next send; no message lost.**
**Fix:** conditionally advance `lastMessage*` only when new `createdAt >= stored lastMessageAt`.

**M-5 — No global unread badge anywhere — unread is invisible until the user opens Messages**
`client/app/src/lib/menuItems.ts:29,42`; `BottomNav.tsx`; `DesktopSidebar.tsx`.
`unread` is consumed **only** inside `MessagesPage.tsx` (per-row pill `:231-233`). No nav/header/layout
component queries `/api/messages/conversations`; the header bell (`NotificationsButton.tsx:119`) sums
agreements/invitations/payments but not messages. With push off there is zero in-app signal a
message arrived.
**Fix:** add optional `badgeCount` to `BottomNavItem`/`SidebarMenuItem`, drive from a shared hook
summing `unread` from the cached conversations query, render on the Messages nav item.

**M-6 — Conversation `:id` path param is fed unvalidated into Firestore `doc()`**
`server/routes/messages.ts:37, 313, 360, 425`.
No IDOR today (participant gate fails closed), but an odd-segment id makes `doc()` throw
**synchronously outside the awaited try block** (try starts at `:310/358/424`); with no global error
middleware that is an unhandled rejection / hung request rather than a clean 400.
**Fix:** validate at the top of `loadConversationForCaller` + each handler, e.g.
`if (!/^[A-Za-z0-9_-]{1,256}$/.test(id) || id.split("_").length !== 2) return 400`.

**M-7 — Push deep-link drops the conversation id — recipient lands on inbox/wrong thread**
`server/routes/messages.ts:402`.
Push URL is `${appBase}/tenant/messages` (or `/owner/messages`) with no `?c=<id>`, unlike all three
in-app Chat buttons. A multi-conversation recipient can land on the wrong thread before the 15s poll,
or on the bare list on mobile.
**Fix:** append `?c=${encodeURIComponent(req.params.id)}` to the push URL.

**M-8 — `OwnerAgreementsPage` "Message tenant" button is not gated on tenant sign-up**
`client/shared/components/owner/OwnerAgreementDrawer.tsx:269-274`.
`TenantsPage:357` and `TenantDetailsDrawer:167` both `disabled={!tenant.userId}`; the agreement-drawer
button has neither (the `OwnerAgreement` payload carries no `userId`). Unaccepted-invite tenant → owner
clicks an enabled button → destructive error toast instead of a disabled affordance. Graceful but
inconsistent.
**Fix:** add `tenantUserId`/`tenantSignedUp` to the `OwnerAgreement` payload and gate the button.

### LOW

- **L-1 — Pagination cursor uses bare `createdAt` ISO, no tiebreaker** (`messages.ts:311-321`). Same-ms messages at a page boundary skipped/duplicated. Latent (no client passes `?before=`). Fix before wiring back-scroll: compound `(createdAt, documentId)` cursor.
- **L-2 — `?before` cursor + 200-message ceiling entirely unexercised** (`messages.ts:300-326`). Threads >200 messages truncate older history with no "load older" control. Wire it (after L-1) or document the ceiling.
- **L-3 — Rate limiter increments before validation/authorization** (`messages.ts:339`). Empty/oversized/403 sends + commit failures still burn the 200/hr quota. Self-DoS only. Fix: meter after validate+authorize, or only post-commit.
- **L-4 — `requireAuth` blocks only `suspended`** (`auth.ts:39-41`). `invited`/`pending` accounts with a valid token can read/send. Onboarding-state bypass only (caller must already be a bound participant). Decide whether messaging needs `status==="active"`.
- **L-5 — Deleted/forbidden counterpart PII (email) leaks indefinitely via the list** (`messages.ts:160-164`). `counterpartName` falls back to live email; permanent threads surface it forever. Marginal. Fix: name-only fallback ("Former tenant") and/or snapshot display name at creation.
- **L-6 — `deleteUserCascade` drains messages then deletes the conversation in separate non-atomic steps** (`userDelete.ts:332-378`). Transient drain failure orphans the `messages` subcollection (server-enumerable PII; GDPR Art. 17 completeness gap). Fix: delete parents only after confirming drain, or use `recursiveDelete`.
- **L-7 — Conversation `tenancyId`/`propertyId` drift** (`messages.ts:90-117`). Stamped once from "most recent active", never reconciled. No reader/authZ uses these fields today — latent. Document as advisory; don't build lease-linking on them.
- **L-8 — Mark-read effect re-POSTs on every 15s poll while a live thread is open** (`MessagesPage.tsx:133-139`). Extra `/read` + refetch per inbound-while-open, can flicker badge 0↔N; ~15s lag before open thread's unread zeroes. Fix: optimistically zero the active row and/or suppress badge for `c.id === activeId`.
- **L-9 — Client send is non-optimistic; flaky-network feedback gap** (`MessagesPage.tsx:141-159`). No optimistic echo; `retry:false` means a failed post-send refetch leaves the message un-rendered until the next 5s poll → invites duplicate re-sends. Fix: optimistic `setQueryData` append reconciled by server id.
- **L-10 — 429 shown as raw `"429: {json}"`, Retry-After ignored** (`MessagesPage.tsx:153-156`). Uses `err.message` instead of `parseApiError` (used in 22 other files), so the friendly "Slow down…" copy is buried and there's no cooldown. Fix: `parseApiError(err)` + branch on 429 to surface `retryAfterSeconds` and disable Send.
- **L-11 — Enter-to-send has no `sending` guard** (`MessagesPage.tsx:363-368`). Button is disabled while sending but the keyboard path isn't; draft not cleared until POST resolves → Enter-mashing on a slow link double/triple-sends. Fix: `if (sending) return` in `handleSend`.
- **L-12 — Re-opening a recently-viewed thread shows stale cached messages** (`MessagesPage.tsx:116-122`). Per-thread key + `staleTime:Infinity` ⇒ no refetch-on-remount, no spinner, newest messages briefly absent ~5s. Fix: `staleTime:0` on the messages query or invalidate on selection.
- **L-13 — Desktop auto-select is a one-shot `matchMedia` read** (`MessagesPage.tsx:93-98`). A desktop window loaded narrow then widened never auto-selects. Fix: subscribe to a `matchMedia` change listener or gate master/detail purely on CSS.
- **L-14 — Tenant→owner push title has no email fallback** (`messages.ts:395-398`). Title is name-only with a hardcoded "New message" fallback, while the list falls back name→email→Unknown. Fix: reuse `name || profile.email || "New message"`.

### INFO (verified non-defects, kept for completeness)

- Send timestamps have no monotonic tiebreaker (same-ms collisions order arbitrarily) — `messages.ts:359-391`. No data loss.
- List sort comparator lacks a final tiebreaker for identical names/timestamps (`:177-186`) — Firestore implicit `__name__` order keeps steady-state stable; near-nil impact.
- A `getAll`/name-hydration failure 500s the whole inbox (`:148-191`) — shares failure mode with the required reads above it.
- **Message text is XSS-safe** — stored raw/trimmed, rendered as a React text node (`MessagesPage.tsx:344`), no `dangerouslySetInnerHTML`; list preview (`:243`) likewise auto-escaped.
- **a11y (info):** unread badge (`:231-235`) is a bare `<span>` with no `aria-label`/`aria-live`; screen readers announce only "3" and new messages aren't announced. Rows are proper `<button>`s. Minor polish.

## 3. Test & type health

- **Tests:** `npx vitest run server/routes/messages.test.ts` → 1 file, **13/13 passed, 0 failed** (~635ms). All under one describe block covering **only** `GET /api/messages/conversations` materialization.
- **Typecheck:** full `npm run check` (server `tsc` + `tsc --noEmit` for landing/app/platform) → exit 0, zero errors, none touching messaging code.

## 4. Coverage gaps

**Five of six endpoints have zero functional tests.** `server/routes.integration.test.ts` is a
registration _surface_ check only (asserts `(method,path)` tuples + 401-without-auth).

Untested behavior, riskiest first:

1. **`POST /conversations/:id/messages` (send)** — which unread side increments, push category/deep-link/url, 4000-char cap, empty-text 400, 429 + Retry-After, batch atomicity. The core write path is assumption-only.
2. **Participant authorization (`loadConversationForCaller` 403/404)** — the entire IDOR boundary for send/read/list-messages. A future `||`→`&&` flip would ship green.
3. **`POST /start` / `POST /start-with-landlord`** — owner-only 403, idempotent fetch-existing, not-signed-up 400, most-recent-active resolution, M-1 clobber race / M-2 propertyId-500.
4. **`GET /conversations/:id/messages`** — pagination, `before` cursor, desc→asc reversal, limit clamp.
5. **`POST /read`** — zeros only the caller's side; the M-3 mark-read-vs-send race.

**Harness blocker:** the in-memory Firestore double (`messages.test.ts:120-134`) implements only
`collection().doc()/where()` + `getAll()`. It has **no `batch()`** and does **not mock
`FieldValue.increment`**, so the send path can't even be invoked today, and `orderBy/startAfter` +
subcollection support is missing for list-messages. Add: a `batch()` that records/applies ops on
`commit()`; a tagged `increment` sentinel resolved during merge; `orderBy/limit/startAfter` +
subcollection support. Then add: third-uid→403, nonexistent-id→404, owner+tenant happy paths,
rateLimit→`allowed:false`→429+Retry-After, empty/4001-char 400s, two-parallel-`/start` asserting the
live doc is never reset, mark-read interleaved with send asserting no unread lost.

## 5. Completeness self-check (modalities the 6 lenses did not explicitly cover)

- **Firestore rules — correct, defense-in-depth-sound.** `firestore.rules:106-120`: `conversations`
  read only to participants, `allow write: if false`; `messages` subcollection re-`get()`s the parent
  to authorize reads, write `false`. All writes go through the Admin SDK (bypasses rules) → the
  server-side participant gate is the real boundary. No client-write hole. Confirms the L-6 orphan
  exposure is server-only (a deleted parent makes the rule's `get().data.ownerId` null, denying client
  reads of orphans).
- **No i18n/RTL concern.** Zero `useTranslation`/`i18next` matches; all copy hardcoded English.
- **Timezone correct for chat.** `formatTime` (`MessagesPage.tsx:43-53`) operates on full ISO instants
  via `toLocaleTimeString` in the viewer's local tz. The project's date-only midnight-UTC bug class
  does not apply (`createdAt`/`lastMessageAt` are real instants, not date-only fields).
- **No missing composite index.** Single-field `orderBy("createdAt")` + equality-only participant/tenant
  queries are served by Firestore auto single-field indexes.

## 6. Refuted (checked, not bugs)

- `/read` merge-set "resurrecting" a deleted conversation — materializer's `have.has(convId)` keys on participant-field queries; a `{unread:0}` zombie has no `ownerId`/`tenantUserId`, never matches; deleted user can't call `/read`.
- Rate-limit per-uid "enables per-recipient push spam" — self-limited to the sender's own budget; the 200/hr cap is a deliberate anti-spam choice.
- `PUBLIC_APP_URL` "unsanitized" in push URL — trusted server env + hardcoded literal suffix; user data flows into separate `title`/`message` keys, never the URL.
- Stale `activeId` "strands the user on a blank pane" — conversation docs are never deleted by any list path; Chat buttons `start`-then-navigate so the doc exists before `?c=` seeds; desktop list aside is always visible.
- Empty-thread `lastMessageSenderId` placeholder coupling — all creation paths set `senderId:""`; the only increment is in the same batch that sets `senderId:uid`.
- Key stability (rows/messages) — confirmed sound; rows keyed by conversation id, bubbles by message id.
- Sender name "leaks/stale" across owner-transfer — push title read fresh from Firestore every request; ex-owner retaining a writable thread is an accepted permanent-thread design choice.
- "Survivor posts into a gone counterpart's thread" — `deleteUserCascade` deletes the shared conversation doc (queried by both `ownerId` and `tenantUserId`), so post-deletion `send` 404s.
- Messages subcollection "needs a composite index" — auto single-field indexes suffice.

## 7. Recommended next step

Highest risk-reduction for least churn: fix **M-1, M-2, M-3** (data races + the 500) and extend the
test double to cover the send/authz path. M-5 (global unread badge) and M-7 (push deep-link) are the
biggest UX wins. — _Awaiting maintainer decision; no code changed yet._
