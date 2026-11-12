import { describe, expect, it } from "vitest";
import {
  canOwnWorkspaces,
  defaultWorkspaceName,
  resolveActiveWorkspace,
  sortWorkspaces,
  validateWorkspaceName,
  type WorkspaceListEntry,
} from "./workspaces";

function ws(p: Partial<WorkspaceListEntry> & Pick<WorkspaceListEntry, "id">): WorkspaceListEntry {
  return {
    type: "real_estate",
    name: p.id,
    ownerId: "me",
    ownerName: "Me",
    portfolioDocId: null,
    role: "owner",
    permissions: ["view", "edit"],
    isSelf: true,
    stats: null,
    createdAt: "2026-01-01",
    ...p,
  };
}

const mine = ws({ id: "re_me" });
const biz = ws({ id: "biz_me", type: "business" });
const shared = ws({
  id: "re_other",
  ownerId: "other",
  ownerName: "Ann",
  isSelf: false,
  role: "legal",
});

describe("resolveActiveWorkspace", () => {
  it("honours an explicit business selection", () => {
    expect(resolveActiveWorkspace([mine, biz], "biz_me", "me")).toBe(biz);
  });
  it("real estate follows the active portfolio, not a stale preference", () => {
    expect(resolveActiveWorkspace([mine, shared], "re_me", "other")).toBe(shared);
  });
  it("falls back to the preferred, then the first workspace", () => {
    expect(resolveActiveWorkspace([biz, shared], "re_other", "nobody")).toBe(shared);
    expect(resolveActiveWorkspace([biz], null, "me")).toBe(biz);
    expect(resolveActiveWorkspace([], null, "me")).toBeNull();
  });
});

describe("helpers", () => {
  it("sorts own (real estate first) before shared", () => {
    expect(sortWorkspaces([shared, biz, mine]).map((w) => w.id)).toEqual([
      "re_me",
      "biz_me",
      "re_other",
    ]);
  });
  it("names and validates", () => {
    expect(defaultWorkspaceName("business", "Thanos")).toBe("Thanos Businesses");
    expect(defaultWorkspaceName("real_estate", "  ")).toBe("Real Estate");
    expect(validateWorkspaceName("")).not.toBeNull();
    expect(validateWorkspaceName("x".repeat(61))).not.toBeNull();
    expect(validateWorkspaceName("Ok")).toBeNull();
  });
  it("mirrors the owner-experience rule, only resolving the plan on the legacy path", async () => {
    let calls = 0;
    const plan = async () => {
      calls += 1;
      return "pro" as const;
    };
    expect(await canOwnWorkspaces({ roles: ["owner"], ownerModeEnabled: false }, plan)).toBe(false);
    expect(await canOwnWorkspaces({ roles: ["tenant"], ownerModeEnabled: true }, plan)).toBe(true);
    expect(await canOwnWorkspaces({ roles: ["owner"] }, plan)).toBe(true);
    expect(calls).toBe(0);
    expect(await canOwnWorkspaces({ roles: ["tenant"] }, plan)).toBe(true);
    expect(calls).toBe(1);
    expect(await canOwnWorkspaces(undefined, plan)).toBe(false);
  });
});
