// HTTP routing composition. Per-domain endpoint code lives under
// server/routes/*.ts; this file owns:
//
//   1. Maintenance-gate middleware (defense-in-depth lockout when
//      a superadmin flips config/system.maintenanceMode).
//   2. Privilege middleware factories that get passed via deps to
//      each per-domain module.
//   3. The single registerRoutes(app) entrypoint that mounts every
//      module in dependency order.
//
// Adding a new endpoint? Create or extend a file in server/routes/,
// export a registerXRoutes(app, deps) function, and add it to the
// mount block at the bottom of this file. Don't add raw app.get/
// app.post calls here — the goal is to keep this file ~250 lines.

import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { auth, db } from "./firebase";
import { requireAuth, requireRole } from "./auth";
import { registerEmailMarketingRoutes } from "./routes/emailMarketing";
import { registerNotificationRoutes } from "./routes/notifications";
import { registerMessageRoutes } from "./routes/messages";
import { registerStripeWebhookRoute } from "./routes/stripeWebhook";
import { registerHealthRoutes } from "./routes/health";
import { registerForgotPasswordRoutes } from "./routes/forgotPassword";
import { registerAskRoutes } from "./routes/ask";
import { registerTicketRoutes } from "./routes/tickets";
import { registerExpertRoutes } from "./routes/expert";
import { registerProfileRoutes } from "./routes/profile";
import { registerDocumentRoutes } from "./routes/documents";
import { registerAccessRoutes } from "./routes/access";
import { registerPropertyRoutes } from "./routes/properties";
import { registerFinanceRoutes } from "./routes/finance";
import { registerDiscoveryRoutes } from "./routes/discovery";
import { registerPlanRoutes } from "./routes/plan";
import { registerBriefingRoutes } from "./routes/briefing";
import { registerAnalyticsRoutes } from "./routes/analytics";
import { registerPortfolioRoutes } from "./routes/portfolio";
import { registerConnectRoutes } from "./routes/connect";
import { registerTenantRoutes } from "./routes/tenant";
import { registerConfigRoutes } from "./routes/config";
import { registerMediaRoutes } from "./routes/media";
import { registerAdminPushRoutes } from "./routes/adminPush";
import { registerEmailQuotaRoutes } from "./routes/emailQuota";
import { registerAdminStripeRoutes } from "./routes/adminStripe";
import { registerAdminContentRoutes } from "./routes/adminContent";
import { registerAdminUsersRoutes } from "./routes/adminUsers";
import { registerAdminUnitsRoutes } from "./routes/adminUnits";
import { registerAdminPortfoliosRoutes } from "./routes/adminPortfolios";
import { registerAdminQueriesRoutes } from "./routes/adminQueries";
import { loadSystemConfig } from "./services/configCache";
import { hasPlatformPrivilege, resolvePlatformRole } from "./services/platformPrivilege";
import {
  hasOwnerPlanPrivilege,
  hasPortfolioPrivilege,
  resolvePortfolioRoles,
} from "./services/portfolioPrivilege";
import { resolveOwnerScope } from "./services/ownerScope";
import {
  COL,
  type OwnerPlanPrivilegeKey,
  type PlatformPrivilegeKey,
  type PortfolioPrivilegeKey,
  type SystemConfig,
  type User,
} from "../shared/firestore-schema";

// ── Privilege middleware factories ──────────────────────────────────
// Constructed once and passed to per-domain route modules as deps.
// Each one returns an Express RequestHandler that 4xx's before the
// endpoint handler runs.

// 403 Forbidden when the caller's platform role lacks the matrix
// privilege. Use AFTER requireAuth so req.user is populated.
function requirePlatformPrivilege(privilege: PlatformPrivilegeKey): RequestHandler {
  return async (req, res, next) => {
    const ok = await hasPlatformPrivilege(req.user?.profile, privilege);
    if (!ok) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

// 402 Payment Required when the caller's OWN portfolio plan doesn't
// grant the feature. Use this for mutating endpoints that only ever
// write against the caller's own data (e.g. POST /api/owner/agreements).
// For read endpoints that accept `?ownerId=` to view another
// portfolio, use requireActivePortfolioPlanPrivilege instead so
// granted contacts inherit the owner's plan.
function requireOwnerPlanPrivilege(privilege: OwnerPlanPrivilegeKey): RequestHandler {
  return async (req, res, next) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Unauthorized" });
    const ok = await hasOwnerPlanPrivilege(uid, privilege);
    if (!ok) {
      return res.status(402).json({ error: "Upgrade required", privilege });
    }
    next();
  };
}

// 402 Payment Required gated on the ACTIVE PORTFOLIO's plan. Resolves
// the portfolio via resolveOwnerScope (so `?ownerId=` granted access
// is honored) and then checks that portfolio owner's plan. A free-
// plan caller browsing a Pro-plan portfolio they have access to still
// sees Pro features.
function requireActivePortfolioPlanPrivilege(privilege: OwnerPlanPrivilegeKey): RequestHandler {
  return async (req, res, next) => {
    const scope = await resolveOwnerScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const ok = await hasOwnerPlanPrivilege(scope.ownerId, privilege);
    if (!ok) {
      return res.status(402).json({ error: "Upgrade required", privilege });
    }
    next();
  };
}

// 403 Forbidden when the caller's role in their OWN portfolio
// (resolved to ["owner"]) doesn't grant the privilege. Use on
// endpoints that only ever serve self-portfolio data; for endpoints
// that accept `?ownerId=` to view someone else's portfolio, inline
// hasPortfolioPrivilege with the resolved scope instead.
function requireSelfPortfolioPrivilege(privilege: PortfolioPrivilegeKey): RequestHandler {
  return async (req, res, next) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Unauthorized" });
    const ok = await hasPortfolioPrivilege(uid, uid, privilege);
    if (!ok) {
      return res.status(403).json({ error: "Forbidden", privilege });
    }
    next();
  };
}

// ── Maintenance gate ────────────────────────────────────────────────

// Endpoints that must keep working while maintenance mode is on. The
// system-config endpoints themselves are exempt so a superadmin can
// toggle the flag back off; /api/me is exempt so the client shell can
// resolve the caller's role and decide whether to render the
// maintenance screen or let a superadmin through. Stripe webhooks
// bypass requireAuth entirely and run before this middleware mounts
// on the app.
const MAINTENANCE_BYPASS_PATHS = new Set<string>([
  "/api/system-config",
  "/api/me",
  // Stripe + other inbound webhooks: third-party deliveries must keep
  // flowing through maintenance windows or we lose subscription/
  // payment state.
  "/api/webhooks/stripe",
  // CSP violation reports are useless to throttle on — let them
  // through so we keep getting telemetry during maintenance windows.
  "/api/csp-report",
]);

// Returns 503 for non-superadmin API calls when maintenance is on.
// Public (no-auth) endpoints get a generic 503; authenticated ones
// look up the caller's role on a best-effort basis. The user-facing
// shell already locks the UI via onSnapshot — this middleware is a
// defense-in-depth backstop that also covers anyone using the API
// outside the browser.
async function maintenanceGate(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api")) return next();
  if (MAINTENANCE_BYPASS_PATHS.has(req.path)) return next();
  let config: SystemConfig;
  try {
    config = await loadSystemConfig();
  } catch {
    // Fail open — never let a config read error take the whole API
    // down.
    return next();
  }
  if (!config.maintenanceMode.enabled) return next();

  // Try to identify the caller; if they're a superadmin, let them
  // through.
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const decoded = await auth().verifyIdToken(header.slice("Bearer ".length));
      const snap = await db().collection(COL.users).doc(decoded.uid).get();
      const profile = snap.exists ? (snap.data() as User) : undefined;
      if (profile?.roles?.includes("superadmin")) return next();
    } catch {
      // Fall through to 503.
    }
  }
  return res.status(503).json({
    error: "Maintenance",
    message:
      config.maintenanceMode.message ||
      "Olio is undergoing scheduled maintenance. We'll be back shortly.",
  });
}

// ── Composition ─────────────────────────────────────────────────────

export function registerRoutes(app: Express): void {
  // Maintenance gate runs before every other route so admin-flipped
  // lockouts take effect API-wide. The superadmin bypass + the
  // explicit allowlist let staff turn it back off and let the user
  // shell decide who sees the maintenance screen.
  app.use(maintenanceGate);

  // ── Webhooks + marketing surfaces (independent) ──────────────────
  registerEmailMarketingRoutes(app, { requirePlatformPrivilege });
  registerNotificationRoutes(app, { requirePlatformPrivilege });
  registerMessageRoutes(app);
  registerStripeWebhookRoute(app);

  // ── Public + auth surface ────────────────────────────────────────
  registerHealthRoutes(app);
  registerForgotPasswordRoutes(app);

  // ── Owner + tenant features (gated on owner-plan / portfolio role) ──
  registerAskRoutes(app, { requireActivePortfolioPlanPrivilege });
  registerTicketRoutes(app);
  registerExpertRoutes(app);
  registerProfileRoutes(app);
  registerDocumentRoutes(app, { requireOwnerPlanPrivilege });
  registerAccessRoutes(app);
  registerPropertyRoutes(app);
  registerFinanceRoutes(app);
  registerDiscoveryRoutes(app, { requireActivePortfolioPlanPrivilege });
  registerPlanRoutes(app);
  registerBriefingRoutes(app, { hasOwnerPlanPrivilege });
  registerAnalyticsRoutes(app, { requireSelfPortfolioPrivilege });
  registerPortfolioRoutes(app, { requireOwnerPlanPrivilege });
  registerConnectRoutes(app);
  registerTenantRoutes(app);

  // ── Admin surface (role + platform-matrix gated) ──────────────────
  registerConfigRoutes(app, { requireRole, requirePlatformPrivilege });
  registerMediaRoutes(app, { requireRole, requirePlatformPrivilege });
  registerAdminPushRoutes(app, { requireRole, requirePlatformPrivilege });
  registerEmailQuotaRoutes(app, { requireRole, requirePlatformPrivilege });
  registerAdminStripeRoutes(app, { requirePlatformPrivilege });
  registerAdminContentRoutes(app, { requireRole, requirePlatformPrivilege });
  registerAdminUsersRoutes(app, { requireRole, requirePlatformPrivilege });
  registerAdminUnitsRoutes(app, { requireRole, requirePlatformPrivilege });
  registerAdminPortfoliosRoutes(app, { requireRole });
  registerAdminQueriesRoutes(app, { requireRole, requirePlatformPrivilege });
}

// Re-export helpers for use by enforcement at other endpoints (kept
// here historically to avoid a circular import chain; new callers
// should import from server/services/* directly).
export const __privileges = {
  resolvePortfolioRoles,
  hasPortfolioPrivilege,
  hasPlatformPrivilege,
  resolvePlatformRole,
  requirePlatformPrivilege,
};
