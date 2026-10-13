// Behavior tests for POST /api/owner/agreements — the
// "add an Agreement / invite a tenant" endpoint.
//
// This endpoint is privilege-gated (owner-plan: tenants.invite +
// contracts.create), creates a Tenant + Agreement pair under
// deterministic ids derived from sha256(owner+property+email+startDate),
// and notifies the tenant exactly once (only if a Firebase Auth account
// already exists for that email). The deterministic-id +
// transaction-noop combo is what makes double-submits safe; without it
// a slow network or two-tab user would get duplicate tenancies.
//
// Mocking strategy:
//   - vi.mock("../firebase") supplies an in-memory Firestore double
//     covering properties, tenants, and agreements. The transaction
//     handle's `get` resolves docRef existence against the same maps,
//     and `set` writes back into them. That's the only thing the
//     route actually needs to call inside the txn.
//   - vi.mock("../auth") supplies a fake requireAuth that injects a
//     test-controlled req.user with a Connect-ready profile.
//   - vi.mock("../services/push") swaps notifyUser for a spy so tests
//     can assert it fires once (or not at all) on double-submit.
//   - The route imports auth().getUserByEmail from "../firebase"; the
//     mock returns either an existing uid or throws auth/user-not-found
//     based on a per-test map.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mutable test state ─────────────────────────────────────────────────

interface TestUser {
  uid: string;
  email?: string;
  profile?: Record<string, unknown>;
}

let currentUser: TestUser = {
  uid: "owner-uid",
  email: "owner@example.com",
  profile: {
    connectAccountId: "acct_test",
    connectChargesEnabled: true,
  },
};

// Per-collection in-memory stores.
const propertiesById = new Map<string, Record<string, unknown>>();
const tenantsById = new Map<string, Record<string, unknown>>();
const agreementsById = new Map<string, Record<string, unknown>>();
const transactionsById = new Map<string, Record<string, unknown>>();

// Map of email -> { uid } for the auth().getUserByEmail mock. Absence
// triggers the auth/user-not-found path.
const authUsersByEmail = new Map<string, { uid: string }>();

// Spy slots so tests can clear + count calls.
const notifyUserSpy = vi.fn(async () => undefined);
const sendTenantAgreementInviteEmailSpy = vi.fn(async () => undefined);

// Controllable resolveOwnerScope result in the PHASE-2 shape: the OK branch
// carries the STABLE portfolio doc id, which is now the operative key for
// every scoped GET in this module. authorizePortfolioRead passes by default —
// the privilege matrix is covered by its own suite.
type ScopeResult =
  | {
      ok: true;
      ownerId: string;
      portfolioId: string | null;
      permissions: string[];
      isSelf: boolean;
    }
  | { ok: false; status: number; error: string };
let scopeResult: ScopeResult;
const resolveOwnerScopeMock = vi.fn(async () => scopeResult);
const authorizePortfolioReadMock = vi.fn(async () => ({ ok: true as const }));

beforeEach(() => {
  currentUser = {
    uid: "owner-uid",
    email: "owner@example.com",
    profile: {
      connectAccountId: "acct_test",
      connectChargesEnabled: true,
    },
  };
  scopeResult = {
    ok: true,
    ownerId: "owner-uid",
    portfolioId: "pf-test",
    permissions: ["view", "edit"],
    isSelf: true,
  };
  propertiesById.clear();
  tenantsById.clear();
  agreementsById.clear();
  transactionsById.clear();
  authUsersByEmail.clear();
  notifyUserSpy.mockClear();
  sendTenantAgreementInviteEmailSpy.mockClear();
  resolveOwnerScopeMock.mockClear();
  authorizePortfolioReadMock.mockClear();
});

// ── Firestore double ───────────────────────────────────────────────────

function makeQuerySnap(
  docs: Array<{ id: string; data: Record<string, unknown> }>,
  store?: Map<string, Record<string, unknown>>,
) {
  return {
    empty: docs.length === 0,
    size: docs.length,
    docs: docs.map((d) => ({
      id: d.id,
      // A functional ref (set/update/get into the source store) so code that
      // writes back through a query result — e.g. settle-balance clearing each
      // agreement's closingBalance — works against the double.
      ref: store ? makeDocRef(store, d.id) : { id: d.id },
      data: () => d.data,
      exists: true,
    })),
  };
}

function makeDocRef(store: Map<string, Record<string, unknown>>, id: string) {
  return {
    id,
    async get() {
      const data = store.get(id);
      return {
        exists: !!data,
        id,
        data: () => data,
      };
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const existing = store.get(id);
      store.set(id, opts?.merge ? { ...existing, ...data } : data);
    },
    async update(updates: Record<string, unknown>) {
      const existing = store.get(id);
      if (!existing) throw new Error(`no doc ${id}`);
      store.set(id, { ...existing, ...updates });
    },
  };
}

function makeBatch() {
  const ops: Array<() => void> = [];
  return {
    set(
      ref: {
        set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => Promise<void>;
      },
      data: Record<string, unknown>,
      opts?: { merge?: boolean },
    ) {
      // Delegate to the doc ref's own setter so each write lands in the
      // correct collection store (agreements/tenants/units) — mirroring real
      // Firestore batch semantics. applyRentChange writes across collections
      // in one batch, so a hardcoded single-store double would misroute them.
      ops.push(() => {
        void ref.set(data, opts);
      });
    },
    delete(_ref: { id: string }) {
      ops.push(() => {
        /* no-op for this route */
      });
    },
    async commit() {
      ops.forEach((fn) => fn());
    },
  };
}

function storeFor(name: string): Map<string, Record<string, unknown>> {
  if (name === "properties") return propertiesById;
  if (name === "tenants") return tenantsById;
  if (name === "agreements") return agreementsById;
  if (name === "transactions") return transactionsById;
  // Unknown collections (units, users, …) read as empty.
  return new Map();
}

// Real equality/`in` filtering over the per-collection stores — the phase-2
// GET tests below seed rows keyed by portfolioId and assert the flipped
// queries select exactly the stamped set. Collections without a store
// (units/users/transactions) still resolve to empty snaps.
function makeFilterQuery(name: string) {
  const filters: Array<{ field: string; op: string; value: unknown }> = [];
  let cap = Infinity;
  const q = {
    where(field: string, op: string, value: unknown) {
      filters.push({ field, op, value });
      return q;
    },
    limit(n: number) {
      cap = Math.min(cap, n);
      return q;
    },
    async get() {
      let rows = Array.from(storeFor(name).entries()).map(([id, data]) => ({ id, data }));
      for (const f of filters) {
        rows = rows.filter((r) =>
          f.op === "in"
            ? Array.isArray(f.value) && f.value.includes(r.data[f.field])
            : r.data[f.field] === f.value,
        );
      }
      return makeQuerySnap(rows.slice(0, cap), storeFor(name));
    },
  };
  return q;
}

const dbDouble = {
  collection: (name: string) => ({
    doc: (id?: string) => {
      const finalId = id ?? `auto_${Math.random().toString(36).slice(2, 10)}`;
      return makeDocRef(storeFor(name), finalId);
    },
    where: (field: string, op: string, value: unknown) =>
      makeFilterQuery(name).where(field, op, value),
  }),
  // Batched point reads used by the GET joins (tenants/properties/units).
  async getAll(...refs: Array<{ get: () => Promise<unknown> }>) {
    return Promise.all(refs.map((r) => r.get()));
  },
  batch: () => makeBatch(),
  async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
    // Same caveat as in properties.test.ts: this isn't a real
    // isolated transaction, but the route only ever does
    // t.get(docRef) followed by t.set(docRef, data), which we apply
    // immediately. Good enough to exercise the existence-check
    // branch + the no-op branch.
    const t = {
      async get(ref: { id: string; get: () => Promise<unknown> }) {
        return ref.get();
      },
      set(
        ref: {
          id: string;
          set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => Promise<void>;
        },
        data: Record<string, unknown>,
        opts?: { merge?: boolean },
      ) {
        return ref.set(data, opts);
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
    async getUserByEmail(email: string) {
      const u = authUsersByEmail.get(email.toLowerCase());
      if (u) return { uid: u.uid };
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

vi.mock("../services/push", () => ({
  notifyUser: notifyUserSpy,
  sendPush: vi.fn(),
  PushError: class extends Error {
    status = 0;
  },
  getPushIntegrationStatus: () => ({ configured: false }),
}));

vi.mock("../services/transactionalEmail", () => ({
  sendTenantAgreementInviteEmail: sendTenantAgreementInviteEmailSpy,
  sendUserInviteEmail: vi.fn(),
  sendPortfolioAccessInviteEmail: vi.fn(),
}));

// The agreement-creation payout gate now reads banking via loadPortfolioBanking
// (banking lives on the portfolio, not the user). These tests express the
// owner's payout state via currentUser.profile, which carries the same
// connectAccountId/connectChargesEnabled/bankDetails fields — surface that here
// rather than wiring a portfolios collection into the Firestore double.
// ensurePortfolio backs the portfolioId stamping on created Tenant/Agreement
// docs — a fixed stable id keeps the assertion deterministic.
vi.mock("../services/portfolioBanking", () => ({
  loadPortfolioBanking: async () => currentUser.profile ?? {},
  ensurePortfolio: async () => ({
    id: "pf-test",
    ownerId: currentUser.uid,
    createdAt: "2026-01-01T00:00:00.000Z",
  }),
}));

// The GET endpoints resolve their scope through resolveOwnerScope; stub it
// with the phase-2 shape (ownerId + STABLE portfolioId) so these tests pin
// the route-side key flip independently of the scope resolver's own suite.
vi.mock("../services/ownerScope", () => ({
  resolveOwnerScope: resolveOwnerScopeMock,
  authorizePortfolioRead: authorizePortfolioReadMock,
}));

// ── Build the test app ────────────────────────────────────────────────

const { registerPortfolioRoutes } = await import("./portfolio");

// The route requires a privilege middleware. Tests inject a permissive
// fake here — the privilege gating itself is covered elsewhere
// (services/configCache + the routes.integration.test surface check).
// This file's job is to pin the create-or-no-op + tenant linking
// branches.
function buildApp() {
  const app = express();
  app.use(express.json());
  registerPortfolioRoutes(app, {
    requireOwnerPlanPrivilege: () => (_req, _res, next) => next(),
  });
  return app;
}

// ── Helpers ────────────────────────────────────────────────────────────

function seedProperty(id: string, ownerId: string) {
  propertiesById.set(id, {
    id,
    ownerId,
    address: `${id} Test Lane`,
    propertyValue: 100000,
    acquisitionPrice: 80000,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

const VALID_BODY = {
  tenantEmail: "newtenant@example.com",
  propertyId: "prop1",
  rentAmount: 1500,
  deposit: 3000,
  startDate: "2026-06-01",
};

// ──────────────────────────────────────────────────────────────────────
// POST /api/owner/agreements
// ──────────────────────────────────────────────────────────────────────

describe("POST /api/owner/agreements", () => {
  it("creates a tenancy with userId=undefined + status='invited' when the tenant has no Auth account", async () => {
    seedProperty("prop1", "owner-uid");
    // authUsersByEmail is empty → getUserByEmail throws auth/user-not-found.
    const app = buildApp();

    const res = await request(app).post("/api/owner/agreements").send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBeTruthy();
    expect(res.body.agreementId).toBeTruthy();
    expect(res.body.inviteLink).toBeNull();

    // Tenant doc was stored with no linked uid and the invited status.
    const tenant = tenantsById.get(res.body.tenantId);
    expect(tenant).toBeTruthy();
    expect(tenant?.userId).toBeUndefined();
    expect(tenant?.status).toBe("invited");
    expect(tenant?.email).toBe("newtenant@example.com");
    expect(tenant?.portfolioId).toBe("pf-test");

    // No push fired — there's no real user to notify.
    expect(notifyUserSpy).not.toHaveBeenCalled();

    // Transactional email DID fire — that's the only channel that
    // reaches an unregistered tenant email. hasAccount=false flips the
    // CTA copy to "sign up".
    expect(sendTenantAgreementInviteEmailSpy).toHaveBeenCalledTimes(1);
    const inviteArgs = sendTenantAgreementInviteEmailSpy.mock.calls[0][0] as {
      email?: string;
      hasAccount?: boolean;
    };
    expect(inviteArgs.email).toBe("newtenant@example.com");
    expect(inviteArgs.hasAccount).toBe(false);
  });

  it("creates a tenancy with userId=<existing uid> + status='pending' when the tenant already has an Auth account", async () => {
    seedProperty("prop1", "owner-uid");
    authUsersByEmail.set("newtenant@example.com", { uid: "tenant-uid-123" });
    const app = buildApp();

    const res = await request(app).post("/api/owner/agreements").send(VALID_BODY);

    expect(res.status).toBe(201);
    const tenant = tenantsById.get(res.body.tenantId);
    expect(tenant?.userId).toBe("tenant-uid-123");
    expect(tenant?.status).toBe("pending");

    // Push was fired once with the propertyActivity category.
    expect(notifyUserSpy).toHaveBeenCalledTimes(1);
    const args = notifyUserSpy.mock.calls[0][0] as { externalUserId?: string; category?: string };
    expect(args.externalUserId).toBe("tenant-uid-123");
    expect(args.category).toBe("propertyActivity");

    // Transactional email also fired with hasAccount=true so the CTA
    // copy points the existing tenant at sign-in rather than sign-up.
    expect(sendTenantAgreementInviteEmailSpy).toHaveBeenCalledTimes(1);
    const inviteArgs = sendTenantAgreementInviteEmailSpy.mock.calls[0][0] as {
      hasAccount?: boolean;
    };
    expect(inviteArgs.hasAccount).toBe(true);
  });

  it("returns 400 'You can't add yourself as a tenant' when tenantEmail belongs to the caller", async () => {
    seedProperty("prop1", "owner-uid");
    // The caller's own email points at their uid in Firebase Auth.
    authUsersByEmail.set("owner@example.com", { uid: "owner-uid" });
    const app = buildApp();

    const res = await request(app)
      .post("/api/owner/agreements")
      .send({ ...VALID_BODY, tenantEmail: "owner@example.com" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/yourself as a tenant/i);
    // No docs written.
    expect(tenantsById.size).toBe(0);
    expect(agreementsById.size).toBe(0);
  });

  it("returns 400 when prepaidRents is set without a first-payment date (L38)", async () => {
    seedProperty("prop1", "owner-uid");
    const app = buildApp();

    // VALID_BODY has no nextPaymentDate; prepaid months need one to offset from.
    const res = await request(app)
      .post("/api/owner/agreements")
      .send({ ...VALID_BODY, prepaidRents: 3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/first payment date/i);
    expect(agreementsById.size).toBe(0);
  });

  it("returns 409 when the property already has a live tenancy (double-occupancy)", async () => {
    seedProperty("prop1", "owner-uid");
    tenantsById.set("ten-existing", {
      id: "ten-existing",
      ownerId: "owner-uid",
      propertyId: "prop1",
      status: "active",
    });
    const app = buildApp();

    const res = await request(app).post("/api/owner/agreements").send(VALID_BODY);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has a tenant or a pending invite/i);
    expect(agreementsById.size).toBe(0);
  });

  it("returns 412 with code='no_payment_method' when the owner has no Connect account", async () => {
    seedProperty("prop1", "owner-uid");
    // Strip Connect fields from the caller profile.
    currentUser = {
      uid: "owner-uid",
      email: "owner@example.com",
      profile: {},
    };
    const app = buildApp();

    const res = await request(app).post("/api/owner/agreements").send(VALID_BODY);

    expect(res.status).toBe(412);
    expect(res.body.code).toBe("no_payment_method");
    expect(res.body.error).toMatch(/payout method/i);
    expect(tenantsById.size).toBe(0);
    expect(agreementsById.size).toBe(0);
  });

  it("allows creation when the owner has an IBAN but no Connect account", async () => {
    seedProperty("prop1", "owner-uid");
    authUsersByEmail.set("newtenant@example.com", { uid: "tenant-uid-iban" });
    // Owner skipped Stripe Connect and added a direct IBAN instead — a
    // valid payout path (tenants pay by bank transfer, off-platform).
    currentUser = {
      uid: "owner-uid",
      email: "owner@example.com",
      profile: {
        bankDetails: {
          holder: "Owner",
          iban: "GR16 0110 1250 0000 0001 2300 695",
          swift: "ETHNGRAA",
        },
      },
    };
    const app = buildApp();

    const res = await request(app).post("/api/owner/agreements").send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(tenantsById.size).toBe(1);
    expect(agreementsById.size).toBe(1);
  });

  it("stamps the owner's stable portfolio id on BOTH the Tenant and the Agreement docs", async () => {
    seedProperty("prop1", "owner-uid");
    authUsersByEmail.set("newtenant@example.com", { uid: "tenant-uid-123" });
    const app = buildApp();

    const res = await request(app).post("/api/owner/agreements").send(VALID_BODY);

    expect(res.status).toBe(201);
    // Both created docs carry Portfolio.id (the STABLE doc id, not the
    // human display label) so a later owner transfer can't strand them.
    expect(tenantsById.get(res.body.tenantId)?.portfolioId).toBe("pf-test");
    expect(agreementsById.get(res.body.agreementId)?.portfolioId).toBe("pf-test");
  });

  it("is idempotent on double-submit: same tenantId+agreementId, one tenant doc, one notification", async () => {
    seedProperty("prop1", "owner-uid");
    authUsersByEmail.set("newtenant@example.com", { uid: "tenant-uid-123" });
    const app = buildApp();

    const first = await request(app).post("/api/owner/agreements").send(VALID_BODY);
    expect(first.status).toBe(201);

    const second = await request(app).post("/api/owner/agreements").send(VALID_BODY);
    expect(second.status).toBe(201);

    // Identical deterministic ids on both responses.
    expect(second.body.tenantId).toBe(first.body.tenantId);
    expect(second.body.agreementId).toBe(first.body.agreementId);

    // Only ONE tenant doc and ONE agreement doc exist — the txn's
    // existence check caught the second write.
    expect(tenantsById.size).toBe(1);
    expect(agreementsById.size).toBe(1);

    // Notification fired exactly once — the second request must skip
    // the push because `alreadyExisted` is true.
    expect(notifyUserSpy).toHaveBeenCalledTimes(1);
    // Same goes for the transactional email — must not double-send on
    // a double-submit.
    expect(sendTenantAgreementInviteEmailSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a zero / negative / fractional rentalDurationMonths with 400 and writes nothing", async () => {
    seedProperty("prop1", "owner-uid");
    const app = buildApp();

    for (const bad of [0, -5, 12.5]) {
      const res = await request(app)
        .post("/api/owner/agreements")
        .send({ ...VALID_BODY, rentalDurationMonths: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/duration must be a whole number/i);
    }

    // None of the rejected attempts half-created a tenancy.
    expect(tenantsById.size).toBe(0);
    expect(agreementsById.size).toBe(0);
  });

  it("offsets nextPaymentDate by prepaid + rent-free months (stacked) so neither window duns the tenant", async () => {
    seedProperty("prop1", "owner-uid");
    const app = buildApp();

    const res = await request(app)
      .post("/api/owner/agreements")
      .send({
        ...VALID_BODY,
        nextPaymentDate: "2026-06-01",
        prepaidRents: 3,
        rentFreePeriodMonths: 2,
      });

    expect(res.status).toBe(201);
    // 3 prepaid + 2 rent-free = first chargeable due date is 5 months out.
    const agreement = agreementsById.get(res.body.agreementId);
    expect(agreement?.nextPaymentDate).toBe("2026-11-01");
    // The raw rent-free value is still persisted for display/PDF.
    expect(agreement?.rentFreePeriodMonths).toBe(2);
    // The tenant doc's nextPayment mirrors the same offset.
    expect(tenantsById.get(res.body.tenantId)?.nextPayment).toBe("2026-11-01");
  });

  it("rejects negative / fractional / over-term month fields (prepaid, rent-free, notice, indexationDelay)", async () => {
    seedProperty("prop1", "owner-uid");
    const app = buildApp();

    const cases: Array<[string, unknown]> = [
      ["rentFreePeriodMonths", -3],
      ["prepaidRents", 2.5],
      ["prepaidRents", 99], // > 12-month default term
      ["noticePeriodMonths", -1],
      ["indexationDelay", -6],
    ];
    for (const [field, value] of cases) {
      const res = await request(app)
        .post("/api/owner/agreements")
        .send({ ...VALID_BODY, [field]: value });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(new RegExp(field, "i"));
    }
    expect(agreementsById.size).toBe(0);
  });

  it("rejects a first-payment date that precedes the lease start", async () => {
    seedProperty("prop1", "owner-uid");
    const app = buildApp();

    const res = await request(app)
      .post("/api/owner/agreements")
      .send({ ...VALID_BODY, startDate: "2026-06-01", nextPaymentDate: "2026-05-01" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/before the lease start/i);
  });

  it("stores fixedRenewalMonths for a 'fixed' auto-renewal so the term isn't lost", async () => {
    seedProperty("prop1", "owner-uid");
    const app = buildApp();

    const res = await request(app)
      .post("/api/owner/agreements")
      .send({ ...VALID_BODY, autoRenewal: "fixed", fixedRenewalMonths: 3 });

    expect(res.status).toBe(201);
    expect(agreementsById.get(res.body.agreementId)?.fixedRenewalMonths).toBe(3);
  });

  it("does NOT store fixedRenewalMonths for a non-fixed auto-renewal", async () => {
    seedProperty("prop1", "owner-uid");
    const app = buildApp();

    const res = await request(app)
      .post("/api/owner/agreements")
      .send({ ...VALID_BODY, autoRenewal: "auto", fixedRenewalMonths: 3 });

    expect(res.status).toBe(201);
    expect(agreementsById.get(res.body.agreementId)?.fixedRenewalMonths).toBeUndefined();
  });

  it("rejects an out-of-range fixedRenewalMonths with 400", async () => {
    seedProperty("prop1", "owner-uid");
    const app = buildApp();

    const res = await request(app)
      .post("/api/owner/agreements")
      .send({ ...VALID_BODY, autoRenewal: "fixed", fixedRenewalMonths: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fixedRenewalMonths/i);
  });

  it("409s when the target property is soft-deactivated (status inactive)", async () => {
    seedProperty("prop1", "owner-uid");
    propertiesById.set("prop1", { ...propertiesById.get("prop1"), status: "inactive" });
    const app = buildApp();

    const res = await request(app).post("/api/owner/agreements").send(VALID_BODY);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/paused under your current plan/i);
    expect(agreementsById.size).toBe(0);
  });

  it("returns 409 when the property already has an active tenancy (no double-occupancy)", async () => {
    seedProperty("prop1", "owner-uid");
    // An existing ACTIVE tenant on the same property, different from the new
    // invite (different email → different deterministic dedupe id).
    tenantsById.set("existing-active", {
      id: "existing-active",
      propertyId: "prop1",
      ownerId: "owner-uid",
      status: "active",
      email: "current@example.com",
    });
    const app = buildApp();

    const res = await request(app).post("/api/owner/agreements").send(VALID_BODY);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has a tenant or a pending invite/i);
    // No second tenancy/agreement was written.
    expect(tenantsById.size).toBe(1);
    expect(agreementsById.size).toBe(0);
  });

  it("returns 409 when the property already has an outstanding pending invite", async () => {
    seedProperty("prop1", "owner-uid");
    tenantsById.set("existing-pending", {
      id: "existing-pending",
      propertyId: "prop1",
      ownerId: "owner-uid",
      status: "pending",
      email: "invited@example.com",
    });
    const app = buildApp();

    const res = await request(app).post("/api/owner/agreements").send(VALID_BODY);

    expect(res.status).toBe(409);
    expect(agreementsById.size).toBe(0);
  });

  it("allows a new tenancy when the prior one is terminal (declined/expired/terminated)", async () => {
    seedProperty("prop1", "owner-uid");
    tenantsById.set("old-declined", {
      id: "old-declined",
      propertyId: "prop1",
      ownerId: "owner-uid",
      status: "declined",
      email: "former@example.com",
    });
    const app = buildApp();

    const res = await request(app).post("/api/owner/agreements").send(VALID_BODY);

    // A closed/declined tenancy doesn't occupy the property — re-letting is OK.
    expect(res.status).toBe(201);
    expect(agreementsById.size).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// PATCH /api/owner/agreements/:id
// ──────────────────────────────────────────────────────────────────────

function seedAgreement(id: string, ownerId: string, overrides: Record<string, unknown> = {}) {
  agreementsById.set(id, {
    id,
    tenantId: `tenant_${id}`,
    unitId: "prop1",
    propertyId: "prop1",
    ownerId,
    agreementValue: 18000,
    startDate: "2026-01-01",
    endDate: "2027-01-01",
    status: "active",
    monthlyRent: 1500,
    deposit: 3000,
    rentalDurationMonths: 12,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
  tenantsById.set(`tenant_${id}`, {
    id: `tenant_${id}`,
    ownerId,
    rentAmount: 1500,
    status: "active",
  });
}

describe("PATCH /api/owner/agreements/:id", () => {
  it("updates rent + dates, recomputes total value + term, and syncs the tenant rentAmount", async () => {
    seedAgreement("agr1", "owner-uid");
    const app = buildApp();

    const res = await request(app)
      .patch("/api/owner/agreements/agr1")
      .send({ monthlyRent: 2000, startDate: "2026-01-01", endDate: "2027-01-01" });

    expect(res.status).toBe(200);
    const stored = agreementsById.get("agr1");
    expect(stored?.monthlyRent).toBe(2000);
    // ~12 months between the dates → 2000 × 12 = 24000.
    expect(stored?.rentalDurationMonths).toBe(12);
    expect(stored?.agreementValue).toBe(24000);
    // Rent change mirrored onto the tenancy (revenue/occupancy source).
    expect(tenantsById.get("tenant_agr1")?.rentAmount).toBe(2000);
  });

  it("BLENDS the value on a rent-only edit (dates untouched)", async () => {
    // Fake only Date (not timers — supertest needs real ones) and pin the clock
    // 6 months into the 12-month lease (ends 2027-01-01).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    try {
      seedAgreement("agr-blend", "owner-uid"); // €1500/mo, 12mo, value €18,000
      const app = buildApp();

      const res = await request(app)
        .patch("/api/owner/agreements/agr-blend")
        .send({ monthlyRent: 1800 }); // rent only — NO startDate/endDate

      expect(res.status).toBe(200);
      const stored = agreementsById.get("agr-blend");
      expect(stored?.monthlyRent).toBe(1800);
      // elapsed 6mo @ €1500 kept; remaining 6mo move to €1800 →
      // 18000 + (1800−1500)×6 = €19,800 (NOT 1800 × 12 = €21,600).
      expect(stored?.agreementValue).toBe(19800);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 403 when the agreement belongs to another owner", async () => {
    seedAgreement("agr2", "someone-else");
    const app = buildApp();

    const res = await request(app).patch("/api/owner/agreements/agr2").send({ monthlyRent: 2000 });

    expect(res.status).toBe(403);
    // Untouched.
    expect(agreementsById.get("agr2")?.monthlyRent).toBe(1500);
  });

  it("returns 404 when the agreement doesn't exist", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/api/owner/agreements/missing")
      .send({ monthlyRent: 2000 });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the agreement is already closed", async () => {
    seedAgreement("agr3", "owner-uid", { status: "terminated" });
    const app = buildApp();

    const res = await request(app).patch("/api/owner/agreements/agr3").send({ monthlyRent: 2000 });

    expect(res.status).toBe(409);
    expect(agreementsById.get("agr3")?.monthlyRent).toBe(1500);
  });

  it("returns 400 when the end date is not after the start date", async () => {
    seedAgreement("agr4", "owner-uid");
    const app = buildApp();

    const res = await request(app)
      .patch("/api/owner/agreements/agr4")
      .send({ startDate: "2027-01-01", endDate: "2026-01-01" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/after the start date/i);
  });

  it("rejects a non-positive rent", async () => {
    seedAgreement("agr5", "owner-uid");
    const app = buildApp();

    const res = await request(app).patch("/api/owner/agreements/agr5").send({ monthlyRent: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rent must be positive/i);
  });
});

// ──────────────────────────────────────────────────────────────────────
// GET endpoints — phase-2 portfolio-keyed scoped reads.
//
// The contract under test: every scoped LIST/AGGREGATE query keys off
// scope.portfolioId (the STABLE Portfolio doc id), NOT the legacy owner
// uid. So a row stamped with the scope's portfolio is returned even when
// its denormalized ownerId points at a previous owner (the post-transfer
// shape), while a row without the portfolio stamp is absent — including
// rows that still match the legacy ownerId. A null-portfolio scope
// short-circuits to the empty response without querying.
// ──────────────────────────────────────────────────────────────────────

function seedScopedProperty(id: string, fields: Record<string, unknown> = {}) {
  propertiesById.set(id, {
    id,
    address: `${id} Test Lane`,
    propertyValue: 100000,
    acquisitionPrice: 80000,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...fields,
  });
}

describe("GET /api/owner/properties — portfolio-keyed scope", () => {
  it("returns rows by portfolio id even when the legacy ownerId differs, and omits unstamped rows", async () => {
    // Stamped with the scope's portfolio but a DIFFERENT legacy owner — the
    // post-transfer shape. The portfolio key must win.
    seedScopedProperty("prop-stamped", {
      portfolioId: "pf-test",
      ownerId: "previous-owner-uid",
    });
    // Legacy row keyed only by ownerId (no portfolio stamp): the flipped
    // query must not return it.
    seedScopedProperty("prop-unstamped", { ownerId: "owner-uid" });
    // Stamped with a different portfolio entirely.
    seedScopedProperty("prop-foreign", { portfolioId: "pf-other", ownerId: "owner-uid" });

    const res = await request(buildApp()).get("/api/owner/properties");

    expect(res.status).toBe(200);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual(["prop-stamped"]);
  });

  it("returns [] without data when the scope has no portfolio (null portfolioId)", async () => {
    seedScopedProperty("prop-unstamped", { ownerId: "owner-uid" });
    scopeResult = {
      ok: true,
      ownerId: "owner-uid",
      portfolioId: null,
      permissions: ["view", "edit"],
      isSelf: false,
    };

    const res = await request(buildApp()).get("/api/owner/properties");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("GET /api/owner/agreements — portfolio-keyed scope", () => {
  it("lists agreements by portfolio id (portfolio key wins over legacy ownerId)", async () => {
    seedScopedProperty("prop1", { portfolioId: "pf-test", ownerId: "previous-owner-uid" });
    tenantsById.set("ten-1", {
      id: "ten-1",
      name: "t@example.com",
      email: "t@example.com",
      status: "active",
      rentAmount: 1500,
    });
    agreementsById.set("agr-stamped", {
      id: "agr-stamped",
      portfolioId: "pf-test",
      ownerId: "previous-owner-uid",
      tenantId: "ten-1",
      propertyId: "prop1",
      unitId: "prop1",
      status: "active",
      monthlyRent: 1500,
      agreementValue: 18000,
      startDate: "2026-01-01",
      endDate: "2027-01-01",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // Unstamped legacy row — absent from the flipped query.
    agreementsById.set("agr-unstamped", {
      id: "agr-unstamped",
      ownerId: "owner-uid",
      tenantId: "ten-1",
      propertyId: "prop1",
      unitId: "prop1",
      status: "active",
      monthlyRent: 1000,
      startDate: "2026-02-01",
      endDate: "2027-02-01",
      createdAt: "2026-02-01T00:00:00.000Z",
    });

    const res = await request(buildApp()).get("/api/owner/agreements");

    expect(res.status).toBe(200);
    expect(res.body.map((a: { id: string }) => a.id)).toEqual(["agr-stamped"]);
    expect(res.body[0].monthlyRent).toBe(1500);
  });

  it("returns [] when the scope has no portfolio", async () => {
    agreementsById.set("agr-unstamped", {
      id: "agr-unstamped",
      ownerId: "owner-uid",
      tenantId: "ten-1",
      propertyId: "prop1",
      unitId: "prop1",
      status: "active",
      startDate: "2026-02-01",
      endDate: "2027-02-01",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    scopeResult = {
      ok: true,
      ownerId: "owner-uid",
      portfolioId: null,
      permissions: ["view"],
      isSelf: false,
    };

    const res = await request(buildApp()).get("/api/owner/agreements");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("GET /api/owner/tenants — portfolio-keyed scope", () => {
  it("keys the roster off the portfolio id and omits unstamped rows", async () => {
    seedScopedProperty("prop1", { portfolioId: "pf-test", ownerId: "previous-owner-uid" });
    tenantsById.set("ten-stamped", {
      id: "ten-stamped",
      portfolioId: "pf-test",
      ownerId: "previous-owner-uid",
      propertyId: "prop1",
      unitId: "prop1",
      name: "t@example.com",
      status: "active",
      rentAmount: 900,
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    tenantsById.set("ten-unstamped", {
      id: "ten-unstamped",
      ownerId: "owner-uid",
      propertyId: "prop1",
      unitId: "prop1",
      name: "x@example.com",
      status: "active",
      rentAmount: 700,
      createdAt: "2026-03-01T00:00:00.000Z",
    });

    const res = await request(buildApp()).get("/api/owner/tenants");

    expect(res.status).toBe(200);
    expect(res.body.map((t: { id: string }) => t.id)).toEqual(["ten-stamped"]);
    expect(res.body[0].propertyAddress).toBe("prop1 Test Lane");
  });
});

describe("GET /api/owner/summary — portfolio-keyed scope", () => {
  it("aggregates by portfolio id even when the legacy ownerId differs", async () => {
    seedScopedProperty("prop1", {
      portfolioId: "pf-test",
      ownerId: "previous-owner-uid",
      propertyValue: 200000,
      acquisitionPrice: 150000,
    });
    tenantsById.set("ten-1", {
      id: "ten-1",
      portfolioId: "pf-test",
      ownerId: "previous-owner-uid",
      propertyId: "prop1",
      unitId: "prop1",
      status: "active",
      rentAmount: 1200,
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    // Unstamped noise that must not count toward the aggregates.
    seedScopedProperty("prop-unstamped", { ownerId: "owner-uid", propertyValue: 999999 });

    const res = await request(buildApp()).get("/api/owner/summary");

    expect(res.status).toBe(200);
    expect(res.body.unitCount).toBe(1);
    expect(res.body.portfolioValue).toBe(200000);
    expect(res.body.monthlyRevenue).toBe(1200);
    expect(res.body.occupancyRate).toBe(100);
    expect(res.body.equityInvested).toBe(150000);
  });

  it("returns the zeroed summary without querying when the scope has no portfolio", async () => {
    seedScopedProperty("prop-unstamped", { ownerId: "owner-uid", propertyValue: 999999 });
    scopeResult = {
      ok: true,
      ownerId: "owner-uid",
      portfolioId: null,
      permissions: ["view"],
      isSelf: false,
    };

    const res = await request(buildApp()).get("/api/owner/summary");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      unitCount: 0,
      portfolioValue: 0,
      monthlyRevenue: 0,
      occupancyRate: 0,
      equityInvested: 0,
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/owner/tenants/:id/settle-balance — atomic + idempotent
// ──────────────────────────────────────────────────────────────────────
describe("POST /api/owner/tenants/:id/settle-balance", () => {
  function seedSettleable() {
    tenantsById.set("ten-1", {
      id: "ten-1",
      ownerId: "owner-uid",
      userId: "tenant-user-1",
      propertyId: "prop1",
      unitId: "prop1",
      portfolioId: "pf-test",
      status: "expired",
      outstandingBalance: 500,
    });
    agreementsById.set("agr-1", {
      id: "agr-1",
      tenantId: "ten-1",
      propertyId: "prop1",
      closingBalance: { amount: 500 },
    });
  }

  it("books exactly one income row, clears the arrear + the agreement balance", async () => {
    seedSettleable();
    const res = await request(buildApp()).post("/api/owner/tenants/ten-1/settle-balance").send({});
    expect(res.status).toBe(200);
    expect(res.body.outstandingBalance).toBe(0);
    expect(transactionsById.size).toBe(1);
    const tx = Array.from(transactionsById.values())[0];
    expect(tx).toMatchObject({
      amount: 500,
      type: "income",
      category: "rent",
      status: "completed",
      name: "Final balance settlement",
      agreementId: "agr-1",
    });
    expect(tenantsById.get("ten-1")?.outstandingBalance).toBe(0);
    expect(agreementsById.get("agr-1")?.closingBalance).toBeNull();
    expect(notifyUserSpy).toHaveBeenCalledTimes(1);
  });

  it("is idempotent on a sequential re-settle (no second income row, no second notify)", async () => {
    seedSettleable();
    await request(buildApp()).post("/api/owner/tenants/ten-1/settle-balance").send({});
    const res2 = await request(buildApp()).post("/api/owner/tenants/ten-1/settle-balance").send({});
    expect(res2.status).toBe(200);
    expect(res2.body.outstandingBalance).toBe(0);
    expect(transactionsById.size).toBe(1); // still ONE
    expect(notifyUserSpy).toHaveBeenCalledTimes(1); // not re-notified
  });

  it("books ONE income row under concurrent settle requests (deterministic id dedup)", async () => {
    // The bug: a plain batch + auto-id row let two racing requests each create a
    // distinct income row for the same arrear. The deterministic id makes both
    // resolve to the same doc → exactly one row.
    seedSettleable();
    const app = buildApp();
    const [a, b] = await Promise.all([
      request(app).post("/api/owner/tenants/ten-1/settle-balance").send({}),
      request(app).post("/api/owner/tenants/ten-1/settle-balance").send({}),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(transactionsById.size).toBe(1);
  });

  it("404s for a missing tenancy and 403s for another owner's tenancy", async () => {
    const missing = await request(buildApp())
      .post("/api/owner/tenants/nope/settle-balance")
      .send({});
    expect(missing.status).toBe(404);

    tenantsById.set("ten-other", {
      id: "ten-other",
      ownerId: "someone-else",
      outstandingBalance: 200,
    });
    const forbidden = await request(buildApp())
      .post("/api/owner/tenants/ten-other/settle-balance")
      .send({});
    expect(forbidden.status).toBe(403);
    expect(transactionsById.size).toBe(0);
  });

  it("no-ops when nothing is outstanding", async () => {
    tenantsById.set("ten-zero", {
      id: "ten-zero",
      ownerId: "owner-uid",
      outstandingBalance: 0,
    });
    const res = await request(buildApp())
      .post("/api/owner/tenants/ten-zero/settle-balance")
      .send({});
    expect(res.status).toBe(200);
    expect(transactionsById.size).toBe(0);
    expect(notifyUserSpy).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/owner/tenants/:id/end — closes EVERY non-terminal agreement
// ──────────────────────────────────────────────────────────────────────
describe("POST /api/owner/tenants/:id/end", () => {
  it("cancels a pending_tenant agreement (declined) so it can't be resurrected", async () => {
    tenantsById.set("ten-p", {
      id: "ten-p",
      ownerId: "owner-uid",
      propertyId: "prop1",
      unitId: "prop1",
      status: "pending",
      rentAmount: 1000,
    });
    agreementsById.set("agr-p", {
      id: "agr-p",
      tenantId: "ten-p",
      propertyId: "prop1",
      status: "pending_tenant",
      monthlyRent: 1000,
    });

    const res = await request(buildApp()).post("/api/owner/tenants/ten-p/end").send({});

    expect(res.status).toBe(200);
    expect(tenantsById.get("ten-p")?.status).toBe("expired");
    // The pending invite is closed — the tenant respond endpoint requires
    // status pending_tenant, so it can no longer be approved.
    expect(agreementsById.get("agr-p")?.status).toBe("declined");
  });

  it("terminates an active agreement and captures its in-term arrear", async () => {
    tenantsById.set("ten-a", {
      id: "ten-a",
      ownerId: "owner-uid",
      propertyId: "prop1",
      unitId: "prop1",
      status: "active",
      rentAmount: 1000,
    });
    agreementsById.set("agr-a", {
      id: "agr-a",
      tenantId: "ten-a",
      propertyId: "prop1",
      status: "active",
      monthlyRent: 1000,
      nextPaymentDate: "2020-01-01",
      paymentFrequency: "monthly",
      paymentDayOfMonth: 1,
    });

    const res = await request(buildApp()).post("/api/owner/tenants/ten-a/end").send({});

    expect(res.status).toBe(200);
    expect(agreementsById.get("agr-a")?.status).toBe("terminated");
    expect(tenantsById.get("ten-a")?.status).toBe("expired");
    // Unpaid cycles from the (past) nextPaymentDate through today are owed.
    expect((tenantsById.get("ten-a")?.outstandingBalance as number) > 0).toBe(true);
  });

  it("404s for a missing tenancy and 403s for another owner's", async () => {
    const missing = await request(buildApp()).post("/api/owner/tenants/nope/end").send({});
    expect(missing.status).toBe(404);

    tenantsById.set("ten-x", { id: "ten-x", ownerId: "someone-else", status: "active" });
    const forbidden = await request(buildApp()).post("/api/owner/tenants/ten-x/end").send({});
    expect(forbidden.status).toBe(403);
  });
});
