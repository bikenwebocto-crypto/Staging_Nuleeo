// Behavior tests for POST /api/properties and POST /api/properties/:id/transfer.
//
// These two endpoints are the cap-sensitive write surface for the owner
// portfolio: every "add a property" + "give a property to another
// owner" flow lands here, and both rely on a runTransaction to guard
// against the TOCTOU window between the pre-check and the write. The
// existing routes.integration.test only asserts that the routes are
// mounted; this file pins down the actual privilege + cap + ownership
// branches so a future refactor of either endpoint can't silently
// regress the security-critical paths.
//
// Mocking strategy:
//   - vi.mock("../firebase") supplies an in-memory Firestore double
//     (just the methods the route touches: collection().doc().get/set,
//     runTransaction, count, where().get).
//   - vi.mock("../auth") supplies a fake requireAuth that injects a
//     test-controlled req.user. Tests reach into the same shared
//     `currentUser` slot to change identity between cases.
//   - vi.mock("../services/planLimits") makes resolveUnitCap return
//     whatever the test wants so we don't have to wire the whole
//     plan-resolution + privileges-config chain just to flip a number.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FieldValue } from "firebase-admin/firestore";

// ── Mutable test state ─────────────────────────────────────────────────
// Mocks read these on every call so each test can rewrite them in its
// own setup without re-creating the Express app.

interface TestUser {
  uid: string;
  email?: string;
  profile?: Record<string, unknown>;
}

let currentUser: TestUser = { uid: "owner-uid", email: "owner@example.com" };

// In-memory Firestore. The property endpoints touch: properties (the
// write target), users (looked up by email during transfer + by uid in
// ensurePortfolio), portfolios (the real, unmocked ensurePortfolio
// resolves get-or-create against this map when stamping portfolioId),
// units and tenants. The transaction double resolves a fresh closure
// each call so a test can inject a "concurrent writer" by mutating the
// underlying maps between the pre-check and the txn.
const propertiesById = new Map<string, Record<string, unknown>>();
const usersByEmail = new Map<string, Record<string, unknown>>();
const portfoliosById = new Map<string, Record<string, unknown>>();
const unitsByPropertyId = new Map<string, Array<Record<string, unknown>>>();
const tenantsList: Array<Record<string, unknown>> = [];

// Allow a test to register a one-shot hook that runs the first time
// the runTransaction closure executes — used to simulate a race
// where another writer slots in between the pre-check and the txn.
let onTransactionStart: (() => void) | null = null;

// Cap info returned by resolveUnitCap. Mutated per test.
let capInfo: { plan: string; cap: number | null; used: number } = {
  plan: "basic",
  cap: 2,
  used: 0,
};
// For transfer tests, the recipient's cap. We branch on the lookup
// uid inside the mock so a single test can have asymmetric caps.
let recipientCapInfo: { plan: string; cap: number | null; used: number } = {
  plan: "basic",
  cap: 2,
  used: 0,
};

beforeEach(() => {
  currentUser = { uid: "owner-uid", email: "owner@example.com" };
  propertiesById.clear();
  usersByEmail.clear();
  portfoliosById.clear();
  unitsByPropertyId.clear();
  tenantsList.length = 0;
  onTransactionStart = null;
  capInfo = { plan: "basic", cap: 2, used: 0 };
  recipientCapInfo = { plan: "basic", cap: 2, used: 0 };
});

// ── Firestore double ───────────────────────────────────────────────────

function makeQuerySnap(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  return {
    empty: docs.length === 0,
    size: docs.length,
    docs: docs.map((d) => ({
      id: d.id,
      ref: { id: d.id },
      data: () => d.data,
      exists: true,
    })),
  };
}

function whereFilter(
  rows: Array<{ id: string; data: Record<string, unknown> }>,
  field: string,
  op: string,
  value: unknown,
) {
  if (op !== "==") throw new Error(`unsupported op ${op}`);
  return rows.filter((r) => r.data[field] === value);
}

interface QueryBuilder {
  where: (field: string, op: string, value: unknown) => QueryBuilder;
  limit: (n: number) => QueryBuilder;
  get: () => Promise<ReturnType<typeof makeQuerySnap>>;
  count: () => { get: () => Promise<{ data: () => { count: number } }> };
  _rows: () => Array<{ id: string; data: Record<string, unknown> }>;
}

function makePropertiesQuery(initialFilter?: {
  field: string;
  op: string;
  value: unknown;
}): QueryBuilder {
  const filters: Array<{ field: string; op: string; value: unknown }> = initialFilter
    ? [initialFilter]
    : [];
  const limits: number[] = [];
  const evaluate = () => {
    let rows = Array.from(propertiesById.entries()).map(([id, data]) => ({
      id,
      data,
    }));
    for (const f of filters) rows = whereFilter(rows, f.field, f.op, f.value);
    if (limits.length) rows = rows.slice(0, Math.min(...limits));
    return rows;
  };
  const q: QueryBuilder = {
    where(field, op, value) {
      filters.push({ field, op, value });
      return q;
    },
    limit(n) {
      limits.push(n);
      return q;
    },
    async get() {
      return makeQuerySnap(evaluate());
    },
    count() {
      return {
        async get() {
          return { data: () => ({ count: evaluate().length }) };
        },
      };
    },
    _rows: evaluate,
  };
  return q;
}

function makeUsersQuery(): QueryBuilder {
  const filters: Array<{ field: string; op: string; value: unknown }> = [];
  const limits: number[] = [];
  const evaluate = () => {
    let rows: Array<{ id: string; data: Record<string, unknown> }> = [];
    for (const [, u] of usersByEmail.entries()) {
      rows.push({ id: u.id as string, data: u });
    }
    for (const f of filters) rows = whereFilter(rows, f.field, f.op, f.value);
    if (limits.length) rows = rows.slice(0, Math.min(...limits));
    return rows;
  };
  const q: QueryBuilder = {
    where(field, op, value) {
      filters.push({ field, op, value });
      return q;
    },
    limit(n) {
      limits.push(n);
      return q;
    },
    async get() {
      return makeQuerySnap(evaluate());
    },
    count() {
      return {
        async get() {
          return { data: () => ({ count: evaluate().length }) };
        },
      };
    },
    _rows: evaluate,
  };
  return q;
}

function makeUnitsQuery(): QueryBuilder {
  const filters: Array<{ field: string; op: string; value: unknown }> = [];
  const limits: number[] = [];
  const evaluate = () => {
    let rows: Array<{ id: string; data: Record<string, unknown> }> = [];
    for (const arr of unitsByPropertyId.values()) {
      arr.forEach((u, idx) => rows.push({ id: `${u.propertyId}_unit_${idx}`, data: u }));
    }
    for (const f of filters) rows = whereFilter(rows, f.field, f.op, f.value);
    if (limits.length) rows = rows.slice(0, Math.min(...limits));
    return rows;
  };
  const q: QueryBuilder = {
    where(field, op, value) {
      filters.push({ field, op, value });
      return q;
    },
    limit(n) {
      limits.push(n);
      return q;
    },
    async get() {
      return makeQuerySnap(evaluate());
    },
    count() {
      return {
        async get() {
          return { data: () => ({ count: evaluate().length }) };
        },
      };
    },
    _rows: evaluate,
  };
  return q;
}

function makeTenantsQuery(): QueryBuilder {
  const filters: Array<{ field: string; op: string; value: unknown }> = [];
  const limits: number[] = [];
  const evaluate = () => {
    let rows = tenantsList.map((t, idx) => ({
      id: (t.id as string) ?? `tenant_${idx}`,
      data: t,
    }));
    for (const f of filters) rows = whereFilter(rows, f.field, f.op, f.value);
    if (limits.length) rows = rows.slice(0, Math.min(...limits));
    return rows;
  };
  const q: QueryBuilder = {
    where(field, op, value) {
      filters.push({ field, op, value });
      return q;
    },
    limit(n) {
      limits.push(n);
      return q;
    },
    async get() {
      return makeQuerySnap(evaluate());
    },
    count() {
      return {
        async get() {
          return { data: () => ({ count: evaluate().length }) };
        },
      };
    },
    _rows: evaluate,
  };
  return q;
}

function makePropertyDoc(id: string) {
  return {
    id,
    get ref() {
      return this;
    },
    async get() {
      const data = propertiesById.get(id);
      return {
        exists: !!data,
        id,
        data: () => data,
      };
    },
    async update(updates: Record<string, unknown>) {
      const existing = propertiesById.get(id);
      if (!existing) throw new Error(`No property ${id} to update`);
      // Honor FieldValue.delete() sentinels the way real Firestore does:
      // remove the key rather than storing the sentinel object.
      const next: Record<string, unknown> = { ...existing };
      for (const [k, v] of Object.entries(updates)) {
        if (v instanceof FieldValue) delete next[k];
        else next[k] = v;
      }
      propertiesById.set(id, next);
    },
    async set(data: Record<string, unknown>) {
      propertiesById.set(id, data);
    },
    async delete() {
      propertiesById.delete(id);
    },
  };
}

// Portfolios: the real ensurePortfolio does a get-or-create against this
// collection (query by ownerId, then a transactional doc create) when the
// route stamps portfolioId on a new/transferred property.
function makePortfoliosQuery(): QueryBuilder {
  const filters: Array<{ field: string; op: string; value: unknown }> = [];
  const limits: number[] = [];
  const evaluate = () => {
    let rows = Array.from(portfoliosById.entries()).map(([id, data]) => ({ id, data }));
    for (const f of filters) rows = whereFilter(rows, f.field, f.op, f.value);
    if (limits.length) rows = rows.slice(0, Math.min(...limits));
    return rows;
  };
  const q: QueryBuilder = {
    where(field, op, value) {
      filters.push({ field, op, value });
      return q;
    },
    limit(n) {
      limits.push(n);
      return q;
    },
    async get() {
      return makeQuerySnap(evaluate());
    },
    count() {
      return {
        async get() {
          return { data: () => ({ count: evaluate().length }) };
        },
      };
    },
    _rows: evaluate,
  };
  return q;
}

function makePortfolioDoc(id: string) {
  return {
    id,
    async get() {
      const data = portfoliosById.get(id);
      return { exists: !!data, id, data: () => data };
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      portfoliosById.set(id, opts?.merge ? { ...(portfoliosById.get(id) ?? {}), ...data } : data);
    },
  };
}

// Users by uid (ensurePortfolio reads users/{ownerId} for the portfolioRef
// link). The backing store is keyed by email (seedUser), so resolve by
// scanning for a matching `id` field.
function makeUserDoc(id: string) {
  const findEntry = () => Array.from(usersByEmail.entries()).find(([, u]) => u.id === id);
  return {
    id,
    async get() {
      const entry = findEntry();
      return { exists: !!entry, id, data: () => entry?.[1] };
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const entry = findEntry();
      if (entry) {
        usersByEmail.set(entry[0], opts?.merge ? { ...entry[1], ...data } : { ...data });
      }
    },
  };
}

function makeCollection(name: string) {
  return {
    doc(id?: string) {
      const finalId = id ?? `auto_${Math.random().toString(36).slice(2, 10)}`;
      if (name === "properties") return makePropertyDoc(finalId);
      if (name === "portfolios") return makePortfolioDoc(finalId);
      if (name === "users") return makeUserDoc(finalId);
      // Other collections: a no-op doc shape. The endpoints under test
      // don't touch units/tenants via .doc().
      return {
        id: finalId,
        async get() {
          return { exists: false };
        },
      };
    },
    where(field: string, op: string, value: unknown) {
      if (name === "properties") return makePropertiesQuery({ field, op, value });
      if (name === "portfolios") {
        const q = makePortfoliosQuery();
        return q.where(field, op, value);
      }
      if (name === "users") {
        const q = makeUsersQuery();
        return q.where(field, op, value);
      }
      if (name === "units") {
        const q = makeUnitsQuery();
        return q.where(field, op, value);
      }
      if (name === "tenants") {
        const q = makeTenantsQuery();
        return q.where(field, op, value);
      }
      // Unused collections — return an always-empty query.
      const q: QueryBuilder = {
        where: () => q,
        limit: () => q,
        async get() {
          return makeQuerySnap([]);
        },
        count() {
          return {
            async get() {
              return { data: () => ({ count: 0 }) };
            },
          };
        },
        _rows: () => [],
      };
      return q;
    },
  };
}

const dbDouble = {
  collection: (name: string) => makeCollection(name),
  // Minimal write-batch: the delete-cascade path only needs delete()/commit().
  // Refs in this double don't carry their collection, so deletes are no-ops
  // here — these tests assert the route's guard + response shape, not store
  // mutation (cascade store-mutation is covered structurally by tsc).
  batch() {
    return {
      delete() {},
      set() {},
      update() {},
      async commit() {},
    };
  },
  async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
    if (onTransactionStart) {
      const hook = onTransactionStart;
      onTransactionStart = null;
      hook();
    }
    // Transaction handle: t.get reuses the same in-memory store
    // (transactions in this double aren't actually isolated, but the
    // route logic only needs the snapshot at txn-entry time, which is
    // already after any onTransactionStart hook ran).
    const t = {
      async get(refOrQuery: unknown) {
        const r = refOrQuery as { get: () => Promise<unknown> } | { _rows?: () => unknown };
        if (typeof (r as { get?: unknown }).get === "function") {
          return (r as { get: () => Promise<unknown> }).get();
        }
        throw new Error("unknown ref in t.get");
      },
      set(
        ref: {
          id: string;
          set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => Promise<void>;
        },
        data: Record<string, unknown>,
        opts?: { merge?: boolean },
      ) {
        // Apply immediately by delegating to the ref's own setter so each
        // write lands in its OWN collection store (properties vs portfolios
        // vs users — ensurePortfolio writes the latter two inside its txn).
        // The route doesn't read its own set in the same txn, so eager
        // application matches semantics.
        void ref.set(data, opts);
      },
      update(
        ref: { id: string; update: (updates: Record<string, unknown>) => Promise<void> },
        updates: Record<string, unknown>,
      ) {
        void ref.update(updates);
      },
    };
    return fn(t);
  },
};

vi.mock("../firebase", () => ({
  db: () => dbDouble,
  bucket: () => ({
    file: () => ({
      delete: async () => undefined,
      setMetadata: async () => undefined,
    }),
  }),
  storageBucketName: "test-bucket",
  initFirebase: () => ({}),
  auth: () => ({
    getUserByEmail: async () => {
      const err = new Error("no user") as Error & { code?: string };
      err.code = "auth/user-not-found";
      throw err;
    },
  }),
}));

vi.mock("../auth", () => ({
  requireAuth: (req: { user?: TestUser }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../services/planLimits", () => ({
  resolveUnitCap: vi.fn(async (uid: string) => {
    // Default: the caller is `currentUser.uid`; anyone else is the
    // recipient in a transfer test.
    if (uid === currentUser.uid) return { ...capInfo };
    return { ...recipientCapInfo };
  }),
}));

// safeRedirect.isPublicHttpsUrl is only used to validate the `image`
// field on create. Tests don't pass `image` so the default real
// implementation is fine — no mock needed.

// ── Build the test app ────────────────────────────────────────────────

const { registerPropertyRoutes } = await import("./properties");

function buildApp() {
  const app = express();
  app.use(express.json());
  registerPropertyRoutes(app);
  return app;
}

// ── Helpers ────────────────────────────────────────────────────────────

function seedProperty(id: string, data: Partial<Record<string, unknown>>) {
  propertiesById.set(id, {
    id,
    ownerId: data.ownerId ?? currentUser.uid,
    address: "1 Test St",
    propertyValue: 100000,
    acquisitionPrice: 80000,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...data,
  });
}

function seedUser(email: string, data: Record<string, unknown>) {
  usersByEmail.set(email, { email, ...data });
}

function seedPortfolio(id: string, ownerId: string) {
  portfoliosById.set(id, {
    id,
    ownerId,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

// The single portfolio doc owned by `ownerId` (ensurePortfolio guarantees at
// most one per owner), or undefined when none was created.
function portfolioOf(ownerId: string): Record<string, unknown> | undefined {
  return Array.from(portfoliosById.values()).find((p) => p.ownerId === ownerId);
}

function seedTenant(data: Record<string, unknown>) {
  tenantsList.push(data);
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/properties
// ──────────────────────────────────────────────────────────────────────

describe("POST /api/properties", () => {
  it("creates the property and returns 201 when the caller is under their cap", async () => {
    capInfo = { plan: "basic", cap: 2, used: 0 };
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties")
      .send({ address: "742 Evergreen Terrace", propertyValue: 250000 });

    expect(res.status).toBe(201);
    expect(res.body.address).toBe("742 Evergreen Terrace");
    expect(res.body.ownerId).toBe("owner-uid");
    expect(res.body.propertyValue).toBe(250000);
    // Doc was persisted to the in-memory store.
    expect(propertiesById.size).toBe(1);
    // Stamped with the owner's stable portfolio id (auto-created by
    // ensurePortfolio since the owner had none yet).
    const ownerPortfolio = portfolioOf("owner-uid");
    expect(ownerPortfolio).toBeTruthy();
    expect(res.body.portfolioId).toBe(ownerPortfolio?.id);
  });

  it("stamps an EXISTING portfolio's id rather than creating a second portfolio", async () => {
    capInfo = { plan: "basic", cap: 2, used: 0 };
    seedPortfolio("pf-owner", "owner-uid");
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties")
      .send({ address: "12 Existing Portfolio Rd", propertyValue: 150000 });

    expect(res.status).toBe(201);
    expect(res.body.portfolioId).toBe("pf-owner");
    // get-or-create must reuse the seeded portfolio, never mint a duplicate.
    expect(portfoliosById.size).toBe(1);
    const stored = Array.from(propertiesById.values()).find(
      (p) => p.address === "12 Existing Portfolio Rd",
    );
    expect(stored?.portfolioId).toBe("pf-owner");
  });

  it("returns 402 with plan/cap/used when the pre-check finds the caller at cap", async () => {
    // Seed two existing properties so the caller is AT the cap.
    seedProperty("p1", { ownerId: "owner-uid" });
    seedProperty("p2", { ownerId: "owner-uid" });
    capInfo = { plan: "basic", cap: 2, used: 2 };
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties")
      .send({ address: "Third property", propertyValue: 100000 });

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("Upgrade required");
    expect(res.body.privilege).toBe("units.unlimited");
    expect(res.body.plan).toBe("basic");
    expect(res.body.cap).toBe(2);
    expect(res.body.used).toBe(2);
    // No new doc.
    expect(propertiesById.size).toBe(2);
  });

  it("returns 402 when a concurrent writer adds a row between the pre-check and the transaction", async () => {
    // Pre-check sees the owner at used=1 of 2. While the transaction
    // closure runs, another writer slots in a second property — the
    // txn's where() re-read now sees 2 rows and bails with capExceeded.
    // The txn counts by stable portfolioId (mirrors resolveUnitCap), so the
    // seeds must carry the owner's portfolioId.
    seedPortfolio("pf-owner", "owner-uid");
    seedProperty("p1", { ownerId: "owner-uid", portfolioId: "pf-owner" });
    capInfo = { plan: "basic", cap: 2, used: 1 };
    onTransactionStart = () => {
      seedProperty("p_concurrent", { ownerId: "owner-uid", portfolioId: "pf-owner" });
    };
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties")
      .send({ address: "Loser of the race", propertyValue: 100000 });

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("Upgrade required");
    // Two rows: the seeded one + the concurrent writer's row. The
    // racing request's doc must NOT have been written.
    expect(propertiesById.size).toBe(2);
    expect(
      Array.from(propertiesById.values()).find((p) => p.address === "Loser of the race"),
    ).toBeUndefined();
  });

  it("returns 400 when address is missing", async () => {
    capInfo = { plan: "pro", cap: null, used: 99 };
    const app = buildApp();

    const res = await request(app).post("/api/properties").send({ propertyValue: 250000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/address/i);
    expect(propertiesById.size).toBe(0);
  });

  it("does NOT count soft-deactivated (inactive) properties against the cap in the authoritative txn", async () => {
    // Owner on cap=2 with 1 ACTIVE + 1 INACTIVE property under their portfolio.
    // resolveUnitCap (pre-check) excludes inactive → used=1 → pre-check passes.
    // The txn re-check must ALSO exclude the inactive one (active=1 < cap=2) and
    // let the create through. The old raw count-by-ownerId saw 2 and 402'd.
    seedPortfolio("pf-owner", "owner-uid");
    seedProperty("active-1", { ownerId: "owner-uid", portfolioId: "pf-owner" });
    seedProperty("inactive-1", {
      ownerId: "owner-uid",
      portfolioId: "pf-owner",
      status: "inactive",
    });
    capInfo = { plan: "basic", cap: 2, used: 1 };
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties")
      .send({ address: "New active unit", propertyValue: 120000 });

    expect(res.status).toBe(201);
    // active-1 + inactive-1 + the newly created one.
    expect(propertiesById.size).toBe(3);
  });

  it("DOES count active properties by portfolioId in the txn (cap still enforced)", async () => {
    // Two ACTIVE properties under the portfolio, cap=2 — the txn must still 402.
    // Pre-check passes (used=1, simulating a racing create) so we exercise the
    // txn re-check specifically, now keyed on portfolioId.
    seedPortfolio("pf-owner", "owner-uid");
    seedProperty("active-1", { ownerId: "owner-uid", portfolioId: "pf-owner" });
    seedProperty("active-2", { ownerId: "owner-uid", portfolioId: "pf-owner" });
    capInfo = { plan: "basic", cap: 2, used: 1 };
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties")
      .send({ address: "Over cap", propertyValue: 120000 });

    expect(res.status).toBe(402);
    // The 402 reports the ACTUAL active count read inside the txn (2), not just
    // the cap — so it agrees with the pre-check's `used` instead of contradicting it.
    expect(res.body.used).toBe(2);
    expect(propertiesById.size).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Bedroom / bathroom count validation (POST + PATCH)
// ──────────────────────────────────────────────────────────────────────
// bedrooms/baths must be a non-negative integer within a sane bound. The old
// num() allowlist accepted -1, 2.5, and 9999, silently corrupting listing /
// public-share displays. A real 0 (studio / no separate bath) is legitimate
// and must persist — these tests pin down both ends.

describe("bedrooms/bathrooms validation", () => {
  it.each([
    ["negative", -1],
    ["fractional", 2.5],
    ["over the cap", 9999],
  ])("POST rejects bedrooms=%s with 400 and writes nothing", async (_label, bedrooms) => {
    capInfo = { plan: "pro", cap: null, used: 0 };
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties")
      .send({ address: "1 Test St", propertyValue: 100000, bedrooms });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bedrooms/i);
    expect(propertiesById.size).toBe(0);
  });

  it.each([
    ["negative parking", { parking: -1 }, /parking/i],
    ["fractional parking", { parking: 1.5 }, /parking/i],
    ["lat out of range", { lat: 91 }, /lat/i],
    ["lng out of range", { lng: -181 }, /lng/i],
    ["zero sqm", { sqm: "0" }, /sqm/i],
    ["negative sqm", { sqm: "-50" }, /sqm/i],
    ["non-numeric sqm", { sqm: "big" }, /sqm/i],
  ])("POST rejects %s with 400 and writes nothing", async (_label, patch, re) => {
    capInfo = { plan: "pro", cap: null, used: 0 };
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties")
      .send({ address: "1 Test St", propertyValue: 100000, ...patch });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(re);
    expect(propertiesById.size).toBe(0);
  });

  it("POST accepts valid parking / coordinates / sqm", async () => {
    capInfo = { plan: "pro", cap: null, used: 0 };
    const app = buildApp();

    const res = await request(app).post("/api/properties").send({
      address: "1 Test St",
      propertyValue: 100000,
      parking: 2,
      lat: 34.9,
      lng: 33.6,
      sqm: "120",
    });

    expect(res.status).toBe(201);
    expect(res.body.parking).toBe(2);
    expect(res.body.lat).toBe(34.9);
    expect(res.body.sqm).toBe("120");
  });

  it("POST rejects a fractional baths value with 400", async () => {
    capInfo = { plan: "pro", cap: null, used: 0 };
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties")
      .send({ address: "1 Test St", propertyValue: 100000, baths: 1.5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/baths/i);
    expect(propertiesById.size).toBe(0);
  });

  it("POST accepts and persists bedrooms=0 (studio) instead of dropping it", async () => {
    capInfo = { plan: "pro", cap: null, used: 0 };
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties")
      .send({ address: "Studio flat", propertyValue: 90000, bedrooms: 0, baths: 1 });

    expect(res.status).toBe(201);
    // A genuine 0 must round-trip — not be silently omitted.
    expect(res.body.bedrooms).toBe(0);
    expect(res.body.baths).toBe(1);
    const stored = Array.from(propertiesById.values()).find((p) => p.address === "Studio flat");
    expect(stored?.bedrooms).toBe(0);
  });

  it("PATCH rejects bedrooms=-1 with 400 and leaves the property unchanged", async () => {
    seedProperty("prop1", { ownerId: "owner-uid", bedrooms: 3 });
    const app = buildApp();

    const res = await request(app).patch("/api/properties/prop1").send({ bedrooms: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bedrooms/i);
    // Untouched.
    expect(propertiesById.get("prop1")?.bedrooms).toBe(3);
  });

  it("PATCH persists bedrooms=0 (studio) rather than treating it as 'not set'", async () => {
    seedProperty("prop1", { ownerId: "owner-uid", bedrooms: 3 });
    const app = buildApp();

    const res = await request(app).patch("/api/properties/prop1").send({ bedrooms: 0 });

    expect(res.status).toBe(200);
    expect(res.body.bedrooms).toBe(0);
    expect(propertiesById.get("prop1")?.bedrooms).toBe(0);
  });

  it("PATCH to owner-occupied clears any stored occupancyStatus (no contradictory state)", async () => {
    // A property that was rented out and flagged "rented"...
    seedProperty("prop1", {
      ownerId: "owner-uid",
      propertyUse: "rent",
      occupancyStatus: "rented",
    });
    const app = buildApp();

    // ...is switched to owner-occupied, which is a *use*, not a status.
    const res = await request(app)
      .patch("/api/properties/prop1")
      .send({ propertyUse: "owner_occupied" });

    expect(res.status).toBe(200);
    expect(res.body.propertyUse).toBe("owner_occupied");
    // The stale "rented" status must be gone — we never persist a current
    // status alongside owner-occupancy.
    expect(res.body.occupancyStatus).toBeUndefined();
    expect(propertiesById.get("prop1")).not.toHaveProperty("occupancyStatus");
  });
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/properties/:id/transfer
// ──────────────────────────────────────────────────────────────────────

describe("POST /api/properties/:id/transfer", () => {
  it("flips ownerId when the recipient is under cap and the property has no occupied unit", async () => {
    seedProperty("prop1", { ownerId: "owner-uid", address: "1 Test St" });
    seedUser("new-owner@example.com", { id: "recipient-uid" });
    recipientCapInfo = { plan: "basic", cap: 5, used: 1 };
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties/prop1/transfer")
      .send({ recipientEmail: "new-owner@example.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, newOwnerId: "recipient-uid" });
    expect(propertiesById.get("prop1")?.ownerId).toBe("recipient-uid");
    // The property's portfolioId moved with it — ensurePortfolio auto-created
    // a portfolio for the recipient (they had none) and the txn stamped it.
    const recipientPortfolio = portfolioOf("recipient-uid");
    expect(recipientPortfolio).toBeTruthy();
    expect(propertiesById.get("prop1")?.portfolioId).toBe(recipientPortfolio?.id);
  });

  it("reassigns portfolioId to the recipient's EXISTING portfolio on transfer", async () => {
    // The property starts stamped into the sender's portfolio; after the
    // transfer it must point at the recipient's (stable Portfolio.id, not
    // the display label) — leaving the old id would strand the property in
    // the previous owner's portfolio.
    seedPortfolio("pf-sender", "owner-uid");
    seedPortfolio("pf-recipient", "recipient-uid");
    seedProperty("prop1", { ownerId: "owner-uid", portfolioId: "pf-sender" });
    seedUser("new-owner@example.com", { id: "recipient-uid" });
    recipientCapInfo = { plan: "basic", cap: 5, used: 1 };
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties/prop1/transfer")
      .send({ recipientEmail: "new-owner@example.com" });

    expect(res.status).toBe(200);
    expect(propertiesById.get("prop1")?.ownerId).toBe("recipient-uid");
    expect(propertiesById.get("prop1")?.portfolioId).toBe("pf-recipient");
    // get-or-create reused the seeded portfolios — no duplicates minted.
    expect(portfoliosById.size).toBe(2);
  });

  it("returns 403 when the caller is not the property owner", async () => {
    seedProperty("prop1", { ownerId: "different-owner" });
    seedUser("new-owner@example.com", { id: "recipient-uid" });
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties/prop1/transfer")
      .send({ recipientEmail: "new-owner@example.com" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
    // Owner unchanged.
    expect(propertiesById.get("prop1")?.ownerId).toBe("different-owner");
  });

  it("returns 409 when transferring a soft-deactivated (inactive) property", async () => {
    // Hidden from the owner's own UI; its inactive status + purge clock must not
    // carry to the recipient. They must restore it first.
    seedProperty("prop1", { ownerId: "owner-uid", status: "inactive" });
    seedUser("new-owner@example.com", { id: "recipient-uid" });
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties/prop1/transfer")
      .send({ recipientEmail: "new-owner@example.com" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/restore it before transferring/i);
    expect(propertiesById.get("prop1")?.ownerId).toBe("owner-uid");
  });

  it("returns 400 when recipient email belongs to the caller themselves", async () => {
    seedProperty("prop1", { ownerId: "owner-uid" });
    // The user lookup returns the SAME uid as the caller.
    seedUser("owner@example.com", { id: "owner-uid" });
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties/prop1/transfer")
      .send({ recipientEmail: "owner@example.com" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already own/i);
    expect(propertiesById.get("prop1")?.ownerId).toBe("owner-uid");
  });

  it("returns 402 with recipient plan info when the recipient is at their cap", async () => {
    seedProperty("prop1", { ownerId: "owner-uid" });
    seedUser("new-owner@example.com", { id: "recipient-uid" });
    // Recipient already maxed out on their plan. The pre-check fires
    // before the transaction.
    recipientCapInfo = { plan: "basic", cap: 2, used: 2 };
    // Seed two existing properties for the recipient so the counted
    // pre-check matches the cap-info we report.
    seedProperty("r1", { ownerId: "recipient-uid" });
    seedProperty("r2", { ownerId: "recipient-uid" });
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties/prop1/transfer")
      .send({ recipientEmail: "new-owner@example.com" });

    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/Recipient is at their plan/i);
    expect(res.body.plan).toBe("basic");
    expect(res.body.cap).toBe(2);
    expect(res.body.used).toBe(2);
    // Transfer must not have happened — neither the owner flip nor the
    // portfolio re-stamp.
    expect(propertiesById.get("prop1")?.ownerId).toBe("owner-uid");
    expect(propertiesById.get("prop1")?.portfolioId).toBeUndefined();
  });

  it("returns 409 when the property has an active tenancy", async () => {
    seedProperty("prop1", { ownerId: "owner-uid" });
    seedUser("new-owner@example.com", { id: "recipient-uid" });
    // Occupancy is derived from an ACTIVE tenancy, not Unit.currentTenantId
    // (which nothing ever writes). Seed a live tenancy on this property.
    seedTenant({
      id: "ten-1",
      propertyId: "prop1",
      ownerId: "owner-uid",
      status: "active",
      rentAmount: 1000,
    });
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties/prop1/transfer")
      .send({ recipientEmail: "new-owner@example.com" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/rented property/i);
    expect(propertiesById.get("prop1")?.ownerId).toBe("owner-uid");
  });

  it("returns 409 when the property has a pending tenant invite (would strand the lease)", async () => {
    seedProperty("prop1", { ownerId: "owner-uid" });
    seedUser("new-owner@example.com", { id: "recipient-uid" });
    // An invite was sent but not yet accepted — the tenancy is "pending".
    // Transferring would leave the Tenant/Agreement on the old owner.
    seedTenant({
      id: "ten-1",
      propertyId: "prop1",
      ownerId: "owner-uid",
      status: "pending",
      rentAmount: 1000,
    });
    const app = buildApp();

    const res = await request(app)
      .post("/api/properties/prop1/transfer")
      .send({ recipientEmail: "new-owner@example.com" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/pending tenant invite/i);
    expect(propertiesById.get("prop1")?.ownerId).toBe("owner-uid");
  });
});

// ──────────────────────────────────────────────────────────────────────
// DELETE /api/properties/:id — occupancy guard + cascade
// ──────────────────────────────────────────────────────────────────────

describe("DELETE /api/properties/:id", () => {
  it("returns 409 when the property has an active tenancy (derived from tenancies, not the never-written Unit.currentTenantId)", async () => {
    seedProperty("prop1", { ownerId: "owner-uid" });
    seedTenant({
      id: "ten-1",
      propertyId: "prop1",
      ownerId: "owner-uid",
      status: "active",
    });
    const app = buildApp();

    const res = await request(app).delete("/api/properties/prop1");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/active tenant/i);
  });

  it("allows delete when only a non-active tenancy exists, and reports agreements in the cascade", async () => {
    seedProperty("prop1", { ownerId: "owner-uid" });
    // A declined tenancy must NOT block deletion (only active does).
    seedTenant({
      id: "ten-old",
      propertyId: "prop1",
      ownerId: "owner-uid",
      status: "declined",
    });
    const app = buildApp();

    const res = await request(app).delete("/api/properties/prop1");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Agreements are now part of the cascade (orphan-lease fix).
    expect(res.body.cascaded).toHaveProperty("agreements");
  });
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/public/properties/:id — unauthenticated shareable view
// ──────────────────────────────────────────────────────────────────────

describe("GET /api/public/properties/:id", () => {
  it("returns only the public-safe subset and 200, with NO auth", async () => {
    // Seed a property loaded with sensitive data the public view must
    // never expose.
    seedProperty("pub1", {
      ownerId: "owner-uid",
      name: "Seaside Villa",
      address: "1 Test St",
      city: "Latsia",
      country: "Cyprus",
      postalCode: "2220",
      propertyType: "House",
      sqm: "130",
      builtYear: "2018",
      energyClass: "B",
      developmentStatus: "fully_developed",
      propertyUse: "rent",
      parking: 2,
      elevator: true,
      // Sensitive — must be stripped:
      propertyValue: 200000,
      acquisitionPrice: 150000,
      acquisitionYear: "1999",
      rentPrice: 1200,
      ownershipType: "individual",
      companyName: "Acme Holdings Ltd",
      titleDeedsStatus: "issued",
    });
    const app = buildApp();

    // No Authorization header — the route is intentionally public.
    const res = await request(app).get("/api/public/properties/pub1");

    expect(res.status).toBe(200);
    // Public-safe fields present.
    expect(res.body.name).toBe("Seaside Villa");
    expect(res.body.address).toBe("1 Test St");
    expect(res.body.energyClass).toBe("B");
    expect(res.body.parking).toBe(2);
    expect(res.body.propertyUse).toBe("rent");
    // Sensitive fields absent. ownerId is the key leak to guard against.
    expect(res.body).not.toHaveProperty("ownerId");
    expect(res.body).not.toHaveProperty("propertyValue");
    expect(res.body).not.toHaveProperty("acquisitionPrice");
    expect(res.body).not.toHaveProperty("acquisitionYear");
    expect(res.body).not.toHaveProperty("rentPrice");
    expect(res.body).not.toHaveProperty("ownershipType");
    expect(res.body).not.toHaveProperty("companyName");
    expect(res.body).not.toHaveProperty("titleDeedsStatus");
  });

  it("returns 404 for an unknown id", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/public/properties/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Property not found");
  });
});
