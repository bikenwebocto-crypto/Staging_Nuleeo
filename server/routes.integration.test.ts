// Smoke test for the route registration surface.
//
// Mounts registerRoutes(app) onto a fresh Express app and asserts the
// exact set of (method, path) pairs the public API exposes. This
// locks in the routes.ts split — if a future refactor drops, renames,
// or duplicates an endpoint, this test fails before deploy.
//
// We deliberately do NOT exercise endpoint logic here; this is a
// surface check, not a behavior check. Per-module behavior tests
// belong next to their module (see e.g. server/services/configCache.test.ts).

import express, { type Express } from "express";
import { describe, expect, it, vi } from "vitest";

// Mock every external client. routes.ts imports a chain of services
// that initialize firebase/stripe/openai/onesignal lazily, but a few
// (firebase, stripe) are referenced at module-load time inside some
// extracted modules. Stub them all to keep the import chain inert.
vi.mock("./firebase", () => ({
  db: () => ({}),
  auth: () => ({}),
  bucket: () => ({}),
  storageBucketName: "test-bucket",
  initFirebase: () => ({}),
}));

vi.mock("./stripe", () => ({
  stripe: () => ({}),
  isStripeConfigured: () => false,
}));

vi.mock("./openai", () => ({
  openai: () => ({}),
  ASK_OLIO_MODEL: "gpt-4o-mini",
  ASK_OLIO_SYSTEM_PROMPT: "test",
  ASK_MAX_HISTORY: 20,
}));

vi.mock("./services/push", () => ({
  PushError: class extends Error {
    status = 0;
  },
  notifyUser: vi.fn(),
  sendPush: vi.fn(),
  getPushIntegrationStatus: () => ({ configured: false }),
}));

const { registerRoutes } = await import("./routes");

// ── Expected surface ────────────────────────────────────────────────
// Every endpoint registered across server/routes/*.ts. Sorted by
// (method, path). Update this list when adding or removing an
// endpoint — that update IS the lock-in.
const EXPECTED: Array<[string, string]> = [
  ["DELETE", "/api/admin/emails/:id"],
  ["DELETE", "/api/admin/emails/templates/:id"],
  ["DELETE", "/api/admin/marketplace/:id"],
  ["DELETE", "/api/admin/partners/:id"],
  ["DELETE", "/api/admin/users/:id"],
  ["DELETE", "/api/admin/users/:id/comp-plan"],
  ["DELETE", "/api/me"],
  ["DELETE", "/api/owner/access-contacts/:type"],
  ["DELETE", "/api/owner/bank-details"],
  ["DELETE", "/api/owner/documents/:id"],
  ["DELETE", "/api/properties/:id"],

  ["GET", "/api/access-contacts/invitations"],
  ["GET", "/api/admin/activity"],
  ["GET", "/api/admin/agreements"],
  ["GET", "/api/admin/audit-log"],
  ["GET", "/api/admin/banners"],
  ["GET", "/api/admin/dashboard"],
  ["GET", "/api/admin/email-quota"],
  ["GET", "/api/admin/emails"],
  ["GET", "/api/admin/emails/:id"],
  ["GET", "/api/admin/emails/:id/recipients"],
  ["GET", "/api/admin/emails/templates"],
  ["GET", "/api/admin/integrations/email/status"],
  ["GET", "/api/admin/integrations/push/status"],
  ["GET", "/api/admin/marketplace"],
  ["GET", "/api/admin/marketplace-leads"],
  ["GET", "/api/admin/partners"],
  ["GET", "/api/admin/plan-labels"],
  ["GET", "/api/admin/platform-fees"],
  ["GET", "/api/admin/portfolios"],
  ["GET", "/api/admin/stripe/live-health"],
  ["GET", "/api/admin/suggestion-requests"],
  ["GET", "/api/admin/tickets"],
  ["GET", "/api/admin/tickets/:id/messages"],
  ["GET", "/api/admin/transactions"],
  ["GET", "/api/admin/units"],
  ["GET", "/api/admin/users"],
  ["GET", "/api/compliance"],
  ["GET", "/api/feature-flags"],
  ["GET", "/api/health/firebase"],
  ["GET", "/api/marketplace"],
  ["GET", "/api/me"],
  ["GET", "/api/me/export"],
  ["GET", "/api/messages/conversations"],
  ["GET", "/api/messages/conversations/:id/messages"],
  ["GET", "/api/owner/access-contacts"],
  ["GET", "/api/owner/agreements"],
  ["GET", "/api/owner/analytics/export"],
  ["GET", "/api/owner/banking"],
  ["GET", "/api/owner/briefing"],
  ["GET", "/api/owner/documents"],
  ["GET", "/api/owner/payments/pending"],
  ["GET", "/api/owner/plan/source"],
  ["GET", "/api/owner/platform-fee-tier"],
  ["GET", "/api/owner/properties"],
  ["GET", "/api/owner/stripe-connect/status"],
  ["GET", "/api/owner/summary"],
  ["GET", "/api/owner/tenants"],
  ["GET", "/api/owner/transactions"],
  ["GET", "/api/owner/unit-cap"],
  ["GET", "/api/partners"],
  ["GET", "/api/portfolios/accessible"],
  ["GET", "/api/privileges-config"],
  ["GET", "/api/properties/:id"],
  ["GET", "/api/properties/:id/transactions"],
  ["GET", "/api/public/properties/:id"],
  ["GET", "/api/social"],
  ["GET", "/api/system-config"],
  ["GET", "/api/tenant/activity"],
  ["GET", "/api/tenant/agreements"],
  ["GET", "/api/tenant/outstanding"],
  ["GET", "/api/tenant/payment-details/:unitId"],
  ["GET", "/api/tenant/units"],
  ["GET", "/api/u/:token"],

  ["PATCH", "/api/admin/emails/:id"],
  ["PATCH", "/api/admin/emails/templates/:id"],
  ["PATCH", "/api/admin/marketplace/:id"],
  ["PATCH", "/api/admin/marketplace-leads/:id"],
  ["PATCH", "/api/admin/partners/:id"],
  ["PATCH", "/api/admin/suggestion-requests/:id"],
  ["PATCH", "/api/admin/tickets/:id"],
  ["PATCH", "/api/admin/units/:id"],
  ["PATCH", "/api/admin/users/:id"],
  ["PATCH", "/api/owner/agreements/:id"],
  ["DELETE", "/api/owner/agreements/:id/document"],
  ["POST", "/api/owner/agreements/:id/document/upload-url"],
  ["POST", "/api/owner/agreements/:id/document/finalize"],
  ["PATCH", "/api/owner/transactions/:id"],
  ["PATCH", "/api/profile"],
  ["PATCH", "/api/properties/:id"],

  ["POST", "/api/access-contacts/invitations/:id/accept"],
  ["POST", "/api/access-contacts/invitations/:id/decline"],
  ["POST", "/api/admin/emails"],
  ["POST", "/api/admin/emails/audience-count"],
  ["POST", "/api/admin/emails/:id/cancel"],
  ["POST", "/api/admin/emails/:id/schedule"],
  ["POST", "/api/admin/emails/:id/send"],
  ["POST", "/api/admin/emails/:id/test"],
  ["POST", "/api/admin/emails/templates"],
  ["POST", "/api/admin/listings/photo/finalize"],
  ["POST", "/api/admin/listings/photo/upload-url"],
  ["POST", "/api/admin/marketplace"],
  ["POST", "/api/admin/notifications/audience-count"],
  ["POST", "/api/admin/notifications/password-reset"],
  ["POST", "/api/admin/notifications/send"],
  ["POST", "/api/admin/partners"],
  ["POST", "/api/admin/partners/:id/renew"],
  ["POST", "/api/admin/portfolios/:id/transfer"],
  ["POST", "/api/admin/push/test"],
  ["POST", "/api/admin/stripe/provision-plan-products"],
  ["POST", "/api/admin/tickets/:id/messages"],
  ["POST", "/api/admin/units"],
  ["POST", "/api/admin/users/:id/comp-plan"],
  ["POST", "/api/admin/users/:id/impersonate"],
  ["POST", "/api/admin/users/:id/send-reset-email"],
  ["POST", "/api/admin/users/invite"],
  ["POST", "/api/ask"],
  ["POST", "/api/auth/account-event"],
  ["POST", "/api/auth/forgot-password"],
  ["POST", "/api/client-errors"],
  ["POST", "/api/csp-report"],
  ["POST", "/api/expert/apply"],
  ["POST", "/api/heartbeat"],
  ["POST", "/api/me/accept-terms"],
  ["POST", "/api/messages/conversations/:id/messages"],
  ["POST", "/api/messages/conversations/:id/read"],
  ["POST", "/api/messages/start"],
  ["POST", "/api/messages/start-with-landlord"],
  ["POST", "/api/owner/agreements"],
  ["POST", "/api/owner/documents/finalize"],
  ["POST", "/api/owner/documents/upload-url"],
  ["POST", "/api/owner/maintenance/resolve/:id"],
  ["POST", "/api/owner/payment/verify/:id"],
  ["POST", "/api/owner/plan/upgrade"],
  ["POST", "/api/owner/stripe-connect/account-link"],
  ["POST", "/api/owner/stripe-connect/disconnect"],
  ["POST", "/api/owner/stripe-connect/login-link"],
  ["POST", "/api/owner/stripe-connect/refresh"],
  ["POST", "/api/owner/stripe-connect/refresh-link"],
  ["POST", "/api/owner/marketplace-leads"],
  ["POST", "/api/owner/suggestion-request"],
  ["POST", "/api/owner/tenants/:id/end"],
  ["POST", "/api/owner/tenants/:id/settle-balance"],
  ["POST", "/api/owner/transactions"],
  ["POST", "/api/profile/photo/finalize"],
  ["POST", "/api/profile/photo/upload-url"],
  ["POST", "/api/properties"],
  ["POST", "/api/properties/:id/transfer"],
  ["POST", "/api/properties/photo/finalize"],
  ["POST", "/api/properties/photo/upload-url"],
  ["POST", "/api/tenant/agreements/:id/respond"],
  ["POST", "/api/tenant/payment/checkout"],
  ["POST", "/api/tenant/payment/finalize"],
  ["POST", "/api/tenant/payment/log"],
  ["POST", "/api/tickets"],
  ["POST", "/api/u/:token"],
  ["POST", "/api/webhooks/resend"],
  ["POST", "/api/webhooks/stripe"],

  ["PUT", "/api/admin/banners"],
  ["PUT", "/api/admin/plan-labels"],
  ["PUT", "/api/admin/platform-fees"],
  ["PUT", "/api/compliance"],
  ["PUT", "/api/feature-flags"],
  ["PUT", "/api/owner/access-contacts/:type"],
  ["PUT", "/api/owner/bank-details"],
  ["PUT", "/api/privileges-config"],
  ["PUT", "/api/social"],
  ["PUT", "/api/system-config"],
];

// Walk the Express internal router stack to extract every registered route.
// Express 5 exposes it as `app.router`; Express 4 used the lazily-created
// `app._router`. One stack entry per app.METHOD() call; `route.path` is the
// literal path string, `route.methods` is { get: true } / { post: true } /
// etc. (both unchanged in v5). Returns sorted [method, path] tuples to compare.
function listRegisteredRoutes(app: Express): Array<[string, string]> {
  // Express types don't expose the internal router publicly; cast through any.
  const a = app as unknown as {
    router?: { stack: unknown[] };
    _router?: { stack: unknown[] };
  };
  const router = a.router ?? a._router;
  if (!router) return [];
  const out: Array<[string, string]> = [];
  for (const layer of router.stack) {
    const l = layer as {
      route?: { path?: string; methods?: Record<string, boolean> };
    };
    if (!l.route?.path || !l.route.methods) continue;
    for (const method of Object.keys(l.route.methods)) {
      if (l.route.methods[method]) {
        out.push([method.toUpperCase(), l.route.path]);
      }
    }
  }
  return out.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
}

describe("registerRoutes surface", () => {
  const app = express();
  registerRoutes(app);
  const actual = listRegisteredRoutes(app);

  it("registers exactly the expected number of endpoints", () => {
    // Hard count guards against a route accidentally landing twice
    // (e.g. mounted from two modules) or silently disappearing.
    expect(actual.length).toBe(EXPECTED.length);
  });

  it("registers every expected (method, path) pair", () => {
    const actualSet = new Set(actual.map(([m, p]) => `${m} ${p}`));
    const missing = EXPECTED.filter(([m, p]) => !actualSet.has(`${m} ${p}`)).map(
      ([m, p]) => `${m} ${p}`,
    );
    expect(missing).toEqual([]);
  });

  it("does not register anything unexpected", () => {
    const expectedSet = new Set(EXPECTED.map(([m, p]) => `${m} ${p}`));
    const unexpected = actual
      .filter(([m, p]) => !expectedSet.has(`${m} ${p}`))
      .map(([m, p]) => `${m} ${p}`);
    expect(unexpected).toEqual([]);
  });

  it("registers no duplicate (method, path) pairs", () => {
    const seen = new Map<string, number>();
    for (const [m, p] of actual) {
      const key = `${m} ${p}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const dupes = Array.from(seen.entries())
      .filter(([, n]) => n > 1)
      .map(([k]) => k);
    expect(dupes).toEqual([]);
  });
});
