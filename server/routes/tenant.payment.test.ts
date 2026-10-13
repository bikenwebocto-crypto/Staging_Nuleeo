// Behavior tests for the tenant payment surface's tenancy resolution.
//
// Regression focus: owner-created properties have NO separate Unit doc
// (the tenancy reuses `propertyId` as `unitId`). `loadActiveTenancy`
// used to hard-require `units/{unitId}` to exist, so BOTH the card
// checkout and the offline log 404'd with "Active tenancy not found"
// for every owner-created lease — even though the tenant's dashboard
// (which falls back to the tenancy doc) happily showed the lease and
// offered a "Make a Payment" button. These tests pin the contract:
//   • an active tenancy with NO unit doc still resolves (rent falls
//     back to the tenancy doc, receipt label to the property address);
//   • a missing/owner-less tenancy still 404s.
//
// Mocking strategy mirrors properties.test.ts: an in-memory Firestore
// double plus thin doubles for auth, Stripe, and the side-effect
// services so the route's branching logic is exercised in isolation.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mutable test state ─────────────────────────────────────────────────
interface TestUser {
  uid: string;
  email?: string;
  profile?: Record<string, unknown>;
}
let currentUser: TestUser = { uid: "tenant-uid", email: "t@example.com" };

// In-memory store, one Map per collection the payment routes touch.
type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {
  tenants: new Map(),
  units: new Map(),
  users: new Map(),
  properties: new Map(),
  transactions: new Map(),
  agreements: new Map(),
  // Banking lives on COL.portfolios (the sole source of truth). loadActiveTenancy
  // resolves it via loadPortfolioBanking(ownerId) → a portfolios query, so these
  // tests seed banking on a PORTFOLIO doc (see seedOwnerCreatedLease).
  portfolios: new Map(),
};

let stripeCreateArgs: unknown[] = [];

beforeEach(() => {
  currentUser = {
    uid: "tenant-uid",
    email: "t@example.com",
    profile: { firstName: "Tess", lastName: "Tenant" },
  };
  for (const m of Object.values(store)) m.clear();
  stripeCreateArgs = [];
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
  // Each filter is either an equality (`==`) or a membership (`in`) test.
  // The /units agreement-frequency join uses `where("tenantId", "in", ids)`
  // (Firestore caps `in` at 30), so the double must honor both ops.
  const filters: Array<{ field: string; op: "==" | "in"; value: unknown }> = [];
  const limits: number[] = [];
  const evaluate = () => {
    let rows = Array.from(store[col].entries()).map(([id, data]) => ({
      id,
      data,
    }));
    for (const f of filters) {
      if (f.op === "in") {
        const set = Array.isArray(f.value) ? f.value : [f.value];
        rows = rows.filter((r) => set.includes(r.data[f.field]));
      } else {
        rows = rows.filter((r) => r.data[f.field] === f.value);
      }
    }
    if (limits.length) rows = rows.slice(0, Math.min(...limits));
    return rows;
  };
  const q = {
    where(field: string, op: string, value: unknown) {
      if (op !== "==" && op !== "in") throw new Error(`unsupported op ${op}`);
      filters.push({ field, op, value });
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
  // Batched point reads — the pending-payments endpoint joins properties,
  // tenancies and users via db().getAll(...refs).
  async getAll(...refs: Array<{ get: () => Promise<unknown> }>) {
    return Promise.all(refs.map((r) => r.get()));
  },
  async runTransaction<T>(cb: (t: unknown) => Promise<T>): Promise<T> {
    const t = {
      async get(ref: { get: () => Promise<unknown> }) {
        return ref.get();
      },
      // Pass merge options through — ensurePortfolio links User.portfolioRef
      // with a merge:true set, which must not clobber the rest of the doc.
      set(
        ref: { set: (d: Row, o?: { merge?: boolean }) => void },
        data: Row,
        opts?: { merge?: boolean },
      ) {
        ref.set(data, opts);
      },
      // advanceAgreementForPayment updates the agreement's nextPaymentDate
      // inside the transaction (real Admin SDK Transaction has update()).
      update(ref: { update: (d: Row) => void }, data: Row) {
        ref.update(data);
      },
    };
    return cb(t);
  },
  // Atomic batch — advanceAgreementForPayment writes the agreement + tenancy in
  // one batch so they can't desync. Buffer ops, apply on commit().
  batch() {
    const ops: Array<() => Promise<void>> = [];
    return {
      set(
        ref: { set: (d: Row, o?: { merge?: boolean }) => Promise<void> },
        data: Row,
        opts?: { merge?: boolean },
      ) {
        ops.push(() => ref.set(data, opts));
      },
      update(ref: { update: (d: Row) => Promise<void> }, data: Row) {
        ops.push(() => ref.update(data));
      },
      delete(ref: { delete?: () => Promise<void> }) {
        ops.push(async () => {
          await ref.delete?.();
        });
      },
      async commit() {
        for (const op of ops) await op();
      },
    };
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

vi.mock("../stripe", () => ({
  isStripeConfigured: () => true,
  stripe: () => ({
    checkout: {
      sessions: {
        create: async (...args: unknown[]) => {
          stripeCreateArgs = args;
          return { url: "https://checkout.stripe.com/session", id: "cs_test_1" };
        },
      },
    },
  }),
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

vi.mock("../services/push", () => ({ notifyUser: async () => {} }));

// Only stub the Stripe recorder. The offline-verify advancement now goes
// through the real, unmocked rentCycle helper, which runs against the
// in-memory Firestore double below — so these tests exercise it faithfully.
vi.mock("../services/rentTransaction", () => ({
  recordRentTransactionFromSession: async () => ({}),
}));

// Imported AFTER the mocks are registered (vi.mock is hoisted, so this
// is belt-and-braces — keeps the intent obvious).
import { registerTenantRoutes } from "./tenant";

function makeApp() {
  const app = express();
  app.use(express.json());
  registerTenantRoutes(app);
  return app;
}

// Seed an owner-created lease: an active tenancy, a real owner with
// Connect enabled, a property — but deliberately NO unit doc.
function seedOwnerCreatedLease() {
  store.users.set("owner-uid", { id: "owner-uid" });
  // Banking lives on the portfolio now — the source of truth loadActiveTenancy
  // reads via loadPortfolioBanking (there is no user-doc fallback anymore).
  store.portfolios.set("pf-owner", {
    id: "pf-owner",
    ownerId: "owner-uid",
    connectAccountId: "acct_123",
    connectChargesEnabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  store.properties.set("prop-1", {
    id: "prop-1",
    ownerId: "owner-uid",
    address: "Makariou III Avenue",
  });
  store.tenants.set("ten-1", {
    id: "ten-1",
    userId: "tenant-uid",
    name: "Tess Tenant",
    unitId: "prop-1", // owner-created: unitId === propertyId, no Unit doc
    propertyId: "prop-1",
    ownerId: "owner-uid",
    rentAmount: 1200,
    status: "active",
  });
}

const CHECKOUT_BODY = {
  unitId: "prop-1",
  successUrl: "https://app.oliowallet.com/tenant?payment=success",
  cancelUrl: "https://app.oliowallet.com/tenant",
};

describe("POST /api/tenant/payment/checkout — owner-created lease (no Unit doc)", () => {
  it("starts checkout using the tenancy's rentAmount when no Unit doc exists", async () => {
    seedOwnerCreatedLease();
    const res = await request(makeApp()).post("/api/tenant/payment/checkout").send(CHECKOUT_BODY);

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://checkout.stripe.com/session");

    // Amount came from the tenancy doc (1200 → 120000 cents), and the
    // session was created on the owner's connected account.
    const [params, opts] = stripeCreateArgs as [
      {
        line_items: Array<{ price_data: { unit_amount: number; product_data: { name: string } } }>;
        metadata: { ownerId?: string; portfolioId?: string };
      },
      { stripeAccount: string },
    ];
    expect(params.line_items[0].price_data.unit_amount).toBe(120000);
    expect(params.line_items[0].price_data.product_data.name).toContain("Makariou III Avenue");
    expect(opts.stripeAccount).toBe("acct_123");
    // Phase-1 portfolio re-key: the session metadata carries the landlord's
    // STABLE portfolio doc id so finalize/webhook can stamp the Transaction.
    expect(params.metadata.ownerId).toBe("owner-uid");
    expect(params.metadata.portfolioId).toBe("pf-owner");
  });

  it("still 404s when there is no active tenancy at all", async () => {
    // Nothing seeded.
    const res = await request(makeApp()).post("/api/tenant/payment/checkout").send(CHECKOUT_BODY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Active tenancy not found");
  });

  it("404s when the owner doc is missing (orphaned tenancy)", async () => {
    seedOwnerCreatedLease();
    store.users.delete("owner-uid");
    const res = await request(makeApp()).post("/api/tenant/payment/checkout").send(CHECKOUT_BODY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Active tenancy not found");
  });

  it("prefers the Unit doc's rentAmount when one exists", async () => {
    seedOwnerCreatedLease();
    // An admin-created lease where a real Unit doc carries its own rent.
    store.units.set("prop-1", { id: "prop-1", label: "Apt 3B", rentAmount: 999 });
    const res = await request(makeApp()).post("/api/tenant/payment/checkout").send(CHECKOUT_BODY);

    expect(res.status).toBe(200);
    const [params] = stripeCreateArgs as [
      {
        line_items: Array<{ price_data: { unit_amount: number; product_data: { name: string } } }>;
      },
    ];
    expect(params.line_items[0].price_data.unit_amount).toBe(99900);
    expect(params.line_items[0].price_data.product_data.name).toContain("Apt 3B");
  });

  it("charges a WHOLE period for a non-monthly lease (quarterly = 3x) and tags the cycle", async () => {
    seedOwnerCreatedLease();
    // The cycle clock advances a full quarter on payment, so the charge must
    // cover the whole period — not one month (M-2 under-collection fix).
    store.agreements.set("ag-1", {
      id: "ag-1",
      tenantId: "ten-1",
      ownerId: "owner-uid",
      status: "active",
      paymentFrequency: "quarterly",
      nextPaymentDate: "2026-06-01",
    });
    const res = await request(makeApp()).post("/api/tenant/payment/checkout").send(CHECKOUT_BODY);

    expect(res.status).toBe(200);
    const [params] = stripeCreateArgs as [
      {
        line_items: Array<{
          price_data: { unit_amount: number; product_data: { name: string } };
        }>;
        metadata: { rentPeriod?: string };
      },
    ];
    expect(params.line_items[0].price_data.unit_amount).toBe(360000); // 1200 × 3
    expect(params.line_items[0].price_data.product_data.name).toContain("(3 months)");
    expect(params.metadata.rentPeriod).toBe("2026-06-01");
  });
});

describe("GET /api/tenant/units — agreement payment-frequency join", () => {
  // The dashboard's offline-payment drawer prefills a WHOLE billing period
  // (quarterly = 3×, yearly = 12×) so the logged amount clears the BL-9 clamp
  // and the verified payment advances the cycle exactly one period — matching
  // what the card-checkout endpoint charges server-side. To do that the client
  // needs the lease cadence on the unit payload, which the GET /units handler
  // joins from the tenancy's ACTIVE agreement (tenant.ts ~120-129). These
  // tests pin that join; they do NOT re-cover BL-9's log-clamp (POST
  // /payment/log) which is exercised separately below.

  it("joins paymentFrequency from the active agreement onto the unit", async () => {
    seedOwnerCreatedLease();
    store.agreements.set("ag-1", {
      id: "ag-1",
      tenantId: "ten-1", // Agreement.tenantId === Tenant.id
      ownerId: "owner-uid",
      status: "active",
      paymentFrequency: "quarterly",
      nextPaymentDate: "2026-06-01",
    });
    const res = await request(makeApp()).get("/api/tenant/units");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const unit = res.body[0];
    expect(unit.tenantId).toBe("ten-1");
    expect(unit.unitId).toBe("prop-1");
    // Cadence comes off the active agreement, not the tenancy/unit doc.
    expect(unit.paymentFrequency).toBe("quarterly");
    // rentAmount falls back to the tenancy doc (owner-created lease, no Unit).
    expect(unit.rentAmount).toBe(1200);
    // The drawer prefills rentAmount × monthsPerPeriod; for a quarterly lease
    // that's the full-period amount the BL-9 clamp on /payment/log requires
    // (1200 × 3 = 3600). Asserting the two fields the prefill is derived from
    // proves the payload carries everything the whole-period prefill needs.
    expect(unit.rentAmount * 3).toBe(3600);
  });

  it("does NOT pick up cadence from a non-active (e.g. declined) agreement", async () => {
    seedOwnerCreatedLease();
    // A stale declined agreement must not leak its cadence onto the unit — the
    // join filters to status === "active" before reading paymentFrequency.
    store.agreements.set("ag-old", {
      id: "ag-old",
      tenantId: "ten-1",
      ownerId: "owner-uid",
      status: "declined",
      paymentFrequency: "yearly",
      nextPaymentDate: "2025-01-01",
    });
    const res = await request(makeApp()).get("/api/tenant/units");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // No active agreement → null cadence; the client treats null as monthly.
    expect(res.body[0].paymentFrequency).toBeNull();
  });

  it("returns null cadence when the lease has no agreement at all (legacy)", async () => {
    seedOwnerCreatedLease(); // no agreement seeded
    const res = await request(makeApp()).get("/api/tenant/units");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].paymentFrequency).toBeNull();
    // The prefill data is still present (monthly fallback on the client).
    expect(res.body[0].rentAmount).toBe(1200);
  });
});

describe("GET /api/tenant/payment-details/:unitId — owner IBAN for bank transfer", () => {
  // The offline drawer shows the owner's saved IBAN when the tenant picks
  // "Bank transfer", or prompts them to ask the owner when none is on file.
  // Resolution goes through loadActiveTenancy, so a tenant only ever sees the
  // IBAN of an owner they currently rent from.

  it("returns the owner's saved bank details for an active tenancy", async () => {
    seedOwnerCreatedLease();
    store.portfolios.set("pf-owner", {
      ...(store.portfolios.get("pf-owner") as Row),
      bankDetails: {
        holder: "Olive Owner",
        iban: "CY17002001280000001200527600",
        swift: "BCYPCY2N",
      },
    });
    const res = await request(makeApp()).get("/api/tenant/payment-details/prop-1");

    expect(res.status).toBe(200);
    expect(res.body.bankDetails).toEqual({
      holder: "Olive Owner",
      iban: "CY17002001280000001200527600",
      swift: "BCYPCY2N",
    });
  });

  it("returns { bankDetails: null } when the owner has saved none", async () => {
    seedOwnerCreatedLease(); // owner doc has no bankDetails
    const res = await request(makeApp()).get("/api/tenant/payment-details/prop-1");

    expect(res.status).toBe(200);
    expect(res.body.bankDetails).toBeNull();
  });

  it("treats a half-saved record (no IBAN) as not set", async () => {
    seedOwnerCreatedLease();
    store.portfolios.set("pf-owner", {
      ...(store.portfolios.get("pf-owner") as Row),
      bankDetails: { holder: "Olive Owner", iban: "", swift: "" },
    });
    const res = await request(makeApp()).get("/api/tenant/payment-details/prop-1");

    expect(res.status).toBe(200);
    expect(res.body.bankDetails).toBeNull();
  });

  it("404s when the caller has no active tenancy for that unit", async () => {
    // Nothing seeded — loadActiveTenancy fails, so no IBAN can leak.
    const res = await request(makeApp()).get("/api/tenant/payment-details/prop-1");
    expect(res.status).toBe(404);
    expect(res.body.bankDetails).toBeUndefined();
  });

  it("does not leak the owner's IBAN to a different user than the tenant", async () => {
    seedOwnerCreatedLease();
    store.portfolios.set("pf-owner", {
      ...(store.portfolios.get("pf-owner") as Row),
      bankDetails: {
        holder: "Olive Owner",
        iban: "CY17002001280000001200527600",
        swift: "BCYPCY2N",
      },
    });
    // A signed-in user who is NOT the tenant of prop-1.
    currentUser = { uid: "stranger-uid" };
    const res = await request(makeApp()).get("/api/tenant/payment-details/prop-1");

    expect(res.status).toBe(404);
    expect(res.body.bankDetails).toBeUndefined();
  });
});

describe("POST /api/tenant/payment/finalize — idempotency ownership binding (H2)", () => {
  it("returns the cached transaction when it belongs to the caller's own tenancy", async () => {
    seedOwnerCreatedLease();
    store.transactions.set("stripe_cs_mine", {
      id: "stripe_cs_mine",
      stripeSessionId: "cs_mine",
      tenantId: "ten-1", // the caller's tenancy
      ownerId: "owner-uid",
      amount: 1200,
      status: "completed",
    });
    const res = await request(makeApp())
      .post("/api/tenant/payment/finalize")
      .send({ sessionId: "cs_mine", unitId: "prop-1" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("stripe_cs_mine");
    expect(res.body.amount).toBe(1200);
  });

  it("403s and leaks nothing when the session's tx belongs to a DIFFERENT tenancy", async () => {
    seedOwnerCreatedLease();
    // A victim's finalized rent record keyed on a session id the attacker
    // replays. Pre-fix, the idempotency branch returned this verbatim.
    store.transactions.set("stripe_cs_victim", {
      id: "stripe_cs_victim",
      stripeSessionId: "cs_victim",
      tenantId: "someone-elses-tenancy",
      ownerId: "other-owner",
      propertyId: "victim-prop",
      amount: 9999,
      applicationFeeCents: 500,
      ownerNetCents: 9499,
      status: "completed",
    });
    const res = await request(makeApp())
      .post("/api/tenant/payment/finalize")
      .send({ sessionId: "cs_victim", unitId: "prop-1" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/different user/i);
    // None of the victim's financial fields crossed the boundary.
    expect(res.body.amount).toBeUndefined();
    expect(res.body.ownerId).toBeUndefined();
    expect(res.body.applicationFeeCents).toBeUndefined();
  });

  it("404s before any session lookup when the caller has no active tenancy", async () => {
    // Nothing seeded — loadActiveTenancy fails first, so an attacker without
    // a tenancy can't even reach the idempotency branch.
    store.transactions.set("stripe_cs_mine", {
      id: "stripe_cs_mine",
      stripeSessionId: "cs_mine",
      tenantId: "ten-1",
      ownerId: "owner-uid",
      amount: 1200,
      status: "completed",
    });
    const res = await request(makeApp())
      .post("/api/tenant/payment/finalize")
      .send({ sessionId: "cs_mine", unitId: "prop-1" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/owner/payment/verify/:id — offline rent confirmation", () => {
  // Seed an owner verifying an offline rent payment: the owner is the caller,
  // a pending rent tx points at the tenancy, and an active agreement carries
  // the current due date.
  function seedPendingOfflineRent(nextPaymentDate = "2026-06-01") {
    seedOwnerCreatedLease();
    currentUser = { uid: "owner-uid" };
    store.transactions.set("offline_x", {
      id: "offline_x",
      tenantId: "ten-1",
      ownerId: "owner-uid",
      // Phase 4: every rent tx is portfolio-stamped; the verify gate keys
      // SOLELY on this (the legacy ownerId equality is gone).
      portfolioId: "pf-owner",
      category: "rent",
      status: "pending",
      amount: 1200,
      currency: "EUR",
      paymentMethod: "bank_transfer",
      timestamp: `${nextPaymentDate}T00:00:00.000Z`,
    });
    store.agreements.set("ag-1", {
      id: "ag-1",
      tenantId: "ten-1",
      ownerId: "owner-uid",
      status: "active",
      monthlyRent: 1200,
      nextPaymentDate,
    });
  }

  it("flips the tx to completed AND advances the agreement's nextPaymentDate by one month", async () => {
    seedPendingOfflineRent("2026-06-01");
    const res = await request(makeApp()).post("/api/owner/payment/verify/offline_x");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.verifiedAt).toBeTruthy();
    // The rent cycle rolled forward so the reminder cron stops nagging this
    // month and fires correctly next month — same as the Stripe card path.
    expect(store.agreements.get("ag-1")?.nextPaymentDate).toBe("2026-07-01");
  });

  it("is idempotent: re-verifying an already-completed tx does NOT advance again", async () => {
    seedPendingOfflineRent("2026-07-01");
    // Pretend it was already verified (cycle already advanced once).
    store.transactions.set("offline_x", {
      ...(store.transactions.get("offline_x") as Row),
      status: "completed",
    });
    const res = await request(makeApp()).post("/api/owner/payment/verify/offline_x");

    expect(res.status).toBe(200);
    // Early-return on the completed guard runs BEFORE advancement, so the due
    // date must be untouched — no double-advance from a repeat verify.
    expect(store.agreements.get("ag-1")?.nextPaymentDate).toBe("2026-07-01");
  });

  it("clamps month-end dates correctly (Jan 31 -> Feb 28)", async () => {
    seedPendingOfflineRent("2026-01-31");
    const res = await request(makeApp()).post("/api/owner/payment/verify/offline_x");

    expect(res.status).toBe(200);
    expect(store.agreements.get("ag-1")?.nextPaymentDate).toBe("2026-02-28");
  });

  it("advances a whole period for a quarterly lease (3 months, not 1)", async () => {
    seedPendingOfflineRent("2026-06-01");
    store.agreements.set("ag-1", {
      ...(store.agreements.get("ag-1") as Row),
      paymentFrequency: "quarterly",
    });
    const res = await request(makeApp()).post("/api/owner/payment/verify/offline_x");

    expect(res.status).toBe(200);
    expect(store.agreements.get("ag-1")?.nextPaymentDate).toBe("2026-09-01");
  });

  it("advances a whole year for a yearly lease (12 months)", async () => {
    seedPendingOfflineRent("2026-06-01");
    store.agreements.set("ag-1", {
      ...(store.agreements.get("ag-1") as Row),
      paymentFrequency: "yearly",
    });
    const res = await request(makeApp()).post("/api/owner/payment/verify/offline_x");

    expect(res.status).toBe(200);
    expect(store.agreements.get("ag-1")?.nextPaymentDate).toBe("2027-06-01");
  });

  it("does NOT double-advance: a payment tagged for an already-passed cycle is a no-op", async () => {
    // The agreement is already sitting on July (a prior payment advanced it).
    seedPendingOfflineRent("2026-07-01");
    // This second payment was logged against the JUNE cycle (rentPeriod).
    store.transactions.set("offline_x", {
      ...(store.transactions.get("offline_x") as Row),
      rentPeriod: "2026-06-01",
    });
    const res = await request(makeApp()).post("/api/owner/payment/verify/offline_x");

    expect(res.status).toBe(200);
    // Idempotency guard: cycle tag (June) != current due date (July) -> skip,
    // so we don't skip August by jumping July -> August.
    expect(store.agreements.get("ag-1")?.nextPaymentDate).toBe("2026-07-01");
  });

  it("rejects verification by someone who is not the transaction's owner", async () => {
    seedPendingOfflineRent("2026-06-01");
    currentUser = { uid: "not-the-owner" };
    const res = await request(makeApp()).post("/api/owner/payment/verify/offline_x");

    expect(res.status).toBe(403);
    // The cycle must NOT advance for an unauthorized caller.
    expect(store.agreements.get("ag-1")?.nextPaymentDate).toBe("2026-06-01");
  });

  // ── Phase-4 portfolio-keyed ownership gate ──────────────────────────
  // The verifier is whoever currently holds the transaction's PORTFOLIO
  // (the stable key that survives an owner transfer). The legacy
  // tx.ownerId === uid equality is removed — the gate keys SOLELY on
  // tx.portfolioId.

  it("accepts the CURRENT portfolio holder even when tx.ownerId is the previous owner", async () => {
    seedPendingOfflineRent("2026-06-01");
    // The portfolio was transferred: the portfolio doc points at the new
    // owner, while the tx still carries the previous owner's uid (Phase 3
    // rewrites it — the gate must not depend on that).
    store.portfolios.set("pf-owner", {
      id: "pf-owner",
      ownerId: "new-owner-uid",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.transactions.set("offline_x", {
      ...(store.transactions.get("offline_x") as Row),
      portfolioId: "pf-owner",
    });
    currentUser = { uid: "new-owner-uid" };

    const res = await request(makeApp()).post("/api/owner/payment/verify/offline_x");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    // The cycle advanced for the new holder, same as a legacy-owner verify.
    expect(store.agreements.get("ag-1")?.nextPaymentDate).toBe("2026-07-01");
  });

  it("still 403s a caller whose own portfolio does not match the tx stamp", async () => {
    seedPendingOfflineRent("2026-06-01");
    store.transactions.set("offline_x", {
      ...(store.transactions.get("offline_x") as Row),
      portfolioId: "pf-owner",
    });
    // The caller has a portfolio of their own — just not the tx's one.
    store.portfolios.set("pf-stranger", {
      id: "pf-stranger",
      ownerId: "stranger-uid",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    currentUser = { uid: "stranger-uid" };

    const res = await request(makeApp()).post("/api/owner/payment/verify/offline_x");

    expect(res.status).toBe(403);
    expect(store.agreements.get("ag-1")?.nextPaymentDate).toBe("2026-06-01");
  });

  // ── Per-cycle double-book guard (M2) ────────────────────────────────
  // Two distinct pending offline logs for the SAME lease + cycle (the
  // offline dedupe id keys on amount, so an exact log and an over-payment
  // produce two rows), or an offline log for a cycle a card payment already
  // settled, would otherwise BOTH be flipped to completed income and
  // double-count that cycle's realized rent in an append-only ledger.
  // Before completing, the verify handler refuses (HTTP 409) if a DIFFERENT
  // completed rent tx already exists for this tenancy + rentPeriod.

  it("409s without flipping when another completed rent tx already covers this cycle", async () => {
    seedPendingOfflineRent("2026-06-01");
    // The pending tx is cycle-tagged (the guard only fires when BOTH tenantId
    // and rentPeriod are set).
    store.transactions.set("offline_x", {
      ...(store.transactions.get("offline_x") as Row),
      rentPeriod: "2026-06-01",
    });
    // A SECOND, already-completed rent payment for the SAME tenancy + cycle
    // (e.g. a card payment that already settled June, or a duplicate offline
    // log). Different doc id.
    store.transactions.set("rent_card_june", {
      id: "rent_card_june",
      tenantId: "ten-1",
      ownerId: "owner-uid",
      portfolioId: "pf-owner",
      category: "rent",
      status: "completed",
      amount: 1200,
      currency: "EUR",
      rentPeriod: "2026-06-01",
      timestamp: "2026-06-01T00:00:00.000Z",
    });

    const res = await request(makeApp()).post("/api/owner/payment/verify/offline_x");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("cycle_already_paid");
    // The pending tx must NOT have been flipped — the ledger isn't double-booked.
    expect(store.transactions.get("offline_x")?.status).toBe("pending");
    // And the cycle clock didn't advance off the back of a refused verify.
    expect(store.agreements.get("ag-1")?.nextPaymentDate).toBe("2026-06-01");
  });

  it("verifies normally when the cycle has NO completed sibling (only a different cycle)", async () => {
    seedPendingOfflineRent("2026-06-01");
    store.transactions.set("offline_x", {
      ...(store.transactions.get("offline_x") as Row),
      rentPeriod: "2026-06-01",
    });
    // A completed rent payment exists but for a DIFFERENT cycle (May) — must
    // not block June's verify.
    store.transactions.set("rent_card_may", {
      id: "rent_card_may",
      tenantId: "ten-1",
      ownerId: "owner-uid",
      portfolioId: "pf-owner",
      category: "rent",
      status: "completed",
      amount: 1200,
      currency: "EUR",
      rentPeriod: "2026-05-01",
      timestamp: "2026-05-01T00:00:00.000Z",
    });

    const res = await request(makeApp()).post("/api/owner/payment/verify/offline_x");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(store.transactions.get("offline_x")?.status).toBe("completed");
    // Cycle rolled forward, same as the unguarded happy path.
    expect(store.agreements.get("ag-1")?.nextPaymentDate).toBe("2026-07-01");
  });

  it("does not block on a same-cycle sibling that is still pending (only COMPLETED counts)", async () => {
    seedPendingOfflineRent("2026-06-01");
    store.transactions.set("offline_x", {
      ...(store.transactions.get("offline_x") as Row),
      rentPeriod: "2026-06-01",
    });
    // A duplicate offline log for the same cycle, but still pending — it has
    // NOT been verified, so it must not trip the guard.
    store.transactions.set("offline_dup", {
      id: "offline_dup",
      tenantId: "ten-1",
      ownerId: "owner-uid",
      portfolioId: "pf-owner",
      category: "rent",
      status: "pending",
      amount: 1200,
      currency: "EUR",
      rentPeriod: "2026-06-01",
      timestamp: "2026-06-01T00:00:00.000Z",
    });

    const res = await request(makeApp()).post("/api/owner/payment/verify/offline_x");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(store.transactions.get("offline_x")?.status).toBe("completed");
  });
});

describe("GET /api/owner/payments/pending — portfolio-keyed pending rent (Phase 4: portfolioId-only)", () => {
  function seedPendingTx(id: string, fields: Record<string, unknown> = {}) {
    store.transactions.set(id, {
      id,
      tenantId: "ten-1",
      propertyId: "prop-1",
      category: "rent",
      status: "pending",
      amount: 1200,
      currency: "EUR",
      paymentMethod: "bank_transfer",
      timestamp: "2026-06-01T00:00:00.000Z",
      ...fields,
    });
  }

  it("returns a row stamped with the caller's portfolio even when its legacy ownerId differs, and omits foreign rows", async () => {
    seedOwnerCreatedLease();
    currentUser = { uid: "owner-uid" };
    // Post-transfer shape: portfolio stamp matches the caller's portfolio,
    // ownerId still points at the previous owner. Portfolio key wins.
    seedPendingTx("offline_stamped", {
      portfolioId: "pf-owner",
      ownerId: "previous-owner-uid",
    });
    // Neither the caller's portfolio nor their uid — must be absent.
    seedPendingTx("offline_foreign", {
      portfolioId: "pf-stranger",
      ownerId: "someone-else",
    });

    const res = await request(makeApp()).get("/api/owner/payments/pending");

    expect(res.status).toBe(200);
    expect(res.body.map((t: { id: string }) => t.id)).toEqual(["offline_stamped"]);
    expect(res.body[0].propertyAddress).toBe("Makariou III Avenue");
  });

  it("Phase 4: returns ONLY portfolio-stamped rows — an unstamped legacy row is invisible", async () => {
    seedOwnerCreatedLease();
    currentUser = { uid: "owner-uid" };
    // Unstamped row (the shape pre-stamping code wrote) — all prod rows are
    // stamped, so the removed legacy ownerId leg must NOT resurrect it.
    seedPendingTx("offline_legacy", {
      ownerId: "owner-uid",
      timestamp: "2026-06-02T00:00:00.000Z",
    });
    // Stamped row — the only kind the portfolioId-only query returns.
    seedPendingTx("offline_stamped", {
      ownerId: "owner-uid",
      portfolioId: "pf-owner",
      timestamp: "2026-06-03T00:00:00.000Z",
    });

    const res = await request(makeApp()).get("/api/owner/payments/pending");

    expect(res.status).toBe(200);
    expect(res.body.map((t: { id: string }) => t.id)).toEqual(["offline_stamped"]);
  });
});

describe("POST /api/tenant/payment/log — owner-created lease (no Unit doc)", () => {
  it("records an offline payment without requiring a Unit doc", async () => {
    seedOwnerCreatedLease();
    const res = await request(makeApp()).post("/api/tenant/payment/log").send({
      unitId: "prop-1",
      amount: 1200,
      method: "bank_transfer",
      paidAt: "2026-06-01T00:00:00.000Z",
      notes: "IBAN ref 42",
    });

    expect(res.status).toBe(201);
    expect(res.body.category).toBe("rent");
    expect(res.body.status).toBe("pending");
    expect(res.body.amount).toBe(1200);
    expect(res.body.propertyId).toBe("prop-1");
    // Collected rent is the owner's INCOME — must match the card path and the
    // income-based net/yield/admin-revenue readers. Regression guard for the
    // 2026-06-07 sign fix (was wrongly written as "expense").
    expect(res.body.type).toBe("income");
    // Phase-1 portfolio re-key: stamped with the LANDLORD's stable portfolio
    // doc id (resolved via ensurePortfolio(ctx.tenant.ownerId)).
    expect(res.body.portfolioId).toBe("pf-owner");
    // The transaction was actually persisted (with the stamp).
    expect(store.transactions.size).toBe(1);
    const persisted = Array.from(store.transactions.values())[0];
    expect(persisted.portfolioId).toBe("pf-owner");
  });

  it("creates + links the owner's portfolio when none exists yet, and stamps its id", async () => {
    seedOwnerCreatedLease();
    // Owner has no portfolio doc at all (e.g. never touched banking).
    store.portfolios.clear();

    const res = await request(makeApp()).post("/api/tenant/payment/log").send({
      unitId: "prop-1",
      amount: 1200,
      method: "cash",
      paidAt: "2026-06-01T00:00:00.000Z",
    });

    expect(res.status).toBe(201);
    // ensurePortfolio created exactly one portfolio for the LANDLORD…
    expect(store.portfolios.size).toBe(1);
    const [pfId, pf] = Array.from(store.portfolios.entries())[0];
    expect(pf.ownerId).toBe("owner-uid");
    // …stamped its stable doc id on the transaction…
    expect(res.body.portfolioId).toBe(pfId);
    // …and linked the owner's user doc for deterministic future lookups
    // WITHOUT clobbering the rest of the doc (merge semantics).
    expect(store.users.get("owner-uid")?.portfolioRef).toBe(pfId);
    expect(store.users.get("owner-uid")?.id).toBe("owner-uid");
  });

  it("tags the offline payment with the current rent cycle (rentPeriod)", async () => {
    seedOwnerCreatedLease();
    store.agreements.set("ag-1", {
      id: "ag-1",
      tenantId: "ten-1",
      ownerId: "owner-uid",
      status: "active",
      nextPaymentDate: "2026-06-01",
    });
    const res = await request(makeApp()).post("/api/tenant/payment/log").send({
      unitId: "prop-1",
      amount: 1200,
      method: "bank_transfer",
      paidAt: "2026-06-01T00:00:00.000Z",
    });

    expect(res.status).toBe(201);
    // Captured from the agreement's due date so a later verify advances the
    // correct cycle (and can't double-advance a split payment).
    expect(res.body.rentPeriod).toBe("2026-06-01");
  });

  // ── Full-period clamp (BL-9) ──────────────────────────────────────────
  // On owner verify, advanceAgreementForPayment rolls the cycle forward a
  // WHOLE billing period regardless of the logged amount. So a quarterly
  // tenant logging ONE month would jump the whole quarter and skip the rest
  // of its reminders. The log handler now rejects any amount short of the
  // full period (rent × monthsPerPeriod) and records exact full-period logs
  // unchanged.

  // Seed an active quarterly agreement (rent 1200/mo → 3600/quarter).
  function seedQuarterlyLease() {
    seedOwnerCreatedLease();
    store.agreements.set("ag-1", {
      id: "ag-1",
      tenantId: "ten-1",
      ownerId: "owner-uid",
      status: "active",
      paymentFrequency: "quarterly",
      nextPaymentDate: "2026-06-01",
    });
  }

  it("rejects an offline log of ONE month on a quarterly lease (no cycle skip)", async () => {
    seedQuarterlyLease();
    const res = await request(makeApp()).post("/api/tenant/payment/log").send({
      unitId: "prop-1",
      amount: 1200, // one month — short of the 3600 quarter
      method: "bank_transfer",
      paidAt: "2026-06-01T00:00:00.000Z",
    });

    // 4xx, and crucially NOTHING is recorded — so the owner can't verify a
    // partial payment that would full-advance the cycle.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/3 months|partial/i);
    expect(store.transactions.size).toBe(0);
  });

  it("rejects a token €1 offline log on a quarterly lease", async () => {
    seedQuarterlyLease();
    const res = await request(makeApp()).post("/api/tenant/payment/log").send({
      unitId: "prop-1",
      amount: 1, // nowhere near the 3600 quarter
      method: "bank_transfer",
      paidAt: "2026-06-01T00:00:00.000Z",
    });

    expect(res.status).toBe(400);
    expect(store.transactions.size).toBe(0);
  });

  it("accepts an offline log equal to the FULL quarter (3 months)", async () => {
    seedQuarterlyLease();
    const res = await request(makeApp()).post("/api/tenant/payment/log").send({
      unitId: "prop-1",
      amount: 3600, // 1200 × 3 — covers the whole quarter
      method: "bank_transfer",
      paidAt: "2026-06-01T00:00:00.000Z",
    });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(3600);
    expect(res.body.category).toBe("rent");
    // Tagged with the cycle it pays so verify advances exactly one quarter.
    expect(res.body.rentPeriod).toBe("2026-06-01");
    expect(store.transactions.size).toBe(1);
  });

  it("still accepts an exact one-month log on a monthly lease (unchanged)", async () => {
    seedOwnerCreatedLease();
    store.agreements.set("ag-1", {
      id: "ag-1",
      tenantId: "ten-1",
      ownerId: "owner-uid",
      status: "active",
      paymentFrequency: "monthly",
      nextPaymentDate: "2026-06-01",
    });
    const res = await request(makeApp()).post("/api/tenant/payment/log").send({
      unitId: "prop-1",
      amount: 1200, // full month on a monthly lease
      method: "bank_transfer",
      paidAt: "2026-06-01T00:00:00.000Z",
    });

    expect(res.status).toBe(201);
    expect(store.transactions.size).toBe(1);
  });
});
