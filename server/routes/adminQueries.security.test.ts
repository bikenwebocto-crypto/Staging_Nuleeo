// H3 + H4 regression for the admin query surface.
//
// H4: GET /api/admin/users must blank phone + home address for callers that
//     lack users.manage (support/sales hold users.viewAll but not manage), so
//     they can't bulk-harvest every user's contact PII.
// H3: the cross-user lead/ticket endpoints must be gated on comm.activityLog
//     (the same gate as /api/admin/activity) — sales/marketing are denied.

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
  suggestionRequests: new Map(),
  marketplaceLeads: new Map(),
  impersonations: new Map(),
  userAudit: new Map(),
  partners: new Map(),
};

// QA-03: record every orderBy/limit/where(in) the routes push into
// Firestore so the bounding tests can assert the query builder actually
// received them, not just that the response shape is right.
interface QueryCall {
  collection: string;
  orderBy?: { field: string; dir: string };
  limit?: number;
  whereIn?: Array<{ field: string; values: unknown[] }>;
}
let queryLog: QueryCall[] = [];

let currentUser: { uid: string; email: string; profile: Record<string, unknown> };
const hasPlatformPrivilege = vi.fn();
const deniedPrivs = new Set<string>();

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
  queryLog = [];
  hasPlatformPrivilege.mockReset().mockResolvedValue(false);
  deniedPrivs.clear();
  currentUser = {
    uid: "admin-uid",
    email: "a@x.com",
    profile: { roles: ["admin"], platformRole: "support" },
  };
});

function colApi(name: string) {
  // eq filters use the recorded op; "in" filters are recorded separately
  // so tests can prove the JOIN was scoped to a bounded id set.
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
      }
      return api;
    },
    orderBy(field: string, dir = "asc") {
      call.orderBy = { field, dir };
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
  // getAll resolves the referenced doc refs against the in-memory store
  // (the JOIN path the QA-03 endpoints use instead of full-collection
  // reads).
  async getAll(...refs: Array<{ id: string; get: () => Promise<unknown> }>) {
    return Promise.all(refs.map((r) => r.get()));
  },
};

vi.mock("../firebase", () => ({
  db: () => fakeDb,
  auth: () => ({
    async listUsers() {
      return { users: [], pageToken: undefined };
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
    (priv: string): Mw =>
    (_req, res, next) => {
      if (deniedPrivs.has(priv)) {
        (res as { status: (n: number) => { json: (b: unknown) => void } })
          .status(403)
          .json({ error: "Forbidden" });
        return;
      }
      next();
    };
  registerAdminQueriesRoutes(app, {
    requireRole: requireRole as never,
    requirePlatformPrivilege: requirePlatformPrivilege as never,
  });
  return app;
}

interface UserRow {
  id: string;
  email: string;
  phone: string;
  address: string;
}

describe("GET /api/admin/users — contact-PII gating (H4)", () => {
  beforeEach(() => {
    store.users.set("u1", {
      id: "u1",
      email: "u1@x.com",
      firstName: "U",
      lastName: "One",
      phone: "555-0100",
      address: "1 Main St, Town",
      roles: ["user"],
      status: "active",
    });
  });

  it("blanks phone + address when the caller lacks users.manage", async () => {
    hasPlatformPrivilege.mockResolvedValue(false);
    const res = await request(makeApp()).get("/api/admin/users");
    expect(res.status).toBe(200);
    const row = (res.body as UserRow[]).find((r) => r.id === "u1")!;
    expect(row.phone).toBe("");
    expect(row.address).toBe("");
    // Name + email stay visible — only the sensitive contact PII is gated.
    expect(row.email).toBe("u1@x.com");
  });

  it("includes phone + address when the caller HAS users.manage", async () => {
    hasPlatformPrivilege.mockResolvedValue(true);
    const res = await request(makeApp()).get("/api/admin/users");
    const row = (res.body as UserRow[]).find((r) => r.id === "u1")!;
    expect(row.phone).toBe("555-0100");
    expect(row.address).toBe("1 Main St, Town");
  });
});

describe("admin ticket/lead endpoints gated on comm.activityLog (H3)", () => {
  beforeEach(() => {
    store.tickets.set("t1", {
      id: "t1",
      subject: "Help",
      userId: "u1",
      userEmail: "u1@x.com",
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("403s GET /api/admin/tickets when comm.activityLog is denied (sales/marketing)", async () => {
    deniedPrivs.add("comm.activityLog");
    const res = await request(makeApp()).get("/api/admin/tickets");
    expect(res.status).toBe(403);
  });

  it("allows GET /api/admin/tickets when comm.activityLog is granted", async () => {
    const res = await request(makeApp()).get("/api/admin/tickets");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("also gates /api/admin/suggestion-requests and /api/admin/marketplace-leads", async () => {
    deniedPrivs.add("comm.activityLog");
    const a = await request(makeApp()).get("/api/admin/suggestion-requests");
    const b = await request(makeApp()).get("/api/admin/marketplace-leads");
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
  });
});
