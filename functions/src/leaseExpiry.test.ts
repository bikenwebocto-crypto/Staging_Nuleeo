// Behavioral tests for the lease-expiry sweep — the lifecycle event that closes
// or renews a lease at its endDate. Covers:
//   - EXPIRE (autoRenewal "none"): status → "expired", schedule cleared, and an
//     unpaid in-term cycle preserved as a collectible closingBalance / tenant
//     outstandingBalance (the "expire but keep arrears collectible" rule).
//   - RENEW (autoRenewal "auto"): endDate pushed forward, lease stays active.
//   - PRENOTICE: a lease nearing endDate gets a heads-up without changing state.
//
// In-memory Firestore double + push mock, mirroring rentIndexation.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {
  agreements: new Map(),
  tenants: new Map(),
  properties: new Map(),
  portfolios: new Map(),
  leaseLifecycleLog: new Map(),
};

const notifyCalls: Array<{ externalUserId: string; title: string; message: string }> = [];

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
  notifyCalls.length = 0;
});

function snapOf(col: string, id: string) {
  const d = store[col].get(id);
  return { exists: !!d, id, data: () => d };
}
function makeRef(col: string, id: string) {
  return {
    id,
    __col: col,
    __id: id,
    async get() {
      return snapOf(col, id);
    },
    set(data: Row, opts?: { merge?: boolean }) {
      if (opts?.merge) store[col].set(id, { ...(store[col].get(id) ?? {}), ...data });
      else store[col].set(id, data);
    },
  };
}
function makeQuery(col: string) {
  const filters: Array<{ f: string; v: unknown }> = [];
  const q = {
    where(f: string, _op: string, v: unknown) {
      filters.push({ f, v });
      return q;
    },
    limit() {
      return q;
    },
    async get() {
      let rows = Array.from(store[col].entries()).map(([id, data]) => ({ id, data }));
      for (const { f, v } of filters) rows = rows.filter((r) => r.data[f] === v);
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((r) => ({
          id: r.id,
          ref: makeRef(col, r.id),
          data: () => r.data,
          exists: true,
        })),
      };
    },
  };
  return q;
}
type FakeRef = ReturnType<typeof makeRef>;
const fakeDb = {
  collection(name: string) {
    return {
      doc: (id: string) => makeRef(name, id),
      where: (f: string, op: string, v: unknown) => makeQuery(name).where(f, op, v),
    };
  },
  async getAll(...refs: FakeRef[]) {
    return refs.map((r) => snapOf(r.__col, r.__id));
  },
  async runTransaction<T>(cb: (tx: unknown) => Promise<T>): Promise<T> {
    const tx = {
      async get(refOrQuery: { get: () => Promise<unknown> }) {
        return refOrQuery.get();
      },
      set(
        ref: { set: (d: Row, o?: { merge?: boolean }) => void },
        data: Row,
        opts?: { merge?: boolean },
      ) {
        ref.set(data, opts);
      },
    };
    return cb(tx);
  },
};

vi.mock("../../server/firebase", () => ({ db: () => fakeDb }));
vi.mock("../../server/services/push", () => ({
  notifyUser: async (args: { externalUserId: string; title: string; message: string }) => {
    notifyCalls.push(args);
  },
}));

import { runLeaseExpirySweep } from "./leaseExpiry";

// The sweep computes "today" in Europe/Athens, so fixtures derive from the same.
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens" }).format(new Date());
function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

function seedCommon() {
  store.portfolios.set("pf1", { id: "pf1", ownerId: "owner1" });
  store.properties.set("p1", { id: "p1", address: "1 Test St" });
  store.tenants.set("t1", {
    id: "t1",
    userId: "tenantUser1",
    status: "active",
    rentAmount: 1000,
    propertyId: "p1",
  });
}

describe("runLeaseExpirySweep", () => {
  it("EXPIRES a past-endDate lease with no auto-renewal and preserves the unpaid cycle as arrears", async () => {
    seedCommon();
    const endDate = addDays(TODAY, -1);
    store.agreements.set("ag1", {
      id: "ag1",
      status: "active",
      endDate,
      autoRenewal: "none",
      paymentFrequency: "monthly",
      paymentDayOfMonth: Number(endDate.slice(8, 10)),
      nextPaymentDate: endDate, // one in-term cycle still owed
      tenantId: "t1",
      propertyId: "p1",
      portfolioId: "pf1",
      monthlyRent: 1000,
    });

    await runLeaseExpirySweep();

    const ag = store.agreements.get("ag1")!;
    expect(ag.status).toBe("expired");
    expect(ag.nextPaymentDate).toBeNull();
    expect((ag.closingBalance as { amount: number }).amount).toBe(1000);
    expect((ag.closingBalance as { reason: string }).reason).toBe("expiry");

    const t = store.tenants.get("t1")!;
    expect(t.status).toBe("expired");
    expect(t.outstandingBalance).toBe(1000);

    // Idempotency log + notifications to both parties.
    expect(store.leaseLifecycleLog.get(`ag1_${endDate}_expired`)).toBeDefined();
    expect(notifyCalls.some((c) => c.externalUserId === "tenantUser1")).toBe(true);
    expect(notifyCalls.some((c) => c.externalUserId === "owner1")).toBe(true);
  });

  it("RENEWS a past-endDate lease with autoRenewal 'auto' (stays active, endDate moves forward)", async () => {
    seedCommon();
    const endDate = addDays(TODAY, -1);
    store.agreements.set("ag2", {
      id: "ag2",
      status: "active",
      endDate,
      autoRenewal: "auto",
      paymentFrequency: "monthly",
      nextPaymentDate: addDays(TODAY, 5),
      tenantId: "t1",
      propertyId: "p1",
      portfolioId: "pf1",
      monthlyRent: 1000,
    });

    await runLeaseExpirySweep();

    const ag = store.agreements.get("ag2")!;
    expect(ag.status).toBe("active");
    expect(String(ag.endDate) > TODAY).toBe(true);
    expect(ag.closingBalance).toBeUndefined();
    expect(store.leaseLifecycleLog.get(`ag2_${endDate}_renewed`)).toBeDefined();
  });

  it("PRENOTICES a lease nearing its endDate without changing its state", async () => {
    seedCommon();
    const endDate = addDays(TODAY, 15);
    store.agreements.set("ag3", {
      id: "ag3",
      status: "active",
      endDate,
      autoRenewal: "none",
      paymentFrequency: "monthly",
      nextPaymentDate: addDays(TODAY, 15),
      tenantId: "t1",
      propertyId: "p1",
      portfolioId: "pf1",
      monthlyRent: 1000,
    });

    await runLeaseExpirySweep();

    const ag = store.agreements.get("ag3")!;
    expect(ag.status).toBe("active"); // not expired yet
    expect(store.leaseLifecycleLog.get(`ag3_${endDate}_prenotice`)).toBeDefined();
    expect(notifyCalls.some((c) => c.title === "Lease ending soon")).toBe(true);
  });

  it("does not expire a lease whose endDate is far in the future", async () => {
    seedCommon();
    store.agreements.set("ag4", {
      id: "ag4",
      status: "active",
      endDate: addDays(TODAY, 200),
      autoRenewal: "none",
      paymentFrequency: "monthly",
      nextPaymentDate: addDays(TODAY, 30),
      tenantId: "t1",
      propertyId: "p1",
      portfolioId: "pf1",
      monthlyRent: 1000,
    });

    await runLeaseExpirySweep();

    expect(store.agreements.get("ag4")!.status).toBe("active");
    expect(notifyCalls.length).toBe(0);
  });
});
