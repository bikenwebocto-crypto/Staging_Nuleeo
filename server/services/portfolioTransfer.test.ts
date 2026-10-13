// Behavior tests for transferPortfolio — the superadmin owner-transfer service.
// Pins the invariants that keep a transfer safe: banking/Connect cleared BEFORE
// the ownership flip; the live operational docs (properties/tenants/agreements/
// documents) move to the new owner while the transactions ledger does NOT;
// User.portfolioRef relinked on both sides; old access grants dropped; the
// recipient-has-portfolio / cap / already-owner guards; and idempotent resume.
//
// In-memory Firestore double (collections as Maps) honoring get/set(merge)/
// update/where(==)/batch + FieldValue.delete(); stripe is "not configured" so
// session-expiry is skipped; push/planLimits/portfolioBanking are stubbed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FieldValue } from "firebase-admin/firestore";

type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {
  portfolios: new Map(),
  users: new Map(),
  properties: new Map(),
  tenants: new Map(),
  agreements: new Map(),
  documents: new Map(),
  transactions: new Map(),
  portfolioAccessContacts: new Map(),
  userAudit: new Map(),
};
let autoId = 0;

// Controllable stub return for getPortfolio(recipientId).
let recipientPortfolio: Row | null = null;
let unitCap: { cap: number | null; used: number; plan: string } = {
  cap: null,
  used: 0,
  plan: "basic",
};

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
  autoId = 0;
  recipientPortfolio = null;
  unitCap = { cap: null, used: 0, plan: "basic" };
});

const isDelete = (v: unknown) =>
  !!v &&
  typeof (v as { isEqual?: unknown }).isEqual === "function" &&
  FieldValue.delete().isEqual(v as never);

function applyMerge(target: Row, data: Row): Row {
  const next = { ...target };
  for (const [k, v] of Object.entries(data)) {
    if (isDelete(v)) delete next[k];
    else next[k] = v;
  }
  return next;
}

function makeRef(col: string, id: string) {
  return {
    id,
    _col: col,
    async get() {
      const data = store[col].get(id);
      return { exists: !!data, id, ref: makeRef(col, id), data: () => data };
    },
    async set(data: Row, opts?: { merge?: boolean }) {
      store[col].set(id, opts?.merge ? applyMerge(store[col].get(id) ?? {}, data) : data);
    },
    async update(data: Row) {
      store[col].set(id, applyMerge(store[col].get(id) ?? {}, data));
    },
  };
}

function makeQuery(col: string) {
  const filters: Array<{ field: string; value: unknown }> = [];
  const q = {
    where(field: string, _op: string, value: unknown) {
      filters.push({ field, value });
      return q;
    },
    limit() {
      return q;
    },
    async get() {
      const rows = Array.from(store[col].entries())
        .filter(([, data]) => filters.every((f) => data[f.field] === f.value))
        .map(([id, data]) => ({ id, ref: makeRef(col, id), data: () => data }));
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  };
  return q;
}

function makeBatch() {
  const ops: Array<() => void> = [];
  return {
    set(
      ref: { set: (d: Row, o?: { merge?: boolean }) => Promise<void> },
      d: Row,
      o?: { merge?: boolean },
    ) {
      ops.push(() => void ref.set(d, o));
    },
    update(ref: { update: (d: Row) => Promise<void> }, d: Row) {
      ops.push(() => void ref.update(d));
    },
    delete(ref: { id: string; _col: string }) {
      ops.push(() => store[ref._col].delete(ref.id));
    },
    async commit() {
      ops.forEach((fn) => fn());
    },
  };
}

const fakeDb = {
  collection(col: string) {
    return {
      doc(id?: string) {
        return makeRef(col, id ?? `auto_${col}_${autoId++}`);
      },
      where(field: string, op: string, value: unknown) {
        return makeQuery(col).where(field, op, value);
      },
      async add(data: Row) {
        const id = `auto_${col}_${autoId++}`;
        store[col].set(id, data);
        return makeRef(col, id);
      },
    };
  },
  batch() {
    return makeBatch();
  },
  // Single-attempt transaction double: get/set/update/delete delegate to the
  // store (no retry/isolation modeled — the marker-claim tests drive contention
  // by pre-seeding the marker state instead).
  async runTransaction<T>(cb: (t: unknown) => Promise<T>): Promise<T> {
    const t = {
      async get(ref: { get: () => Promise<unknown> }) {
        return ref.get();
      },
      set(
        ref: { set: (d: Row, o?: { merge?: boolean }) => Promise<void> },
        d: Row,
        o?: { merge?: boolean },
      ) {
        void ref.set(d, o);
      },
      update(ref: { update: (d: Row) => Promise<void> }, d: Row) {
        void ref.update(d);
      },
      delete(ref: { id: string; _col: string }) {
        store[ref._col].delete(ref.id);
      },
    };
    return cb(t);
  },
};

vi.mock("../firebase", () => ({ db: () => fakeDb }));
vi.mock("../stripe", () => ({ isStripeConfigured: () => false, stripe: () => ({}) }));
vi.mock("./push", () => ({
  notifyUser: vi.fn(async () => undefined),
  notifyStaff: vi.fn(async () => undefined),
}));
vi.mock("./planLimits", () => ({ resolveUnitCap: vi.fn(async () => unitCap) }));
vi.mock("./portfolioBanking", () => ({ getPortfolio: vi.fn(async () => recipientPortfolio) }));

const { transferPortfolio, PortfolioTransferError } = await import("./portfolioTransfer");

const NOW = "2026-06-10T12:00:00.000Z";

// Seed a portfolio owned by owner-a with banking + a full doc set stamped pf-1,
// the recipient owner-b, an active tenant, an old access grant, and a ledger row.
function seedTransferable() {
  store.portfolios.set("pf-1", {
    id: "pf-1",
    ownerId: "owner-a",
    connectAccountId: "acct_a",
    connectChargesEnabled: true,
    bankDetails: { holder: "A", iban: "CY1700", swift: "BCYPCY2N" },
    createdAt: "2026-01-01",
  });
  store.users.set("owner-a", { id: "owner-a", portfolioRef: "pf-1", email: "a@x.com" });
  store.users.set("owner-b", { id: "owner-b", email: "b@x.com" });
  store.properties.set("prop-1", { id: "prop-1", ownerId: "owner-a", portfolioId: "pf-1" });
  store.tenants.set("ten-1", {
    id: "ten-1",
    ownerId: "owner-a",
    portfolioId: "pf-1",
    userId: "tenant-uid",
    status: "active",
  });
  store.agreements.set("ag-1", { id: "ag-1", ownerId: "owner-a", portfolioId: "pf-1" });
  store.documents.set("doc-1", { id: "doc-1", ownerId: "owner-a", portfolioId: "pf-1" });
  store.transactions.set("tx-1", {
    id: "tx-1",
    ownerId: "owner-a",
    portfolioId: "pf-1",
    status: "completed",
  });
  // A pending offline-rent row (operational — must move to the new owner).
  store.transactions.set("tx-pending", {
    id: "tx-pending",
    ownerId: "owner-a",
    portfolioId: "pf-1",
    status: "pending",
  });
  store.portfolioAccessContacts.set("owner-a_legal", {
    id: "owner-a_legal",
    ownerId: "owner-a",
    portfolioId: "pf-1",
    type: "legal",
    status: "active",
  });
}

const RUN = () =>
  transferPortfolio({
    portfolioId: "pf-1",
    newOwnerId: "owner-b",
    actorUid: "admin-1",
    nowIso: NOW,
  });

describe("transferPortfolio — happy path", () => {
  it("clears banking, moves live docs to the new owner, relinks users, drops grants", async () => {
    seedTransferable();
    const result = await RUN();

    expect(result.outcome).toBe("transferred");
    // Portfolio: owner flipped, marker cleared, Connect + IBAN cleared.
    const pf = store.portfolios.get("pf-1")!;
    expect(pf.ownerId).toBe("owner-b");
    expect(pf.connectAccountId).toBeNull();
    expect("bankDetails" in pf).toBe(false);
    expect("transferStatus" in pf).toBe(false);
    expect(pf.transferredFrom).toBe("owner-a");

    // Live operational docs moved to owner-b.
    expect(store.properties.get("prop-1")!.ownerId).toBe("owner-b");
    expect(store.tenants.get("ten-1")!.ownerId).toBe("owner-b");
    expect(store.agreements.get("ag-1")!.ownerId).toBe("owner-b");
    expect(store.documents.get("doc-1")!.ownerId).toBe("owner-b");

    // Completed ledger UNTOUCHED (historical record of who collected); the
    // PENDING row moves to the new owner (operational, they must verify it).
    expect(store.transactions.get("tx-1")!.ownerId).toBe("owner-a");
    expect(store.transactions.get("tx-pending")!.ownerId).toBe("owner-b");
    expect(result.pendingTransactionsMoved).toBe(1);

    // Users relinked: recipient owns + is an owner; old owner unlinked.
    expect(store.users.get("owner-b")!.portfolioRef).toBe("pf-1");
    expect(store.users.get("owner-b")!.ownerModeEnabled).toBe(true);
    expect("portfolioRef" in store.users.get("owner-a")!).toBe(false);

    // Old owner's access grants dropped (not inherited).
    expect(store.portfolioAccessContacts.has("owner-a_legal")).toBe(false);

    // Audit row written.
    expect(store.userAudit.size).toBe(1);
    expect(result.reassigned.properties).toBe(1);
    expect(result.tenantsNotified).toBe(1);
  });
});

describe("transferPortfolio — guards", () => {
  it("refuses when the recipient already owns a portfolio", async () => {
    seedTransferable();
    recipientPortfolio = { id: "pf-b", ownerId: "owner-b" };
    await expect(RUN()).rejects.toMatchObject({ detail: { code: "recipient_has_portfolio" } });
    // Nothing moved.
    expect(store.portfolios.get("pf-1")!.ownerId).toBe("owner-a");
    expect(store.properties.get("prop-1")!.ownerId).toBe("owner-a");
  });

  it("refuses a recipient who is an active tenant of this portfolio", async () => {
    seedTransferable();
    store.tenants.set("ten-self", {
      id: "ten-self",
      ownerId: "owner-a",
      portfolioId: "pf-1",
      userId: "owner-b",
      status: "active",
    });
    await expect(RUN()).rejects.toMatchObject({ detail: { code: "recipient_is_tenant" } });
    expect(store.portfolios.get("pf-1")!.ownerId).toBe("owner-a");
  });

  it("refuses transferring to the current owner", async () => {
    seedTransferable();
    await expect(
      transferPortfolio({
        portfolioId: "pf-1",
        newOwnerId: "owner-a",
        actorUid: "admin-1",
        nowIso: NOW,
      }),
    ).rejects.toMatchObject({ detail: { code: "already_owner" } });
  });

  it("404s an unknown portfolio", async () => {
    // Recipient exists (the recipient check runs first); the portfolio doesn't.
    store.users.set("owner-b", { id: "owner-b", email: "b@x.com" });
    await expect(RUN()).rejects.toMatchObject({ detail: { code: "portfolio_not_found" } });
  });

  it("404s an unknown recipient", async () => {
    seedTransferable();
    store.users.delete("owner-b");
    await expect(RUN()).rejects.toMatchObject({ detail: { code: "recipient_not_found" } });
  });

  it("refuses when the recipient is over their plan's unit cap", async () => {
    seedTransferable();
    unitCap = { cap: 1, used: 1, plan: "basic" }; // 1 used + 1 incoming > cap 1
    await expect(RUN()).rejects.toBeInstanceOf(PortfolioTransferError);
    await expect(RUN()).rejects.toMatchObject({ detail: { code: "recipient_over_cap" } });
    expect(store.portfolios.get("pf-1")!.ownerId).toBe("owner-a");
  });
});

describe("transferPortfolio — idempotency / resume", () => {
  it("resumes a transfer marked for the SAME recipient and completes", async () => {
    seedTransferable();
    // Simulate a prior run that set the marker then crashed.
    store.portfolios.set("pf-1", {
      ...(store.portfolios.get("pf-1") as Row),
      transferStatus: "in_progress",
      transferTo: "owner-b",
      transferFrom: "owner-a",
    });
    const result = await RUN();
    expect(result.outcome).toBe("resumed");
    expect(store.portfolios.get("pf-1")!.ownerId).toBe("owner-b");
    expect("transferStatus" in store.portfolios.get("pf-1")!).toBe(false);
  });

  it("is an idempotent no-op when the portfolio already belongs to the recipient (post-transfer replay)", async () => {
    seedTransferable();
    // A completed prior transfer: ownership flipped + transferredFrom stamped.
    store.portfolios.set("pf-1", {
      ...(store.portfolios.get("pf-1") as Row),
      ownerId: "owner-b",
      transferredFrom: "owner-a",
    });
    const result = await RUN();
    expect(result.outcome).toBe("already-done");
    // No second reassignment / no throw.
    expect(store.portfolios.get("pf-1")!.ownerId).toBe("owner-b");
  });

  it("RE-RUNS preflights on resume when the marker is only at 'preflight' (not yet executing)", async () => {
    // A claim that crashed mid-preflight (or a concurrent double-submit) must
    // NOT skip the recipient_has_portfolio guard — the phase gate forces a
    // re-check. Here the recipient has since acquired a portfolio.
    seedTransferable();
    store.portfolios.set("pf-1", {
      ...(store.portfolios.get("pf-1") as Row),
      transferStatus: "in_progress",
      transferTo: "owner-b",
      transferPhase: "preflight",
    });
    recipientPortfolio = { id: "pf-b", ownerId: "owner-b" };
    await expect(RUN()).rejects.toMatchObject({ detail: { code: "recipient_has_portfolio" } });
    expect(store.portfolios.get("pf-1")!.ownerId).toBe("owner-a");
  });

  it("SKIPS preflights on resume once the marker reached 'executing'", async () => {
    // Destructive work already started under a validated claim — a phantom
    // portfolio appearing now must not brick the resume.
    seedTransferable();
    store.portfolios.set("pf-1", {
      ...(store.portfolios.get("pf-1") as Row),
      transferStatus: "in_progress",
      transferTo: "owner-b",
      transferPhase: "executing",
    });
    recipientPortfolio = { id: "pf-phantom", ownerId: "owner-b" }; // would block a fresh run
    const result = await RUN();
    expect(result.outcome).toBe("resumed");
    expect(store.portfolios.get("pf-1")!.ownerId).toBe("owner-b");
  });

  it("refuses when a transfer to a DIFFERENT recipient is already in progress", async () => {
    seedTransferable();
    store.portfolios.set("pf-1", {
      ...(store.portfolios.get("pf-1") as Row),
      transferStatus: "in_progress",
      transferTo: "owner-c",
    });
    await expect(RUN()).rejects.toMatchObject({ detail: { code: "in_progress_elsewhere" } });
  });
});
