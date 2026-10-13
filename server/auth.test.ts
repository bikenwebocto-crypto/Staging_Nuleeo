import { describe, it, expect, beforeEach, vi } from "vitest";

// Mocks the Firebase Admin SDK so requireAuth can be exercised in isolation.
// `verifyIdToken` is stubbed to succeed/fail per test; `db()` routes
// collection(name).doc(id).get() into the per-test `users` / `deletedUsers`
// fixtures. `deletedUsersReads` counts tombstone lookups so we can assert the
// guard adds NO read on the common (profile-present) path.
const state: {
  verifyOk: boolean;
  decoded: { uid: string; email?: string; name?: string; picture?: string };
  users: Map<string, Record<string, unknown>>;
  deletedUsers: Set<string>;
  deletedUsersReads: number;
} = {
  verifyOk: true,
  decoded: { uid: "u1", email: "u@example.com" },
  users: new Map(),
  deletedUsers: new Set(),
  deletedUsersReads: 0,
};

function docSnap(data: Record<string, unknown> | undefined) {
  return { exists: data !== undefined, data: () => data };
}

vi.mock("./firebase", () => ({
  auth: () => ({
    verifyIdToken: async (_token: string) => {
      if (!state.verifyOk) throw new Error("invalid token");
      return state.decoded;
    },
  }),
  db: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        async get() {
          if (name === "users") return docSnap(state.users.get(id));
          if (name === "deletedUsers") {
            state.deletedUsersReads += 1;
            return docSnap(
              state.deletedUsers.has(id) ? { deletedAt: "2026-06-17T00:00:00Z" } : undefined,
            );
          }
          return docSnap(undefined);
        },
      }),
    }),
  }),
}));

import { requireAuth } from "./auth";

async function invoke(authorization: string | undefined = "Bearer tok") {
  const req: Record<string, unknown> = { headers: { authorization } };
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  let nexted = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await requireAuth(req as any, res as any, () => {
    nexted = true;
  });
  return { req, res, nexted };
}

beforeEach(() => {
  state.verifyOk = true;
  state.decoded = { uid: "u1", email: "u@example.com" };
  state.users = new Map();
  state.deletedUsers = new Set();
  state.deletedUsersReads = 0;
});

describe("requireAuth", () => {
  it("401s when the Authorization header is missing/non-Bearer", async () => {
    const { res, nexted } = await invoke("");
    expect(res.statusCode).toBe(401);
    expect(nexted).toBe(false);
  });

  it("401s on an invalid or expired token", async () => {
    state.verifyOk = false;
    const { res, nexted } = await invoke();
    expect(res.statusCode).toBe(401);
    expect(nexted).toBe(false);
  });

  it("allows a user with an existing profile and does NOT read the tombstone (no cost on the common path)", async () => {
    state.users.set("u1", { id: "u1", roles: ["tenant"], status: "active" });
    const { req, res, nexted } = await invoke();
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(0);
    expect((req.user as { uid: string }).uid).toBe("u1");
    expect((req.user as { profile?: { status?: string } }).profile?.status).toBe("active");
    expect(state.deletedUsersReads).toBe(0);
  });

  it("403s a suspended user", async () => {
    state.users.set("u1", { id: "u1", roles: ["tenant"], status: "suspended" });
    const { res, nexted } = await invoke();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/suspended/i);
    expect(nexted).toBe(false);
  });

  it("lets a brand-new user (no profile, no tombstone) through to provisioning", async () => {
    const { req, res, nexted } = await invoke();
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(0);
    expect((req.user as { profile?: unknown }).profile).toBeUndefined();
    // Tombstone is checked exactly once when there's no profile.
    expect(state.deletedUsersReads).toBe(1);
  });

  it("403s a hard-deleted user whose token outlived erasure (tombstone present, no profile)", async () => {
    state.deletedUsers.add("u1");
    const { res, nexted } = await invoke();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/deleted/i);
    expect(nexted).toBe(false);
  });
});
