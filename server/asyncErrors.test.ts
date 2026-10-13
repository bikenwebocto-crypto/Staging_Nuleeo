import { describe, it, expect } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { enableAsyncErrorForwarding } from "./asyncErrors";

// Builds a minimal app with the patch applied, plus a 4-arg error handler that
// reports the error it received. If the patch failed to forward a rejection,
// the /throws request would hang and these tests would time out — so a passing
// run also proves "no hang".
function buildApp() {
  const app = express();
  enableAsyncErrorForwarding(app);

  // A normal async middleware (registered via the patched app.use) must still
  // run and call next() — verifies the wrapper doesn't break sync/normal flow.
  let middlewareRan = false;
  app.use((_req, _res, next) => {
    middlewareRan = true;
    next();
  });

  app.get("/ok", async (_req, res) => {
    await Promise.resolve();
    res.json({ ok: true, middlewareRan });
  });

  app.get("/rejects", async () => {
    await Promise.resolve();
    throw new Error("boom");
  });

  app.get("/sync-throws", () => {
    throw new Error("sync boom");
  });

  // 4-arg error handler — must remain recognized as an error handler (arity 4,
  // left unwrapped) AND must actually receive the forwarded error.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "handled", message: err.message });
  });

  return app;
}

describe("enableAsyncErrorForwarding", () => {
  it("passes a normal async handler through unchanged", async () => {
    const res = await request(buildApp()).get("/ok");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, middlewareRan: true });
  });

  it("forwards a rejected async handler to the error middleware (no hang)", async () => {
    const res = await request(buildApp()).get("/rejects");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("handled");
    expect(res.body.message).toBe("boom");
  });

  it("also catches a synchronous throw from a handler", async () => {
    const res = await request(buildApp()).get("/sync-throws");
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("sync boom");
  });
});
