import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the firebase module before importing the SUT. The mock returns a
// snapshot built from a per-test users array — tests set `__USERS__` to drive
// what `db().collection('users').get()` yields.
const state: { users: Array<Record<string, unknown>> } = { users: [] };

vi.mock("../firebase", () => ({
  db: () => ({
    collection: (_name: string) => ({
      get: async () => ({
        docs: state.users.map((u) => ({ data: () => u })),
      }),
    }),
  }),
}));

// Import AFTER the mock so the SUT picks up the stubbed `db`.
import { parseMarketingFilter, resolvePushAudience } from "./audiences";

function user(
  overrides: Partial<{
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    roles: string[];
    status: string;
  }>,
) {
  return {
    id: overrides.id ?? "u_" + Math.random().toString(36).slice(2, 8),
    email: overrides.email ?? "u@example.com",
    firstName: overrides.firstName ?? "",
    lastName: overrides.lastName ?? "",
    roles: overrides.roles ?? ["owner"],
    status: overrides.status ?? "active",
  };
}

beforeEach(() => {
  state.users = [];
});

describe("resolvePushAudience", () => {
  it("hard-excludes admin / superadmin / employee accounts even with role='all'", async () => {
    state.users = [
      user({ id: "a1", email: "a@x.com", roles: ["admin"] }),
      user({ id: "s1", email: "s@x.com", roles: ["superadmin"] }),
      user({ id: "e1", email: "e@x.com", roles: ["employee"] }),
      user({ id: "o1", email: "o@x.com", roles: ["owner"] }),
      user({ id: "t1", email: "t@x.com", roles: ["tenant"] }),
    ];
    const out = await resolvePushAudience({ role: "all", status: "any" });
    const ids = out.map((u) => u.userId).sort();
    expect(ids).toEqual(["o1", "t1"]);
  });

  it("does not exclude owner-with-admin-also accounts (they still count as owner)", async () => {
    // Real-world: a superadmin can also be granted owner role. The push
    // surface should reach them via the owner role — this matches the email
    // surface's behavior. (Hard exclusion only applies to users with NO
    // owner/tenant role at all.)
    state.users = [user({ id: "dual", email: "x@x.com", roles: ["owner", "superadmin"] })];
    const out = await resolvePushAudience({ role: "all", status: "any" });
    expect(out.map((u) => u.userId)).toEqual(["dual"]);
  });

  it("filters to owners only when role='owners'", async () => {
    state.users = [
      user({ id: "o1", email: "o@x.com", roles: ["owner"] }),
      user({ id: "t1", email: "t@x.com", roles: ["tenant"] }),
      user({ id: "ot1", email: "ot@x.com", roles: ["owner", "tenant"] }),
    ];
    const out = await resolvePushAudience({ role: "owners", status: "any" });
    const ids = out.map((u) => u.userId).sort();
    expect(ids).toEqual(["o1", "ot1"]);
  });

  it("filters to tenants only when role='tenants'", async () => {
    state.users = [
      user({ id: "o1", email: "o@x.com", roles: ["owner"] }),
      user({ id: "t1", email: "t@x.com", roles: ["tenant"] }),
      user({ id: "ot1", email: "ot@x.com", roles: ["owner", "tenant"] }),
    ];
    const out = await resolvePushAudience({ role: "tenants", status: "any" });
    const ids = out.map((u) => u.userId).sort();
    expect(ids).toEqual(["ot1", "t1"]);
  });

  it("respects status filter (only active)", async () => {
    state.users = [
      user({ id: "a", email: "a@x.com", roles: ["owner"], status: "active" }),
      user({ id: "s", email: "s@x.com", roles: ["owner"], status: "suspended" }),
      user({ id: "i", email: "i@x.com", roles: ["owner"], status: "invited" }),
    ];
    const out = await resolvePushAudience({ role: "owners", status: "active" });
    expect(out.map((u) => u.userId)).toEqual(["a"]);
  });

  it("respects status filter (only suspended)", async () => {
    state.users = [
      user({ id: "a", email: "a@x.com", roles: ["owner"], status: "active" }),
      user({ id: "s", email: "s@x.com", roles: ["owner"], status: "suspended" }),
    ];
    const out = await resolvePushAudience({ role: "owners", status: "suspended" });
    expect(out.map((u) => u.userId)).toEqual(["s"]);
  });

  it("status='any' returns every status", async () => {
    state.users = [
      user({ id: "a", email: "a@x.com", roles: ["owner"], status: "active" }),
      user({ id: "s", email: "s@x.com", roles: ["owner"], status: "suspended" }),
      user({ id: "i", email: "i@x.com", roles: ["owner"], status: "invited" }),
      user({ id: "p", email: "p@x.com", roles: ["owner"], status: "pending" }),
    ];
    const out = await resolvePushAudience({ role: "owners", status: "any" });
    expect(out.map((u) => u.userId).sort()).toEqual(["a", "i", "p", "s"]);
  });

  it("emailContains substring is case-insensitive", async () => {
    state.users = [
      user({ id: "g1", email: "alice@Gmail.com", roles: ["owner"] }),
      user({ id: "y1", email: "bob@yahoo.com", roles: ["owner"] }),
      user({ id: "g2", email: "carol@gmail.com", roles: ["tenant"] }),
    ];
    const out = await resolvePushAudience({
      role: "all",
      status: "any",
      emailContains: "GMAIL.COM",
    });
    const ids = out.map((u) => u.userId).sort();
    expect(ids).toEqual(["g1", "g2"]);
  });

  it("emailContains is ignored when empty/whitespace", async () => {
    state.users = [user({ id: "o1", email: "a@x.com", roles: ["owner"] })];
    const out = await resolvePushAudience({
      role: "owners",
      status: "any",
      emailContains: "   ",
    });
    // Implementation only treats `emailContains` as set when truthy after
    // trim — but the SUT itself does NOT trim here, so verify it doesn't
    // silently match nothing on whitespace input.
    expect(out.map((u) => u.userId)).toEqual(["o1"]);
  });

  it("skips users with no email even if role/status match", async () => {
    state.users = [
      { ...user({ id: "no_email", roles: ["owner"] }), email: "" },
      user({ id: "ok", email: "ok@x.com", roles: ["owner"] }),
    ];
    const out = await resolvePushAudience({ role: "owners", status: "any" });
    expect(out.map((u) => u.userId)).toEqual(["ok"]);
  });

  it("returns first/last name fields on each recipient", async () => {
    state.users = [
      user({
        id: "o1",
        email: "alice@x.com",
        firstName: "Alice",
        lastName: "Wonderland",
        roles: ["owner"],
      }),
    ];
    const [r] = await resolvePushAudience({ role: "owners", status: "any" });
    expect(r).toEqual({
      userId: "o1",
      email: "alice@x.com",
      firstName: "Alice",
      lastName: "Wonderland",
    });
  });

  it("does not double-count a user that matches twice (owner+tenant, role='all')", async () => {
    state.users = [user({ id: "dual", email: "d@x.com", roles: ["owner", "tenant"] })];
    const out = await resolvePushAudience({ role: "all", status: "any" });
    expect(out).toHaveLength(1);
    expect(out[0].userId).toBe("dual");
  });

  it("returns an empty array when nothing matches the filter", async () => {
    state.users = [user({ id: "o1", email: "o@x.com", roles: ["owner"], status: "active" })];
    const out = await resolvePushAudience({
      role: "tenants",
      status: "any",
    });
    expect(out).toEqual([]);
  });

  it("excludes users who opted out of marketing push (marketingPush === false)", async () => {
    state.users = [
      { ...user({ id: "in", email: "in@x.com", roles: ["owner"] }) },
      {
        ...user({ id: "optout", email: "out@x.com", roles: ["owner"] }),
        notificationPrefs: { marketingPush: false },
      },
      {
        ...user({ id: "pushoff", email: "po@x.com", roles: ["owner"] }),
        notificationPrefs: { pushEnabled: false },
      },
      {
        // master push on, marketing push left default (opted-in) => included
        ...user({ id: "default", email: "def@x.com", roles: ["tenant"] }),
        notificationPrefs: { pushEnabled: true },
      },
    ];
    const out = await resolvePushAudience({ role: "all", status: "any" });
    expect(out.map((u) => u.userId).sort()).toEqual(["default", "in"]);
  });
});

describe("parseMarketingFilter", () => {
  it("accepts a minimal valid filter", () => {
    expect(parseMarketingFilter({ role: "owners", status: "active" })).toEqual({
      role: "owners",
      status: "active",
      emailContains: undefined,
    });
  });

  it("rejects an invalid role / status", () => {
    expect(parseMarketingFilter({ role: "nope", status: "any" })).toHaveProperty("error");
    expect(parseMarketingFilter({ role: "all", status: "nope" })).toHaveProperty("error");
  });

  it("parses owner-stats ranges and plans", () => {
    const out = parseMarketingFilter({
      role: "owners",
      status: "any",
      plans: ["pro", "business"],
      propertiesRange: { min: 1, max: 10 },
    });
    expect(out).toMatchObject({
      role: "owners",
      plans: ["pro", "business"],
      propertiesRange: { min: 1, max: 10 },
    });
  });

  it("rejects a malformed range (min > max) and a bad plan key", () => {
    expect(
      parseMarketingFilter({ role: "owners", status: "any", propertiesRange: { min: 5, max: 1 } }),
    ).toHaveProperty("error");
    expect(parseMarketingFilter({ role: "owners", status: "any", plans: ["gold"] })).toHaveProperty(
      "error",
    );
  });
});
