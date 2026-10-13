// Regression tests for the portfolio-matrix gate on property READS (QA-01).
//
// Before the fix, GET /api/properties/:id and /:id/transactions authorized
// via a blanket "any active portfolio grant" check, so a low-tier contact
// (e.g. a `legal` contact, which the matrix denies `finance.viewHistory`)
// could read an owner's rent/payment ledger by calling the property
// endpoint instead of the matrix-gated GET /api/owner/transactions.
//
// These tests pin the contract: each read endpoint must consult
// hasPortfolioPrivilege with the privilege that matches what it returns —
// `finance.viewHistory` for the ledger, `property.view` for plain details.
// We mock hasPortfolioPrivilege so we can both control the verdict AND
// assert the exact privilege key the endpoint asks for.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COL } from "../../shared/firestore-schema";

// ── Mutable test state ─────────────────────────────────────────────────
let currentUser: { uid: string; email?: string } = { uid: "legal-uid" };

const propertiesById = new Map<string, Record<string, unknown>>();
const transactionRows: Array<Record<string, unknown>> = [];
const unitRows: Array<Record<string, unknown>> = [];

const hasPortfolioPrivilegeMock =
  vi.fn<(caller: string, owner: string, privilege: string) => Promise<boolean>>();

// ── Mocks ──────────────────────────────────────────────────────────────
function makeQuerySnap(rows: Array<Record<string, unknown>>) {
  return {
    empty: rows.length === 0,
    size: rows.length,
    docs: rows.map((data, i) => ({
      id: (data.id as string) ?? String(i),
      ref: { id: (data.id as string) ?? String(i) },
      data: () => data,
      exists: true,
    })),
  };
}

function rowsFor(name: string): Array<Record<string, unknown>> {
  if (name === COL.transactions) return transactionRows;
  if (name === COL.units) return unitRows;
  if (name === COL.properties)
    return Array.from(propertiesById.entries()).map(([id, d]) => ({ id, ...d }));
  return [];
}

function makeQuery(name: string) {
  const filters: Array<{ field: string; value: unknown }> = [];
  const builder = {
    where(field: string, _op: string, value: unknown) {
      filters.push({ field, value });
      return builder;
    },
    orderBy() {
      return builder;
    },
    limit() {
      return builder;
    },
    async get() {
      let out = rowsFor(name);
      for (const f of filters) out = out.filter((r) => r[f.field] === f.value);
      return makeQuerySnap(out);
    },
  };
  return builder;
}

vi.mock("../firebase", () => ({
  db: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        async get() {
          if (name === COL.properties) {
            const d = propertiesById.get(id);
            return { exists: !!d, data: () => (d ? { id, ...d } : undefined) };
          }
          return { exists: false, data: () => undefined };
        },
      }),
      where: (field: string, op: string, value: unknown) => makeQuery(name).where(field, op, value),
    }),
  }),
  bucket: () => ({}),
}));

vi.mock("../auth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user: unknown }).user = currentUser;
    next();
  },
  requireRole: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

vi.mock("../services/portfolioPrivilege", () => ({
  hasPortfolioPrivilege: (caller: string, owner: string, privilege: string) =>
    hasPortfolioPrivilegeMock(caller, owner, privilege),
}));

// Import AFTER mocks are registered.
import { registerPropertyRoutes } from "./properties";

function makeApp() {
  const app = express();
  app.use(express.json());
  registerPropertyRoutes(app);
  return app;
}

beforeEach(() => {
  currentUser = { uid: "legal-uid" };
  propertiesById.clear();
  transactionRows.length = 0;
  unitRows.length = 0;
  hasPortfolioPrivilegeMock.mockReset();
  propertiesById.set("prop1", { ownerId: "owner-uid", name: "Makariou III Ave" });
  transactionRows.push({
    id: "t1",
    propertyId: "prop1",
    ownerId: "owner-uid",
    amount: 500,
    timestamp: 2,
  });
});

describe("GET /api/properties/:id/transactions — finance.viewHistory gate", () => {
  it("returns 404 (no ledger) when the caller is denied finance.viewHistory", async () => {
    // Models a `legal` contact: granted property.view, denied finance.viewHistory.
    hasPortfolioPrivilegeMock.mockImplementation(async (_c, _o, priv) => priv === "property.view");

    const res = await request(makeApp()).get("/api/properties/prop1/transactions");

    expect(res.status).toBe(404);
    expect(hasPortfolioPrivilegeMock).toHaveBeenCalledWith(
      "legal-uid",
      "owner-uid",
      "finance.viewHistory",
    );
  });

  it("returns the ledger when the caller IS granted finance.viewHistory", async () => {
    hasPortfolioPrivilegeMock.mockResolvedValue(true);

    const res = await request(makeApp()).get("/api/properties/prop1/transactions");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].amount).toBe(500);
    expect(hasPortfolioPrivilegeMock).toHaveBeenCalledWith(
      "legal-uid",
      "owner-uid",
      "finance.viewHistory",
    );
  });
});

describe("GET /api/properties/:id — property.view gate", () => {
  it("allows the property details read with property.view even when finance is denied", async () => {
    hasPortfolioPrivilegeMock.mockImplementation(async (_c, _o, priv) => priv === "property.view");

    const res = await request(makeApp()).get("/api/properties/prop1");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("prop1");
    expect(hasPortfolioPrivilegeMock).toHaveBeenCalledWith(
      "legal-uid",
      "owner-uid",
      "property.view",
    );
  });

  it("returns 404 when the caller lacks property.view entirely", async () => {
    hasPortfolioPrivilegeMock.mockResolvedValue(false);

    const res = await request(makeApp()).get("/api/properties/prop1");

    expect(res.status).toBe(404);
  });

  it("reports €0 rent for a VACANT property even when a Unit carries an admin-set rentAmount", async () => {
    // No active tenancy on prop1 (tenants resolve empty here), but an admin-set
    // Unit.rentAmount exists. That figure is only an expectation — surfacing it
    // as current rent was "phantom rent" the dashboard summary reported as €0.
    hasPortfolioPrivilegeMock.mockResolvedValue(true);
    unitRows.push({ id: "prop1", propertyId: "prop1", rentAmount: 1000, paymentStatus: "pending" });

    const res = await request(makeApp()).get("/api/properties/prop1");

    expect(res.status).toBe(200);
    expect(res.body.occupied).toBe(false);
    expect(res.body.rentAmount).toBe(0);
  });
});
