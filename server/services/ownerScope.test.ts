// Tests for the authorization scope boundary (resolveOwnerScope) and the
// per-resource matrix gate (authorizePortfolioRead).
//
// Phase 4 contract: the STABLE Portfolio doc id is the ONLY scope key.
//   • `?portfolioId=` (preferred) loads portfolios/{id}; unknown id and
//     no-grant both refuse with the SAME 403 (no existence probing).
//   • `?ownerId=` (legacy REQUEST param) keeps working; the owner's
//     portfolio is resolved read-only.
//   • Self always ensures a portfolio so scope.portfolioId is non-null.
//   • Grant lookups key SOLELY off the stamped portfolioId field — the
//     Phase-2 legacy ownerId dual-read fallback is removed, so an
//     UNSTAMPED grant (or a portfolio-less owner) confers nothing.
// SECURITY pins: pending/declined/revoked grants confer nothing; a grant on
// a DIFFERENT portfolio must not leak access; requireEdit rejects view-only.
//
// Mocking strategy: the in-memory Firestore double shared across these
// suites (see portfolioBanking.test.ts) — one Map per collection +
// runTransaction; vi.mock("../firebase"). hasPortfolioPrivilege is mocked so
// the authorizePortfolioRead suite can control the verdict AND assert the
// exact privilege key + threaded portfolioId.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request } from "express";

type Row = Record<string, unknown>;

// One Map per collection the scope resolver touches.
const store: Record<string, Map<string, Row>> = {
  users: new Map(),
  portfolios: new Map(),
  portfolioAccessContacts: new Map(),
  tenants: new Map(),
};

// Monotonic counter so each no-arg doc() gets a distinct generated id
// (ensurePortfolio's created doc id must be owner-independent).
let autoId = 0;

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
  autoId = 0;
  hasPortfolioPrivilege.mockReset();
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
      doc(id?: string) {
        return makeRef(name, id ?? `auto_${name}_${autoId++}`);
      },
      where(field: string, op: string, value: unknown) {
        return makeQuery(name).where(field, op, value);
      },
    };
  },
  // Single-attempt transaction double (ensurePortfolio's create path).
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

const hasPortfolioPrivilege = vi.fn();
vi.mock("./portfolioPrivilege", () => ({
  hasPortfolioPrivilege: (...args: unknown[]) => hasPortfolioPrivilege(...args),
}));

const { resolveOwnerScope, authorizePortfolioRead } = await import("./ownerScope");

// ── Fixtures ───────────────────────────────────────────────────────────

function makeReq(uid: string, query: Record<string, string> = {}): Request {
  return { user: { uid }, query } as unknown as Request;
}

function seedPortfolio(id: string, ownerId: string): void {
  store.portfolios.set(id, { id, ownerId, createdAt: "2026-01-01T00:00:00.000Z" });
}

function seedGrant(
  id: string,
  overrides: Partial<{
    ownerId: string;
    portfolioId: string;
    contactUserId: string;
    type: string;
    status: string;
    permissions: string[];
  }>,
): void {
  store.portfolioAccessContacts.set(id, {
    id,
    ownerId: "owner-x",
    contactUserId: "contact-1",
    type: "legal",
    status: "active",
    permissions: ["view"],
    invitedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

// ── resolveOwnerScope ──────────────────────────────────────────────────

describe("resolveOwnerScope — self", () => {
  it("ensures a portfolio and returns its stable id (non-null for self)", async () => {
    store.users.set("me", { id: "me", email: "me@example.com" });

    const scope = await resolveOwnerScope(makeReq("me"));

    expect(scope).toMatchObject({
      ok: true,
      ownerId: "me",
      isSelf: true,
      permissions: ["view", "edit"],
    });
    if (!scope.ok) throw new Error("unreachable");
    expect(scope.portfolioId).not.toBeNull();
    // The ensure actually persisted the doc and linked User.portfolioRef.
    expect(store.portfolios.get(scope.portfolioId!)).toMatchObject({ ownerId: "me" });
    expect(store.users.get("me")!.portfolioRef).toBe(scope.portfolioId);
  });

  it("is stable: a second resolve returns the SAME portfolio id (idempotent ensure)", async () => {
    store.users.set("me", { id: "me" });
    const first = await resolveOwnerScope(makeReq("me"));
    const second = await resolveOwnerScope(makeReq("me"));
    if (!first.ok || !second.ok) throw new Error("expected ok scopes");
    expect(second.portfolioId).toBe(first.portfolioId);
    expect(store.portfolios.size).toBe(1);
  });

  it("treats legacy ?ownerId=<own uid> as self (ensures, full permissions)", async () => {
    store.users.set("me", { id: "me" });
    const scope = await resolveOwnerScope(makeReq("me", { ownerId: "me" }));
    expect(scope).toMatchObject({ ok: true, ownerId: "me", isSelf: true });
    if (scope.ok) expect(scope.portfolioId).not.toBeNull();
  });
});

describe("resolveOwnerScope — ?portfolioId= (preferred key)", () => {
  it("resolves the portfolio's owner and isSelf=true for the owner themselves", async () => {
    seedPortfolio("pf-mine", "me");
    const scope = await resolveOwnerScope(makeReq("me", { portfolioId: "pf-mine" }));
    expect(scope).toEqual({
      ok: true,
      ownerId: "me",
      portfolioId: "pf-mine",
      permissions: ["view", "edit"],
      isSelf: true,
    });
  });

  it("403s an UNKNOWN portfolio id (same refusal as no-grant — no existence probe)", async () => {
    const scope = await resolveOwnerScope(makeReq("me", { portfolioId: "pf-ghost" }));
    expect(scope).toMatchObject({ ok: false, status: 403 });
  });

  it("403s a foreign portfolio when the caller holds NO grant", async () => {
    seedPortfolio("pf-x", "owner-x");
    const scope = await resolveOwnerScope(makeReq("stranger", { portfolioId: "pf-x" }));
    expect(scope).toMatchObject({ ok: false, status: 403 });
  });

  it("resolves a foreign portfolio via an ACTIVE grant stamped with its portfolioId", async () => {
    seedPortfolio("pf-x", "owner-x");
    seedGrant("owner-x_legal", { portfolioId: "pf-x", contactUserId: "contact-1" });

    const scope = await resolveOwnerScope(makeReq("contact-1", { portfolioId: "pf-x" }));

    expect(scope).toEqual({
      ok: true,
      ownerId: "owner-x",
      portfolioId: "pf-x",
      permissions: ["view"],
      isSelf: false,
    });
  });

  it("merges permissions across multiple active grants (legal view + legacy view/edit)", async () => {
    seedPortfolio("pf-x", "owner-x");
    seedGrant("owner-x_legal", { portfolioId: "pf-x", permissions: ["view"] });
    seedGrant("owner-x_legacy", {
      portfolioId: "pf-x",
      type: "legacy",
      permissions: ["view", "edit"],
    });

    const scope = await resolveOwnerScope(makeReq("contact-1", { portfolioId: "pf-x" }));
    if (!scope.ok) throw new Error("expected ok scope");
    expect([...scope.permissions].sort()).toEqual(["edit", "view"]);
  });

  it("Phase 4: does NOT honor an UNSTAMPED active grant (legacy ownerId dual-read removed)", async () => {
    seedPortfolio("pf-x", "owner-x");
    // Row shaped like pre-stamping code wrote it: no portfolioId field at all
    // (the seedGrant base fixture only carries one when explicitly
    // overridden). All prod rows are stamped, so this row is unreachable by
    // the portfolioId-only lookup and must confer nothing.
    seedGrant("owner-x_legal", { contactUserId: "contact-1" });

    const scope = await resolveOwnerScope(makeReq("contact-1", { portfolioId: "pf-x" }));
    expect(scope).toMatchObject({ ok: false, status: 403 });
  });

  it("does NOT honor a grant stamped for a DIFFERENT portfolio of the same owner", async () => {
    // Transfer hazard: owner-x is now on a fresh portfolio pf-new, but an old
    // grant is still stamped to their PRIOR portfolio pf-old. The exact
    // portfolioId key must NOT match the pf-old grant → no access to pf-new.
    seedPortfolio("pf-new", "owner-x");
    seedGrant("owner-x_legal", { portfolioId: "pf-old", contactUserId: "contact-1" });

    const scope = await resolveOwnerScope(makeReq("contact-1", { portfolioId: "pf-new" }));
    expect(scope).toMatchObject({ ok: false, status: 403 });
  });

  it("takes precedence over a conflicting legacy ?ownerId= param", async () => {
    seedPortfolio("pf-x", "owner-x");
    seedGrant("owner-x_legal", { portfolioId: "pf-x", contactUserId: "contact-1" });
    // ownerId points elsewhere — the portfolioId param must win.
    const scope = await resolveOwnerScope(
      makeReq("contact-1", { portfolioId: "pf-x", ownerId: "someone-else" }),
    );
    expect(scope).toMatchObject({ ok: true, ownerId: "owner-x", portfolioId: "pf-x" });
  });

  it("requireEdit rejects a view-only grant with a distinct 403", async () => {
    seedPortfolio("pf-x", "owner-x");
    seedGrant("owner-x_legal", { portfolioId: "pf-x", permissions: ["view"] });

    const scope = await resolveOwnerScope(makeReq("contact-1", { portfolioId: "pf-x" }), true);
    expect(scope).toMatchObject({ ok: false, status: 403 });
    if (!scope.ok) expect(scope.error).toMatch(/view access/);
  });

  it("requireEdit passes for a grant that carries edit", async () => {
    seedPortfolio("pf-x", "owner-x");
    seedGrant("owner-x_legacy", {
      portfolioId: "pf-x",
      type: "legacy",
      permissions: ["view", "edit"],
    });
    const scope = await resolveOwnerScope(makeReq("contact-1", { portfolioId: "pf-x" }), true);
    expect(scope).toMatchObject({ ok: true, isSelf: false });
  });
});

describe("resolveOwnerScope — legacy ?ownerId= REQUEST param (kept working)", () => {
  it("resolves a granted owner, attaching their portfolio id (grant found via the stamped key)", async () => {
    seedPortfolio("pf-x", "owner-x");
    store.users.set("owner-x", { id: "owner-x", portfolioRef: "pf-x" });
    // The ?ownerId= param resolves the owner's portfolio, then the grant is
    // looked up by that stamped portfolioId (the only grant key).
    seedGrant("owner-x_legal", { portfolioId: "pf-x", contactUserId: "contact-1" });

    const scope = await resolveOwnerScope(makeReq("contact-1", { ownerId: "owner-x" }));

    expect(scope).toEqual({
      ok: true,
      ownerId: "owner-x",
      portfolioId: "pf-x",
      permissions: ["view"],
      isSelf: false,
    });
  });

  it("Phase 4: 403s a foreign owner with NO portfolio (no portfolio => no grants by construction)", async () => {
    // No portfolios row at all — pre-portfolio owner. Grants are stamped at
    // creation, so a portfolio-less owner can have none; even an (impossible
    // in prod) unstamped grant row confers nothing now.
    seedGrant("owner-x_legal", { contactUserId: "contact-1" });

    const scope = await resolveOwnerScope(makeReq("contact-1", { ownerId: "owner-x" }));
    expect(scope).toMatchObject({ ok: false, status: 403 });
  });

  it("403s a stranger with no grant", async () => {
    seedPortfolio("pf-x", "owner-x");
    const scope = await resolveOwnerScope(makeReq("stranger", { ownerId: "owner-x" }));
    expect(scope).toMatchObject({ ok: false, status: 403 });
  });

  it("does NOT create a portfolio for the foreign owner (read-only resolve)", async () => {
    seedGrant("owner-x_legal", { contactUserId: "contact-1" });
    await resolveOwnerScope(makeReq("contact-1", { ownerId: "owner-x" }));
    expect(store.portfolios.size).toBe(0);
  });
});

describe("resolveOwnerScope — SECURITY", () => {
  it("a PENDING grant must not resolve (invites confer nothing until accepted)", async () => {
    seedPortfolio("pf-x", "owner-x");
    seedGrant("owner-x_legal", { portfolioId: "pf-x", status: "pending" });

    expect(await resolveOwnerScope(makeReq("contact-1", { portfolioId: "pf-x" }))).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await resolveOwnerScope(makeReq("contact-1", { ownerId: "owner-x" }))).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("a REVOKED/DECLINED grant must not resolve", async () => {
    seedPortfolio("pf-x", "owner-x");
    seedGrant("owner-x_legal", { portfolioId: "pf-x", status: "revoked" });
    seedGrant("owner-x_financial", { portfolioId: "pf-x", type: "financial", status: "declined" });

    expect(await resolveOwnerScope(makeReq("contact-1", { portfolioId: "pf-x" }))).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("an active grant on a DIFFERENT portfolio must not leak access to this one", async () => {
    seedPortfolio("pf-target", "owner-target");
    seedPortfolio("pf-other", "owner-other");
    // contact-1 is legitimately granted on owner-other's portfolio only.
    seedGrant("owner-other_legal", {
      ownerId: "owner-other",
      portfolioId: "pf-other",
      contactUserId: "contact-1",
      permissions: ["view", "edit"],
    });

    expect(
      await resolveOwnerScope(makeReq("contact-1", { portfolioId: "pf-target" })),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await resolveOwnerScope(makeReq("contact-1", { ownerId: "owner-target" })),
    ).toMatchObject({ ok: false, status: 403 });
  });
});

// ── authorizePortfolioRead (H1 — server-side matrix enforcement) ───────
// resolveOwnerScope only proves *some* active grant; the per-role privilege
// matrix must be enforced SERVER-SIDE so e.g. a "financial" contact can't
// read agreements via a direct API call. Self always passes without a
// matrix lookup.

type OkScope = Extract<Awaited<ReturnType<typeof resolveOwnerScope>>, { ok: true }>;

const selfScope: OkScope = {
  ok: true,
  ownerId: "me",
  portfolioId: "pf-me",
  permissions: ["view", "edit"],
  isSelf: true,
};
const contactScope: OkScope = {
  ok: true,
  ownerId: "owner-x",
  portfolioId: "pf-x",
  permissions: ["view"],
  isSelf: false,
};

describe("authorizePortfolioRead (H1 — server-side matrix enforcement)", () => {
  it("allows self without consulting the matrix", async () => {
    const r = await authorizePortfolioRead("me", selfScope, "agreement.view");
    expect(r.ok).toBe(true);
    expect(hasPortfolioPrivilege).not.toHaveBeenCalled();
  });

  it("allows a contact whose role grants the privilege", async () => {
    hasPortfolioPrivilege.mockResolvedValueOnce(true);
    const r = await authorizePortfolioRead("contact", contactScope, "tenant.view");
    expect(r.ok).toBe(true);
    expect(hasPortfolioPrivilege).toHaveBeenCalledWith("contact", "owner-x", "tenant.view", "pf-x");
  });

  it("403s a contact whose role does NOT grant the privilege (the leak this closes)", async () => {
    hasPortfolioPrivilege.mockResolvedValueOnce(false);
    const r = await authorizePortfolioRead("financial-contact", contactScope, "agreement.view");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("threads the resolved ownerId AND stable portfolioId to the matrix check", async () => {
    hasPortfolioPrivilege.mockResolvedValueOnce(true);
    await authorizePortfolioRead("contact", contactScope, "finance.viewHistory");
    expect(hasPortfolioPrivilege).toHaveBeenCalledWith(
      "contact",
      "owner-x",
      "finance.viewHistory",
      "pf-x",
    );
  });

  it("passes portfolioId=null through unchanged (legacy null-portfolio scope)", async () => {
    hasPortfolioPrivilege.mockResolvedValueOnce(true);
    await authorizePortfolioRead("contact", { ...contactScope, portfolioId: null }, "tenant.view");
    expect(hasPortfolioPrivilege).toHaveBeenCalledWith("contact", "owner-x", "tenant.view", null);
  });
});
