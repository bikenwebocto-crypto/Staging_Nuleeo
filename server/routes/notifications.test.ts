// Behavior tests for the notification-marketing broadcast route's URL
// allowlist (M4).
//
// Regression focus: the broadcast click-through opens directly from a
// trusted, Olio-branded push to up to MAX_BROADCAST real users. A
// compromised / rogue comm.email session must not be able to turn the
// channel into a phishing amplifier, so `parseSendInput` rejects any
// `url` that isn't an https link on an oliowallet.com host (no userinfo
// tricks, no suffix tricks, no non-https). These tests pin that gate by
// driving the real route — POST /api/admin/notifications/send — with the
// side-effect services (push, audiences, rate limit) stubbed so only the
// URL validation is exercised.
//
// Mocking strategy mirrors tenant.payment.test.ts: thin module doubles for
// auth, firebase, push, rate limit and the audience resolver, registered
// before the route module is imported (vi.mock is hoisted).

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ───────────────────────────────────────────────────────

// requireAuth injects an admin caller. The route also calls req.user!.uid.
vi.mock("../auth", () => ({
  requireAuth: (req: { user?: { uid: string } }, _res: unknown, next: () => void) => {
    req.user = { uid: "admin-uid" };
    next();
  },
}));

// The route only touches firebase via auth()/db() on OTHER endpoints; the
// broadcast send resolves recipients through the (mocked) audience service,
// so a bare double keeps the import graph happy.
vi.mock("../firebase", () => ({
  auth: () => ({}),
  db: () => ({}),
}));

// Always-allow rate limit so we never short-circuit on the 429 before the
// URL check (the cap runs first, but we want it to pass through).
vi.mock("../services/rateLimit", () => ({
  checkAndIncrement: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

// No real push fires. Report ≥1 recipient so an accepted send returns 200.
vi.mock("../services/push", () => ({
  PushError: class PushError extends Error {},
  sendPush: async () => ({ id: "notif_1", recipients: 1 }),
}));

// resolveTargets (in the route) calls resolvePushAudience for filter sends.
// Return exactly one recipient so an accepted URL is NOT rejected on the
// "zero recipients" check. parseMarketingFilter passes the filter through so
// audience.kind === "filter" parses as valid — keeping the test focused on
// the URL gate, not filter validation.
vi.mock("../services/audiences", () => ({
  parseMarketingFilter: (raw: unknown) => raw,
  resolvePushAudience: async () => [{ userId: "u1", email: "u1@example.com" }],
}));

// Imported AFTER the mocks are registered.
import { registerNotificationRoutes } from "./notifications";

function makeApp() {
  const app = express();
  app.use(express.json());
  // Passthrough privilege gate: the privilege factory is injected via deps,
  // so the test supplies one that always allows.
  registerNotificationRoutes(app, {
    requirePlatformPrivilege: () => (_req, _res, next) => next(),
  });
  return app;
}

const BASE_BODY = {
  title: "New feature",
  message: "Check out the latest update.",
  audience: { kind: "filter", filter: { role: "all", status: "any" } },
};

async function send(url: string) {
  return request(makeApp())
    .post("/api/admin/notifications/send")
    .send({ ...BASE_BODY, url });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/admin/notifications/send — broadcast URL allowlist (M4)", () => {
  it("rejects a non-Olio host", async () => {
    const res = await send("https://evil.example/login");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/oliowallet\.com/i);
  });

  it("rejects a suffix-trick host (oliowallet.com.evil.com)", async () => {
    const res = await send("https://oliowallet.com.evil.com");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/oliowallet\.com/i);
  });

  it("rejects a non-https scheme even on an Olio host", async () => {
    const res = await send("http://app.oliowallet.com");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/oliowallet\.com/i);
  });

  it("rejects a userinfo-trick URL (https://x@evil.com)", async () => {
    const res = await send("https://x@evil.com");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/oliowallet\.com/i);
  });

  it("accepts an https link on an oliowallet.com subdomain", async () => {
    const res = await send("https://app.oliowallet.com/x");
    // The URL passed the allowlist: the request was NOT rejected with the
    // url-validation 400, and (with ≥1 recipient mocked) the send succeeded.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("accepts the apex oliowallet.com host", async () => {
    const res = await send("https://oliowallet.com/promo");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("accepts a send with no url at all (url is optional)", async () => {
    const res = await request(makeApp()).post("/api/admin/notifications/send").send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
