# 4. One unified `users` collection per persona — roles, not separate collections

- Status: Accepted
- Deciders: platform team
- Tags: data-model, identity, authorization

## Context

Olio has several personas: tenants, owners (landlords), platform admins (with
sub-roles: manager / support / sales / …), and superadmins. A common instinct
is to model each persona as its own collection (`tenants/`, `owners/`,
`admins/`). That feels tidy until you hit the realities of this product:

- **One human is often several personas.** An owner is also a tenant of their
  own product surfaces; a tenant can "Activate Landlord View" and become an
  owner without re-registering. A separate-collection model forces either
  duplicate docs (sync hell) or cross-collection joins on every request.
- **Identity is already unified.** Every persona authenticates through one
  Firebase Auth identity. `User.id == Firebase Auth UID`, so there is exactly
  one natural primary key per human.
- **Authorization is matrix-driven** (ADR 0001), keyed on role/plan, not on
  which table a row lives in.

## Decision

There is **one `users` collection**. Persona is expressed as data on the `User`
doc, never as a separate collection:

- `roles: Role[]` where `Role = "tenant" | "owner" | "admin" | "superadmin"`
  (`shared/firestore-schema.ts`). A human can hold several at once.
- `ownerModeEnabled?: boolean` — explicit opt-in for the owner experience,
  toggled from settings; gates the tenant↔owner mode switch.
- `platformRole?: PlatformRoleKey` — the admin sub-role, meaningful only when
  `roles` includes `"admin"`; drives the platform privilege matrix.
  `superadmin` bypasses the matrix entirely.

A new persona type is added by **extending `roles` / `platformRole`**, never by
creating a new collection. This is a standing rule (project memory
`feedback_unified_user_table`).

## Consequences

- **No duplicate identity, no cross-collection sync.** One human = one doc =
  one UID. Mode-switching (tenant↔owner) is a field flip, not a migration.
- **AuthZ composes cleanly.** `requireRole(...)` checks `profile.roles`; the
  privilege matrices key on role/plan/platformRole. Adding "expert" or any new
  persona is a type-union edit plus matrix columns, not schema surgery.
- **Role assignment is a sharp edge** and is gated accordingly: `users.assignRoles`
  is admin-only by default, and **only an existing superadmin can mint another
  superadmin** — hard-coded in `PATCH /api/admin/users/:id`, not matrix-driven.
  Every role/status/platformRole change is written to `userAudit` (see the
  `UserAuditEntry` schema and `SECURITY.md` → Authorization).
- **Fresh-read discipline matters more.** Because one doc carries all
  entitlements, `requireAuth` reads the profile **fresh per request** and we
  `revokeRefreshTokens` on any security-relevant change so a cached ID token
  can't outlive a demotion.
- **Trade-off: wide docs + broad queries.** A `User` carries tenant, owner, and
  Connect fields together; some admin queries scan the whole collection (a
  flagged scale gap in `SECURITY.md` → Known gaps). We accept this for the
  identity simplicity it buys.
