// Resolve which portfolio the caller is asking for and confirm they're
// allowed to read (or edit) it. Returns the resolved ownerId, the STABLE
// portfolio doc id (the operative key for every scoped list query), and the
// merged permission set. Self always gets ["view","edit"]; cross-portfolio
// access is looked up in `portfolioAccessContacts` (legacy/legal/financial
// slots).
//
// Param precedence: `?portfolioId=` (the stable Portfolio doc id — NEW,
// preferred) > `?ownerId=` (legacy uid, kept working through the transition)
// > self. Read endpoints call this with requireEdit=false; the few mutating
// endpoints that accept a scope pass requireEdit=true.
//
// Phase 4: grant lookups key SOLELY off the stamped portfolioId field —
// every grant row is stamped (backfill verified), so the Phase-2 legacy
// ownerId-keyed dual-read fallback is gone. An owner with no portfolio doc
// can have no grants by construction.

import type { Request } from "express";
import { db } from "../firebase";
import { hasPortfolioPrivilege } from "./portfolioPrivilege";
import { ensurePortfolio, getPortfolio } from "./portfolioBanking";
import {
  COL,
  type AccessPermission,
  type Portfolio,
  type PortfolioAccessContact,
  type PortfolioPrivilegeKey,
} from "../../shared/firestore-schema";

export type OwnerScope =
  | {
      ok: true;
      ownerId: string;
      // STABLE Portfolio doc id (Portfolio.id, NOT the human display label).
      // Guaranteed non-null for self (ensured on resolve). Since Phase 4 a
      // cross-portfolio scope is also always non-null (grants are looked up
      // by portfolioId alone, so a portfolio-less owner refuses with 403);
      // the type keeps `| null` so defensive null-handling in routes stays
      // compiled-in.
      portfolioId: string | null;
      permissions: AccessPermission[];
      isSelf: boolean;
    }
  | { ok: false; status: number; error: string };

// One refusal shape for "missing portfolio" and "no grant" alike — a 403
// that doesn't reveal whether the portfolio id exists.
const NO_ACCESS = {
  ok: false,
  status: 403,
  error: "You don't have access to this portfolio",
} as const;

function queryParam(req: Request, name: string): string | null {
  const value = req.query[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function resolveOwnerScope(req: Request, requireEdit = false): Promise<OwnerScope> {
  const callerUid = req.user!.uid;
  const queryPortfolioId = queryParam(req, "portfolioId");
  const queryOwnerId = queryParam(req, "ownerId");

  // ── Preferred: scope by the stable portfolio doc id ────────────────
  if (queryPortfolioId) {
    const snap = await db().collection(COL.portfolios).doc(queryPortfolioId).get();
    // Unknown id gets the exact same refusal as "no grant" so callers
    // can't probe which portfolio ids exist.
    if (!snap.exists) return NO_ACCESS;
    const portfolio = snap.data() as Portfolio;
    if (portfolio.ownerId === callerUid) {
      return {
        ok: true,
        ownerId: callerUid,
        portfolioId: portfolio.id,
        permissions: ["view", "edit"],
        isSelf: true,
      };
    }
    return grantScope(callerUid, portfolio.ownerId, portfolio.id, requireEdit);
  }

  // ── Legacy: scope by owner uid (or default to self) ────────────────
  const ownerId = queryOwnerId ?? callerUid;
  if (ownerId === callerUid) {
    // Self: get-or-create the portfolio so the scope always carries a
    // non-null operative key. ensurePortfolio is idempotent/cheap and is
    // only ever called SELF-scoped — a caller must never be able to
    // force-create someone else's portfolio doc.
    const portfolio = await ensurePortfolio(callerUid);
    return {
      ok: true,
      ownerId,
      portfolioId: portfolio.id,
      permissions: ["view", "edit"],
      isSelf: true,
    };
  }
  // Cross-portfolio via legacy ?ownerId=: READ-resolve their portfolio
  // (never ensure on a foreign owner). An owner with no portfolio doc has
  // no data AND no grants (grants are portfolio-stamped), so a null
  // resolution refuses below.
  const portfolio = await getPortfolio(ownerId);
  return grantScope(callerUid, ownerId, portfolio?.id ?? null, requireEdit);
}

// Cross-portfolio: the caller must hold an ACTIVE grant on this portfolio —
// pending/declined invites confer nothing. Multiple grants are possible
// (e.g. legacy + legal); permissions merge across them.
async function grantScope(
  callerUid: string,
  ownerId: string,
  portfolioId: string | null,
  requireEdit: boolean,
): Promise<OwnerScope> {
  const activeGrants = await findActiveGrants(callerUid, portfolioId);
  if (activeGrants.length === 0) return NO_ACCESS;
  const permissions: AccessPermission[] = [];
  activeGrants.forEach((g) => {
    g.permissions.forEach((p) => {
      if (!permissions.includes(p)) permissions.push(p);
    });
  });
  if (requireEdit && !permissions.includes("edit")) {
    return {
      ok: false,
      status: 403,
      error: "You only have view access to this portfolio",
    };
  }
  return { ok: true, ownerId, portfolioId, permissions, isSelf: false };
}

// Active grants for the caller on this portfolio, keyed SOLELY by the
// stamped portfolioId field (Phase 4 — every grant row is stamped; the
// legacy ownerId-keyed fallback query is removed). Null portfolioId means
// the target owner has no portfolio doc, and therefore no grants by
// construction: return [].
//
// SECURITY: keying on the exact portfolio doc id (never ownerId) also means
// a grant stamped for a DIFFERENT portfolio of the same owner can never
// match — relevant since an ownership transfer can re-point ownership while
// stale grants stay stamped to the old portfolio.
async function findActiveGrants(
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

// Per-resource authorization for an already-resolved portfolio scope.
// resolveOwnerScope only proves the caller holds *some* active grant on the
// portfolio; it does NOT enforce the per-role privilege matrix — e.g. a
// "financial" contact must not read agreements, a "legal" contact must not
// read the money ledger / revenue analytics. The legal vs financial slots
// even store an identical ["view"] permissions array, so the matrix is the
// ONLY thing that distinguishes them. The client gates its UI on the same
// matrix; this enforces it server-side so a direct API call can't bypass it.
// Self (the owner) is always allowed.
export async function authorizePortfolioRead(
  callerUid: string,
  scope: Extract<OwnerScope, { ok: true }>,
  privilege: PortfolioPrivilegeKey,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (scope.isSelf) return { ok: true };
  // Thread the already-resolved portfolioId so the privilege engine keys
  // its grant lookup off the stable id (the only grant key since Phase 4).
  const allowed = await hasPortfolioPrivilege(
    callerUid,
    scope.ownerId,
    privilege,
    scope.portfolioId,
  );
  if (!allowed) {
    return {
      ok: false,
      status: 403,
      error: "You don't have access to that in this portfolio",
    };
  }
  return { ok: true };
}
