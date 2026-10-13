// Behavior tests for PATCH /api/owner/transactions/:id — the owner's
// 24h edit window on manual ledger entries — plus the phase-1 portfolio
// stamping on POST /api/owner/transactions (new rows carry the owner's
// STABLE portfolio doc id; reads still key off ownerId).
//
// The ledger is otherwise append-only, so this endpoint is the one sanctioned
// mutation and is tightly gated. These tests pin every gate:
//   • owner-self only (tx.ownerId must equal the caller);
//   • manual rows only (source === "manual" — never a rent/system row);
//   • within 24h of createdAt (the real write time, not the activity date);
//   • property reassignment re-verifies ownership of the new property;
//   • clearing notes removes the field rather than storing "".
//
// Mocking strategy mirrors portfolio.test.ts: an in-memory Firestore double
// over the `transactions` and `properties` collections, a permissive
// requireAuth that injects a test-controlled user, and a stubbed rate limiter
// (the POST path's only firestore-touching dependency, never hit here).
// FieldValue comes from the REAL firebase-admin/firestore so the delete
// sentinel behaves like production; the update() double honours it.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FieldValue } from "firebase-admin/firestore";

interface TestUser {
  uid: string;
  email?: string;
}

let currentUser: TestUser = { uid: "owner-uid" };

// Controllable resolveOwnerScope result in the PHASE-2 shape: the GET
// transactions feed keys off scope.portfolioId (the STABLE Portfolio doc id),
// so these tests pin the flipped query independently of the scope resolver's
// own suite. authorizePortfolioRead passes by default (privilege matrix is
// covered elsewhere).
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
vi.mock("../services/ownerScope", () => ({
  resolveOwnerScope: resolveOwnerScopeMock,
  authorizePortfolioRead: authorizePortfolioReadMock,
}));

const transactionsById = new Map<string, Record<string, unknown>>();
const propertiesById = new Map<string, Record<string, unknown>>();
// Phase-1 portfolio stamping: POST resolves the owner's portfolio through
// ensurePortfolio (users.portfolioRef → portfolios doc, with a
// portfolios.where(ownerId==) fallback + transactional create), so the double
// needs users + portfolios stores too.
const usersById = new Map<string, Record<string, unknown>>();
const portfoliosById = new Map<string, Record<string, unknown>>();

beforeEach(() => {
  currentUser = { uid: "owner-uid" };
  scopeResult = {
    ok: true,
    ownerId: "owner-uid",
    portfolioId: "pf-1",
    permissions: ["view", "edit"],
    isSelf: true,
  };
  transactionsById.clear();
  propertiesById.clear();
  usersById.clear();
  portfoliosById.clear();
  resolveOwnerScopeMock.mockClear();
  authorizePortfolioReadMock.mockClear();
});

// ── Firestore double ───────────────────────────────────────────────────

function makeDocRef(store: Map<string, Record<string, unknown>>, id: string) {
  return {
    id,
    async get() {
      const data = store.get(id);
      return { exists: !!data, id, data: () => data };
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const existing = store.get(id);
      store.set(id, opts?.merge ? { ...existing, ...data } : data);
    },
    async update(updates: Record<string, unknown>) {
      const existing = store.get(id);
      if (!existing) throw new Error(`no doc ${id}`);
      const next: Record<string, unknown> = { ...existing };
      for (const [k, v] of Object.entries(updates)) {
        // Honour FieldValue.delete() by removing the key, like real Firestore.
        if (
          v &&
          typeof (v as { isEqual?: unknown }).isEqual === "function" &&
          FieldValue.delete().isEqual(v as never)
        ) {
          delete next[k];
        } else {
          next[k] = v;
        }
      }
      store.set(id, next);
    },
  };
}

function storeFor(name: string): Map<string, Record<string, unknown>> {
  if (name === "transactions") return transactionsById;
  if (name === "properties") return propertiesById;
  if (name === "users") return usersById;
  if (name === "portfolios") return portfoliosById;
  return new Map();
}

const dbDouble = {
  collection: (name: string) => ({
    doc: (id?: string) => {
      const finalId = id ?? `auto_${Math.random().toString(36).slice(2, 10)}`;
      return makeDocRef(storeFor(name), finalId);
    },
    // Minimal equality query — enough for ensurePortfolio's
    // portfolios.where("ownerId", "==", …).limit(1) fallback.
    where(field: string, _op: string, value: unknown) {
      let cap = Infinity;
      const q = {
        limit(n: number) {
          cap = n;
          return q;
        },
        async get() {
          const rows = Array.from(storeFor(name).entries())
            .filter(([, data]) => data[field] === value)
            .slice(0, cap);
          return {
            empty: rows.length === 0,
            docs: rows.map(([id, data]) => ({ id, exists: true, data: () => data })),
          };
        },
      };
      return q;
    },
  }),
  // Batched point reads used by the GET transactions property join.
  async getAll(...refs: Array<{ get: () => Promise<unknown> }>) {
    return Promise.all(refs.map((r) => r.get()));
  },
  // ensurePortfolio's create path runs in a transaction; mirror the
  // tenant.payment.test.ts double (merge opts pass through to set()).
  async runTransaction<T>(cb: (t: unknown) => Promise<T>): Promise<T> {
    const t = {
      async get(ref: { get: () => Promise<unknown> }) {
        return ref.get();
      },
      set(
        ref: { set: (d: Record<string, unknown>, o?: { merge?: boolean }) => void },
        data: Record<string, unknown>,
        opts?: { merge?: boolean },
      ) {
        ref.set(data, opts);
      },
    };
    return cb(t);
  },
};

vi.mock("../firebase", () => ({
  db: () => dbDouble,
  bucket: () => ({}),
  storageBucketName: "test-bucket",
  initFirebase: () => ({}),
  auth: () => ({}),
}));

vi.mock("../auth", () => ({
  requireAuth: (req: { user?: TestUser }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../services/rateLimit", () => ({
  checkAndIncrement: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));

const { registerFinanceRoutes } = await import("./finance");

// ── Helpers ────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  registerFinanceRoutes(app);
  return app;
}

function seedProperty(id: string, ownerId: string) {
  propertiesById.set(id, { id, ownerId, address: `${id} Test Lane` });
}

interface SeedTxOpts {
  ownerId?: string;
  source?: string;
  createdAtMsAgo?: number; // how long ago the row was written
  notes?: string;
  portfolioId?: string;
}

function seedManualTx(id: string, opts: SeedTxOpts = {}) {
  const {
    ownerId = "owner-uid",
    source = "manual",
    createdAtMsAgo = 1000,
    notes,
    portfolioId,
  } = opts;
  transactionsById.set(id, {
    id,
    propertyId: "prop1",
    ownerId,
    ...(portfolioId ? { portfolioId } : {}),
    name: "Maintenance",
    amount: 120,
    currency: "EUR",
    type: "expense",
    category: "maintenance",
    status: "completed",
    timestamp: "2026-06-01T10:00:00.000Z",
    source,
    createdAt: new Date(Date.now() - createdAtMsAgo).toISOString(),
    ...(notes ? { notes } : {}),
  });
}

// Link a caller to a portfolio they currently hold (getPortfolio resolves it
// via users.portfolioRef → portfolios doc).
function seedOwnedPortfolio(portfolioId: string, ownerUid: string) {
  portfoliosById.set(portfolioId, { id: portfolioId, ownerId: ownerUid, createdAt: "2026-01-01" });
  usersById.set(ownerUid, {
    ...(usersById.get(ownerUid) ?? { id: ownerUid }),
    portfolioRef: portfolioId,
  });
}

const EDIT = {
  propertyId: "prop1",
  name: "Repairs",
  amount: 250,
  type: "expense",
  category: "maintenance",
  timestamp: "2026-06-02T10:00:00.000Z",
  notes: "fixed the boiler",
};

// ──────────────────────────────────────────────────────────────────────

describe("PATCH /api/owner/transactions/:id", () => {
  it("edits a manual entry inside the 24h window", async () => {
    seedProperty("prop1", "owner-uid");
    seedManualTx("tx1");
    const app = buildApp();

    const res = await request(app).patch("/api/owner/transactions/tx1").send(EDIT);

    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(250);
    expect(res.body.name).toBe("Repairs");
    const stored = transactionsById.get("tx1")!;
    expect(stored.amount).toBe(250);
    expect(stored.name).toBe("Repairs");
    expect(stored.notes).toBe("fixed the boiler");
    // Immutable fields stay put.
    expect(stored.ownerId).toBe("owner-uid");
    expect(stored.source).toBe("manual");
    expect(stored.status).toBe("completed");
  });

  it("404s when the transaction does not exist", async () => {
    const app = buildApp();
    const res = await request(app).patch("/api/owner/transactions/missing").send(EDIT);
    expect(res.status).toBe(404);
  });

  it("allows the CURRENT portfolio holder to edit a portfolio-stamped row", async () => {
    seedProperty("prop1", "owner-uid");
    seedOwnedPortfolio("pf-1", "owner-uid");
    seedManualTx("tx1", { portfolioId: "pf-1" });
    const res = await request(buildApp()).patch("/api/owner/transactions/tx1").send(EDIT);
    expect(res.status).toBe(200);
    expect(transactionsById.get("tx1")!.amount).toBe(250);
  });

  it("403s a prior owner editing a transferred row (still their ownerId, but not their portfolio)", async () => {
    // Post-transfer: the completed row keeps ownerId=owner-uid (ledger history)
    // and portfolioId=pf-1, but pf-1 now belongs to someone else and owner-uid
    // holds no portfolio → the portfolio-hold gate refuses the edit.
    seedProperty("prop1", "owner-uid");
    portfoliosById.set("pf-1", { id: "pf-1", ownerId: "new-owner", createdAt: "2026-01-01" });
    seedManualTx("tx1", { ownerId: "owner-uid", portfolioId: "pf-1" });
    const res = await request(buildApp()).patch("/api/owner/transactions/tx1").send(EDIT);
    expect(res.status).toBe(403);
    expect(transactionsById.get("tx1")!.amount).toBe(120); // unchanged
  });

  it("403s when the transaction belongs to another owner", async () => {
    seedProperty("prop1", "other-uid");
    seedManualTx("tx1", { ownerId: "other-uid" });
    const app = buildApp();

    const res = await request(app).patch("/api/owner/transactions/tx1").send(EDIT);

    expect(res.status).toBe(403);
    // Untouched.
    expect(transactionsById.get("tx1")!.amount).toBe(120);
  });

  it("409s on a non-manual (system-generated) row", async () => {
    seedProperty("prop1", "owner-uid");
    seedManualTx("tx1", { source: "rent" });
    const app = buildApp();

    const res = await request(app).patch("/api/owner/transactions/tx1").send(EDIT);

    expect(res.status).toBe(409);
    expect(transactionsById.get("tx1")!.amount).toBe(120);
  });

  it("409s on a legacy manual row with no createdAt", async () => {
    seedProperty("prop1", "owner-uid");
    seedManualTx("tx1");
    // Strip createdAt to simulate a row recorded before the field existed.
    const row = transactionsById.get("tx1")!;
    delete row.createdAt;
    const app = buildApp();

    const res = await request(app).patch("/api/owner/transactions/tx1").send(EDIT);

    expect(res.status).toBe(409);
  });

  it("409s once the 24h window has passed", async () => {
    seedProperty("prop1", "owner-uid");
    seedManualTx("tx1", { createdAtMsAgo: 25 * 60 * 60 * 1000 });
    const app = buildApp();

    const res = await request(app).patch("/api/owner/transactions/tx1").send(EDIT);

    expect(res.status).toBe(409);
    expect(transactionsById.get("tx1")!.amount).toBe(120);
  });

  it("clears notes when sent blank rather than storing an empty string", async () => {
    seedProperty("prop1", "owner-uid");
    seedManualTx("tx1", { notes: "old note" });
    const app = buildApp();

    const res = await request(app)
      .patch("/api/owner/transactions/tx1")
      .send({ ...EDIT, notes: "" });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("notes");
    expect(transactionsById.get("tx1")!).not.toHaveProperty("notes");
  });

  it("rejects a property reassignment to a property the owner does not own", async () => {
    seedProperty("prop1", "owner-uid");
    seedProperty("prop2", "other-uid");
    seedManualTx("tx1");
    const app = buildApp();

    const res = await request(app)
      .patch("/api/owner/transactions/tx1")
      .send({ ...EDIT, propertyId: "prop2" });

    expect(res.status).toBe(403);
    expect(transactionsById.get("tx1")!.propertyId).toBe("prop1");
  });

  it("allows reassigning to another property the owner owns", async () => {
    seedProperty("prop1", "owner-uid");
    seedProperty("prop2", "owner-uid");
    seedManualTx("tx1");
    const app = buildApp();

    const res = await request(app)
      .patch("/api/owner/transactions/tx1")
      .send({ ...EDIT, propertyId: "prop2" });

    expect(res.status).toBe(200);
    expect(transactionsById.get("tx1")!.propertyId).toBe("prop2");
  });

  it("rejects an invalid amount", async () => {
    seedProperty("prop1", "owner-uid");
    seedManualTx("tx1");
    const app = buildApp();

    const res = await request(app)
      .patch("/api/owner/transactions/tx1")
      .send({ ...EDIT, amount: 0 });

    expect(res.status).toBe(400);
    expect(transactionsById.get("tx1")!.amount).toBe(120);
  });
});

describe("POST /api/owner/transactions — portfolio stamping (phase-1 re-key)", () => {
  const ENTRY = {
    propertyId: "prop1",
    amount: 850,
    type: "income",
    category: "rent",
    name: "June rent",
  };

  it("stamps the owner's existing portfolio id on the new ledger row", async () => {
    seedProperty("prop1", "owner-uid");
    usersById.set("owner-uid", { id: "owner-uid", portfolioRef: "pf-1" });
    portfoliosById.set("pf-1", {
      id: "pf-1",
      ownerId: "owner-uid",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const app = buildApp();

    const res = await request(app).post("/api/owner/transactions").send(ENTRY);

    expect(res.status).toBe(201);
    expect(res.body.ownerId).toBe("owner-uid");
    // The STABLE portfolio doc id (Portfolio.id), not the display label.
    expect(res.body.portfolioId).toBe("pf-1");
    const stored = Array.from(transactionsById.values())[0];
    expect(stored.portfolioId).toBe("pf-1");
    expect(stored.source).toBe("manual");
  });

  it("creates + links a portfolio when the owner has none yet, and stamps its id", async () => {
    seedProperty("prop1", "owner-uid");
    usersById.set("owner-uid", { id: "owner-uid" }); // no portfolioRef, no portfolio doc
    const app = buildApp();

    const res = await request(app).post("/api/owner/transactions").send(ENTRY);

    expect(res.status).toBe(201);
    // ensurePortfolio created exactly one portfolio for the owner…
    expect(portfoliosById.size).toBe(1);
    const [pfId, pf] = Array.from(portfoliosById.entries())[0];
    expect(pf.ownerId).toBe("owner-uid");
    // …stamped its stable doc id on the new row…
    expect(res.body.portfolioId).toBe(pfId);
    expect(Array.from(transactionsById.values())[0].portfolioId).toBe(pfId);
    // …and linked the user doc (merge — the rest of the doc survives).
    expect(usersById.get("owner-uid")?.portfolioRef).toBe(pfId);
    expect(usersById.get("owner-uid")?.id).toBe("owner-uid");
  });
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/owner/transactions — phase-2 portfolio-keyed feed. The query
// keys off scope.portfolioId (NOT the owner uid), sorts newest-first in
// memory (no orderBy → no portfolioId+timestamp composite index) and
// applies the limit AFTER the sort. Null-portfolio scope → [] without
// querying.
// ──────────────────────────────────────────────────────────────────────

describe("GET /api/owner/transactions — portfolio-keyed scope", () => {
  function seedTx(id: string, fields: Record<string, unknown> = {}) {
    transactionsById.set(id, {
      id,
      propertyId: "prop1",
      amount: 100,
      currency: "EUR",
      type: "income",
      category: "rent",
      status: "completed",
      timestamp: "2026-06-01T00:00:00.000Z",
      ...fields,
    });
  }

  it("returns rows by the scope's portfolio id even when the legacy ownerId differs, omitting unstamped rows", async () => {
    seedProperty("prop1", "previous-owner-uid");
    // Post-transfer shape: stamped with the scope's portfolio, ownerId still
    // points at the previous owner. The portfolio key must win.
    seedTx("tx-stamped", { portfolioId: "pf-1", ownerId: "previous-owner-uid" });
    // Row without the stamp — absent, even though its ownerId matches the
    // resolved owner.
    seedTx("tx-unstamped", { ownerId: "owner-uid" });
    // Different portfolio entirely — absent.
    seedTx("tx-foreign", { portfolioId: "pf-other", ownerId: "owner-uid" });

    const res = await request(buildApp()).get("/api/owner/transactions");

    expect(res.status).toBe(200);
    expect(res.body.map((t: { id: string }) => t.id)).toEqual(["tx-stamped"]);
    // The property join still resolves the address.
    expect(res.body[0].propertyAddress).toBe("prop1 Test Lane");
  });

  it("sorts newest-first in memory and applies ?limit= AFTER the sort", async () => {
    seedProperty("prop1", "owner-uid");
    seedTx("tx-old", { portfolioId: "pf-1", timestamp: "2026-01-01T00:00:00.000Z" });
    seedTx("tx-new", { portfolioId: "pf-1", timestamp: "2026-06-03T00:00:00.000Z" });
    seedTx("tx-mid", { portfolioId: "pf-1", timestamp: "2026-03-01T00:00:00.000Z" });

    const res = await request(buildApp()).get("/api/owner/transactions?limit=2");

    expect(res.status).toBe(200);
    // The two NEWEST rows — proving the cap runs after the in-memory sort,
    // not against Firestore's (unordered) read.
    expect(res.body.map((t: { id: string }) => t.id)).toEqual(["tx-new", "tx-mid"]);
  });

  it("returns [] without querying when the scope has no portfolio", async () => {
    seedTx("tx-unstamped", { ownerId: "owner-uid" });
    scopeResult = {
      ok: true,
      ownerId: "owner-uid",
      portfolioId: null,
      permissions: ["view"],
      isSelf: false,
    };

    const res = await request(buildApp()).get("/api/owner/transactions");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
