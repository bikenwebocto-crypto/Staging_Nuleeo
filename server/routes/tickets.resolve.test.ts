// Behavior tests for POST /api/owner/maintenance/resolve/:id — the owner-side
// complement to the tenant "Report a Problem" flow. A property issue is
// mirrored into the activity ledger as a neutral/maintenance transaction
// (status "pending"); resolving flips it to "resolved", closes the backing
// support ticket, and pushes the tenant.
//
// Also covers the phase-1 portfolio stamping on the mirror write itself
// (POST /api/tickets with category "property"): the ledger row carries the
// LANDLORD's stable portfolio doc id, resolved via ensurePortfolio.
//
// Mocking strategy mirrors tenant.payment.test.ts: an in-memory Firestore
// double plus thin doubles for auth, rate limiting and the push service so the
// route's branching is exercised in isolation.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TestUser {
  uid: string;
  email?: string;
  profile?: Record<string, unknown>;
}
let currentUser: TestUser = { uid: "owner-uid", email: "o@example.com" };

type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {
  transactions: new Map(),
  tenants: new Map(),
  tickets: new Map(),
  users: new Map(),
  // ensurePortfolio resolves the landlord's portfolio for the mirror stamp.
  portfolios: new Map(),
};

// Captured push sends so tests can assert the tenant was (or wasn't) notified.
let notifyCalls: Array<Record<string, unknown>> = [];

beforeEach(() => {
  currentUser = { uid: "owner-uid", email: "o@example.com" };
  for (const m of Object.values(store)) m.clear();
  notifyCalls = [];
});

function snapFor(col: string, id: string) {
  const data = store[col].get(id);
  return { exists: !!data, id, data: () => data };
}

function makeRef(col: string, id: string) {
  return {
    id,
    async get() {
      return snapFor(col, id);
    },
    async set(data: Row, opts?: { merge?: boolean }) {
      if (opts?.merge) {
        store[col].set(id, { ...(store[col].get(id) ?? {}), ...data });
      } else {
        store[col].set(id, data);
      }
    },
    async update(data: Row) {
      store[col].set(id, { ...(store[col].get(id) ?? {}), ...data });
    },
  };
}

// Equality query with a limit — POST /api/tickets resolves the caller's
// active tenancy via tenants.where(userId==).where(status==).limit(5), and
// ensurePortfolio falls back to portfolios.where(ownerId==).limit(1).
function makeQuery(col: string) {
  const filters: Array<{ field: string; value: unknown }> = [];
  let cap = Infinity;
  const q = {
    where(field: string, op: string, value: unknown) {
      if (op !== "==") throw new Error(`unsupported op ${op}`);
      filters.push({ field, value });
      return q;
    },
    limit(n: number) {
      cap = n;
      return q;
    },
    async get() {
      let rows = Array.from(store[col].entries()).map(([id, data]) => ({ id, data }));
      for (const f of filters) rows = rows.filter((r) => r.data[f.field] === f.value);
      rows = rows.slice(0, cap);
      return {
        empty: rows.length === 0,
        docs: rows.map((r) => ({ id: r.id, exists: true, data: () => r.data })),
      };
    },
  };
  return q;
}

const fakeDb = {
  collection(name: string) {
    return {
      doc(id?: string) {
        return makeRef(name, id ?? `auto_${store[name].size}`);
      },
      where(field: string, op: string, value: unknown) {
        return makeQuery(name).where(field, op, value);
      },
    };
  },
  // ensurePortfolio's create path runs in a transaction; merge opts pass
  // through to set() (it links User.portfolioRef with merge:true).
  async runTransaction<T>(cb: (t: unknown) => Promise<T>): Promise<T> {
    const t = {
      async get(ref: { get: () => Promise<unknown> }) {
        return ref.get();
      },
      set(
        ref: { set: (d: Row, o?: { merge?: boolean }) => void },
        data: Row,
        opts?: { merge?: boolean },
      ) {
        ref.set(data, opts);
      },
    };
    return cb(t);
  },
};

vi.mock("../firebase", () => ({ db: () => fakeDb }));

vi.mock("../auth", () => ({
  requireAuth: (req: { user?: TestUser }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
}));

vi.mock("../services/rateLimit", () => ({
  checkAndIncrement: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("../services/push", () => ({
  notifyUser: async (input: Record<string, unknown>) => {
    notifyCalls.push(input);
  },
  notifyStaff: async () => {},
}));

import { registerTicketRoutes } from "./tickets";

function makeApp() {
  const app = express();
  app.use(express.json());
  registerTicketRoutes(app);
  return app;
}

// A tenant-reported issue as the mirror writes it: neutral/maintenance,
// pending, ownerId set, `notes` carrying the backing ticket id, tenantId
// pointing at the tenancy doc.
function seedReport() {
  store.tenants.set("ten-1", { id: "ten-1", userId: "tenant-uid", ownerId: "owner-uid" });
  store.tickets.set("tk-1", { id: "tk-1", status: "open", category: "property" });
  store.transactions.set("tx-1", {
    id: "tx-1",
    ownerId: "owner-uid",
    tenantId: "ten-1",
    type: "neutral",
    category: "maintenance",
    status: "pending",
    name: "Reported issue: Leaking tap",
    amount: 0,
    currency: "EUR",
    notes: "tk-1",
    timestamp: "2026-06-10T00:00:00.000Z",
  });
}

describe("POST /api/owner/maintenance/resolve/:id", () => {
  it("flips the report to resolved, closes the ticket and notifies the tenant", async () => {
    seedReport();
    const res = await request(makeApp()).post("/api/owner/maintenance/resolve/tx-1");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");
    expect(res.body.resolvedBy).toBe("owner-uid");
    expect(res.body.resolvedAt).toBeTruthy();

    // Persisted, ticket closed, tenant pushed.
    expect(store.transactions.get("tx-1")?.status).toBe("resolved");
    expect(store.tickets.get("tk-1")?.status).toBe("resolved");
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].externalUserId).toBe("tenant-uid");
    expect(notifyCalls[0].category).toBe("maintenance");
    expect(String(notifyCalls[0].message)).toContain("Leaking tap");
  });

  it("403s when the caller is not the report's owner", async () => {
    seedReport();
    currentUser = { uid: "someone-else", email: "x@example.com" };
    const res = await request(makeApp()).post("/api/owner/maintenance/resolve/tx-1");
    expect(res.status).toBe(403);
    expect(store.transactions.get("tx-1")?.status).toBe("pending");
    expect(notifyCalls).toHaveLength(0);
  });

  it("400s a non-maintenance transaction (e.g. rent)", async () => {
    store.transactions.set("rent-1", {
      id: "rent-1",
      ownerId: "owner-uid",
      type: "income",
      category: "rent",
      status: "pending",
      name: "Rent",
      amount: 1200,
      currency: "EUR",
    });
    const res = await request(makeApp()).post("/api/owner/maintenance/resolve/rent-1");
    expect(res.status).toBe(400);
    expect(store.transactions.get("rent-1")?.status).toBe("pending");
  });

  it("is idempotent — re-resolving returns 200 without re-notifying", async () => {
    seedReport();
    store.transactions.set("tx-1", {
      ...(store.transactions.get("tx-1") as Row),
      status: "resolved",
    });
    const res = await request(makeApp()).post("/api/owner/maintenance/resolve/tx-1");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");
    expect(notifyCalls).toHaveLength(0);
  });

  it("404s an unknown transaction", async () => {
    const res = await request(makeApp()).post("/api/owner/maintenance/resolve/nope");
    expect(res.status).toBe(404);
  });

  it("resolves the ledger row but does NOT regress a ticket staff already closed", async () => {
    seedReport();
    // Staff drove the backing ticket to the terminal "closed" state via the
    // admin queue before the owner pressed Resolve.
    store.tickets.set("tk-1", { id: "tk-1", status: "closed", category: "property" });
    const res = await request(makeApp()).post("/api/owner/maintenance/resolve/tx-1");

    expect(res.status).toBe(200);
    expect(store.transactions.get("tx-1")?.status).toBe("resolved");
    // The ticket stays closed — the owner's ledger resolve must not churn the
    // support queue backward.
    expect(store.tickets.get("tk-1")?.status).toBe("closed");
    // Tenant is still notified the issue is fixed.
    expect(notifyCalls).toHaveLength(1);
  });
});

describe("POST /api/tickets — property-issue mirror portfolio stamping (phase-1 re-key)", () => {
  // The tenant files the ticket; the mirrored ledger row belongs to the
  // LANDLORD, so its portfolioId must be the landlord's stable portfolio
  // doc id — never anything derived from the caller.
  function seedActiveTenancy() {
    currentUser = { uid: "tenant-uid", email: "t@example.com" };
    store.tenants.set("ten-1", {
      id: "ten-1",
      userId: "tenant-uid",
      ownerId: "owner-uid",
      propertyId: "prop-1",
      unitId: "prop-1",
      status: "active",
    });
    store.users.set("owner-uid", { id: "owner-uid", portfolioRef: "pf-owner" });
    store.portfolios.set("pf-owner", {
      id: "pf-owner",
      ownerId: "owner-uid",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }

  const TICKET_BODY = {
    subject: "Leaking tap",
    description: "Kitchen tap drips constantly.",
    category: "property",
    propertyId: "prop-1",
  };

  it("stamps the landlord's portfolio id on the mirrored maintenance transaction", async () => {
    seedActiveTenancy();
    const res = await request(makeApp()).post("/api/tickets").send(TICKET_BODY);

    expect(res.status).toBe(201);
    // Exactly one mirror row, shaped as before…
    expect(store.transactions.size).toBe(1);
    const tx = Array.from(store.transactions.values())[0];
    expect(tx.type).toBe("neutral");
    expect(tx.category).toBe("maintenance");
    expect(tx.status).toBe("pending");
    expect(tx.ownerId).toBe("owner-uid");
    // …now carrying the landlord's STABLE portfolio doc id.
    expect(tx.portfolioId).toBe("pf-owner");
  });

  it("creates + links the landlord's portfolio when none exists yet", async () => {
    seedActiveTenancy();
    store.portfolios.clear();
    store.users.set("owner-uid", { id: "owner-uid" }); // no portfolioRef either

    const res = await request(makeApp()).post("/api/tickets").send(TICKET_BODY);

    expect(res.status).toBe(201);
    expect(store.portfolios.size).toBe(1);
    const [pfId, pf] = Array.from(store.portfolios.entries())[0];
    expect(pf.ownerId).toBe("owner-uid");
    const tx = Array.from(store.transactions.values())[0];
    expect(tx.portfolioId).toBe(pfId);
    // User doc linked for deterministic future lookups, merge-preserved.
    expect(store.users.get("owner-uid")?.portfolioRef).toBe(pfId);
    expect(store.users.get("owner-uid")?.id).toBe("owner-uid");
  });

  it("writes no mirror row (and no portfolio) for a non-property ticket", async () => {
    seedActiveTenancy();
    const res = await request(makeApp())
      .post("/api/tickets")
      .send({ ...TICKET_BODY, category: "billing", propertyId: undefined });

    expect(res.status).toBe(201);
    expect(store.transactions.size).toBe(0);
  });
});
