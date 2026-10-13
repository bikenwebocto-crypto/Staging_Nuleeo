// Tests for the defense-in-depth CSRF Origin/Referer guard.
//
// The middleware is a pure Express RequestHandler with no Firebase/Stripe
// dependency, so we exercise it directly with minimal mock req/res objects
// rather than booting the full app.

import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { originGuard } from "./originGuard";

// Build a fake (req, res, next) triple. `next` is a spy; `res.status().json()`
// records the status so we can assert allow (next called) vs 403 (status set).
function run(opts: { method?: string; path?: string; origin?: string; referer?: string }) {
  const headers: Record<string, string | undefined> = {};
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.referer !== undefined) headers.referer = opts.referer;

  const req = {
    method: opts.method ?? "POST",
    path: opts.path ?? "/api/properties",
    headers,
  } as unknown as Request;

  let statusCode: number | undefined;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;

  const next = vi.fn();
  originGuard()(req, res, next);
  return { nextCalled: next.mock.calls.length > 0, statusCode };
}

describe("originGuard", () => {
  afterEach(() => {
    delete process.env.PUBLIC_APP_URL;
  });

  it("allows an allowlisted Olio origin on a state-changing request", () => {
    const r = run({ method: "POST", origin: "https://app.oliowallet.com" });
    expect(r.nextCalled).toBe(true);
    expect(r.statusCode).toBeUndefined();
  });

  it("allows every prod Olio host", () => {
    for (const host of [
      "https://app.oliowallet.com",
      "https://platform.oliowallet.com",
      "https://oliowallet.com",
      "https://www.oliowallet.com",
    ]) {
      const r = run({ method: "PUT", origin: host });
      expect(r.nextCalled).toBe(true);
    }
  });

  it("allows localhost origins for dev", () => {
    expect(run({ origin: "http://localhost:5173" }).nextCalled).toBe(true);
    expect(run({ origin: "http://127.0.0.1:5000" }).nextCalled).toBe(true);
  });

  it("403s a clearly-foreign browser origin on a state-changing route", () => {
    const r = run({ method: "POST", origin: "https://evil.com" });
    expect(r.nextCalled).toBe(false);
    expect(r.statusCode).toBe(403);
  });

  it("403s a foreign Referer when no Origin is present", () => {
    const r = run({ method: "DELETE", referer: "https://evil.com/attack" });
    expect(r.nextCalled).toBe(false);
    expect(r.statusCode).toBe(403);
  });

  it("falls back to Referer host when Origin is absent (allowlisted)", () => {
    const r = run({ method: "POST", referer: "https://app.oliowallet.com/owner" });
    expect(r.nextCalled).toBe(true);
  });

  it("allows when NEITHER Origin nor Referer is present (curl/mobile/server)", () => {
    const r = run({ method: "POST" });
    expect(r.nextCalled).toBe(true);
    expect(r.statusCode).toBeUndefined();
  });

  it("treats a literal 'null' Origin as no-origin (allowed)", () => {
    const r = run({ method: "POST", origin: "null" });
    expect(r.nextCalled).toBe(true);
  });

  it("does not check non-state-changing methods even with a foreign origin", () => {
    expect(run({ method: "GET", origin: "https://evil.com" }).nextCalled).toBe(true);
    expect(run({ method: "HEAD", origin: "https://evil.com" }).nextCalled).toBe(true);
    expect(run({ method: "OPTIONS", origin: "https://evil.com" }).nextCalled).toBe(true);
  });

  it("exempts the Stripe webhook path even with a foreign origin", () => {
    const r = run({
      method: "POST",
      path: "/api/webhooks/stripe",
      origin: "https://evil.com",
    });
    expect(r.nextCalled).toBe(true);
    expect(r.statusCode).toBeUndefined();
  });

  it("exempts the Resend webhook path even with a foreign origin", () => {
    const r = run({
      method: "POST",
      path: "/api/webhooks/resend",
      origin: "https://evil.com",
    });
    expect(r.nextCalled).toBe(true);
  });

  it("exempts the CSP report path even with a foreign origin", () => {
    const r = run({
      method: "POST",
      path: "/api/csp-report",
      origin: "https://evil.com",
    });
    expect(r.nextCalled).toBe(true);
  });

  it("allows the PUBLIC_APP_URL host when set (staging override)", () => {
    process.env.PUBLIC_APP_URL = "https://staging.oliowallet.com";
    const r = run({ method: "POST", origin: "https://staging.oliowallet.com" });
    expect(r.nextCalled).toBe(true);
  });

  it("403s a garbage/unparseable origin that is not 'null'", () => {
    // An Origin header that won't parse as a URL → headerHost returns null →
    // treated as no-origin → allowed. This documents that conservative choice.
    const r = run({ method: "POST", origin: "not-a-url" });
    expect(r.nextCalled).toBe(true);
  });
});
