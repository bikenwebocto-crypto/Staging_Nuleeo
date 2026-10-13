# Contributing

Workflow rules + commit-style conventions for the Olio repo. Read once,
then keep this file open for the first few PRs.

## Branch model

- **`main` is always deployable.** Every push to main triggers a
  Firebase deploy via [`deploy.yml`](.github/workflows/deploy.yml). A
  failing typecheck, failing test, or failing build blocks the deploy.
- **Feature branches**: `name/short-thing` (e.g. `kingjames/audit-log`).
- **Open a PR** for anything that touches user-visible behavior, money
  paths, security primitives, or the privilege matrix. Even one-line
  fixes — code review catches things tests don't.
- **Direct push to main** is fine for: typo fixes in docs/comments,
  test additions, dependency bumps that pass CI, infra config that
  doesn't affect runtime.

## Before you push

Run all three locally:

```bash
npm run check    # tsc across all 4 tsconfigs — must be clean
npm test         # vitest — must be 100% green
npm run build    # vite + server bundle build — must succeed
```

Functions deploy ALSO needs the functions build to pass:

```bash
cd functions && npm run build
```

If any of these fails, fix it before pushing. CI runs the same gates
and will surface the failure publicly otherwise.

### When you touch a security primitive

If you change `safeRedirect`, `csvSafety`, `unicodeSanitize`,
`storagePath`, `rentTransaction`, `planReconcile`, `connectMirror`,
`configCache`, `audiences` (server `resolvePushAudience`), or `log`, the
matching `server/services/*.test.ts` file **must still pass + must still
cover the original regression**. (The email-marketing audience-summary
model is a separate CLIENT test at
`client/platform/src/features/email-marketing/model/audience.test.ts`.)
Each test was written against a specific attack class — removing one
silently re-opens the hole.

If you're adding a NEW security-relevant helper, extract it to
`server/services/X.ts` + add `server/services/X.test.ts` with at minimum
the happy path + the attack shape you're defending against. See
existing files for the pattern.

## Commit style

We use a simple convention adapted from Conventional Commits — enough
shape to scan `git log` and grep for things, not so much that it gets
in the way.

Format:

```
<type>(<scope>): <short summary>

<body — what changed, WHY, links / call-site pointers as needed>

Co-Authored-By: <if applicable>
```

Types we use:

- `feat` — new user-visible behavior
- `fix` — bug fix
- `security` — closes a vulnerability (use for anything from the
  audit queue; makes it easy to grep `git log --grep security`)
- `perf` — measurable performance improvement
- `refactor` — code shape change, no behavior change
- `test` — adding tests against existing behavior
- `docs` — README, SECURITY, code comments
- `ci` — `.github/workflows/*` changes
- `chore` — dep bumps, lint, formatting
- `infra` — `infra/` directory + firebase.json + firestore.rules

Scope is optional but useful when narrow. Examples from our history:

```
security: close 3 critical findings — log redaction + SSRF + unit-cap race
feat(emails): finalize audience refactor — filter / user / legacy enum
fix(server): cascade property delete (storage + documents + tenants)
test: extract + lock in 3 security primitives — csvCell, sanitizeText, …
perf: consolidate hot config-doc reads into shared configCache (4 caches)
refactor(logs): migrate hot console.* sites to structured logger
docs: add SECURITY.md — threat model, controls, incident-response runbook
```

**Always include the WHY in the body** for security/perf/feat commits.
A future engineer reading `git blame` six months from now needs to
understand the rationale without rediscovering the entire context. The
specific attack shape, the race scenario, the perf gain in concrete
numbers — write it down.

## Adding endpoints

- Every authenticated route goes through `requireAuth`.
- Every admin route ALSO goes through `requireRole(...)` + (when
  relevant) `requirePlatformPrivilege(...)`.
- Every user-mutable input gets a length cap + a type check + (for
  display strings) `sanitizeText`.
- Every user-supplied URL that flows to a server-side fetch goes
  through `isPublicHttpsUrl`.
- Every user-supplied URL that flows to a redirector goes through
  `isSafeRedirectUrl`.
- Money-path writes that could race must use deterministic doc ids +
  `runTransaction`. See `recordRentTransactionFromSession` for the
  pattern.
- Endpoints that send Resend / OneSignal / Stripe API calls per
  request need a per-uid rate limit. See `rateLimit()` in
  `server/services/rateLimit.ts`.
- Log meaningful events via `log()` from `server/services/log.ts`
  with a stable `event` id (kebab.dotted) — Cloud Logging dashboards
  filter on `jsonPayload.event`.

## Adding Firestore queries

If your new query is composite (more than one `where` + an
`orderBy`, or two `where`s on different fields), it needs a composite
index in [`firestore.indexes.json`](firestore.indexes.json). Without
it, the first prod hit will fail with `FAILED_PRECONDITION`. Test
locally with `firebase emulators:start` or accept the failure trip in
staging.

For single-field collectionGroup queries (rare), use the
`fieldOverrides` section, not `indexes`.

## Working with user PII

- Don't log raw email / phone / address / IBAN / message body. The
  request logger redacts a fixed set (`SENSITIVE_KEYS` in
  `server/app.ts`) but explicit `logError("...", err, {uid})` lines
  are your responsibility.
- For email rate-limit keys, NFKC-normalize before lowercasing so
  Unicode variants fold to the same bucket.
- Display-name fields get `sanitizeText` (strips bidi overrides +
  zero-width chars) before storage.
- If you're adding a new collection that holds PII, update
  `deleteUserCascade` in `server/services/userDelete.ts` so it gets
  cleaned on GDPR Art. 17 erasure.

## Working with money

- Read [`server/services/rentTransaction.ts`](server/services/rentTransaction.ts)
  - its tests before touching the rent-checkout flow.
- Every Stripe write path is idempotent on
  `idempotencyKey: <stable-key-based-on-event-id>`. Don't break this
  — webhook retries depend on it.
- Application fee derivation prefers expanded PaymentIntent over
  metadata. The helper is `deriveFeeBreakdown`; the tests are in the
  same file.
- Plan-downgrade reconcile fires on `customer.subscription.updated`;
  policy is "delete excess properties vacant-first, terminate
  agreements if rent.collectStripe lost". See `planReconcile.ts`
  before adding new plan-related behavior.

## Pull-request checklist

- [ ] `npm run check` clean
- [ ] `npm test` green (no test count regression)
- [ ] If you added code: matching test (mandatory for security
      primitives, strongly preferred for everything else)
- [ ] If you added a new collection / composite query: index
      declared in `firestore.indexes.json`
- [ ] If you added a new auth/role/status state change: token
      refresh-revoke via `auth().revokeRefreshTokens(uid)` if the
      change should take effect inside the 1h ID-token window
- [ ] If you added a new PII-bearing field: `deleteUserCascade`
      covers it
- [ ] Commit message follows the format above + explains WHY
- [ ] Self-review: did you `git diff origin/main` your own PR
      before requesting review?

## Code style

- TypeScript strict. No `any` unless you genuinely can't avoid it
  (and then add a `// eslint-disable-next-line` comment with the
  reason).
- No comments that just repeat the code. Comments explain WHY, not
  WHAT.
- No `console.log` in committed code — use `log()` for production
  events, or delete it entirely if it was a debug line.
- Prefer extracting to a small helper + writing tests vs. inlining
  cleverness. Easier to read, easier to refactor.
- Match the surrounding style. The codebase uses 2-space indent in
  most files, tabs in others — don't fight it; follow the file
  you're in.

## When in doubt

Open a draft PR + ask. The cost of a 30-second clarification is
much lower than the cost of a wrong commit on `main` that auto-deploys
to production.
