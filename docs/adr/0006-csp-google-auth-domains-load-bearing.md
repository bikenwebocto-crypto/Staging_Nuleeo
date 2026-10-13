# 6. Google auth domains in the CSP are load-bearing for Google sign-in

- Status: Accepted
- Deciders: platform team
- Tags: security, csp, auth

## Context

The Content-Security-Policy in `firebase.json` is fully enforced (see QA-02).
Firebase Auth's `signInWithPopup` (the "Continue with Google" flow in
`client/app/src/pages/auth/Home.tsx`) loads `https://apis.google.com/js/api.js`
(the gapi iframe bridge) and embeds an iframe from `apis.google.com` /
`accounts.google.com`. If the CSP doesn't allow those origins, the browser
blocks the bridge and Firebase surfaces it as the opaque error
`auth/internal-error` — Google login breaks in production with no obvious cause.

This actually happened on 2026-06-09: the enforced CSP was missing
`https://apis.google.com`, so Google login threw `auth/internal-error`. Fixed
in commit `aaa4a4d`. It was latent until the CSP moved from Report-Only to
enforced.

## Decision

The CSP **must** keep these Google origins, across all three site blocks in
`firebase.json`:

- `script-src`: `https://apis.google.com` (gapi loader)
- `frame-src`: `https://apis.google.com` and `https://accounts.google.com`
  (auth bridge iframe + consent)
- `connect-src`: `https://*.googleapis.com` already covers the
  `identitytoolkit` / `securetoken` token endpoints.

These are **load-bearing for Google login — do not remove them** during any CSP
cleanup or tightening. There is no test that exercises the live OAuth popup
(it's credential-gated), so a regression here is silent until a human clicks
the button.

## Consequences

- A CSP "tidy-up" that strips `apis.google.com` / `accounts.google.com` will
  break Google sign-in in prod with only `auth/internal-error` to debug.
- The allowlist is intentionally narrow (specific Google auth hosts), not a
  wildcard — adding only what the popup flow needs.
- If Firebase changes the domains its popup flow uses, this ADR + the CSP must
  follow; confirm via the browser console's CSP-violation message, then update
  all three `firebase.json` site blocks together.
