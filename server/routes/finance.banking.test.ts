// Authorization wiring for the portfolio-scoped banking endpoints:
//   GET    /api/owner/banking
//   PUT    /api/owner/bank-details
//   DELETE /api/owner/bank-details
//
// Banking lives on the portfolio (server/services/portfolioBanking.ts) and
// editing it is gated by the realtime "finance.manageBanking" privilege: the
// owner is always allowed (resolveOwnerScope isSelf short-circuit, exercised
// elsewhere), and a delegated contact (e.g. financial) needs edit permission
// AND that privilege. We mock the ownerScope + portfolioBanking layers and
// assert the routes enforce both gates and write to the RESOLVED portfolio —
// never the caller's own user doc.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TestUser {
  uid: string;
}
let currentUser: TestUser = { uid: "owner-uid" };

// Controllable resolveOwnerScope / authorizePortfolioRead results per test.
type ScopeResult =
  | {
      ok: true;
      ownerId: string;
      portfolioId: string | null;
      permissions: string[];
      isSelf: boolean;
    }
  | { ok: false; status: number; error: string };
let scopeResult: ScopeResult;
let authzResult: { ok: true } | { ok: false; status: number; error: string };
const resolveOwnerScope = vi.fn(async () => scopeResult);
const authorizePortfolioRead = vi.fn(async () => authzResult);

// portfolioBanking spies.
const ensurePortfolio = vi.fn(async (ownerId: string) => ({ id: `pf_${ownerId}`, ownerId }));
const writePortfolioBanking = vi.fn(async () => undefined);
let loadedBanking: Record<string, unknown> = {};
// Phase 2: the GET handler reads by the authorized portfolio doc id.
const loadPortfolioBankingById = vi.fn(async () => loadedBanking);

// Records what the DELETE path writes to the portfolios doc.
const portfolioUpdates: Record<string, unknown>[] = [];
const dbDouble = {
  collection: () => ({
    doc: () => ({
      async update(u: Record<string, unknown>) {
        portfolioUpdates.push(u);
      },
    }),
  }),
};

vi.mock("../firebase", () => ({
  db: () => dbDouble,
  auth: () => ({}),
  bucket: () => ({}),
  storageBucketName: "test-bucket",
  initFirebase: () => ({}),
}));
vi.mock("../auth", () => ({
  requireAuth: (req: { user?: TestUser }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../services/rateLimit", () => ({
  checkAndIncrement: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
vi.mock("../services/ownerScope", () => ({ resolveOwnerScope, authorizePortfolioRead }));
vi.mock("../services/portfolioBanking", () => ({
  ensurePortfolio,
  writePortfolioBanking,
  loadPortfolioBankingById,
}));

const { registerFinanceRoutes } = await import("./finance");

function buildApp() {
  const app = express();
  app.use(express.json());
  registerFinanceRoutes(app);
  return app;
}

beforeEach(() => {
  currentUser = { uid: "owner-uid" };
  scopeResult = {
    ok: true,
    ownerId: "owner-uid",
    portfolioId: "pf-self",
    permissions: ["view", "edit"],
    isSelf: true,
  };
  authzResult = { ok: true };
  loadedBanking = {};
  portfolioUpdates.length = 0;
  resolveOwnerScope.mockClear();
  authorizePortfolioRead.mockClear();
  ensurePortfolio.mockClear();
  writePortfolioBanking.mockClear();
  loadPortfolioBankingById.mockClear();
});

const VALID_IBAN_BODY = {
  holder: "Olive Owner",
  iban: "CY17002001280000001200527600",
  swift: "BCYPCY2N",
};

describe("GET /api/owner/banking", () => {
  it("returns the portfolio's bankDetails for an authorized caller", async () => {
    loadedBanking = {
      bankDetails: { holder: "X", iban: "Y", swift: "Z" },
      connectAccountId: "acct_1",
    };
    const res = await request(buildApp()).get("/api/owner/banking?ownerId=owner-uid");
    expect(res.status).toBe(200);
    // ONLY bankDetails crosses — Connect is the owner's own flow, not exposed here.
    expect(res.body).toEqual({ bankDetails: { holder: "X", iban: "Y", swift: "Z" } });
    expect(authorizePortfolioRead).toHaveBeenCalledWith(
      "owner-uid",
      expect.anything(),
      "finance.manageBanking",
    );
  });

  it("returns { bankDetails: null } when none is set", async () => {
    loadedBanking = {};
    const res = await request(buildApp()).get("/api/owner/banking");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bankDetails: null });
  });

  it("403s (and never reads banking) when the privilege check fails", async () => {
    scopeResult = {
      ok: true,
      ownerId: "other-owner",
      portfolioId: "pf-other",
      permissions: ["view"],
      isSelf: false,
    };
    authzResult = { ok: false, status: 403, error: "nope" };
    const res = await request(buildApp()).get("/api/owner/banking?ownerId=other-owner");
    expect(res.status).toBe(403);
    expect(loadPortfolioBankingById).not.toHaveBeenCalled();
  });

  it("403s before the privilege check when scope resolution fails", async () => {
    scopeResult = { ok: false, status: 403, error: "no access" };
    const res = await request(buildApp()).get("/api/owner/banking?ownerId=stranger");
    expect(res.status).toBe(403);
    expect(authorizePortfolioRead).not.toHaveBeenCalled();
  });
});

describe("PUT /api/owner/bank-details", () => {
  it("writes the IBAN to the ALREADY-AUTHORIZED portfolio id when authorized", async () => {
    scopeResult = {
      ok: true,
      ownerId: "granted-owner",
      portfolioId: "pf-granted",
      permissions: ["view", "edit"],
      isSelf: false,
    };
    const res = await request(buildApp())
      .put("/api/owner/bank-details?portfolioId=pf-granted")
      .send(VALID_IBAN_BODY);
    expect(res.status).toBe(200);
    // requireEdit scope + the banking privilege are both enforced.
    expect(resolveOwnerScope).toHaveBeenCalledWith(expect.anything(), true);
    expect(authorizePortfolioRead).toHaveBeenCalledWith(
      "owner-uid",
      expect.anything(),
      "finance.manageBanking",
    );
    // Wrote to the scope's resolved portfolio id — NOT re-derived via
    // ensurePortfolio(ownerId), so it can't target a different portfolio.
    expect(ensurePortfolio).not.toHaveBeenCalled();
    expect(writePortfolioBanking).toHaveBeenCalledWith("pf-granted", {
      bankDetails: VALID_IBAN_BODY,
    });
  });

  it("403s and writes nothing when the caller lacks the privilege", async () => {
    scopeResult = {
      ok: true,
      ownerId: "granted-owner",
      portfolioId: "pf-granted",
      permissions: ["view", "edit"],
      isSelf: false,
    };
    authzResult = { ok: false, status: 403, error: "nope" };
    const res = await request(buildApp())
      .put("/api/owner/bank-details?portfolioId=pf-granted")
      .send(VALID_IBAN_BODY);
    expect(res.status).toBe(403);
    expect(writePortfolioBanking).not.toHaveBeenCalled();
  });

  it("403s (view-only access) before any privilege check or write", async () => {
    scopeResult = { ok: false, status: 403, error: "view only" };
    const res = await request(buildApp())
      .put("/api/owner/bank-details?ownerId=granted-owner")
      .send(VALID_IBAN_BODY);
    expect(res.status).toBe(403);
    expect(authorizePortfolioRead).not.toHaveBeenCalled();
    expect(writePortfolioBanking).not.toHaveBeenCalled();
  });

  it("validates the IBAN format before writing", async () => {
    const res = await request(buildApp())
      .put("/api/owner/bank-details")
      .send({ holder: "X", iban: "not-an-iban", swift: "BCYPCY2N" });
    expect(res.status).toBe(400);
    expect(writePortfolioBanking).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/owner/bank-details", () => {
  it("clears bankDetails on the resolved portfolio when authorized", async () => {
    scopeResult = {
      ok: true,
      ownerId: "granted-owner",
      portfolioId: "pf-granted",
      permissions: ["view", "edit"],
      isSelf: false,
    };
    const res = await request(buildApp()).delete("/api/owner/bank-details?portfolioId=pf-granted");
    expect(res.status).toBe(200);
    // Cleared on the authorized portfolio id (no ensurePortfolio re-derivation).
    expect(ensurePortfolio).not.toHaveBeenCalled();
    expect(portfolioUpdates).toHaveLength(1);
    expect("bankDetails" in portfolioUpdates[0]).toBe(true);
  });

  it("403s and clears nothing when the privilege check fails", async () => {
    authzResult = { ok: false, status: 403, error: "nope" };
    const res = await request(buildApp()).delete("/api/owner/bank-details?ownerId=granted-owner");
    expect(res.status).toBe(403);
    expect(portfolioUpdates).toHaveLength(0);
  });
});
