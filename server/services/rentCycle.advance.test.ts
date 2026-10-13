// Direct unit tests for the impure advanceAgreementForPayment, exercised through
// its runTransaction path against a minimal in-memory Firestore double. Locks in
// the per-cycle idempotency guard (a payment tagged for an already-advanced
// cycle must NOT advance again) that the transaction makes reliable under
// concurrent payments. The pure date helpers live in rentCycle.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {
  agreements: new Map(),
  tenants: new Map(),
};

function makeRef(col: string, id: string) {
  return {
    id,
    async get() {
      const data = store[col].get(id);
      return { exists: !!data, id, data: () => data };
    },
    update(data: Row) {
      store[col].set(id, { ...(store[col].get(id) ?? {}), ...data });
    },
    set(data: Row, opts?: { merge?: boolean }) {
      store[col].set(id, opts?.merge ? { ...(store[col].get(id) ?? {}), ...data } : data);
    },
  };
}

function makeQuery(col: string) {
  const filters: Array<{ field: string; value: unknown }> = [];
  let lim = Infinity;
  const q = {
    where(field: string, _op: string, value: unknown) {
      filters.push({ field, value });
      return q;
    },
    limit(n: number) {
      lim = n;
      return q;
    },
    async get() {
      let rows = Array.from(store[col].entries()).map(([id, data]) => ({ id, data }));
      for (const f of filters) rows = rows.filter((r) => r.data[f.field] === f.value);
      rows = rows.slice(0, lim);
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((r) => ({ id: r.id, ref: makeRef(col, r.id), data: () => r.data })),
      };
    },
  };
  return q;
}

const fakeDb = {
  collection(name: string) {
    return {
      doc: (id: string) => makeRef(name, id),
      where: (f: string, op: string, v: unknown) => makeQuery(name).where(f, op, v),
    };
  },
  async runTransaction<T>(cb: (t: unknown) => Promise<T>): Promise<T> {
    const t = {
      async get(refOrQuery: { get: () => Promise<unknown> }) {
        return refOrQuery.get();
      },
      update(ref: { update: (d: Row) => void }, data: Row) {
        ref.update(data);
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

import { advanceAgreementForPayment } from "./rentCycle";

function seedActiveLease(opts: {
  nextPaymentDate: string;
  frequency?: string;
  paymentDayOfMonth?: number;
}) {
  store.agreements.set("ag-1", {
    tenantId: "ten-1",
    status: "active",
    nextPaymentDate: opts.nextPaymentDate,
    paymentFrequency: opts.frequency ?? "monthly",
    paymentDayOfMonth: opts.paymentDayOfMonth ?? 1,
  });
}

beforeEach(() => {
  store.agreements.clear();
  store.tenants.clear();
});

describe("advanceAgreementForPayment", () => {
  it("advances one period and mirrors Tenant.nextPayment when the cycle matches", async () => {
    seedActiveLease({ nextPaymentDate: "2026-06-01" });
    const r = await advanceAgreementForPayment({ tenantId: "ten-1", paidCycle: "2026-06-01" });
    expect(r).toEqual({ advanced: true, from: "2026-06-01", to: "2026-07-01" });
    expect(store.agreements.get("ag-1")?.nextPaymentDate).toBe("2026-07-01");
    expect(store.tenants.get("ten-1")?.nextPayment).toBe("2026-07-01");
  });

  it("is a no-op for a payment tagged to an already-advanced cycle (idempotency guard)", async () => {
    // The agreement has already rolled forward to July; a (late/duplicate)
    // payment tagged for the June cycle must NOT advance it again — the core
    // guarantee the transaction makes reliable against concurrent payments.
    seedActiveLease({ nextPaymentDate: "2026-07-01" });
    const r = await advanceAgreementForPayment({ tenantId: "ten-1", paidCycle: "2026-06-01" });
    expect(r).toEqual({ advanced: false, from: "2026-07-01" });
    expect(store.agreements.get("ag-1")?.nextPaymentDate).toBe("2026-07-01");
    expect(store.tenants.get("ten-1")?.nextPayment).toBeUndefined();
  });

  it("advances a whole quarter for a quarterly lease", async () => {
    seedActiveLease({ nextPaymentDate: "2026-06-01", frequency: "quarterly" });
    const r = await advanceAgreementForPayment({ tenantId: "ten-1", paidCycle: "2026-06-01" });
    expect(r.to).toBe("2026-09-01");
  });

  it("advances (legacy fallback) when no paidCycle is supplied", async () => {
    seedActiveLease({ nextPaymentDate: "2026-06-01" });
    const r = await advanceAgreementForPayment({ tenantId: "ten-1" });
    expect(r.advanced).toBe(true);
    expect(store.agreements.get("ag-1")?.nextPaymentDate).toBe("2026-07-01");
  });

  it("returns advanced:false when the tenancy has no active agreement", async () => {
    const r = await advanceAgreementForPayment({ tenantId: "nobody", paidCycle: "2026-06-01" });
    expect(r).toEqual({ advanced: false });
  });

  it("advances a SUSPENDED lease (rent paid during a plan-suspension window)", async () => {
    // planReconcile suspends the Agreement but leaves the Tenant active, so an
    // offline payment can still be verified during the window. The cycle MUST
    // still advance or the reminder cron false-overdue-nudges on re-upgrade.
    store.agreements.set("ag-susp", {
      tenantId: "ten-1",
      status: "suspended",
      nextPaymentDate: "2026-06-01",
      paymentFrequency: "monthly",
      paymentDayOfMonth: 1,
    });
    const r = await advanceAgreementForPayment({ tenantId: "ten-1", paidCycle: "2026-06-01" });
    expect(r).toEqual({ advanced: true, from: "2026-06-01", to: "2026-07-01" });
    expect(store.agreements.get("ag-susp")?.nextPaymentDate).toBe("2026-07-01");
    expect(store.tenants.get("ten-1")?.nextPayment).toBe("2026-07-01");
  });

  it("prefers the ACTIVE agreement when both active and suspended exist for one tenancy", async () => {
    store.agreements.set("ag-susp", {
      tenantId: "ten-1",
      status: "suspended",
      nextPaymentDate: "2026-01-01",
      paymentFrequency: "monthly",
      paymentDayOfMonth: 1,
    });
    store.agreements.set("ag-act", {
      tenantId: "ten-1",
      status: "active",
      nextPaymentDate: "2026-06-01",
      paymentFrequency: "monthly",
      paymentDayOfMonth: 1,
    });
    const r = await advanceAgreementForPayment({ tenantId: "ten-1", paidCycle: "2026-06-01" });
    expect(r).toEqual({ advanced: true, from: "2026-06-01", to: "2026-07-01" });
    expect(store.agreements.get("ag-act")?.nextPaymentDate).toBe("2026-07-01");
    // The suspended one is left untouched.
    expect(store.agreements.get("ag-susp")?.nextPaymentDate).toBe("2026-01-01");
  });

  it("ignores terminated/expired agreements (no live agreement → no-op)", async () => {
    store.agreements.set("ag-term", {
      tenantId: "ten-1",
      status: "terminated",
      nextPaymentDate: "2026-06-01",
      paymentFrequency: "monthly",
      paymentDayOfMonth: 1,
    });
    const r = await advanceAgreementForPayment({ tenantId: "ten-1", paidCycle: "2026-06-01" });
    expect(r).toEqual({ advanced: false });
    expect(store.agreements.get("ag-term")?.nextPaymentDate).toBe("2026-06-01");
  });
});
