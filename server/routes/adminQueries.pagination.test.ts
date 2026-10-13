// QA-03 regression: the admin LIST endpoints must bound their Firestore
// reads instead of pulling whole collections and slicing in JS.
//
// Two things are asserted per endpoint:
//   (a) the query builder received the expected orderBy + limit (and,
//       for time-ranged / JOIN paths, a `where(... in ...)` scoped to a
//       bounded id set) — proven via an in-memory Firestore double that
//       records every call, AND that NO unbounded `.get()` ran against
//       the JOINed collections; and
//   (b) the response shape / field set / financial gating is unchanged.
//
// The double mirrors the one in adminQueries.security.test.ts but also
// records orderBy/limit/where-in and supports getAll + doc() so the JOIN
// path (getAll by id, chunked `in`) can run.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {
  users: new Map(),
  properties: new Map(),
  tenants: new Map(),
  tickets: new Map(),
  units: new Map(),
  agreements: new Map(),
  transactions: new Map(),
  portfolioAccessContacts: new Map(),
  customers: new Map(),
  impersonations: new Map(),
  userAudit: new Map(),
};

// /api/admin/transactions merges in owner-subscription payments fetched
// live from Stripe Billing. Default each test to "no invoices" so the
// Stripe leg is inert unless a test seeds it.
const invoicesList = vi.fn();

interface QueryCall {
  collection: string;
  orderBy?: { field: string; dir: string };
  limit?: number;
  whereIn?: Array<{ field: string; values: unknown[] }>;
  whereEq?: Array<{ field: string; value: unknown }>;
  select?: string[];
}
let queryLog: QueryCall[] = [];

let currentUser: { uid: string; email: string; profile: Record<string, unknown> };
const hasPlatformPrivilege = vi.fn();

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
  queryLog = [];
  invoicesList.mockReset().mockResolvedValue({ data: [] });
  // Default: caller HAS every privilege (we test financial gating
  // explicitly where it matters).
  hasPlatformPrivilege.mockReset().mockResolvedValue(true);
  currentUser = {
    uid: "admin-uid",
    email: "a@x.com",
    profile: { roles: ["superadmin"], platformRole: "superadmin" },
  };
});

function colApi(name: string) {
  const eqFilters: Array<{ f: string; v: unknown }> = [];
  const inFilters: Array<{ f: string; vs: unknown[] }> = [];
  const call: QueryCall = { collection: name };
  const api = {
    where(f: string, op: string, v: unknown) {
      if (op === "in") {
        const values = Array.isArray(v) ? v : [v];
        inFilters.push({ f, vs: values });
        (call.whereIn ??= []).push({ field: f, values });
      } else {
        eqFilters.push({ f, v });
        (call.whereEq ??= []).push({ field: f, value: v });
      }
      return api;
    },
    orderBy(field: string, dir = "asc") {
      call.orderBy = { field, dir };
      return api;
    },
    // Projection — like the Admin SDK, returns a chainable query. The mock
    // serves full docs regardless (test rows already carry every field), so
    // the field list is recorded only for assertions, not applied.
    select(...fields: string[]) {
      call.select = fields;
      return api;
    },
    limit(n: number) {
      call.limit = n;
      return api;
    },
    startAfter() {
      return api;
    },
    async get() {
      queryLog.push(call);
      let rows = Array.from(store[name].entries()).map(([id, data]) => ({
        id,
        data,
      }));
      for (const flt of eqFilters) rows = rows.filter((r) => r.data[flt.f] === flt.v);
      for (const flt of inFilters) rows = rows.filter((r) => flt.vs.includes(r.data[flt.f]));
      if (call.orderBy) {
        const { field, dir } = call.orderBy;
        rows = rows.slice().sort((a, b) => {
          const av = String(a.data[field] ?? "");
          const bv = String(b.data[field] ?? "");
          return dir === "desc" ? (av < bv ? 1 : av > bv ? -1 : 0) : av < bv ? -1 : av > bv ? 1 : 0;
        });
      }
      if (typeof call.limit === "number") rows = rows.slice(0, call.limit);
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((r) => ({ id: r.id, data: () => r.data, ref: {} })),
      };
    },
  };
  return api;
}

function docRef(name: string, id: string) {
  return {
    id,
    async get() {
      const data = store[name]?.get(id);
      return { exists: !!data, id, data: () => data };
    },
  };
}

const fakeDb = {
  collection: (n: string) => ({
    ...colApi(n),
    doc: (id: string) => docRef(n, id),
  }),
  async getAll(...refs: Array<{ id: string; get: () => Promise<unknown> }>) {
    return Promise.all(refs.map((r) => r.get()));
  },
};

vi.mock("../firebase", () => ({
  db: () => fakeDb,
  auth: () => ({
    async listUsers() {
      // One paying subscriber on the "pro" plan — drives platform MRR/ARR
      // (subscription revenue), which is now independent of tenant rent.
      return {
        users: [{ uid: "sub-pro", customClaims: { stripeRole: "pro" } }],
        pageToken: undefined,
      };
    },
  }),
}));
vi.mock("../auth", () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
}));
vi.mock("../services/platformPrivilege", () => ({
  hasPlatformPrivilege: (...a: unknown[]) => hasPlatformPrivilege(...a),
}));
vi.mock("../stripe", () => ({
  isStripeConfigured: () => true,
  stripe: () => ({ invoices: { list: (...a: unknown[]) => invoicesList(...a) } }),
}));

import { registerAdminQueriesRoutes } from "./adminQueries";

type Mw = (req: unknown, res: unknown, next: () => void) => void;
function makeApp() {
  const app = express();
  app.use(express.json());
  const requireRole =
    (..._roles: string[]): Mw =>
    (_req, _res, next) =>
      next();
  const requirePlatformPrivilege =
    (_priv: string): Mw =>
    (_req, _res, next) =>
      next();
  registerAdminQueriesRoutes(app, {
    requireRole: requireRole as never,
    requirePlatformPrivilege: requirePlatformPrivilege as never,
  });
  return app;
}

function callFor(col: string): QueryCall | undefined {
  return queryLog.find((c) => c.collection === col);
}
function callsFor(col: string): QueryCall[] {
  return queryLog.filter((c) => c.collection === col);
}

// ──────────────────────────────────────────────────────────────────────
// /api/admin/transactions
// ──────────────────────────────────────────────────────────────────────

describe("GET /api/admin/transactions — bounded read (QA-03) + Stripe-only filter", () => {
  beforeEach(() => {
    // Two REAL Stripe rows out of order so the desc orderBy is observable,
    // plus offline/manual rows that must be filtered out.
    store.transactions.set("t-old", {
      id: "t-old",
      name: "Rent Payment",
      amount: 100,
      currency: "EUR",
      type: "income",
      category: "rent",
      status: "completed",
      timestamp: "2026-01-01T00:00:00.000Z",
      propertyId: "p1",
      ownerId: "o1",
      tenantId: "tn1",
      paymentMethod: "card",
      stripeSessionId: "cs_old",
    });
    store.transactions.set("t-new", {
      id: "t-new",
      name: "Rent Payment",
      amount: 200,
      currency: "EUR",
      type: "income",
      category: "rent",
      status: "completed",
      timestamp: "2026-03-01T00:00:00.000Z",
      propertyId: "p1",
      ownerId: "o1",
      paymentMethod: "card",
      stripeSessionId: "cs_new",
      applicationFeeCents: 250,
    });
    store.transactions.set("t-offline", {
      id: "t-offline",
      name: "Rent Payment",
      amount: 300,
      currency: "EUR",
      type: "income",
      category: "rent",
      status: "completed",
      timestamp: "2026-04-01T00:00:00.000Z",
      propertyId: "p1",
      ownerId: "o1",
      paymentMethod: "bank_transfer",
    });
    store.transactions.set("t-manual", {
      id: "t-manual",
      name: "Boiler repair",
      amount: -80,
      currency: "EUR",
      type: "expense",
      category: "maintenance",
      status: "completed",
      timestamp: "2026-05-01T00:00:00.000Z",
      propertyId: "p1",
      ownerId: "o1",
      source: "manual",
    });
    store.properties.set("p1", { id: "p1", address: "1 Main St" });
    store.users.set("o1", { id: "o1", firstName: "Oli", lastName: "Owner", email: "o1@x.com" });
    store.tenants.set("tn1", { id: "tn1", name: "Tess Tenant" });
  });

  it("orders by timestamp desc with a limit, and does NOT read whole join collections", async () => {
    const res = await request(makeApp()).get("/api/admin/transactions");
    expect(res.status).toBe(200);

    const tx = callFor("transactions")!;
    expect(tx.orderBy).toEqual({ field: "timestamp", dir: "desc" });
    expect(typeof tx.limit).toBe("number");
    expect(tx.limit!).toBeGreaterThan(0);
    // The Stripe-only scope is pushed INTO the query so offline/manual
    // bookkeeping can't eat the LIST_CAP window.
    expect(tx.whereEq).toEqual([{ field: "paymentMethod", value: "card" }]);

    // The properties/tenants/users JOINs must go through getAll (doc by
    // id), so there must be NO unbounded .get() recorded for them.
    expect(callsFor("properties")).toHaveLength(0);
    expect(callsFor("tenants")).toHaveLength(0);
    expect(callsFor("users")).toHaveLength(0);
  });

  it("returns ONLY Stripe rows (offline + manual ledger entries excluded), newest first", async () => {
    const res = await request(makeApp()).get("/api/admin/transactions");
    const rows = (res.body as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows.map((r) => r.id)).toEqual(["t-new", "t-old"]);
    const first = rows[0];
    expect(first).toMatchObject({
      id: "t-new",
      kind: "rent",
      name: "Rent Payment",
      amount: 200,
      currency: "EUR",
      type: "income",
      status: "completed",
      propertyAddress: "1 Main St",
      ownerName: "Oli Owner",
      platformFeeCents: 250,
    });
    expect(first).toHaveProperty("date");
    // t-old joins a tenant (no linked User → falls back to Tenant.name)
    // and has no captured fee; t-new has no tenant.
    const old = rows.find((r) => r.id === "t-old")!;
    expect(old.tenantName).toBe("Tess Tenant");
    expect(old.platformFeeCents).toBeNull();
    expect(rows.find((r) => r.id === "t-new")!.tenantName).toBeNull();
  });

  it("excludes a paymentMethod:'card' row that has no stripeSessionId (non-Stripe impostor)", async () => {
    // A demo-seed / legacy / import row tagged "card" but never run through
    // Stripe Checkout — the real path always co-sets stripeSessionId, so a
    // card row without one must NOT be presented as a Stripe transaction.
    store.transactions.set("t-fake-card", {
      id: "t-fake-card",
      name: "Rent Payment",
      amount: 5800,
      currency: "EUR",
      type: "income",
      category: "rent",
      status: "completed",
      timestamp: "2026-06-01T00:00:00.000Z", // newer than the real rows
      propertyId: "p1",
      ownerId: "o1",
      paymentMethod: "card",
      // no stripeSessionId
    });
    const res = await request(makeApp()).get("/api/admin/transactions");
    const rows = (res.body as { rows: Array<Record<string, unknown>> }).rows;
    // Despite being the newest "card" row, it's dropped — only the two real
    // Stripe rows (which carry a session id) remain.
    expect(rows.map((r) => r.id)).toEqual(["t-new", "t-old"]);
  });

  it("resolves the tenant's real name through the linked User doc", async () => {
    store.tenants.set("tn1", {
      id: "tn1",
      name: "invite@x.com",
      userId: "tu1",
    });
    store.users.set("tu1", { id: "tu1", firstName: "Tess", lastName: "Real", email: "t@x.com" });
    const res = await request(makeApp()).get("/api/admin/transactions");
    const old = (res.body as { rows: Array<Record<string, unknown>> }).rows.find(
      (r) => r.id === "t-old",
    )!;
    expect(old.tenantName).toBe("Tess Real");
  });

  it("merges owner-subscription payments from Stripe Billing, interleaved by timestamp", async () => {
    store.customers.set("o1", { stripeId: "cus_o1" });
    invoicesList.mockResolvedValue({
      data: [
        {
          id: "in_1",
          customer: "cus_o1",
          amount_paid: 49900,
          currency: "eur",
          created: 1739577600, // 2025-02-15
          billing_reason: "subscription_create",
          status_transitions: { paid_at: 1739577600 },
          lines: { data: [{ description: "1 × Growth (at €499.00 / year)" }] },
        },
        // Zero-amount invoice (trial / 100% coupon) — no money moved.
        {
          id: "in_free",
          customer: "cus_o1",
          amount_paid: 0,
          currency: "eur",
          created: 1739577600,
          billing_reason: "subscription_cycle",
        },
        // One-off invoice raised from the Stripe Dashboard — paid, but NOT
        // a subscription; must not be booked as subscription revenue.
        {
          id: "in_oneoff",
          customer: "cus_o1",
          amount_paid: 12300,
          currency: "eur",
          created: 1739577600,
          billing_reason: "manual",
        },
      ],
    });

    const res = await request(makeApp()).get("/api/admin/transactions");
    // The charge is expanded so subscription refunds can be reflected.
    expect(invoicesList).toHaveBeenCalledWith(
      { status: "paid", limit: 100, expand: ["data.charge"] },
      { timeout: 10_000 },
    );
    const rows = (res.body as { rows: Array<Record<string, unknown>> }).rows;
    // 2026-03-01 rent, 2026-01-01 rent, 2025-02-15 subscription.
    expect(rows.map((r) => r.id)).toEqual(["t-new", "t-old", "in_1"]);
    expect(rows[2]).toMatchObject({
      id: "in_1",
      kind: "subscription",
      name: "Growth (at €499.00 / year)",
      amount: 499,
      currency: "EUR",
      status: "completed",
      ownerName: "Oli Owner",
      tenantName: null,
      propertyAddress: null,
      // A subscription payment is platform revenue in full.
      platformFeeCents: 49900,
    });
  });

  it("reflects a refunded owner subscription from the expanded charge", async () => {
    store.customers.set("o1", { stripeId: "cus_o1" });
    invoicesList.mockResolvedValue({
      data: [
        {
          id: "in_ref",
          customer: "cus_o1",
          amount_paid: 29000,
          currency: "eur",
          created: 1739577600,
          billing_reason: "subscription_cycle",
          status_transitions: { paid_at: 1739577600 },
          lines: { data: [{ description: "1 × Pro (at €290.00 / year)" }] },
          // The refund lives on the expanded charge, not the invoice itself.
          charge: { id: "ch_1", amount_refunded: 29000 },
        },
      ],
    });
    const res = await request(makeApp()).get("/api/admin/transactions");
    const sub = (res.body as { rows: Array<Record<string, unknown>> }).rows.find(
      (r) => r.id === "in_ref",
    )!;
    // Whole subscription payment is platform revenue, so a full refund reverses
    // both the amount returned to the owner and the platform revenue.
    expect(sub).toMatchObject({
      kind: "subscription",
      platformFeeCents: 29000,
      refundedAmountCents: 29000,
      feeRefundedCents: 29000,
    });
  });

  it("keeps subscription rows (no refund) when the charge expand is unsupported", async () => {
    store.customers.set("o1", { stripeId: "cus_o1" });
    // Simulate an API version that rejects `expand: ['data.charge']`: the first
    // (expanded) call throws, the retry without expand succeeds — so rows are
    // still returned, just without refund annotation (no regression to rent-only).
    invoicesList
      .mockRejectedValueOnce(new Error("This field cannot be expanded (data.charge)"))
      .mockResolvedValueOnce({
        data: [
          {
            id: "in_noexp",
            customer: "cus_o1",
            amount_paid: 6900,
            currency: "eur",
            created: 1739577600,
            billing_reason: "subscription_cycle",
          },
        ],
      });
    const res = await request(makeApp()).get("/api/admin/transactions");
    const rows = (res.body as { rows: Array<Record<string, unknown>> }).rows;
    const sub = rows.find((r) => r.id === "in_noexp")!;
    expect(sub).toMatchObject({ kind: "subscription", refundedAmountCents: null });
    expect(invoicesList).toHaveBeenNthCalledWith(
      1,
      { status: "paid", limit: 100, expand: ["data.charge"] },
      { timeout: 10_000 },
    );
    expect(invoicesList).toHaveBeenNthCalledWith(
      2,
      { status: "paid", limit: 100 },
      { timeout: 10_000 },
    );
  });

  it("degrades to rent-only rows when the Stripe invoice fetch fails", async () => {
    invoicesList.mockRejectedValue(new Error("stripe down"));
    const res = await request(makeApp()).get("/api/admin/transactions");
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<Record<string, unknown>>; subscriptionsCapped: boolean };
    expect(body.rows.map((r) => r.id)).toEqual(["t-new", "t-old"]);
  });

  it("exposes truncation flags and pages past 100 subscription invoices, capping the loop", async () => {
    store.customers.set("o1", { stripeId: "cus_o1" });
    // Every page reports has_more → the endpoint must page with starting_after
    // and stop at the 10-page bound, flagging subscriptionsCapped rather than
    // looping forever or silently dropping rows.
    let call = 0;
    invoicesList.mockImplementation(async () => {
      call += 1;
      return {
        data: [
          {
            id: `in_p${call}`,
            customer: "cus_o1",
            amount_paid: 49900,
            currency: "eur",
            created: 1739577600,
            billing_reason: "subscription_cycle",
          },
        ],
        has_more: true,
      };
    });

    const res = await request(makeApp()).get("/api/admin/transactions");
    const body = res.body as {
      rows: Array<Record<string, unknown>>;
      rentCapped: boolean;
      subscriptionsCapped: boolean;
    };
    // Paged exactly 10 times (MAX_INVOICE_PAGES) then stopped.
    expect(invoicesList).toHaveBeenCalledTimes(10);
    // First page carries no starting_after; the second does. Both expand the
    // charge (refund reflection) — the expand persists across pages.
    expect(invoicesList).toHaveBeenNthCalledWith(
      1,
      { status: "paid", limit: 100, expand: ["data.charge"] },
      { timeout: 10_000 },
    );
    expect(invoicesList).toHaveBeenNthCalledWith(
      2,
      { status: "paid", limit: 100, starting_after: "in_p1", expand: ["data.charge"] },
      { timeout: 10_000 },
    );
    expect(body.subscriptionsCapped).toBe(true);
    expect(body.rentCapped).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// /api/admin/agreements
// ──────────────────────────────────────────────────────────────────────

describe("GET /api/admin/agreements — bounded read (QA-03)", () => {
  beforeEach(() => {
    store.agreements.set("a1", {
      id: "a1",
      tenantId: "tn1",
      unitId: "u1",
      propertyId: "p1",
      ownerId: "o1",
      agreementValue: 12000,
      monthlyRent: 1000,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.tenants.set("tn1", {
      id: "tn1",
      name: "Tess",
      email: "tess@x.com",
      status: "active",
      userId: "tu1",
    });
    store.properties.set("p1", { id: "p1", address: "1 Main St" });
    store.units.set("u1", { id: "u1", rentAmount: 999, nextPaymentDate: "2026-04-01" });
    store.users.set("o1", { id: "o1", firstName: "Oli", lastName: "Owner", email: "o1@x.com" });
    store.users.set("tu1", { id: "tu1", photoURL: "http://img/t.png" });
  });

  it("orders agreements by createdAt desc with a limit and JOINs by id (no full reads)", async () => {
    const res = await request(makeApp()).get("/api/admin/agreements?financial=1");
    expect(res.status).toBe(200);
    const agr = callFor("agreements")!;
    expect(agr.orderBy).toEqual({ field: "createdAt", dir: "desc" });
    expect(typeof agr.limit).toBe("number");
    // JOINed collections resolved via getAll → no recorded .get().
    expect(callsFor("properties")).toHaveLength(0);
    expect(callsFor("tenants")).toHaveLength(0);
    expect(callsFor("units")).toHaveLength(0);
    expect(callsFor("users")).toHaveLength(0);
  });

  it("returns the denormalized shape and gates financial fields", async () => {
    const withFin = await request(makeApp()).get("/api/admin/agreements?financial=1");
    const r = (withFin.body as Array<Record<string, unknown>>)[0];
    expect(r).toMatchObject({
      id: "a1",
      tenantName: "Tess",
      tenantEmail: "tess@x.com",
      tenantImage: "http://img/t.png",
      propertyAddress: "1 Main St",
      ownerName: "Oli Owner",
      rentAmount: 1000,
      agreementValue: 12000,
      status: "active",
    });

    // Without the flag, monetary fields are zeroed.
    hasPlatformPrivilege.mockResolvedValue(true);
    const noFin = await request(makeApp()).get("/api/admin/agreements");
    const r2 = (noFin.body as Array<Record<string, unknown>>)[0];
    expect(r2.rentAmount).toBe(0);
    expect(r2.agreementValue).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// /api/admin/units
// ──────────────────────────────────────────────────────────────────────

describe("GET /api/admin/units — bounded read (QA-03)", () => {
  beforeEach(() => {
    store.properties.set("p1", {
      id: "p1",
      ownerId: "o1",
      address: "1 Main St",
      propertyValue: 200000,
      acquisitionPrice: 150000,
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    store.users.set("o1", { id: "o1", firstName: "Oli", lastName: "Owner", email: "o1@x.com" });
    store.units.set("u1", {
      id: "u1",
      propertyId: "p1",
      label: "Apt 1",
      rentAmount: 1000,
      paymentStatus: "paid",
    });
    // Occupancy/tenant on a unit row is derived from the ACTIVE tenancy that
    // points at the unit (Tenant.unitId), not the never-written
    // Unit.currentTenantId.
    store.tenants.set("tn1", {
      id: "tn1",
      propertyId: "p1",
      unitId: "u1",
      name: "Tess",
      status: "active",
    });
    store.transactions.set("tx1", {
      id: "tx1",
      propertyId: "p1",
      unitId: "u1",
      amount: 500,
      type: "income",
      status: "completed",
    });
  });

  it("bounds properties (orderBy+limit) and scopes units/tenants/tx via where-in", async () => {
    const res = await request(makeApp()).get("/api/admin/units?financial=1");
    expect(res.status).toBe(200);

    const props = callFor("properties")!;
    expect(props.orderBy).toEqual({ field: "createdAt", dir: "desc" });
    expect(typeof props.limit).toBe("number");

    // units + tenants + transactions are joined by a bounded `in` set,
    // not a full collection read.
    const unitsCall = callFor("units")!;
    expect(unitsCall.whereIn?.[0]).toEqual({ field: "propertyId", values: ["p1"] });
    const tenantsCall = callFor("tenants")!;
    expect(tenantsCall.whereIn?.[0]).toEqual({ field: "propertyId", values: ["p1"] });
    const txCalls = callsFor("transactions");
    expect(txCalls.length).toBeGreaterThan(0);
    for (const c of txCalls) expect(c.whereIn).toBeDefined();
    // owner resolved by id (getAll) → no users .get().
    expect(callsFor("users")).toHaveLength(0);
  });

  it("returns one row per unit with denormalized owner/tenant + collected total", async () => {
    const res = await request(makeApp()).get("/api/admin/units?financial=1");
    const rows = res.body as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "u1",
      propertyId: "p1",
      ownerName: "Oli Owner",
      address: "1 Main St",
      unitLabel: "Apt 1",
      tenantName: "Tess",
      rentAmount: 1000,
      totalCollected: 500,
      propertyValue: 200000,
    });
  });

  it("counts a tx carrying both propertyId and unitId once per bucket", async () => {
    // No-unit property whose tx has only propertyId set.
    store.units.clear();
    store.transactions.clear();
    store.transactions.set("txA", {
      id: "txA",
      propertyId: "p1",
      unitId: "u1",
      amount: 700,
      type: "income",
      status: "completed",
    });
    const res = await request(makeApp()).get("/api/admin/units?financial=1");
    const rows = res.body as Array<Record<string, unknown>>;
    // p1 has no units now → single property row keyed by propertyId.
    // collectedByProperty(p1) === 700 (counted once despite the union of
    // the propertyId-in and unitId-in fetches).
    expect(rows).toHaveLength(1);
    expect(rows[0].totalCollected).toBe(700);
  });
});

// ──────────────────────────────────────────────────────────────────────
// /api/admin/users
// ──────────────────────────────────────────────────────────────────────

describe("GET /api/admin/users — bounded read (QA-03)", () => {
  beforeEach(() => {
    store.users.set("u1", {
      id: "u1",
      email: "u1@x.com",
      firstName: "U",
      lastName: "One",
      roles: ["owner"],
      status: "active",
      joinedAt: "2026-02-01T00:00:00.000Z",
    });
    store.properties.set("p1", { id: "p1", ownerId: "u1", createdAt: "2026-01-01T00:00:00.000Z" });
    store.tenants.set("tn1", { id: "tn1", ownerId: "u1", propertyId: "p1", status: "active" });
  });

  it("orders users by joinedAt desc with a limit and scopes prop/tenant joins via where-in", async () => {
    const res = await request(makeApp()).get("/api/admin/users");
    expect(res.status).toBe(200);
    const usersCall = callFor("users")!;
    expect(usersCall.orderBy).toEqual({ field: "joinedAt", dir: "desc" });
    expect(typeof usersCall.limit).toBe("number");

    const propCall = callFor("properties")!;
    expect(propCall.whereIn?.[0]).toEqual({ field: "ownerId", values: ["u1"] });
    // tenants joined by BOTH ownerId and userId (union).
    const tenantCalls = callsFor("tenants");
    const fields = tenantCalls.flatMap((c) => (c.whereIn ?? []).map((w) => w.field));
    expect(fields).toContain("ownerId");
    expect(fields).toContain("userId");
  });

  it("still derives the per-user counts and shape", async () => {
    const res = await request(makeApp()).get("/api/admin/users");
    const row = (res.body as Array<Record<string, unknown>>).find((r) => r.id === "u1")!;
    expect(row).toMatchObject({
      id: "u1",
      email: "u1@x.com",
      unitsOwned: 1,
      unitsRentedOut: 1,
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// /api/admin/activity
// ──────────────────────────────────────────────────────────────────────

describe("GET /api/admin/activity — bounded read (QA-03)", () => {
  beforeEach(() => {
    store.users.set("u1", {
      id: "u1",
      email: "u1@x.com",
      firstName: "U",
      lastName: "One",
      joinedAt: "2026-02-01T00:00:00.000Z",
    });
    store.properties.set("p1", {
      id: "p1",
      ownerId: "u1",
      address: "1 Main St",
      createdAt: "2026-03-01T00:00:00.000Z",
    });
    store.transactions.set("t1", {
      id: "t1",
      name: "Rent",
      amount: 1000,
      ownerId: "u1",
      status: "completed",
      timestamp: "2026-04-01T00:00:00.000Z",
    });
  });

  it("bounds EVERY source query with orderBy+limit on its primary timestamp", async () => {
    const res = await request(makeApp()).get("/api/admin/activity");
    expect(res.status).toBe(200);

    const expected: Record<string, string> = {
      users: "joinedAt",
      properties: "createdAt",
      agreements: "createdAt",
      transactions: "timestamp",
      tickets: "createdAt",
      portfolioAccessContacts: "invitedAt",
    };
    for (const [col, field] of Object.entries(expected)) {
      const c = callFor(col);
      expect(c, `${col} must be queried`).toBeDefined();
      expect(c!.orderBy).toEqual({ field, dir: "desc" });
      expect(typeof c!.limit).toBe("number");
    }
  });

  it("merges sources newest-first and resolves actor labels via getAll", async () => {
    const res = await request(makeApp()).get("/api/admin/activity");
    const rows = res.body as Array<Record<string, unknown>>;
    // Newest event (the transaction) is first; user.created last.
    expect(rows[0].entity).toBe("transaction");
    expect(rows[0].actorName).toBe("U One");
    const propRow = rows.find((r) => r.entity === "property")!;
    expect(propRow.actorName).toBe("U One");
    // The second users read is the getAll-by-id label resolution; there
    // must be at most ONE recorded full users query (the bounded page).
    expect(callsFor("users").every((c) => typeof c.limit === "number")).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// /api/admin/dashboard — explicitly LEFT unbounded (QA-03)
// ──────────────────────────────────────────────────────────────────────

describe("GET /api/admin/dashboard — counts unchanged (QA-03)", () => {
  beforeEach(() => {
    store.users.set("u1", {
      id: "u1",
      roles: ["owner"],
      status: "active",
      joinedAt: "2026-01-01T00:00:00.000Z",
    });
    store.users.set("u2", {
      id: "u2",
      roles: ["tenant"],
      status: "active",
      joinedAt: "2026-01-02T00:00:00.000Z",
    });
    store.users.set("u3", {
      id: "u3",
      roles: ["tenant"],
      status: "suspended",
      joinedAt: "2026-01-03T00:00:00.000Z",
    });
    store.properties.set("p1", {
      id: "p1",
      ownerId: "u1",
      propertyValue: 100000,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.agreements.set("a1", {
      id: "a1",
      status: "active",
      monthlyRent: 1000,
      createdAt: "2026-01-01T00:00:00.000Z",
      ownerId: "u1",
      tenantId: "u2",
      propertyId: "p1",
      unitId: "p1",
    });
  });

  it("totalUsers excludes suspended and MRR is platform subscription revenue (full reads, no limit)", async () => {
    const res = await request(makeApp()).get("/api/admin/dashboard?financial=1&range=all");
    expect(res.status).toBe(200);
    // 2 active users (u3 suspended).
    expect(res.body.stats.totalUsers).toBe(2);
    // Platform MRR/ARR = OWNER SUBSCRIPTION revenue, NOT contracted tenant rent.
    // One "pro" subscriber → DEFAULT plan price €290/yr → ARR 290, MRR round(290/12)=24.
    expect(res.body.stats.arr).toBe(290);
    expect(res.body.stats.mrr).toBe(24);
    expect(res.body.stats.totalRealEstateValue).toBe(100000);

    // The dashboard reads must remain UNBOUNDED — no orderBy/limit pushed.
    for (const col of ["users", "properties", "agreements", "transactions", "tenants", "units"]) {
      const c = callFor(col);
      expect(c, `${col} read`).toBeDefined();
      expect(c!.limit, `${col} must NOT be limited`).toBeUndefined();
      expect(c!.orderBy, `${col} must NOT be ordered`).toBeUndefined();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// /api/admin/audit-log — admin-activity-only feed
// ──────────────────────────────────────────────────────────────────────
describe("GET /api/admin/audit-log — excludes self-initiated end-user events", () => {
  beforeEach(() => {
    // An admin changing another user's roles — a genuine staff action.
    store.userAudit.set("ua-admin", {
      actorUid: "admin-uid",
      actorEmail: "a@x.com",
      targetUid: "user-1",
      targetEmail: "user1@x.com",
      beforeRoles: ["tenant"],
      afterRoles: ["tenant", "owner"],
      createdAt: "2026-07-03T10:00:00.000Z",
    });
    // A user managing their OWN login (connect Google) — actor === target.
    store.userAudit.set("ua-self", {
      actorUid: "user-2",
      actorEmail: "user2@x.com",
      targetUid: "user-2",
      targetEmail: "user2@x.com",
      action: "google-connected",
      createdAt: "2026-07-04T10:00:00.000Z",
    });
    // A user deleting their own account — also self-initiated (actor === target).
    store.userAudit.set("ua-self-delete", {
      actorUid: "user-3",
      actorEmail: "user3@x.com",
      targetUid: "user-3",
      targetEmail: "user3@x.com",
      beforeStatus: "active",
      afterStatus: "deleted",
      createdAt: "2026-07-04T11:00:00.000Z",
    });
    // An impersonation — always a staff action, must survive.
    store.impersonations.set("imp-1", {
      actorUid: "admin-uid",
      actorEmail: "a@x.com",
      targetUid: "user-1",
      targetEmail: "user1@x.com",
      createdAt: "2026-07-02T10:00:00.000Z",
    });
  });

  it("returns admin actions + impersonations but drops self-initiated (actor === target) rows", async () => {
    const res = await request(makeApp()).get("/api/admin/audit-log");
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain("ua-admin");
    expect(ids).toContain("imp-1");
    expect(ids).not.toContain("ua-self");
    expect(ids).not.toContain("ua-self-delete");
  });

  it("still drops self rows when the caller filters to type=user-audit", async () => {
    const res = await request(makeApp()).get("/api/admin/audit-log?type=user-audit");
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toEqual(["ua-admin"]);
  });
});
