// End-to-end integration tests for the plan-downgrade SOFT-DEACTIVATION
// lifecycle. Unlike planReconcile.test.ts (which pins the pure helpers), this
// drives the REAL Firestore-touching orchestration against a faithful in-memory
// Firestore double — supporting chained .where() equality filters, batch
// set/delete with merge semantics, and FieldValue.delete() — so we can assert
// the exact state machine the cron + webhook + delete-hook rely on:
//
//   downgrade  → property/unit "inactive", lease "suspended" (schedule PRESERVED),
//                NOTHING deleted, transaction ledger untouched;
//   re-upgrade ≤30d → lease "active" again, schedule intact;
//   re-upgrade >30d → lease "terminated", tenancy ended;
//   30-day sweep   → documents + signed lease purged, lease terminated, but the
//                    unit / agreement / tenant / TRANSACTIONS all retained.
//
// The whole point of this file is that none of the above needs a live Stripe
// event to verify — it runs in CI on every push.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CONFIG_DOC_PLAN_LABELS, CONFIG_DOC_PRIVILEGES } from "../../shared/firestore-schema";

// ── In-memory Firestore double ─────────────────────────────────────────────
// A recognizable sentinel so the merge logic can implement FieldValue.delete().
const DELETE_SENTINEL = { __op: "delete" } as const;

type Doc = Record<string, unknown>;
const store: Record<string, Map<string, Doc>> = {};
const col = (name: string): Map<string, Doc> => (store[name] ??= new Map());

function applyMerge(existing: Doc | undefined, data: Doc, merge: boolean): Doc {
  const base: Doc = merge ? { ...(existing ?? {}) } : {};
  for (const [k, v] of Object.entries(data)) {
    if (v === DELETE_SENTINEL) delete base[k];
    else base[k] = v;
  }
  return base;
}

function docRef(name: string, id: string) {
  return {
    id,
    async get() {
      const data = col(name).get(id);
      return { exists: !!data, id, ref: docRef(name, id), data: () => data };
    },
    async set(data: Doc, opts?: { merge?: boolean }) {
      col(name).set(id, applyMerge(col(name).get(id), data, !!opts?.merge));
    },
    async update(u: Doc) {
      const ex = col(name).get(id);
      if (!ex) throw new Error(`no doc ${name}/${id}`);
      col(name).set(id, applyMerge(ex, u, true));
    },
    async delete() {
      col(name).delete(id);
    },
  };
}

function query(name: string) {
  const filters: Array<{ f: string; op: string; v: unknown }> = [];
  let cap = Infinity;
  const q = {
    where(f: string, op: string, v: unknown) {
      filters.push({ f, op, v });
      return q;
    },
    limit(n: number) {
      cap = Math.min(cap, n);
      return q;
    },
    async get() {
      let rows = Array.from(col(name).entries()).map(([id, data]) => ({ id, data }));
      for (const fl of filters) {
        rows = rows.filter((r) =>
          fl.op === "in"
            ? Array.isArray(fl.v) && fl.v.includes(r.data[fl.f])
            : r.data[fl.f] === fl.v,
        );
      }
      rows = rows.slice(0, cap);
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((r) => ({
          id: r.id,
          ref: docRef(name, r.id),
          data: () => r.data,
          exists: true,
        })),
      };
    },
  };
  return q;
}

const dbDouble = {
  collection: (name: string) => ({
    doc: (id?: string) => docRef(name, id ?? `auto_${Math.random().toString(36).slice(2, 10)}`),
    where: (f: string, op: string, v: unknown) => query(name).where(f, op, v),
  }),
  async getAll(...refs: Array<{ get: () => Promise<unknown> }>) {
    return Promise.all(refs.map((r) => r.get()));
  },
  batch() {
    const ops: Array<() => Promise<void>> = [];
    return {
      set(
        ref: { set: (d: Doc, o?: { merge?: boolean }) => Promise<void> },
        data: Doc,
        opts?: { merge?: boolean },
      ) {
        ops.push(() => ref.set(data, opts));
      },
      delete(ref: { delete: () => Promise<void> }) {
        ops.push(() => ref.delete());
      },
      async commit() {
        for (const op of ops) await op();
      },
    };
  },
};

const deletedStoragePaths: string[] = [];

vi.mock("firebase-admin/firestore", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, FieldValue: { delete: () => DELETE_SENTINEL } };
});
vi.mock("../firebase", () => ({
  db: () => dbDouble,
  bucket: () => ({
    file: (p: string) => ({
      delete: async () => {
        deletedStoragePaths.push(p);
      },
    }),
  }),
}));
vi.mock("./push", () => ({
  notifyUser: vi.fn(async () => undefined),
  notifyStaff: vi.fn(async () => undefined),
}));
vi.mock("./log", () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }));
// getPortfolio always resolves the test owner to the same stable portfolio id.
vi.mock("./portfolioBanking", () => ({ getPortfolio: async () => ({ id: "pf1" }) }));
// resolveOwnerPlan is only reached via restoreInactiveAfterCapFreed (not used here).
vi.mock("./commission", () => ({ resolveOwnerPlan: async () => "advance" }));

import { reconcileAfterPlanChange, restorePortfolioWithinPlan } from "./planReconcile";
import { runInactiveUnitsSweep } from "../../functions/src/sweepInactiveUnits";

// ── Seed helpers ───────────────────────────────────────────────────────────
const PF = "pf1";
const OWNER = "owner1";
const DAY = 24 * 60 * 60 * 1000;
const isoDaysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function seedConfig(opts: { rentCollect?: Record<string, boolean> } = {}) {
  col("config").set(CONFIG_DOC_PLAN_LABELS, {
    plans: {
      basic: { unitCap: 2 },
      advance: { unitCap: 5 },
      pro: { unitCap: 20 },
      business: { unitCap: null },
    },
  });
  col("config").set(CONFIG_DOC_PRIVILEGES, {
    ownerPlan: {
      "rent.collectStripe": opts.rentCollect ?? {
        basic: true,
        advance: true,
        pro: true,
        business: true,
      },
    },
  });
}

let pCounter = 0;
function seedProperty(over: Doc = {}): string {
  const id = `prop${++pCounter}`;
  col("properties").set(id, {
    id,
    ownerId: OWNER,
    portfolioId: PF,
    address: `Addr ${id}`,
    propertyValue: 100000,
    acquisitionPrice: 80000,
    createdAt: isoDaysAgo(100 - pCounter), // deterministic ordering
    ...over,
  });
  return id;
}
function seedTenant(propertyId: string, over: Doc = {}): string {
  const id = `ten_${propertyId}`;
  col("tenants").set(id, {
    id,
    userId: `user_${id}`,
    name: "T",
    email: "t@e.com",
    unitId: propertyId,
    propertyId,
    ownerId: OWNER,
    portfolioId: PF,
    rentAmount: 1000,
    status: "active",
    createdAt: isoDaysAgo(90),
    ...over,
  });
  return id;
}
function seedAgreement(propertyId: string, tenantId: string, over: Doc = {}): string {
  const id = `agr_${propertyId}`;
  col("agreements").set(id, {
    id,
    tenantId,
    unitId: propertyId,
    propertyId,
    ownerId: OWNER,
    portfolioId: PF,
    agreementValue: 12000,
    startDate: isoDaysAgo(90).slice(0, 10),
    endDate: "2027-01-01",
    status: "active",
    monthlyRent: 1000,
    nextPaymentDate: "2026-07-01",
    createdAt: isoDaysAgo(90),
    ...over,
  });
  return id;
}
function seedTransaction(propertyId: string, tenantId: string, agreementId: string): string {
  const id = `tx_${propertyId}`;
  col("transactions").set(id, {
    id,
    propertyId,
    tenantId,
    agreementId,
    ownerId: OWNER,
    portfolioId: PF,
    name: "Rent Payment",
    amount: 1000,
    currency: "EUR",
    type: "income",
    category: "rent",
    status: "completed",
    timestamp: isoDaysAgo(30),
  });
  return id;
}
function seedDocument(propertyId: string, n = 1): string {
  const id = `doc_${propertyId}_${n}`;
  col("documents").set(id, {
    id,
    ownerId: OWNER,
    portfolioId: PF,
    propertyId,
    name: "lease.pdf",
    storagePath: `documents/${OWNER}/${propertyId}/${id}.pdf`,
    createdAt: isoDaysAgo(40),
  });
  return id;
}

const get = (c: string, id: string) => col(c).get(id);

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  deletedStoragePaths.length = 0;
  pCounter = 0;
  seedConfig();
});

// ── Downgrade → soft-deactivate ──────────────────────────────────────────────
describe("reconcileAfterPlanChange — soft-deactivation", () => {
  it("hides the excess property + suspends its lease WITHOUT deleting anything; schedule preserved; ledger untouched", async () => {
    // advance(cap 5) → basic(cap 2) with 3 properties → 1 excess. One occupied
    // (with a lease + a paid rent txn), two vacant — vacant goes first.
    const occ = seedProperty();
    const t = seedTenant(occ);
    const agr = seedAgreement(occ, t);
    const tx = seedTransaction(occ, t, agr);
    const vac1 = seedProperty();
    const vac2 = seedProperty();

    const res = await reconcileAfterPlanChange(OWNER, "advance", "basic");

    expect(res).not.toBeNull();
    // 3 active → cap 2 → exactly 1 deactivated, and it's a VACANT one (policy).
    expect(res!.vacantDeactivated + res!.occupiedDeactivated).toBe(1);
    expect(res!.vacantDeactivated).toBe(1);
    expect(res!.occupiedDeactivated).toBe(0);

    // The occupied property + its lease are UNTOUCHED (it survived the cut).
    expect(get("properties", occ)!.status).toBeUndefined(); // still active
    expect(get("agreements", agr)!.status).toBe("active");

    // One vacant property is now inactive with a deactivatedAt stamp; nothing deleted.
    const deactivated = [vac1, vac2].filter((p) => get("properties", p)!.status === "inactive");
    expect(deactivated).toHaveLength(1);
    expect(get("properties", deactivated[0])!.deactivatedAt).toBeTruthy();
    expect(col("properties").size).toBe(3); // NONE deleted

    // The rent transaction ledger is never touched.
    expect(get("transactions", tx)).toBeTruthy();
    expect(get("transactions", tx)!.amount).toBe(1000);
  });

  it("suspends an OCCUPIED lease (when it must be cut) preserving nextPaymentDate, not terminating it", async () => {
    // 3 occupied properties, advance(5)→basic(2) → 1 cut, and it must be occupied.
    const ids = [seedProperty(), seedProperty(), seedProperty()];
    const agrs = ids.map((p) => {
      const t = seedTenant(p);
      return seedAgreement(p, t);
    });

    const res = await reconcileAfterPlanChange(OWNER, "advance", "basic");
    expect(res!.occupiedDeactivated).toBe(1);

    const suspended = agrs.filter((a) => get("agreements", a)!.status === "suspended");
    expect(suspended).toHaveLength(1);
    const ag = get("agreements", suspended[0])!;
    expect(ag.status).toBe("suspended");
    expect(ag.suspendedAt).toBeTruthy();
    expect(ag.suspendedReason).toBe("planDowngrade");
    // Schedule PRESERVED — this is what lets a re-upgrade resume cleanly.
    expect(ag.nextPaymentDate).toBe("2026-07-01");
    expect(ag.terminatedAt).toBeUndefined();
  });

  it("on rent.collectStripe loss, suspends EVERY active lease (not just over-cap ones)", async () => {
    seedConfig({ rentCollect: { basic: false, advance: true, pro: true, business: true } });
    // Stay within cap (2 props, basic cap 2) so the ONLY effect is rentCollectLost.
    const a = seedProperty();
    const b = seedProperty();
    const agA = seedAgreement(a, seedTenant(a));
    const agB = seedAgreement(b, seedTenant(b));

    const res = await reconcileAfterPlanChange(OWNER, "advance", "basic");
    expect(res!.rentCollectLost).toBe(true);
    expect(get("agreements", agA)!.status).toBe("suspended");
    expect(get("agreements", agB)!.status).toBe("suspended");
    expect(get("agreements", agA)!.suspendedReason).toBe("rentCollectLost");
    // Tenancies stay active (clean resume); schedule preserved.
    expect(get("agreements", agA)!.nextPaymentDate).toBe("2026-07-01");
  });

  it("no-ops on an upgrade (returns null, touches nothing)", async () => {
    const p = seedProperty();
    const res = await reconcileAfterPlanChange(OWNER, "basic", "pro");
    expect(res).toBeNull();
    expect(get("properties", p)!.status).toBeUndefined();
  });
});

// ── Restore (re-upgrade / freed cap) ─────────────────────────────────────────
describe("restorePortfolioWithinPlan — restore", () => {
  function seedSuspended(daysAgo: number) {
    const p = seedProperty({ status: "inactive", deactivatedAt: isoDaysAgo(daysAgo) });
    const t = seedTenant(p);
    const agr = seedAgreement(p, t, {
      status: "suspended",
      suspendedAt: isoDaysAgo(daysAgo),
      suspendedReason: "planDowngrade",
      nextPaymentDate: "2026-07-01",
    });
    return { p, t, agr };
  }

  it("re-upgrade WITHIN 30 days resumes the lease with its schedule intact", async () => {
    const { p, agr } = seedSuspended(5);
    const r = await restorePortfolioWithinPlan(OWNER, "advance");

    expect(r.propertiesRestored).toBe(1);
    expect(r.agreementsResumed).toBe(1);
    expect(r.agreementsTerminated).toBe(0);

    expect(get("properties", p)!.status).toBe("active");
    expect(get("properties", p)!.deactivatedAt).toBeUndefined(); // cleared
    const ag = get("agreements", agr)!;
    expect(ag.status).toBe("active");
    expect(ag.suspendedAt).toBeUndefined();
    expect(ag.suspendedReason).toBeUndefined();
    expect(ag.nextPaymentDate).toBe("2026-07-01"); // schedule preserved
  });

  it("re-upgrade AFTER 30 days terminates the lease + ends the tenancy (owner must recreate)", async () => {
    const { p, t, agr } = seedSuspended(45);
    const r = await restorePortfolioWithinPlan(OWNER, "advance");

    expect(r.propertiesRestored).toBe(1);
    expect(r.agreementsResumed).toBe(0);
    expect(r.agreementsTerminated).toBe(1);

    // Property comes back so the owner can re-use the slot...
    expect(get("properties", p)!.status).toBe("active");
    // ...but the lease is dead and the tenancy ended.
    const ag = get("agreements", agr)!;
    expect(ag.status).toBe("terminated");
    expect(ag.terminatedAt).toBeTruthy();
    expect(ag.nextPaymentDate).toBeNull();
    expect(get("tenants", t)!.status).toBe("expired");
  });

  it("restores only up to the new cap (most-recently-deactivated first)", async () => {
    // 4 inactive properties, restoring under basic (cap 2) with 0 active → 2 restored.
    const recent = seedProperty({ status: "inactive", deactivatedAt: isoDaysAgo(1) });
    const mid = seedProperty({ status: "inactive", deactivatedAt: isoDaysAgo(3) });
    const old1 = seedProperty({ status: "inactive", deactivatedAt: isoDaysAgo(10) });
    const old2 = seedProperty({ status: "inactive", deactivatedAt: isoDaysAgo(20) });

    const r = await restorePortfolioWithinPlan(OWNER, "basic");
    expect(r.propertiesRestored).toBe(2);
    // The two most-recently-deactivated come back; the older two stay hidden.
    expect(get("properties", recent)!.status).toBe("active");
    expect(get("properties", mid)!.status).toBe("active");
    expect(get("properties", old1)!.status).toBe("inactive");
    expect(get("properties", old2)!.status).toBe("inactive");
  });

  it("restores RESUMABLE properties before already-purged shells, even if older", async () => {
    // cap 2, 3 inactive: the most-recent one was already PURGED (empty shell);
    // the fix must restore the two non-purged ones first and leave the purged
    // one inactive rather than resurrecting an empty property into a cap slot.
    const purged = seedProperty({
      status: "inactive",
      deactivatedAt: isoDaysAgo(1),
      docsPurgedAt: isoDaysAgo(1),
    });
    const liveA = seedProperty({ status: "inactive", deactivatedAt: isoDaysAgo(3) });
    const liveB = seedProperty({ status: "inactive", deactivatedAt: isoDaysAgo(5) });

    const r = await restorePortfolioWithinPlan(OWNER, "basic");
    expect(r.propertiesRestored).toBe(2);
    expect(get("properties", liveA)!.status).toBe("active");
    expect(get("properties", liveB)!.status).toBe("active");
    expect(get("properties", purged)!.status).toBe("inactive");
  });
});

// ── 30-day sweep ─────────────────────────────────────────────────────────────
describe("runInactiveUnitsSweep — 30-day purge", () => {
  it("purges documents + signed lease and terminates the lease, but RETAINS unit/agreement/tenant/transactions", async () => {
    const p = seedProperty({ status: "inactive", deactivatedAt: isoDaysAgo(31) });
    const t = seedTenant(p);
    const agr = seedAgreement(p, t, {
      status: "suspended",
      suspendedAt: isoDaysAgo(31),
      suspendedReason: "planDowngrade",
      signedLeaseDocument: {
        storagePath: `documents/${OWNER}/${p}/agreements/${`agr_${p}`}/lease.pdf`,
        name: "signed.pdf",
        contentType: "application/pdf",
        size: 1,
        uploadedAt: isoDaysAgo(60),
        uploadedBy: OWNER,
      },
    });
    const doc1 = seedDocument(p, 1);
    const doc2 = seedDocument(p, 2);
    const tx = seedTransaction(p, t, agr);
    col("units").set(`unit_${p}`, {
      id: `unit_${p}`,
      propertyId: p,
      status: "inactive",
      rentAmount: 1000,
      paymentStatus: "pending",
      createdAt: isoDaysAgo(90),
    });

    await runInactiveUnitsSweep();

    // Documents GONE (Firestore rows + storage objects).
    expect(get("documents", doc1)).toBeUndefined();
    expect(get("documents", doc2)).toBeUndefined();
    expect(deletedStoragePaths.some((p2) => p2.includes(doc1))).toBe(true);
    expect(deletedStoragePaths.some((p2) => p2.endsWith("lease.pdf"))).toBe(true);

    // Lease terminated + signed lease reference cleared + tenancy ended.
    const ag = get("agreements", agr)!;
    expect(ag.status).toBe("terminated");
    expect(ag.signedLeaseDocument).toBeNull();
    expect(get("tenants", t)!.status).toBe("expired");

    // RETAINED: unit, agreement doc, tenant doc, and the transaction ledger.
    expect(get("agreements", agr)).toBeTruthy();
    expect(get("tenants", t)).toBeTruthy();
    expect(get("units", `unit_${p}`)).toBeTruthy();
    expect(get("transactions", tx)).toBeTruthy();
    expect(get("transactions", tx)!.amount).toBe(1000);

    // Property retained + stamped purged.
    expect(get("properties", p)!.docsPurgedAt).toBeTruthy();
  });

  it("does NOT purge a property still inside the 30-day grace, nor one already purged", async () => {
    const young = seedProperty({ status: "inactive", deactivatedAt: isoDaysAgo(10) });
    const done = seedProperty({
      status: "inactive",
      deactivatedAt: isoDaysAgo(60),
      docsPurgedAt: isoDaysAgo(20),
    });
    seedDocument(young);
    const doneDoc = seedDocument(done);

    await runInactiveUnitsSweep();

    expect(get("properties", young)!.docsPurgedAt).toBeUndefined();
    // The already-purged property is skipped — its (re-seeded) doc is left alone.
    expect(get("documents", doneDoc)).toBeTruthy();
    expect(deletedStoragePaths).toHaveLength(0);
  });
});

// docsPurgedAt is the sweep's idempotency stamp ("already purged → skip"). If it
// were never cleared, a property purged once would be PERMANENTLY exempt from the
// purge — so after a restore + re-deactivation its NEW documents/lease would
// never be cleaned up. Both cascades must clear it so each deactivation starts a
// fresh 30-day window.
describe("docsPurgedAt is cleared across the deactivate/restore lifecycle", () => {
  it("restore clears a stale docsPurgedAt from a prior purge cycle", async () => {
    const p = seedProperty({
      status: "inactive",
      deactivatedAt: isoDaysAgo(5),
      docsPurgedAt: isoDaysAgo(35), // stamped in a PRIOR purge
    });
    const t = seedTenant(p);
    seedAgreement(p, t, { status: "suspended", suspendedAt: isoDaysAgo(5) });

    await restorePortfolioWithinPlan(OWNER, "advance");

    expect(get("properties", p)!.status).toBe("active");
    expect(get("properties", p)!.docsPurgedAt).toBeUndefined();
  });

  it("re-deactivation via reconcile clears a leftover docsPurgedAt", async () => {
    // basic cap = 2; three vacant active props → the newest (target) is the one
    // deactivated. It carries a leftover stamp the downgrade must drop.
    const keep1 = seedProperty();
    const keep2 = seedProperty();
    const target = seedProperty({ docsPurgedAt: isoDaysAgo(35) });

    await reconcileAfterPlanChange(OWNER, "advance", "basic");

    expect(get("properties", target)!.status).toBe("inactive");
    expect(get("properties", target)!.docsPurgedAt).toBeUndefined();
    // The kept ones are untouched — seedProperty leaves status absent (= active).
    expect(get("properties", keep1)!.status).not.toBe("inactive");
    expect(get("properties", keep2)!.status).not.toBe("inactive");
  });

  it("end-to-end: a purged → restored → re-deactivated property is purged AGAIN", async () => {
    const p = seedProperty({
      status: "inactive",
      deactivatedAt: isoDaysAgo(40),
      docsPurgedAt: isoDaysAgo(35),
    });
    const t = seedTenant(p);
    seedAgreement(p, t, { status: "suspended", suspendedAt: isoDaysAgo(5) });

    // Re-upgrade restores it (clears the stale stamp).
    await restorePortfolioWithinPlan(OWNER, "advance");
    expect(get("properties", p)!.docsPurgedAt).toBeUndefined();

    // Owner uploads a NEW document while active again.
    const newDoc = seedDocument(p, 2);

    // A later downgrade re-deactivates it; simulate the 30 days elapsing by
    // backdating deactivatedAt (the restore already cleared docsPurgedAt).
    const cur = get("properties", p)!;
    col("properties").set(p, { ...cur, status: "inactive", deactivatedAt: isoDaysAgo(31) });

    await runInactiveUnitsSweep();

    // The NEW document IS purged and the property re-stamped — pre-fix the stale
    // docsPurgedAt would have skipped it forever.
    expect(get("documents", newDoc)).toBeUndefined();
    expect(get("properties", p)!.docsPurgedAt).toBeTruthy();
  });
});
