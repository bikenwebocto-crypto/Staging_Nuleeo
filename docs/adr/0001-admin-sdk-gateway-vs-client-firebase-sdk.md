# 1. Admin-SDK-in-Express gateway, not the client Firebase SDK

- Status: Accepted
- Deciders: platform team
- Tags: security, data-access, architecture

## Context

Firebase offers two ways for a web app to reach Firestore and Storage:

1. **Client SDK direct** — the browser talks to Firestore/Storage straight,
   and Firestore Security Rules are the authorization layer.
2. **Server gateway** — every read/write goes through our own API (an Express
   Cloud Function using the Firebase **Admin** SDK), and the client never
   touches Firestore directly.

Security Rules are powerful but they express authorization as a per-document
predicate language. Our authZ is not per-document — it is a three-matrix
privilege model (portfolio roles, platform admin sub-roles, owner plan tiers)
that is **admin-editable at runtime** and involves cross-document joins
(does this owner's plan unlock this feature? is this contact an accepted
cross-portfolio invitee?). Encoding that in Rules would mean duplicating the
logic in two languages and keeping them in sync forever.

## Decision

All application reads and writes flow through the Express API. The API uses
the Firebase **Admin SDK**, which **bypasses Security Rules entirely**, and
does its own authorization: `requireAuth` verifies the Firebase ID token and
loads a fresh profile per request, then role/plan/privilege middleware gates
the route.

Firestore and Storage rules are therefore **deny-by-default**. See
`firestore.rules` (`match /{document=**} { allow read, write: if false; }`)
and `storage.rules` (`allow read, write: if false`).

The only client-readable Firestore docs are the deliberate exceptions in
`firestore.rules`:

- `customers/{uid}` + subcollections — owned by the Stripe Payments
  extension, which **requires** direct client reads to drive Checkout / the
  billing portal.
- `products/*`, `config/privileges`, `config/compliance`, `config/social`,
  `config/system`, `config/planLabels`, and `conversations/*` — read-only
  realtime-UI feeds (plan catalog, the UI-only privilege matrix, maintenance
  flag, chat threads). Every one is `allow write: if false`; writes go through
  an Express endpoint.

## Consequences

- **Single authorization surface.** AuthZ lives in one place (the API), in one
  language. The privilege matrix can change at runtime without a Rules deploy.
- **Rules stay trivially auditable.** A reviewer reads ~120 lines and sees that
  everything not explicitly listed is denied — no subtle predicate bugs.
- **The client realtime-reads are explicitly bounded.** Each exception carries
  a comment justifying why a direct read is safe (no PII, or extension-owned).
  Critically, `config/privileges` is readable but **UI-only** — the API
  re-enforces the real authZ on every request, so reading it grants nothing
  (see ADR 0005 and `SECURITY.md` → Authorization).
- **Cost: a hop.** Reads that could have been a direct `onSnapshot` now pay an
  API round-trip. We accept this for everything except the realtime feeds above.
- **The Admin SDK is all-powerful**, so an API bug is a confused-deputy risk
  that Rules would otherwise have backstopped. We mitigate with per-route
  privilege middleware + route-level authZ tests (`*.authz.test.ts`).
