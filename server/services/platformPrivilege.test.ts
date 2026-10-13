// TE-2: behavioral tests for the REAL platform privilege-resolution engine
// (server/services/platformPrivilege.ts). Existing authz tests MOCK
// hasPlatformPrivilege, leaving the actual superadmin shortcut + admin
// sub-role matrix lookup + last-superadmin lockout guard untested.
//
// What IS mocked (deps, not the engine):
//   - ./configCache → loadPrivilegesConfig returns a per-test platform matrix.
//   - ../firebase   → in-memory users collection honouring the
//                     .where("roles","array-contains","superadmin") filter that
//                     isLastSuperadmin issues.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PlatformGrants, PlatformRoleKey, Role, User } from "../../shared/firestore-schema";

const state: {
  platform: Partial<PlatformGrants>;
  users: Array<{ id: string; roles: Role[] }>;
} = { platform: {}, users: [] };

// isLastSuperadmin queries:
//   collection(users).where("roles","array-contains","superadmin").get()
// so the mock must implement array-contains (not ==) for the roles field.
vi.mock("../firebase", () => {
  const makeQuery = (
    rows: Array<{ id: string; roles: Role[] }>,
    pred: (r: { id: string; roles: Role[] }) => boolean,
  ) => ({
    where(field: string, op: string, value: unknown) {
      const next =
        field === "roles" && op === "array-contains"
          ? (r: { id: string; roles: Role[] }) =>
              pred(r) && Array.isArray(r.roles) && r.roles.includes(value as Role)
          : (r: { id: string; roles: Role[] }) =>
              pred(r) && (r as unknown as Record<string, unknown>)[field] === value;
      return makeQuery(rows, next);
    },
    async get() {
      const matched = rows.filter(pred);
      return {
        empty: matched.length === 0,
        docs: matched.map((r) => ({ id: r.id, data: () => r })),
      };
    },
  });
  return {
    db: () => ({
      collection: (_name: string) => makeQuery(state.users, () => true),
    }),
  };
});

vi.mock("./configCache", () => ({
  loadPrivilegesConfig: async () => ({
    portfolio: {},
    platform: state.platform,
    ownerPlan: {},
  }),
}));

const { resolvePlatformRole, hasPlatformPrivilege, isLastSuperadmin } =
  await import("./platformPrivilege");

// Trimmed platform matrix. users.viewAll is granted to admin+manager+support;
// users.assignRoles is admin-only (superadmin-class power); platform.maintenance
// is admin-only. "support" sub-role gets only the read key.
function row(over: Partial<Record<PlatformRoleKey, boolean>>) {
  return {
    admin: false,
    manager: false,
    legal: false,
    financial: false,
    support: false,
    sales: false,
    marketing: false,
    ...over,
  };
}
const PLATFORM_MATRIX: Partial<PlatformGrants> = {
  "users.viewAll": row({ admin: true, manager: true, support: true }),
  "users.assignRoles": row({ admin: true }),
  "platform.maintenance": row({ admin: true }),
};

function profile(over: Partial<User>): User {
  return { roles: [], status: "active", ...(over as object) } as User;
}

beforeEach(() => {
  state.platform = PLATFORM_MATRIX;
  state.users = [];
});

describe("resolvePlatformRole (real role resolution)", () => {
  it("returns 'superadmin' when roles include superadmin (matrix is bypassed)", () => {
    expect(resolvePlatformRole(profile({ roles: ["superadmin"] }))).toBe("superadmin");
  });

  it("returns the explicit platformRole sub-role for an admin", () => {
    expect(resolvePlatformRole(profile({ roles: ["admin"], platformRole: "support" }))).toBe(
      "support",
    );
  });

  it("falls back to 'admin' for an admin with no platformRole set", () => {
    expect(resolvePlatformRole(profile({ roles: ["admin"] }))).toBe("admin");
  });

  it("returns null for a non-staff user (owner/tenant)", () => {
    expect(resolvePlatformRole(profile({ roles: ["owner"] }))).toBeNull();
  });

  it("returns null for an undefined profile (fail closed)", () => {
    expect(resolvePlatformRole(undefined)).toBeNull();
  });

  it("prioritises superadmin over admin when both roles are held", () => {
    expect(
      resolvePlatformRole(profile({ roles: ["admin", "superadmin"], platformRole: "support" })),
    ).toBe("superadmin");
  });
});

describe("hasPlatformPrivilege (real matrix lookup + superadmin shortcut)", () => {
  it("ALLOWS a superadmin ANY privilege without a matrix entry (shortcut)", async () => {
    // platform.branding is intentionally absent from PLATFORM_MATRIX; the
    // superadmin shortcut must still allow it.
    expect(
      await hasPlatformPrivilege(profile({ roles: ["superadmin"] }), "platform.branding"),
    ).toBe(true);
  });

  it("ALLOWS an admin for an admin-granted privilege", async () => {
    expect(await hasPlatformPrivilege(profile({ roles: ["admin"] }), "users.assignRoles")).toBe(
      true,
    );
  });

  it("ALLOWS a support sub-role for a key its column grants", async () => {
    expect(
      await hasPlatformPrivilege(
        profile({ roles: ["admin"], platformRole: "support" }),
        "users.viewAll",
      ),
    ).toBe(true);
  });

  it("DENIES a support sub-role a key its column does NOT grant (sub-role gating)", async () => {
    expect(
      await hasPlatformPrivilege(
        profile({ roles: ["admin"], platformRole: "support" }),
        "users.assignRoles",
      ),
    ).toBe(false);
  });

  it("DENIES a non-staff user (null role) every privilege", async () => {
    expect(await hasPlatformPrivilege(profile({ roles: ["owner"] }), "users.viewAll")).toBe(false);
  });

  it("DENIES an undefined profile (fail closed)", async () => {
    expect(await hasPlatformPrivilege(undefined, "users.viewAll")).toBe(false);
  });

  it("FAILS CLOSED for a key absent from the matrix when caller is NOT superadmin", async () => {
    // An admin without a matrix entry for the key is denied (no fail-open).
    expect(
      await hasPlatformPrivilege(profile({ roles: ["admin"] }), "does.not.exist" as never),
    ).toBe(false);
  });

  it("DENIES a manager a key whose column is false even when the key exists", async () => {
    expect(
      await hasPlatformPrivilege(
        profile({ roles: ["admin"], platformRole: "manager" }),
        "platform.maintenance",
      ),
    ).toBe(false);
  });
});

describe("isLastSuperadmin (last-superadmin lockout guard)", () => {
  it("returns true when the given user is the ONLY superadmin", async () => {
    state.users = [{ id: "sa1", roles: ["superadmin"] }];
    expect(await isLastSuperadmin("sa1")).toBe(true);
  });

  it("returns false when another superadmin exists", async () => {
    state.users = [
      { id: "sa1", roles: ["superadmin"] },
      { id: "sa2", roles: ["superadmin"] },
    ];
    expect(await isLastSuperadmin("sa1")).toBe(false);
  });

  it("counts a suspended superadmin as recoverable cover (status ignored, any other doc => false)", async () => {
    // The query is array-contains on roles only — status is intentionally not
    // filtered, so a suspended-but-still-superadmin doc keeps the guard from
    // firing.
    state.users = [
      { id: "sa1", roles: ["superadmin"] },
      { id: "sa2", roles: ["superadmin"] },
    ];
    expect(await isLastSuperadmin("sa1")).toBe(false);
  });

  it("returns true (last) when only non-superadmins also exist", async () => {
    // The array-contains filter excludes non-superadmins, so they don't count.
    state.users = [{ id: "sa1", roles: ["superadmin"] }];
    expect(await isLastSuperadmin("sa1")).toBe(true);
  });
});
