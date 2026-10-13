// TE-2: behavioral tests for the REAL portfolio privilege-resolution engine
// (server/services/portfolioPrivilege.ts). Every existing authz test MOCKS
// hasPortfolioPrivilege, so the actual role->verdict matrix lookup +
// role-resolution (active-only grants, OR-across-roles, fail-closed on missing
// keys) was untested. These tests exercise the engine itself against inline
// fixture matrices — no mock of the SUT.
//
// What IS mocked (the engine's deps, not the engine):
//   - ../firebase            → an in-memory Firestore that serves
//                              portfolioAccessContacts + tenants from per-test
//                              arrays, honouring the .where(field,==,value)
//                              filters the SUT applies.
//   - ./configCache          → loadPrivilegesConfig returns a per-test matrix.
//   - ./commission           → resolveOwnerPlan returns a per-test plan (for
//                              the owner-plan privilege check).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  OwnerPlanGrants,
  OwnerPlanKey,
  PortfolioAccessContact,
  PortfolioGrants,
  PortfolioRoleKey,
} from "../../shared/firestore-schema";

// ---- Per-test mutable state driving the mocked deps -----------------------
const state: {
  contacts: Partial<PortfolioAccessContact>[];
  tenants: Array<{ ownerId: string; userId: string; portfolioId?: string }>;
  portfolio: Partial<PortfolioGrants>;
  ownerPlan: Partial<OwnerPlanGrants>;
  plan: OwnerPlanKey;
} = {
  contacts: [],
  tenants: [],
  portfolio: {},
  ownerPlan: {},
  plan: "basic",
};

// Minimal Firestore stand-in. resolvePortfolioRoles issues two query shapes
// (Phase 4 — keyed SOLELY by the stamped portfolioId):
//   collection(portfolioAccessContacts).where(portfolioId,==,P).where(contactUserId,==,Y).get()
//   collection(tenants).where(portfolioId,==,P).where(userId,==,Y).limit(1).get()
// We accumulate .where() filters, then materialise the matching docs on .get().
vi.mock("../firebase", () => {
  const makeQuery = (rows: Array<Record<string, unknown>>, filters: Array<[string, unknown]>) => ({
    where(field: string, _op: string, value: unknown) {
      return makeQuery(rows, [...filters, [field, value]]);
    },
    limit(_n: number) {
      return makeQuery(rows, filters);
    },
    async get() {
      const matched = rows.filter((r) => filters.every(([f, v]) => r[f] === v));
      return {
        empty: matched.length === 0,
        docs: matched.map((r) => ({ data: () => r })),
      };
    },
  });
  return {
    db: () => ({
      collection(name: string) {
        const rows =
          name === "tenants"
            ? (state.tenants as Array<Record<string, unknown>>)
            : (state.contacts as Array<Record<string, unknown>>);
        return makeQuery(rows, []);
      },
    }),
  };
});

vi.mock("./configCache", () => ({
  loadPrivilegesConfig: async () => ({
    portfolio: state.portfolio,
    platform: {},
    ownerPlan: state.ownerPlan,
  }),
}));

vi.mock("./commission", () => ({
  resolveOwnerPlan: async () => state.plan,
}));

const { resolvePortfolioRoles, hasPortfolioPrivilege, hasOwnerPlanPrivilege } =
  await import("./portfolioPrivilege");

// ---- Fixtures -------------------------------------------------------------
// A trimmed matrix that exercises every role column. property.view is granted
// to everyone; finance.recordPayment only to owner+financial; agreement.edit
// only to owner+legal. tenant.manage is owner-only. "orphan.key" is
// deliberately ABSENT from the matrix to prove fail-closed on a missing entry.
function row(
  o: boolean,
  legacy: boolean,
  legal: boolean,
  fin: boolean,
  tenant: boolean,
): Record<PortfolioRoleKey, boolean> {
  return { owner: o, legacyOwner: legacy, legal, financial: fin, tenant };
}
const PORTFOLIO_MATRIX: Partial<PortfolioGrants> = {
  "property.view": row(true, true, true, true, true),
  "finance.recordPayment": row(true, false, false, true, false),
  "agreement.edit": row(true, false, true, false, false),
  "tenant.manage": row(true, false, false, false, false),
};

const OWNER_PLAN_MATRIX: Partial<OwnerPlanGrants> = {
  "rent.collectStripe": {
    basic: false,
    advance: true,
    pro: true,
    business: true,
  },
};

function contact(overrides: Partial<PortfolioAccessContact>): Partial<PortfolioAccessContact> {
  return {
    ownerId: "owner-1",
    // Phase 4: every grant row is stamped with its portfolio doc id — the
    // ONLY key the engine queries by.
    portfolioId: "pf-1",
    contactUserId: "contact-1",
    type: "legal",
    status: "active",
    ...overrides,
  };
}

beforeEach(() => {
  state.contacts = [];
  state.tenants = [];
  state.portfolio = PORTFOLIO_MATRIX;
  state.ownerPlan = OWNER_PLAN_MATRIX;
  state.plan = "basic";
});

describe("resolvePortfolioRoles (real role resolution)", () => {
  it("returns ['owner'] when caller IS the owner (no DB lookup needed)", async () => {
    const roles = await resolvePortfolioRoles("owner-1", "owner-1");
    expect(roles).toEqual(["owner"]);
  });

  it("maps active legal + financial grants to both portfolio roles (multi-role)", async () => {
    state.contacts = [contact({ type: "legal" }), contact({ type: "financial" })];
    const roles = await resolvePortfolioRoles("contact-1", "owner-1", "pf-1");
    expect(roles.sort()).toEqual(["financial", "legal"]);
  });

  it("maps a legacy grant to the legacyOwner role", async () => {
    state.contacts = [contact({ type: "legacy" })];
    const roles = await resolvePortfolioRoles("contact-1", "owner-1", "pf-1");
    expect(roles).toEqual(["legacyOwner"]);
  });

  it("EXCLUDES pending / non-active grants (project rule: invites don't confer privilege)", async () => {
    state.contacts = [
      contact({ type: "legal", status: "pending" }),
      contact({ type: "financial", status: "revoked" }),
      contact({ type: "legacy", status: "declined" }),
    ];
    const roles = await resolvePortfolioRoles("contact-1", "owner-1", "pf-1");
    expect(roles).toEqual([]);
  });

  it("does NOT leak roles from a grant stamped to a DIFFERENT portfolio (where-filter honoured)", async () => {
    state.contacts = [contact({ portfolioId: "pf-other", type: "legal", status: "active" })];
    const roles = await resolvePortfolioRoles("contact-1", "owner-1", "pf-1");
    expect(roles).toEqual([]);
  });

  it("Phase 4: a null/absent portfolioId resolves NO grant roles (fail closed — ownerId is never a key)", async () => {
    // Active, stamped grant exists — but without the portfolio key there is
    // no lookup path; the removed legacy ownerId query must not resurrect it.
    state.contacts = [contact({ type: "legal" })];
    expect(await resolvePortfolioRoles("contact-1", "owner-1")).toEqual([]);
    expect(await resolvePortfolioRoles("contact-1", "owner-1", null)).toEqual([]);
  });

  it("falls back to ['tenant'] when caller holds a tenancy stamped to the portfolio and no grant", async () => {
    state.tenants = [{ ownerId: "owner-1", userId: "tenant-9", portfolioId: "pf-1" }];
    const roles = await resolvePortfolioRoles("tenant-9", "owner-1", "pf-1");
    expect(roles).toEqual(["tenant"]);
  });

  it("Phase 4: a tenancy NOT stamped to the portfolio confers no tenant role (ownerId leg removed)", async () => {
    state.tenants = [{ ownerId: "owner-1", userId: "tenant-9" }];
    expect(await resolvePortfolioRoles("tenant-9", "owner-1", "pf-1")).toEqual([]);
    expect(await resolvePortfolioRoles("tenant-9", "owner-1")).toEqual([]);
  });

  it("prefers explicit grants over the tenant fallback (grant present => no tenant role added)", async () => {
    state.contacts = [contact({ contactUserId: "dual", type: "legal" })];
    state.tenants = [{ ownerId: "owner-1", userId: "dual", portfolioId: "pf-1" }];
    const roles = await resolvePortfolioRoles("dual", "owner-1", "pf-1");
    expect(roles).toEqual(["legal"]);
  });

  it("returns [] for a stranger with no grant and no tenancy", async () => {
    const roles = await resolvePortfolioRoles("nobody", "owner-1", "pf-1");
    expect(roles).toEqual([]);
  });
});

describe("hasPortfolioPrivilege (real matrix lookup)", () => {
  it("ALLOWS the owner for an owner-only privilege", async () => {
    const ok = await hasPortfolioPrivilege("owner-1", "owner-1", "tenant.manage");
    expect(ok).toBe(true);
  });

  it("ALLOWS a financial contact for finance.recordPayment (role HAS the privilege)", async () => {
    state.contacts = [contact({ type: "financial" })];
    const ok = await hasPortfolioPrivilege("contact-1", "owner-1", "finance.recordPayment", "pf-1");
    expect(ok).toBe(true);
  });

  it("DENIES a financial contact for agreement.edit (role lacks the privilege)", async () => {
    state.contacts = [contact({ type: "financial" })];
    const ok = await hasPortfolioPrivilege("contact-1", "owner-1", "agreement.edit", "pf-1");
    expect(ok).toBe(false);
  });

  it("DENIES a legal contact for finance.recordPayment (the cross-role leak this engine closes)", async () => {
    state.contacts = [contact({ type: "legal" })];
    const ok = await hasPortfolioPrivilege("contact-1", "owner-1", "finance.recordPayment", "pf-1");
    expect(ok).toBe(false);
  });

  it("OR's grants across multiple roles (legal+financial => union of both columns)", async () => {
    state.contacts = [contact({ type: "legal" }), contact({ type: "financial" })];
    // legal grants agreement.edit, financial grants finance.recordPayment;
    // the holder of both gets each.
    expect(await hasPortfolioPrivilege("contact-1", "owner-1", "agreement.edit", "pf-1")).toBe(
      true,
    );
    expect(
      await hasPortfolioPrivilege("contact-1", "owner-1", "finance.recordPayment", "pf-1"),
    ).toBe(true);
  });

  it("DENIES a pending grant the privilege its role would otherwise confer", async () => {
    state.contacts = [contact({ type: "financial", status: "pending" })];
    const ok = await hasPortfolioPrivilege("contact-1", "owner-1", "finance.recordPayment", "pf-1");
    expect(ok).toBe(false);
  });

  it("Phase 4: DENIES a granted contact when no portfolioId is threaded (fail closed)", async () => {
    state.contacts = [contact({ type: "financial" })];
    const ok = await hasPortfolioPrivilege("contact-1", "owner-1", "finance.recordPayment");
    expect(ok).toBe(false);
  });

  it("FAILS CLOSED for a privilege key absent from the matrix (no entry => denied, not open)", async () => {
    // Even the owner is denied a key that isn't in the matrix at all.
    const ok = await hasPortfolioPrivilege(
      "owner-1",
      "owner-1",
      // deliberately not a real key — proves `if (!grants) return false`
      "does.not.exist" as never,
    );
    expect(ok).toBe(false);
  });

  it("DENIES a stranger (empty roles) every privilege", async () => {
    expect(await hasPortfolioPrivilege("nobody", "owner-1", "property.view", "pf-1")).toBe(false);
  });
});

describe("hasOwnerPlanPrivilege (real owner-plan matrix lookup)", () => {
  it("ALLOWS when the owner's plan grants the feature", async () => {
    state.plan = "pro";
    expect(await hasOwnerPlanPrivilege("owner-1", "rent.collectStripe")).toBe(true);
  });

  it("DENIES when the owner's plan does not grant the feature", async () => {
    state.plan = "basic";
    expect(await hasOwnerPlanPrivilege("owner-1", "rent.collectStripe")).toBe(false);
  });

  it("FAILS CLOSED for a plan-privilege key absent from the matrix", async () => {
    state.plan = "business";
    expect(await hasOwnerPlanPrivilege("owner-1", "does.not.exist" as never)).toBe(false);
  });
});
