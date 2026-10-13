// Portfolio-role + owner-plan privilege helpers. Sibling to
// platformPrivilege.ts:
//
//   resolvePortfolioRoles(caller, owner) → ["owner"] | ["legal", ...] | ["tenant"]
//   hasPortfolioPrivilege(caller, owner, p) → matrix lookup across all roles
//   hasOwnerPlanPrivilege(ownerUid, p) → owner-plan matrix lookup
//
// All three read `config/privileges` via the 30s-TTL cache in
// configCache.ts. The middleware factories that wrap these
// (requireOwnerPlanPrivilege, requireActivePortfolioPlanPrivilege,
// requireSelfPortfolioPrivilege) live in routes.ts because they're
// only constructed there and passed to per-domain modules as deps.

import { db } from "../firebase";
import { resolveOwnerPlan } from "./commission";
import { loadPrivilegesConfig } from "./configCache";
import {
  COL,
  type OwnerPlanPrivilegeKey,
  type PortfolioAccessContact,
  type PortfolioPrivilegeKey,
  type PortfolioRoleKey,
} from "../../shared/firestore-schema";

// Effective portfolio role(s) of the caller relative to a target
// portfolio. A user can hold multiple slots simultaneously (e.g.
// legal + financial), so this returns an array; the privilege check
// OR's grants across all of them.
//
// `portfolioId` (the STABLE Portfolio doc id) is the ONLY lookup key for
// both the grant query and the tenant fallback (Phase 4 — every row is
// stamped, so the legacy ownerId-keyed dual-read queries are removed).
// A null/absent portfolioId resolves to no grants and no tenancy: callers
// that aren't the owner get [] (fail closed).
export async function resolvePortfolioRoles(
  callerUid: string,
  ownerId: string,
  portfolioId?: string | null,
): Promise<PortfolioRoleKey[]> {
  if (callerUid === ownerId) return ["owner"];
  const roles: PortfolioRoleKey[] = [];
  const grants = await loadActiveGrants(callerUid, portfolioId ?? null);
  grants.forEach((g) => {
    if (g.type === "legacy" && !roles.includes("legacyOwner")) roles.push("legacyOwner");
    if (g.type === "legal" && !roles.includes("legal")) roles.push("legal");
    if (g.type === "financial" && !roles.includes("financial")) roles.push("financial");
  });
  if (roles.length > 0) return roles;
  // Tenant fallback: the caller holds a tenancy stamped to this portfolio.
  if (await hasTenancy(callerUid, portfolioId ?? null)) roles.push("tenant");
  return roles;
}

// ACTIVE access grants for the caller, keyed SOLELY by the stamped
// portfolioId field (Phase 4 — every grant row is stamped; the legacy
// ownerId-keyed dual-read query is removed; null => no grants).
// Pending/declined/revoked invites don't grant access — only accepted
// (active) ones do. Without this, owner X could spam fake portfolio
// entries into Y's sidebar and immediately read all of Y's data.
//
// SECURITY (mirrors ownerScope.findActiveGrants): keying on the exact
// portfolio doc id means a grant stamped for a DIFFERENT portfolio of the
// same owner can never match — relevant once an ownership transfer leaves
// stale grants stamped to the old portfolio.
async function loadActiveGrants(
  callerUid: string,
  portfolioId: string | null,
): Promise<PortfolioAccessContact[]> {
  if (!portfolioId) return [];
  const snaps = await db()
    .collection(COL.portfolioAccessContacts)
    .where("portfolioId", "==", portfolioId)
    .where("contactUserId", "==", callerUid)
    .get();
  return snaps.docs
    .map((d) => d.data() as PortfolioAccessContact)
    .filter((g) => g.status === "active");
}

// Does the caller hold a tenancy under this portfolio? Keyed SOLELY by the
// stamped portfolioId (Phase 4; null => no tenancy).
async function hasTenancy(callerUid: string, portfolioId: string | null): Promise<boolean> {
  if (!portfolioId) return false;
  const snaps = await db()
    .collection(COL.tenants)
    .where("portfolioId", "==", portfolioId)
    .where("userId", "==", callerUid)
    .limit(1)
    .get();
  return !snaps.empty;
}

export async function hasPortfolioPrivilege(
  callerUid: string,
  ownerId: string,
  privilege: PortfolioPrivilegeKey,
  portfolioId?: string | null,
): Promise<boolean> {
  const config = await loadPrivilegesConfig();
  const grants = config.portfolio[privilege];
  if (!grants) return false;
  const roles = await resolvePortfolioRoles(callerUid, ownerId, portfolioId);
  return roles.some((r) => grants[r]);
}

// Owner-plan privilege check: does the given owner's subscription
// plan (resolved from the Stripe `stripeRole` claim on the PORTFOLIO
// OWNER — not necessarily the caller) unlock this feature? The matrix
// lives in `config/privileges.ownerPlan` and is editable in
// /admin/owner-plans.
//
// Plans are portfolio-scoped: a granted contact (legal/financial/
// legacy) inherits the owner's plan when acting on that owner's
// portfolio.
export async function hasOwnerPlanPrivilege(
  portfolioOwnerUid: string,
  privilege: OwnerPlanPrivilegeKey,
): Promise<boolean> {
  const [plan, config] = await Promise.all([
    resolveOwnerPlan(portfolioOwnerUid),
    loadPrivilegesConfig(),
  ]);
  return Boolean(config.ownerPlan[privilege]?.[plan]);
}
