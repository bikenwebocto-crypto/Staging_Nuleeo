// Behavior tests for POST /api/admin/units — the admin "register a unit for an
// owner" endpoint.
//
// Regression focus (extreme-QA findings):
//   • Plan-cap enforcement: an admin must NOT silently push an owner over their
//     plan's unit cap (admin-created properties count via resolveUnitCap). A
//     superadmin can deliberately override with overrideCap:true; a non-
//     superadmin's flag is ignored (server re-checks the role).
//   • unitId === propertyId: the Unit doc must be created AT the property's id,
//     not a random auto-id, or the owner/tenant rent-charge paths can never
//     resolve it (orphan unit).
//
// Mocking strategy: an in-memory Firestore double for users/properties/units,
// plus controllable resolveUnitCap + resolvePlatformRole so each test pins one
// branch. The injected requireRole/requirePlatformPrivilege are permissive —
// their gating is covered by the route-surface integration test.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
interface TestUser {
  uid: string;
  profile?: Record<string, unknown>;
}

const store: Record<string, Map<string, Row>> = {
  users: new Map(),
  properties: new Map(),
  units: new Map(),
};

let currentUser: TestUser;
let capInfo: { plan: string; cap: number | null; used: number };
let platformRole: "admin" | "superadmin";
let autoId = 0;

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
  currentUser = { uid: "admin-uid", profile: { roles: ["admin"], platformRole: "support" } };
  capInfo = { plan: "basic", cap: 2, used: 0 };
  platformRole = "admin";
  autoId = 0;
  // The target owner the unit is being registered for.
  store.users.set("owner-1", { id: "owner-1", roles: ["owner"] });
});

// ── Firestore double ───────────────────────────────────────────────────

function makeRef(col: string, id: string) {
  return {
    id,
    async get() {
      const data = store[col].get(id);
      return { exists: !!data, id, data: () => data };
    },
    async set(data: Row, opts?: { merge?: boolean }) {
      store[col].set(id, opts?.merge ? { ...(store[col].get(id) ?? {}), ...data } : data);
    },
  };
}

// A query is the collection narrowed by a chain of where() equality filters.
function makeQuery(col: string, filters: Array<[string, unknown]>) {
  return {
    __col: col,
    __filters: filters,
    where(field: string, _op: string, value: unknown) {
      return makeQuery(col, [...filters, [field, value]]);
    },
    matches(): Array<{ data: () => Row }> {
      return [...store[col].values()]
        .filter((row) => filters.every(([f, v]) => row[f] === v))
        .map((row) => ({ data: () => row }));
    },
  };
}

const dbDouble = {
  collection(name: string) {
    return {
      doc(id?: string) {
        return makeRef(name, id ?? `auto_${name}_${autoId++}`);
      },
      where(field: string, _op: string, value: unknown) {
        return makeQuery(name, [[field, value]]);
      },
    };
  },
  // The POST writes Property + Unit atomically AND re-counts the portfolio's
  // properties inside the txn for the cap recheck — so the double's `t.get`
  // resolves the where-query against the live store, and `t.set` forwards to ref.
  async runTransaction<T>(cb: (t: unknown) => Promise<T>): Promise<T> {
    const t = {
      async get(query: { matches: () => Array<{ data: () => Row }> }) {
        return { docs: query.matches() };
      },
      set(ref: { set: (d: Row) => void }, data: Row) {
        ref.set(data);
      },
    };
    return cb(t);
  },
};

// ── Module mocks ───────────────────────────────────────────────────────

vi.mock("../firebase", () => ({ db: () => dbDouble }));

vi.mock("../auth", () => ({
  requireAuth: (req: { user?: TestUser }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
}));

vi.mock("../services/planLimits", () => ({
  resolveUnitCap: vi.fn(async () => capInfo),
}));

vi.mock("../services/platformPrivilege", () => ({
  resolvePlatformRole: vi.fn(() => platformRole),
  hasPlatformPrivilege: vi.fn(async () => true),
}));

vi.mock("../services/portfolioBanking", () => ({
  ensurePortfolio: vi.fn(async () => ({ id: "pf-owner-1" })),
}));

vi.mock("../services/rentChange", () => ({
  applyRentChange: vi.fn(),
  findActiveAgreementIdForUnit: vi.fn(),
}));

vi.mock("../services/log", () => ({ logWarn: vi.fn() }));

const { registerAdminUnitsRoutes } = await import("./adminUnits");

function buildApp() {
  const app = express();
  app.use(express.json());
  registerAdminUnitsRoutes(app, {
    requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    requirePlatformPrivilege: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  });
  return app;
}

const VALID = { ownerId: "owner-1", address: "1 Test St", propertyType: "Apartment" };

// ──────────────────────────────────────────────────────────────────────

describe("POST /api/admin/units — plan-cap enforcement", () => {
  it("402s when the owner is already at their plan cap and writes nothing", async () => {
    capInfo = { plan: "basic", cap: 2, used: 2 };

    const res = await request(buildApp()).post("/api/admin/units").send(VALID);

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("owner_at_cap");
    expect(store.properties.size).toBe(0);
    expect(store.units.size).toBe(0);
  });

  it("ignores overrideCap from a non-superadmin (still 402)", async () => {
    capInfo = { plan: "basic", cap: 2, used: 2 };
    platformRole = "admin";

    const res = await request(buildApp())
      .post("/api/admin/units")
      .send({ ...VALID, overrideCap: true });

    expect(res.status).toBe(402);
    expect(store.properties.size).toBe(0);
  });

  it("lets a superadmin override the cap and creates the unit", async () => {
    capInfo = { plan: "basic", cap: 2, used: 2 };
    platformRole = "superadmin";

    const res = await request(buildApp())
      .post("/api/admin/units")
      .send({ ...VALID, overrideCap: true });

    expect(res.status).toBe(201);
    expect(store.properties.size).toBe(1);
    expect(store.units.size).toBe(1);
  });

  it("creates normally when the owner is under cap", async () => {
    capInfo = { plan: "basic", cap: 2, used: 1 };

    const res = await request(buildApp()).post("/api/admin/units").send(VALID);

    expect(res.status).toBe(201);
    expect(store.units.size).toBe(1);
  });

  it("re-counts inside the txn and 402s when a concurrent create already filled the cap", async () => {
    // Pre-check sees the owner UNDER cap (the stale snapshot a racing request
    // observed), but the live store already holds cap-many active properties for
    // this owner's portfolio. The in-transaction recount must catch it and 402.
    capInfo = { plan: "basic", cap: 2, used: 1 };
    store.properties.set("p-a", { id: "p-a", portfolioId: "pf-owner-1" });
    store.properties.set("p-b", { id: "p-b", portfolioId: "pf-owner-1" });

    const res = await request(buildApp()).post("/api/admin/units").send(VALID);

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("owner_at_cap");
    // The losing create must write nothing — only the two pre-existing rows remain.
    expect(store.properties.size).toBe(2);
    expect(store.units.size).toBe(0);
  });

  it("does NOT count soft-deactivated properties against the in-txn cap", async () => {
    // An inactive property (plan-downgrade hold) must not consume a slot — the
    // owner is at 1 active + 1 inactive on a cap of 2, so the create succeeds.
    capInfo = { plan: "basic", cap: 2, used: 1 };
    store.properties.set("p-active", { id: "p-active", portfolioId: "pf-owner-1" });
    store.properties.set("p-inactive", {
      id: "p-inactive",
      portfolioId: "pf-owner-1",
      status: "inactive",
    });

    const res = await request(buildApp()).post("/api/admin/units").send(VALID);

    expect(res.status).toBe(201);
    expect(store.units.size).toBe(1);
  });

  it("superadmin override skips the in-txn recount even when over the live cap", async () => {
    capInfo = { plan: "basic", cap: 2, used: 1 };
    platformRole = "superadmin";
    store.properties.set("p-a", { id: "p-a", portfolioId: "pf-owner-1" });
    store.properties.set("p-b", { id: "p-b", portfolioId: "pf-owner-1" });

    const res = await request(buildApp())
      .post("/api/admin/units")
      .send({ ...VALID, overrideCap: true });

    expect(res.status).toBe(201);
    expect(store.units.size).toBe(1);
  });
});

describe("POST /api/admin/units — unitId === propertyId", () => {
  it("creates the Unit doc AT the property's id, not a random auto-id", async () => {
    capInfo = { plan: "pro", cap: null, used: 9 };

    const res = await request(buildApp()).post("/api/admin/units").send(VALID);

    expect(res.status).toBe(201);
    const propId = [...store.properties.keys()][0];
    const unitId = [...store.units.keys()][0];
    expect(unitId).toBe(propId);
    expect(res.body.unit.id).toBe(res.body.property.id);
    expect(res.body.unit.propertyId).toBe(res.body.property.id);
  });
});

describe("PATCH /api/admin/units/:id — image clear", () => {
  it("allows an empty-string image to clear it (mirrors the owner PATCH)", async () => {
    store.properties.set("prop-x", {
      id: "prop-x",
      ownerId: "owner-1",
      address: "1 Test St",
      image: "https://cdn.example.com/old.jpg",
    });

    const res = await request(buildApp()).patch("/api/admin/units/prop-x").send({ image: "" });

    expect(res.status).toBe(200);
    expect(store.properties.get("prop-x")?.image).toBe("");
  });

  it("still rejects a non-empty, non-public-https image", async () => {
    store.properties.set("prop-y", { id: "prop-y", ownerId: "owner-1", address: "2 Test St" });

    const res = await request(buildApp())
      .patch("/api/admin/units/prop-y")
      .send({ image: "http://169.254.169.254/" });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/units — owner-path parity", () => {
  it("defaults propertyUse to 'rent' so the unit classifies as a rental", async () => {
    capInfo = { plan: "pro", cap: null, used: 0 };

    const res = await request(buildApp()).post("/api/admin/units").send(VALID);

    expect(res.status).toBe(201);
    expect(res.body.property.propertyUse).toBe("rent");
  });

  it.each([
    ["negative bedrooms", { bedrooms: -1 }, /bedrooms/i],
    ["fractional baths", { baths: 1.5 }, /baths/i],
    ["negative parking", { parking: -2 }, /parking/i],
    ["lat out of range", { lat: 200 }, /lat/i],
    ["zero sqm", { sqm: "0" }, /sqm/i],
  ])("rejects %s with 400 and writes nothing", async (_label, patch, re) => {
    capInfo = { plan: "pro", cap: null, used: 0 };

    const res = await request(buildApp())
      .post("/api/admin/units")
      .send({ ...VALID, ...patch });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(re);
    expect(store.properties.size).toBe(0);
    expect(store.units.size).toBe(0);
  });
});
