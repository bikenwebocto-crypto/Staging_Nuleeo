// Unit tests for the portfolioBanking resolver — the single door to a
// portfolio's banking (IBAN + Stripe Connect state). Banking moved off the
// owner's user doc onto COL.portfolios (keyed by a STABLE, owner-independent
// doc id, resolved by `ownerId`). Banking has been migrated off user docs and
// stripped, so the portfolio is the sole source of truth — there is no
// fallback. These tests pin:
//   • getPortfolio — query by ownerId, null when none.
//   • loadPortfolioBanking — the portfolio's banking, else {} (no fallback).
//   • ensurePortfolio — get-or-create with a FRESH id (not the ownerId),
//     mirroring the portfolioId label, linking User.portfolioRef, idempotent.
//   • loadPortfolioByConnectAccount — the portfolio holding the account, else null.
//
// Mocking strategy: the in-memory Firestore double shared across these suites
// — a `store` object with one Map per collection; fakeDb.collection(name)
// reads store[name], so every collection the code under test touches needs a
// Map. vi.mock("../firebase").

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, unknown>;

// One Map per collection the resolver touches.
const store: Record<string, Map<string, Row>> = {
  users: new Map(),
  portfolios: new Map(),
};

// Monotonic counter so each no-arg doc() gets a distinct, owner-independent id
// (mirrors Firestore's generated ids — the portfolio doc id must NOT be the
// ownerId).
let autoId = 0;

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
  autoId = 0;
});

function makeRef(col: string, id: string) {
  return {
    id,
    async get() {
      const data = store[col].get(id);
      return { exists: !!data, id, data: () => data };
    },
    async set(data: Row, opts?: { merge?: boolean }) {
      if (opts?.merge) {
        store[col].set(id, { ...(store[col].get(id) ?? {}), ...data });
      } else {
        store[col].set(id, data);
      }
    },
  };
}

function makeQuery(col: string) {
  const filters: Array<{ field: string; value: unknown }> = [];
  const limits: number[] = [];
  const q = {
    where(field: string, _op: string, value: unknown) {
      filters.push({ field, value });
      return q;
    },
    limit(n: number) {
      limits.push(n);
      return q;
    },
    async get() {
      let rows = Array.from(store[col].entries()).map(([id, data]) => ({ id, data }));
      for (const f of filters) rows = rows.filter((r) => r.data[f.field] === f.value);
      if (limits.length) rows = rows.slice(0, Math.min(...limits));
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((r) => ({ id: r.id, data: () => r.data })),
      };
    },
  };
  return q;
}

const fakeDb = {
  collection(name: string) {
    return {
      // No-arg doc() generates a fresh, owner-independent id.
      doc(id?: string) {
        return makeRef(name, id ?? `auto_${name}_${autoId++}`);
      },
      where(field: string, op: string, value: unknown) {
        return makeQuery(name).where(field, op, value);
      },
    };
  },
  // Single-attempt transaction double: get/set delegate to the same store.
  // (Contention/retry semantics aren't modeled — tests exercise the re-check
  // branch by pre-seeding portfolioRef instead.)
  async runTransaction<T>(cb: (t: unknown) => Promise<T>): Promise<T> {
    const t = {
      async get(ref: { get: () => Promise<unknown> }) {
        return ref.get();
      },
      set(
        ref: { set: (d: Row, o?: { merge?: boolean }) => Promise<void> },
        data: Row,
        opts?: { merge?: boolean },
      ) {
        void ref.set(data, opts);
      },
    };
    return cb(t);
  },
};

vi.mock("../firebase", () => ({ db: () => fakeDb }));

const { getPortfolio, loadPortfolioBanking, ensurePortfolio, loadPortfolioByConnectAccount } =
  await import("./portfolioBanking");

// A representative banking blob (the legacy 12-field shape).
const SAMPLE_BANKING = {
  connectAccountId: "acct_owner",
  connectChargesEnabled: true,
  connectPayoutsEnabled: true,
  connectDetailsSubmitted: true,
  bankDetails: { holder: "Olive Owner", iban: "CY17002001280000001200527600", swift: "BCYPCY2N" },
};

describe("getPortfolio", () => {
  it("returns the portfolio for an owner", async () => {
    store.portfolios.set("pf-1", { id: "pf-1", ownerId: "owner-1", createdAt: "2026-01-01" });
    const pf = await getPortfolio("owner-1");
    expect(pf).not.toBeNull();
    expect(pf!.id).toBe("pf-1");
    expect(pf!.ownerId).toBe("owner-1");
  });

  it("returns null when the owner has no portfolio", async () => {
    expect(await getPortfolio("nobody")).toBeNull();
  });

  it("resolves via User.portfolioRef when two portfolios match the owner (deterministic)", async () => {
    // Duplicate-doc hazard: a where(ownerId).limit(1) query could return
    // either; the portfolioRef link names the authoritative one directly.
    store.portfolios.set("pf-dupe", { id: "pf-dupe", ownerId: "owner-1", createdAt: "2026-01-01" });
    store.portfolios.set("pf-real", {
      id: "pf-real",
      ownerId: "owner-1",
      createdAt: "2026-01-02",
      connectAccountId: "acct_real",
    });
    store.users.set("owner-1", { id: "owner-1", portfolioRef: "pf-real" });

    const pf = await getPortfolio("owner-1");
    expect(pf!.id).toBe("pf-real");
    expect(pf!.connectAccountId).toBe("acct_real");
  });

  it("ignores a STALE portfolioRef (portfolio now owned by someone else) and falls back to the query", async () => {
    // After a transfer, the old owner's link may briefly point at a portfolio
    // whose ownerId has moved on — never serve another owner's portfolio.
    store.portfolios.set("pf-moved", {
      id: "pf-moved",
      ownerId: "new-owner",
      createdAt: "2026-01-01",
    });
    store.users.set("owner-1", { id: "owner-1", portfolioRef: "pf-moved" });

    expect(await getPortfolio("owner-1")).toBeNull();
  });
});

describe("loadPortfolioBanking", () => {
  it("returns the portfolio's banking when a portfolio exists", async () => {
    store.portfolios.set("pf-1", {
      id: "pf-1",
      ownerId: "owner-1",
      createdAt: "2026-01-01",
      ...SAMPLE_BANKING,
    });
    // A legacy banking blob is also on the user doc — the portfolio must win.
    store.users.set("owner-1", { id: "owner-1", connectAccountId: "acct_stale" });

    const banking = await loadPortfolioBanking("owner-1");
    expect(banking.connectAccountId).toBe("acct_owner");
    expect(banking.connectChargesEnabled).toBe(true);
    expect(banking.bankDetails).toEqual(SAMPLE_BANKING.bankDetails);
    // pickDefinedBanking strips the doc envelope (id/ownerId/createdAt).
    expect((banking as Record<string, unknown>).id).toBeUndefined();
    expect((banking as Record<string, unknown>).ownerId).toBeUndefined();
  });

  it("returns {} when the owner has no portfolio (no legacy user-doc fallback)", async () => {
    // A stale legacy blob lingering on the user doc is never read post-strip.
    store.users.set("owner-1", { id: "owner-1", ...SAMPLE_BANKING });
    expect(await loadPortfolioBanking("owner-1")).toEqual({});
  });

  it("returns {} when neither a portfolio nor a user doc has banking", async () => {
    expect(await loadPortfolioBanking("ghost")).toEqual({});
  });

  it("returns {} when the user doc exists but carries no banking fields", async () => {
    store.users.set("owner-1", { id: "owner-1", email: "o@example.com" });
    expect(await loadPortfolioBanking("owner-1")).toEqual({});
  });
});

describe("ensurePortfolio", () => {
  it("creates a portfolio with a FRESH id (not the ownerId), mirroring the label only", async () => {
    // Any legacy banking lingering on the user doc is NOT copied — banking is
    // set via the write paths now, not migrated on create.
    store.users.set("owner-1", {
      id: "owner-1",
      portfolioId: "OLIO-A4F2K9",
      ...SAMPLE_BANKING,
    });

    const pf = await ensurePortfolio("owner-1");

    // Doc id is generated, NOT the owner's uid.
    expect(pf.id).not.toBe("owner-1");
    expect(pf.ownerId).toBe("owner-1");
    // Banking is NOT carried over from the user doc.
    expect(pf.connectAccountId).toBeUndefined();
    expect(pf.bankDetails).toBeUndefined();
    // Human-friendly label mirrored from the user.
    expect(pf.portfolioId).toBe("OLIO-A4F2K9");
    expect(typeof pf.createdAt).toBe("string");

    // The doc was actually persisted under its fresh id.
    expect(store.portfolios.get(pf.id)).toMatchObject({ id: pf.id, ownerId: "owner-1" });
    // User.portfolioRef now points at it.
    expect(store.users.get("owner-1")!.portfolioRef).toBe(pf.id);
  });

  it("is idempotent: a second call returns the same doc with no duplicate", async () => {
    store.users.set("owner-1", { id: "owner-1", ...SAMPLE_BANKING });

    const first = await ensurePortfolio("owner-1");
    const second = await ensurePortfolio("owner-1");

    expect(second.id).toBe(first.id);
    // Only one portfolio doc exists for the owner.
    expect(store.portfolios.size).toBe(1);
  });

  it("creates an empty portfolio (no banking, no portfolioId) when the user doc has none", async () => {
    store.users.set("owner-1", { id: "owner-1", email: "o@example.com" });
    const pf = await ensurePortfolio("owner-1");
    expect(pf.ownerId).toBe("owner-1");
    expect(pf.connectAccountId).toBeUndefined();
    expect(pf.portfolioId).toBeUndefined();
    expect(store.users.get("owner-1")!.portfolioRef).toBe(pf.id);
  });

  it("returns the portfolioRef-linked doc inside the transaction (concurrent-create loser path)", async () => {
    // Simulate the state a retried transaction sees after losing a race: the
    // fast path missed (we seed AFTER it would have run — here the user's
    // portfolioRef and doc both already exist, exercising the in-txn re-check
    // returning the winner's doc instead of creating a second one).
    // getPortfolio's fast path would also catch this; what we pin is that NO
    // duplicate is created and the linked doc wins.
    store.portfolios.set("pf-won", { id: "pf-won", ownerId: "owner-1", createdAt: "2026-01-01" });
    store.users.set("owner-1", { id: "owner-1", portfolioRef: "pf-won" });

    const pf = await ensurePortfolio("owner-1");
    expect(pf.id).toBe("pf-won");
    expect(store.portfolios.size).toBe(1);
  });
});

describe("loadPortfolioByConnectAccount", () => {
  it("resolves the portfolio that holds the connect account (portfolios first)", async () => {
    store.portfolios.set("pf-1", {
      id: "pf-1",
      ownerId: "owner-1",
      createdAt: "2026-01-01",
      connectAccountId: "acct_owner",
    });
    const pf = await loadPortfolioByConnectAccount("acct_owner");
    expect(pf).not.toBeNull();
    expect(pf!.id).toBe("pf-1");
    expect(pf!.ownerId).toBe("owner-1");
    // No migration happened — still exactly one portfolio.
    expect(store.portfolios.size).toBe(1);
  });

  it("returns null when the account is only on a user doc (no portfolio, no fallback)", async () => {
    // A stale connectAccountId lingering on a user doc is NOT a binding source.
    store.users.set("owner-1", { id: "owner-1", ...SAMPLE_BANKING });
    expect(await loadPortfolioByConnectAccount("acct_owner")).toBeNull();
    // Nothing was created.
    expect(store.portfolios.size).toBe(0);
  });

  it("returns null when no portfolio or user holds the account", async () => {
    expect(await loadPortfolioByConnectAccount("acct_unknown")).toBeNull();
    // Nothing was created for an unknown account.
    expect(store.portfolios.size).toBe(0);
  });
});
