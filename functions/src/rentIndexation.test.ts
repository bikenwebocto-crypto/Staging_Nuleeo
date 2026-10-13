// Behavioral tests for the rent-indexation sweep — the app's most consequential
// automated money mutation (it raises the rent a tenant is charged). Covers:
//   - compoundRent: compounds off CURRENT rent and CLAMPS to the rate ceiling
//     (H-6 — a runaway rate can never auto-apply).
//   - notify-then-apply guard (M-7): a due step with NO prior prenotice DEFERS
//     (sends notice + pushes the effective date out) instead of bumping rent.
//   - apply-after-prenotice: a due step WITH a prenotice applies the increase.
//   - idempotency: the applied-log guard prevents a double-apply on replay.
//   - portfolio-ONLY owner resolution (Phase 4): the plan gate + owner push
//     follow portfolios/{agreement.portfolioId}.ownerId (the CURRENT owner);
//     an agreement whose portfolio can't be resolved is SKIPPED — the legacy
//     agreement.ownerId fallback is removed.
//
// In-memory Firestore double + thin mocks for push/plan, mirroring the other
// route tests, so the real sweep logic runs against fixtures.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {
  agreements: new Map(),
  rentIndexationLog: new Map(),
  units: new Map(),
  properties: new Map(),
  tenants: new Map(),
  config: new Map(),
  portfolios: new Map(),
};

// Call recorders for the mocked plan + push services, so tests can assert WHO
// the sweep gated on and pushed to (the Phase 2 portfolio-first owner
// resolution), not just that rent moved.
const planCalls: string[] = [];
const notifyCalls: Array<{ externalUserId: string; title: string; message: string }> = [];

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
  planCalls.length = 0;
  notifyCalls.length = 0;
});

function snapOf(col: string, id: string) {
  const d = store[col].get(id);
  return { exists: !!d, id, data: () => d };
}
function makeRef(col: string, id: string) {
  return {
    id,
    // Carried so the getAll batch helper can resolve a ref back to the store.
    __col: col,
    __id: id,
    async get() {
      return snapOf(col, id);
    },
    set(data: Row, opts?: { merge?: boolean }) {
      if (opts?.merge) {
        store[col].set(id, { ...(store[col].get(id) ?? {}), ...data });
      } else {
        store[col].set(id, data);
      }
    },
  };
}
function makeQuery(col: string) {
  const filters: Array<{ f: string; v: unknown }> = [];
  let lim: number | null = null;
  const q = {
    where(f: string, _op: string, v: unknown) {
      filters.push({ f, v });
      return q;
    },
    limit(n: number) {
      lim = n;
      return q;
    },
    async get() {
      let rows = Array.from(store[col].entries()).map(([id, data]) => ({ id, data }));
      for (const { f, v } of filters) rows = rows.filter((r) => r.data[f] === v);
      if (lim != null) rows = rows.slice(0, lim);
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
// Doc refs carry their (col, id) so getAll can resolve them from the store —
// mirrors the Admin SDK's getAll(...DocumentReference) batch read the sweep now
// uses to pre-fetch idempotency logs / tenant / property docs.
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
vi.mock("../../server/services/commission", () => ({
  resolveOwnerPlan: async (uid: string) => {
    planCalls.push(uid);
    return "pro"; // pro grants rent.autoIndex in defaults
  },
}));

import { runRentIndexationSweep, compoundRent } from "./rentIndexation";

// Match the sweep's clock: it computes "today" in Europe/Athens (not UTC), so
// the expected deferred date must use the same timezone.
const TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Athens",
}).format(new Date());
function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

function seedLease(
  id: string,
  idx: Row,
  opts: { monthlyRent?: number; ownerId?: string; portfolioId?: string } = {},
) {
  // Phase 4: every agreement is portfolio-stamped, and the sweep resolves the
  // owner SOLELY through portfolios/{portfolioId}.ownerId — so the fixture
  // stamps a portfolio and seeds its doc (unless a test pre-seeded it to
  // model a transfer, or deletes it to model a dangling stamp).
  const ownerId = opts.ownerId ?? "owner1";
  const portfolioId = opts.portfolioId ?? `pf_${ownerId}`;
  if (!store.portfolios.has(portfolioId)) {
    store.portfolios.set(portfolioId, { id: portfolioId, ownerId, createdAt: "2026-01-01" });
  }
  store.agreements.set(id, {
    id,
    status: "active",
    ownerId,
    portfolioId,
    tenantId: `ten_${id}`,
    unitId: `prop_${id}`, // owner-created: unitId === propertyId, no Unit doc
    propertyId: `prop_${id}`,
    monthlyRent: opts.monthlyRent ?? 1000,
    rentalDurationMonths: 12,
    indexation: idx,
  });
  store.tenants.set(`ten_${id}`, {
    id: `ten_${id}`,
    userId: `user_${id}`,
    propertyId: `prop_${id}`,
    status: "active",
    rentAmount: opts.monthlyRent ?? 1000,
  });
  store.properties.set(`prop_${id}`, { id: `prop_${id}`, address: "1 Test St" });
}

describe("compoundRent — H-6 ceiling clamp", () => {
  it("compounds off the current rent", () => {
    expect(compoundRent(1000, 5)).toBe(1050);
    expect(compoundRent(1050, 5)).toBe(1103); // compounds off the NEW base
  });
  it("clamps an out-of-range rate to the ceiling (runaway can't apply)", () => {
    expect(compoundRent(1000, 9999)).toBe(1250); // clamped to 25%
    expect(compoundRent(1000, 50)).toBe(1250); // 50 (typo) → 25% cap
  });
  it("clamps a negative rate to 0 (no decrease)", () => {
    expect(compoundRent(1000, -10)).toBe(1000);
  });
});

describe("runRentIndexationSweep — notify-then-apply (M-7)", () => {
  it("DEFERS a due increase that was never pre-noticed (no rent bump)", async () => {
    // Due step (effective date well in the past), fixed 5%, no prenotice log.
    seedLease("a", {
      type: "fixed",
      rate: 5,
      frequency: "yearly",
      nextIncreaseDate: "2020-01-01",
    });

    await runRentIndexationSweep();

    const ag = store.agreements.get("a")!;
    // Rent NOT bumped — applied was withheld pending notice.
    expect(ag.monthlyRent).toBe(1000);
    // Effective date pushed out by the 30-day lead time.
    const deferredOn = addDays(TODAY, 30);
    expect((ag.indexation as Row).nextIncreaseDate).toBe(deferredOn);
    // A prenotice was recorded for the new date; no applied row exists.
    expect(store.rentIndexationLog.has(`a_${deferredOn}_prenotice`)).toBe(true);
    expect(store.rentIndexationLog.has("a_2020-01-01_applied")).toBe(false);
  });

  it("APPLIES a due increase that was already pre-noticed", async () => {
    seedLease("b", {
      type: "fixed",
      rate: 5,
      frequency: "yearly",
      nextIncreaseDate: "2020-01-01",
    });
    // Prenotice already on record for this step → apply is allowed.
    store.rentIndexationLog.set("b_2020-01-01_prenotice", {
      id: "b_2020-01-01_prenotice",
      kind: "prenotice",
      effectiveOn: "2020-01-01",
    });

    await runRentIndexationSweep();

    const ag = store.agreements.get("b")!;
    expect(ag.monthlyRent).toBe(1050); // 5% off 1000
    expect((ag.indexation as Row).appliedSteps).toBe(1);
    // Clock advanced one yearly stride from the effective date.
    expect((ag.indexation as Row).nextIncreaseDate).toBe("2021-01-01");
    // Tenancy rent kept in step (charged-amount source of truth).
    expect(store.tenants.get("ten_b")!.rentAmount).toBe(1050);
    expect(store.rentIndexationLog.has("b_2020-01-01_applied")).toBe(true);
  });

  it("does not double-apply the same step on replay (applied-log idempotency)", async () => {
    seedLease("c", {
      type: "fixed",
      rate: 5,
      frequency: "yearly",
      nextIncreaseDate: "2020-01-01",
    });
    store.rentIndexationLog.set("c_2020-01-01_prenotice", {
      id: "c_2020-01-01_prenotice",
      kind: "prenotice",
      effectiveOn: "2020-01-01",
    });

    await runRentIndexationSweep(); // applies → 1050, advances to 2021-01-01
    expect(store.agreements.get("c")!.monthlyRent).toBe(1050);

    // Simulate a replay where the clock hadn't advanced (e.g. a retry of the
    // same step): the applied-log guard must make it a no-op.
    const ag = store.agreements.get("c")!;
    ag.indexation = { ...(ag.indexation as Row), nextIncreaseDate: "2020-01-01" };
    store.agreements.set("c", ag);

    await runRentIndexationSweep();
    expect(store.agreements.get("c")!.monthlyRent).toBe(1050); // unchanged
  });
});

describe("runRentIndexationSweep — portfolio-ONLY owner resolution (Phase 4)", () => {
  it("plan-gates AND notifies the portfolio's CURRENT owner, not a stale agreement.ownerId", async () => {
    // Ownership transferred: the portfolio doc now points at new-owner, but
    // the agreement still carries the old denormalized ownerId (a missed
    // denorm — the silent failure the portfolio re-key exists to absorb).
    store.portfolios.set("pf1", { id: "pf1", ownerId: "new-owner", createdAt: "2026-01-01" });
    seedLease(
      "d",
      { type: "fixed", rate: 5, frequency: "yearly", nextIncreaseDate: "2020-01-01" },
      { ownerId: "stale-owner", portfolioId: "pf1" },
    );
    // Prenotice on record → the due step takes the APPLY path (which pushes
    // the owner an "applied" notice we can assert the target of).
    store.rentIndexationLog.set("d_2020-01-01_prenotice", {
      id: "d_2020-01-01_prenotice",
      kind: "prenotice",
      effectiveOn: "2020-01-01",
    });

    await runRentIndexationSweep();

    // The increase applied — the plan gate ran against the resolved owner.
    expect(store.agreements.get("d")!.monthlyRent).toBe(1050);
    // Plan resolved for the portfolio's CURRENT owner; the stale uid (which
    // resolveOwnerPlan would silently default to 'basic' for) is never asked.
    expect(planCalls).toContain("new-owner");
    expect(planCalls).not.toContain("stale-owner");
    // The owner push targeted the current owner too.
    const ownerPushes = notifyCalls.filter((c) => c.title === "Rent increase applied");
    expect(ownerPushes).toHaveLength(1);
    expect(ownerPushes[0].externalUserId).toBe("new-owner");
    expect(notifyCalls.some((c) => c.externalUserId === "stale-owner")).toBe(false);
  });

  it("SKIPS an agreement whose portfolio doc is missing — never falls back to the stale denorm", async () => {
    // Phase 4: the legacy agreement.ownerId fallback is removed. A dangling
    // portfolio stamp means the CURRENT owner is unknowable, so the sweep
    // must skip (logged) rather than plan-gate or push against a stale uid.
    seedLease(
      "e",
      { type: "fixed", rate: 5, frequency: "yearly", nextIncreaseDate: "2020-01-01" },
      { ownerId: "owner1", portfolioId: "pf_ghost" },
    );
    store.portfolios.delete("pf_ghost");
    store.rentIndexationLog.set("e_2020-01-01_prenotice", {
      id: "e_2020-01-01_prenotice",
      kind: "prenotice",
      effectiveOn: "2020-01-01",
    });

    await runRentIndexationSweep();

    // Nothing applied, no plan asked, nobody pushed.
    expect(store.agreements.get("e")!.monthlyRent).toBe(1000);
    expect(planCalls).toHaveLength(0);
    expect(notifyCalls).toHaveLength(0);
    expect(store.rentIndexationLog.has("e_2020-01-01_applied")).toBe(false);
  });
});
