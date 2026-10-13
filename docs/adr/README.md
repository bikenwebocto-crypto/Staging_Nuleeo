# Architecture Decision Records

This directory captures the genuinely non-obvious architectural decisions
behind Olio — the ones a new engineer (or a security reviewer) would
otherwise have to reconstruct from `SECURITY.md`, scattered code comments,
and commit bodies.

An ADR is short and immutable. It records the **context** that forced a
choice, the **decision** taken, and the **consequences** we accepted. If a
decision is later reversed, we don't edit the old record — we add a new ADR
that supersedes it and link the two. That way the rationale stays auditable
even after the code moves on.

We use a trimmed [MADR](https://adr.github.io/madr/) shape: Status / Context
/ Decision / Consequences. Keep each entry to a screenful. Code and ops
detail that changes often lives in `SECURITY.md` and the source comments —
ADRs point at those, they don't duplicate them.

## When to write one

Add an ADR when you make a choice that is **load-bearing and not obvious from
the code**: a security boundary, a money-path invariant, a data-model commitment,
a third-party-integration shape. Routine "use library X over Y" calls don't
need one. The test: would a reviewer reading the diff ask "why is it done this
way?" — if yes, write the ADR.

## Index

| ADR                                                         | Decision                                                                  | Status   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| [0001](0001-admin-sdk-gateway-vs-client-firebase-sdk.md)    | Admin-SDK-in-Express gateway + deny-by-default rules (not client SDK)     | Accepted |
| [0002](0002-stripe-connect-standard-direct-charges.md)      | Stripe Connect Standard accounts + DIRECT charges (Model B, owner-liable) | Accepted |
| [0003](0003-signed-url-upload-download-gateway.md)          | Server-minted signed-URL gateway for all Storage upload/download          | Accepted |
| [0004](0004-unified-users-table-roles-not-collections.md)   | One unified `users` table per persona (roles, not separate collections)   | Accepted |
| [0005](0005-bearer-token-csrf-control-plus-origin-guard.md) | Bearer-token (no cookies) as primary CSRF control + origin-guard DiD      | Accepted |
| [0006](0006-csp-google-auth-domains-load-bearing.md)        | Google auth domains in the CSP are load-bearing for Google sign-in        | Accepted |
