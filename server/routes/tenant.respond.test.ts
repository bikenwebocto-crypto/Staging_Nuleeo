// Behavior tests for the agreement approval state machine —
// POST /api/tenant/agreements/:id/respond (server/routes/tenant.ts).
//
// This is the core lease-acceptance flow: an owner-created lease lands in
// status "pending_tenant"; the linked tenant approves it (→ active) or
// declines it (→ declined), and the tenancy doc moves in lockstep so the
// owner's tenant list and the tenant's dashboard never disagree. These
// tests pin the real transitions, side effects, authorization, and the
// idempotency/wrong-state guards the handler actually enforces:
//   • approve: agreement→active, tenancy→active, acceptedAt stamped,
//     indexation anchor re-seeded to activation (notify-then-apply);
//   • decline: agreement→declined, tenancy→declined, declinedAt stamped,
//     NO activation side effects;
//   • only the linked tenant may respond (otherwise 403, nothing mutates);
//   • re-POSTing the action that already took effect is an idempotent 200
//     with NO re-write; the OPPOSITE action on a resolved lease is 409;
//   • a non-pending lease (expired/terminated) can't be responded to (409);
//   • bad/absent action is a 400.
//
// Mocking strategy mirrors tenant.payment.test.ts: an in-memory Firestore
// double plus thin doubles for auth and the notify side effect, so the
// route's branching logic is exercised in isolation. The clock is frozen
// (vi.setSystemTime) so the indexation re-seed math is deterministic.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mutable test state ─────────────────────────────────────────────────
interface TestUser {
  uid: string;
  email?: string;
  profile?: Record<string, unknown>;
}
let currentUser: TestUser = { uid: "tenant-uid", email: "t@example.com" };

// In-memory store, one Map per collection the respond route touches.
type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {
  tenants: new Map(),
  units: new Map(),
  users: new Map(),
  properties: new Map(),
  transactions: new Map(),
  agreements: new Map(),
};

// Captured notifyUser payloads, so we can assert who got told what (and
// that a declined/idempotent path does or doesn't notify).
let notifyCalls: Array<Record<string, unknown>> = [];

// A fixed "now" so the indexation re-seed (anchor + delayMonths, rolled
// forward to the next not-yet-passed step) is deterministic across runs.
const FIXED_NOW = new Date("2026-06-08T12:00:00.000Z");

beforeEach(() => {
  // Freeze ONLY the wall clock (Date), not setTimeout/setImmediate/etc. —
  // supertest does real loopback HTTP I/O and would hang if those were
  // faked. Restricting `toFake` to "Date" keeps the indexation re-seed math
  // deterministic without stalling the request lifecycle.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  currentUser = {
    uid: "tenant-uid",
    email: "t@example.com",
    profile: { firstName: "Tess", lastName: "Tenant" },
  };
  for (const m of Object.values(store)) m.clear();
  notifyCalls = [];
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Firestore double ───────────────────────────────────────────────────

function snapFor(col: string, id: string) {
  const data = store[col].get(id);
  return { exists: !!data, id, data: () => data };
}

function makeRef(col: string, id: string) {
  return {
    _col: col,
    _id: id,
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

function makeQuery(col: string) {
  const filters: Array<{ field: string; value: unknown }> = [];
  const limits: number[] = [];
  const evaluate = () => {
    let rows = Array.from(store[col].entries()).map(([id, data]) => ({
      id,
      data,
    }));
    for (const f of filters) {
      rows = rows.filter((r) => r.data[f.field] === f.value);
    }
    if (limits.length) rows = rows.slice(0, Math.min(...limits));
    return rows;
  };
  const q = {
    where(field: string, op: string, value: unknown) {
      if (op !== "==") throw new Error(`unsupported op ${op}`);
      filters.push({ field, value });
      return q;
    },
    limit(n: number) {
      limits.push(n);
      return q;
    },
    async get() {
      const rows = evaluate();
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((r) => ({
          id: r.id,
          ref: makeRef(col, r.id),
          exists: true,
          data: () => r.data,
        })),
      };
    },
  };
  return q;
}

const fakeDb = {
  collection(name: string) {
    return {
      doc(id?: string) {
        return makeRef(name, id ?? `auto_${Object.keys(store[name]).length}`);
      },
      where(field: string, op: string, value: unknown) {
        return makeQuery(name).where(field, op, value);
      },
    };
  },
  // The handler commits the agreement + tenancy patches together via
  // runTransaction with t.set(ref, data, { merge: true }). Forward the
  // merge option through to the ref so both docs really move in lockstep.
  async runTransaction<T>(cb: (t: unknown) => Promise<T>): Promise<T> {
    const t = {
      async get(ref: { get: () => Promise<unknown> }) {
        return ref.get();
      },
      set(
        ref: { set: (d: Row, opts?: { merge?: boolean }) => void },
        data: Row,
        opts?: { merge?: boolean },
      ) {
        ref.set(data, opts);
      },
    };
    return cb(t);
  },
};

// ── Module mocks ───────────────────────────────────────────────────────

vi.mock("../firebase", () => ({ db: () => fakeDb }));

vi.mock("../auth", () => ({
  requireAuth: (req: { user?: TestUser }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
}));

// Stripe is unused by /respond but the module is imported at load time.
vi.mock("../stripe", () => ({
  isStripeConfigured: () => true,
  stripe: () => ({ checkout: { sessions: { create: async () => ({}) } } }),
}));

vi.mock("../services/rateLimit", () => ({
  checkAndIncrement: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("../services/safeRedirect", () => ({
  isSafeRedirectUrl: () => true,
}));

vi.mock("../services/commission", () => ({
  computeRentCommission: async () => ({ feeCents: 0, plan: "basic", tier: {} }),
}));

vi.mock("../services/rentTransaction", () => ({
  recordRentTransactionFromSession: async () => ({}),
}));

// Capture the landlord notification so tests can assert it fired (or not).
vi.mock("../services/push", () => ({
  notifyUser: async (payload: Record<string, unknown>) => {
    notifyCalls.push(payload);
  },
}));

// Imported AFTER the mocks are registered (vi.mock is hoisted, so this is
// belt-and-braces — keeps the intent obvious).
import { registerTenantRoutes } from "./tenant";

function makeApp() {
  const app = express();
  app.use(express.json());
  registerTenantRoutes(app);
  return app;
}

// Seed a pending owner-created lease: an owner, a property, a tenancy
// linked to the caller (status "pending"), and a "pending_tenant"
// agreement that points at the tenancy. `extra` overrides the agreement.
function seedPendingLease(extra: Row = {}) {
  store.users.set("owner-uid", { id: "owner-uid" });
  store.properties.set("prop-1", {
    id: "prop-1",
    ownerId: "owner-uid",
    address: "Makariou III Avenue",
  });
  store.tenants.set("ten-1", {
    id: "ten-1",
    userId: "tenant-uid",
    name: "Tess Tenant",
    unitId: "prop-1",
    propertyId: "prop-1",
    ownerId: "owner-uid",
    rentAmount: 1200,
    status: "pending",
  });
  store.agreements.set("ag-1", {
    id: "ag-1",
    tenantId: "ten-1",
    ownerId: "owner-uid",
    propertyId: "prop-1",
    status: "pending_tenant",
    monthlyRent: 1200,
    ...extra,
  });
}

function respond(action: unknown, id = "ag-1") {
  return request(makeApp()).post(`/api/tenant/agreements/${id}/respond`).send({ action });
}

// ── approve ────────────────────────────────────────────────────────────

describe("POST /api/tenant/agreements/:id/respond — approve", () => {
  it("activates the agreement AND the tenancy in lockstep, stamping acceptedAt", async () => {
    seedPendingLease();
    const res = await respond("approve");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "ag-1", status: "active" });

    // Both docs moved to active together.
    expect(store.agreements.get("ag-1")?.status).toBe("active");
    expect(store.tenants.get("ten-1")?.status).toBe("active");
    // Acceptance is timestamped; the decline timestamp is NOT set.
    expect(store.agreements.get("ag-1")?.acceptedAt).toBe(FIXED_NOW.toISOString());
    expect(store.agreements.get("ag-1")?.declinedAt).toBeUndefined();
  });

  it("notifies the landlord that the lease was accepted, using the tenant's name", async () => {
    seedPendingLease();
    await respond("approve");

    expect(notifyCalls).toHaveLength(1);
    const n = notifyCalls[0];
    expect(n.externalUserId).toBe("owner-uid"); // the OWNER, not the tenant
    expect(n.title).toBe("Lease accepted");
    expect(String(n.message)).toContain("Tess Tenant");
    expect(String(n.message)).toContain("active");
  });

  it("re-anchors the indexation clock to activation when an indexation clause exists", async () => {
    // Signed in the past with a 12-month freeze; the first step (2026-01-01)
    // already passed, so the sweep would otherwise apply an increase with no
    // prenotice. The handler rolls forward to the next not-yet-passed step
    // (2027-01-01) so notify-then-apply is preserved. Frozen clock makes
    // this deterministic.
    seedPendingLease({
      signatureDate: "2025-01-01",
      indexation: {
        type: "fixed",
        rate: 5,
        delayMonths: 12,
        frequency: "yearly",
      },
    });
    const res = await respond("approve");

    expect(res.status).toBe(200);
    const idx = store.agreements.get("ag-1")?.indexation as Record<string, unknown>;
    // 2025-01-01 + 12mo = 2026-01-01 (passed, today is 2026-06-08) → +12mo.
    expect(idx.nextIncreaseDate).toBe("2027-01-01");
    // The rest of the clause is preserved (rate not clobbered).
    expect(idx.rate).toBe(5);
  });

  it("leaves indexation untouched when the lease has no indexation clause", async () => {
    seedPendingLease(); // no `indexation` field
    const res = await respond("approve");

    expect(res.status).toBe(200);
    expect(store.agreements.get("ag-1")?.indexation).toBeUndefined();
  });

  it("409s on approve when another active tenancy already occupies the property", async () => {
    seedPendingLease();
    // A second, already-ACTIVE tenancy on the SAME property (e.g. two pending
    // invites were sent and one approved first). The in-transaction occupancy
    // re-check must block this approval to prevent double-occupancy.
    store.tenants.set("ten-2", {
      id: "ten-2",
      userId: "other-tenant",
      propertyId: "prop-1",
      ownerId: "owner-uid",
      status: "active",
    });
    const res = await respond("approve");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has an active lease/i);
    // The pending lease stays pending — neither doc was activated.
    expect(store.agreements.get("ag-1")?.status).toBe("pending_tenant");
    expect(store.tenants.get("ten-1")?.status).toBe("pending");
    // No landlord "accepted" push fired.
    expect(notifyCalls).toHaveLength(0);
  });

  it("still approves when the only active tenancy on the property is this one", async () => {
    seedPendingLease();
    const res = await respond("approve");

    // No OTHER active tenancy exists → the guard lets the approval through.
    expect(res.status).toBe(200);
    expect(store.agreements.get("ag-1")?.status).toBe("active");
    expect(store.tenants.get("ten-1")?.status).toBe("active");
  });

  it("409s on approve when the owner already ENDED the tenancy (no resurrection)", async () => {
    seedPendingLease();
    // Owner cancelled the invite via /tenants/:id/end → tenancy is "expired".
    // Approving a still-pending agreement must NOT bring the ended tenancy back.
    store.tenants.set("ten-1", { ...store.tenants.get("ten-1")!, status: "expired" });

    const res = await respond("approve");

    expect(res.status).toBe(409);
    expect(store.agreements.get("ag-1")?.status).toBe("pending_tenant");
    expect(store.tenants.get("ten-1")?.status).toBe("expired");
  });
});

// ── decline ────────────────────────────────────────────────────────────

describe("POST /api/tenant/agreements/:id/respond — decline", () => {
  it("declines both docs and stamps declinedAt, with NO activation side effects", async () => {
    seedPendingLease({
      signatureDate: "2025-01-01",
      indexation: { type: "fixed", rate: 5, delayMonths: 12, frequency: "yearly" },
    });
    const res = await respond("decline");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "ag-1", status: "declined" });

    expect(store.agreements.get("ag-1")?.status).toBe("declined");
    expect(store.tenants.get("ten-1")?.status).toBe("declined");
    // declinedAt stamped; acceptedAt never set; indexation NOT re-anchored
    // (decline must not run the activation-only side effects).
    expect(store.agreements.get("ag-1")?.declinedAt).toBe(FIXED_NOW.toISOString());
    expect(store.agreements.get("ag-1")?.acceptedAt).toBeUndefined();
    expect(
      (store.agreements.get("ag-1")?.indexation as Record<string, unknown>).nextIncreaseDate,
    ).toBeUndefined();
  });

  it("notifies the landlord that the lease was declined", async () => {
    seedPendingLease();
    await respond("decline");

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].title).toBe("Lease declined");
    expect(String(notifyCalls[0].message)).toContain("declined");
  });
});

// ── authorization ──────────────────────────────────────────────────────

describe("POST /api/tenant/agreements/:id/respond — authorization", () => {
  it("403s and mutates NOTHING when the caller is not the linked tenant", async () => {
    seedPendingLease();
    currentUser = { uid: "someone-else" };
    const res = await respond("approve");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not your agreement/i);
    // Neither doc moved off pending, and no one was notified.
    expect(store.agreements.get("ag-1")?.status).toBe("pending_tenant");
    expect(store.tenants.get("ten-1")?.status).toBe("pending");
    expect(notifyCalls).toHaveLength(0);
  });

  it("404s when the agreement does not exist", async () => {
    seedPendingLease();
    const res = await respond("approve", "does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/agreement not found/i);
  });

  it("404s when the agreement's tenancy doc is missing (orphaned)", async () => {
    seedPendingLease();
    store.tenants.delete("ten-1");
    const res = await respond("approve");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/tenancy not found/i);
  });
});

// ── idempotency & wrong-state guards ───────────────────────────────────

describe("POST /api/tenant/agreements/:id/respond — idempotency & wrong state", () => {
  it("is idempotent: re-approving an already-active lease returns 200 and does NOT re-notify", async () => {
    seedPendingLease({ status: "active", acceptedAt: "2026-01-01T00:00:00.000Z" });
    const res = await respond("approve");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "ag-1", status: "active" });
    // Early-return on the target-state guard: no re-write (acceptedAt stays
    // the original) and crucially NO duplicate landlord notification.
    expect(store.agreements.get("ag-1")?.acceptedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(notifyCalls).toHaveLength(0);
  });

  it("is idempotent: re-declining an already-declined lease returns 200 without re-notifying", async () => {
    seedPendingLease({ status: "declined" });
    const res = await respond("decline");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "ag-1", status: "declined" });
    expect(notifyCalls).toHaveLength(0);
  });

  it("409s the OPPOSITE action on an already-resolved lease (can't decline what you accepted)", async () => {
    seedPendingLease({ status: "active" });
    const res = await respond("decline");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/can no longer be declined/i);
    // The accepted lease is untouched and no notification fires.
    expect(store.agreements.get("ag-1")?.status).toBe("active");
    expect(store.tenants.get("ten-1")?.status).toBe("pending");
    expect(notifyCalls).toHaveLength(0);
  });

  it("409s any action on a non-pending lease (e.g. terminated)", async () => {
    seedPendingLease({ status: "terminated" });
    const res = await respond("approve");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/can no longer be approved/i);
    expect(store.agreements.get("ag-1")?.status).toBe("terminated");
    expect(notifyCalls).toHaveLength(0);
  });
});

// ── input validation ───────────────────────────────────────────────────

describe("POST /api/tenant/agreements/:id/respond — input validation", () => {
  it("400s when action is missing", async () => {
    seedPendingLease();
    const res = await request(makeApp()).post("/api/tenant/agreements/ag-1/respond").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/action must be/i);
    expect(store.agreements.get("ag-1")?.status).toBe("pending_tenant");
  });

  it("400s when action is an unrecognized value", async () => {
    seedPendingLease();
    const res = await respond("maybe");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/action must be/i);
    expect(store.agreements.get("ag-1")?.status).toBe("pending_tenant");
  });
});
