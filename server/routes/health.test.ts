// Tests the public client-error sink (POST /api/client-errors): it logs at
// WARNING with bounded fields, is IP-rate-limited, and always 204s.

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// Hoisted so the vi.mock factories (hoisted above imports) can close over it.
const h = vi.hoisted(() => ({
  allowed: true,
  warns: [] as Array<{ event: string; fields?: Record<string, unknown> }>,
}));

vi.mock("../firebase", () => ({
  db: () => ({
    collection: () => ({ doc: () => ({ get: async () => ({ exists: true }) }) }),
  }),
}));

vi.mock("../services/rateLimit", () => ({
  checkAndIncrement: async () => ({
    allowed: h.allowed,
    retryAfterSeconds: 0,
    remaining: 0,
  }),
}));

vi.mock("../services/log", () => ({
  logError: () => {},
  logWarn: (event: string, fields?: Record<string, unknown>) => h.warns.push({ event, fields }),
}));

import { registerHealthRoutes } from "./health";

function makeApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" })); // match the production body limit (server/app.ts)
  registerHealthRoutes(app);
  return app;
}

beforeEach(() => {
  h.allowed = true;
  h.warns = [];
});

describe("POST /api/client-errors", () => {
  it("logs a client.error at WARNING and returns 204", async () => {
    const res = await request(makeApp())
      .post("/api/client-errors")
      .send({ kind: "react", message: "boom", stack: "at x", path: "/owner", app: "app" });
    expect(res.status).toBe(204);
    const entry = h.warns.find((w) => w.event === "client.error");
    expect(entry).toBeTruthy();
    expect(entry?.fields?.kind).toBe("react");
    expect(entry?.fields?.message).toBe("boom");
    expect(entry?.fields?.app).toBe("app");
  });

  it("bounds oversized message/stack and normalizes an unknown kind", async () => {
    const res = await request(makeApp())
      .post("/api/client-errors")
      .send({ kind: "totally-bogus", message: "m".repeat(2000), stack: "s".repeat(8000) });
    expect(res.status).toBe(204);
    const f = h.warns.find((w) => w.event === "client.error")?.fields;
    expect((f?.message as string).length).toBe(1000);
    expect((f?.stack as string).length).toBe(4000);
    expect(f?.kind).toBe("unknown"); // not in the allowlist -> "unknown"
  });

  it("silently drops (204, no log) when the IP rate limit is exceeded", async () => {
    h.allowed = false;
    const res = await request(makeApp())
      .post("/api/client-errors")
      .send({ kind: "react", message: "boom" });
    expect(res.status).toBe(204);
    expect(h.warns.find((w) => w.event === "client.error")).toBeUndefined();
  });

  it("does not throw on a malformed/empty body", async () => {
    const res = await request(makeApp()).post("/api/client-errors").send();
    expect(res.status).toBe(204);
  });
});

describe("GET /api/health/firebase", () => {
  it("returns ok:true when Firestore is reachable", async () => {
    const res = await request(makeApp()).get("/api/health/firebase");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
