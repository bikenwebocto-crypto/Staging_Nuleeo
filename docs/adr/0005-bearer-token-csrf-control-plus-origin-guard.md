# 5. Bearer-token auth (no cookies) as the primary CSRF control + origin-guard defense-in-depth

- Status: Accepted
- Deciders: platform team
- Tags: security, csrf, auth

## Context

Cross-Site Request Forgery (CSRF) is the attack where `evil.com` causes a
victim's browser to fire an authenticated state-changing request at our API,
riding on credentials the browser auto-attaches. The classic defense is a
synchronizer token (a per-form/per-session token the server checks), which
exists **because** the ambient credential — a session **cookie** — is attached
automatically by the browser on cross-site requests.

We had a choice of how the SPA carries auth to the API. If we used an auth
**cookie**, we'd inherit the full CSRF problem and need a token-per-form
scheme. Firebase Auth, however, hands the client a short-lived **ID token**
that the SPA can attach itself.

## Decision

**Primary control: bearer token, not cookies.** Every authenticated request
carries the Firebase ID token in `Authorization: Bearer <token>`, verified per
request in `server/auth.ts` (`requireAuth`). The API reads **no auth cookies**.

Browsers auto-attach cookies to cross-site requests but **never** the
`Authorization` header. So a forged cross-site request from `evil.com` simply
arrives **unauthenticated** and is rejected by `requireAuth`. This makes the
API **structurally immune** to classic CSRF — no synchronizer-token scheme
needed.

**Defense-in-depth: a soft Origin/Referer allowlist** (`server/originGuard.ts`,
mounted before the body parser). Deliberately conservative, because a false
positive blocks a real user:

- (a) Only **state-changing** methods (POST/PUT/PATCH/DELETE) are checked.
- (b) If an `Origin` (or fallback `Referer`) header is present, its **host**
  must be a first-party Olio host (`app.`/`platform.`/`www.`/apex
  `oliowallet.com`, plus `localhost`/`127.0.0.1` and an optional
  `PUBLIC_APP_URL` host for staging) — otherwise **403**. Matches host only,
  since the API is reached both same-origin via the Hosting rewrite and
  directly at `*.run.app`.
- (c) If **neither** header is present → **allow** (server-to-server, curl,
  mobile, webhook deliveries send no browser Origin; blocking them breaks real
  traffic). Literal `Origin: null` is treated as "no usable origin" → allow.
- (d) `/api/webhooks/` and `/api/csp-report` are **exempt** — they authenticate
  via HMAC signature, not Origin, and must never be blocked on a technicality.

The allowlist intentionally mirrors `safeRedirect.ts` `PROD_HOSTS` (kept as a
separate copy so this module imports no route/service code; keep them in sync).

## Consequences

- **No CSRF token machinery.** No per-form tokens, no double-submit cookie, no
  `SameSite` tuning. The architecture removes the attack class rather than
  patching it.
- **The origin guard is genuinely secondary.** It catches nothing the bearer
  model lets through; it's a cheap extra wall against an unforeseen
  cookie/credential leak or a future endpoint that forgets `requireAuth`.
- **Conservative-by-design means it can be bypassed by a non-browser caller.**
  That's intended — we only reject a _clearly-foreign browser origin_. The real
  authenticity guarantee is the bearer token (auth'd routes) or the HMAC
  signature (webhooks), never the Origin header.
- **Two host allowlists to keep in sync** (`originGuard.ts` and
  `safeRedirect.ts`). Both are covered by tests (`originGuard.test.ts`,
  `safeRedirect.test.ts`) and called out in `SECURITY.md` → CSRF.
- **Token freshness is part of the control.** Because auth is a bearer token,
  `revokeRefreshTokens` on any security-relevant change caps how long a stolen
  or stale token stays valid (~1h). See `SECURITY.md` → Identity & sessions.
