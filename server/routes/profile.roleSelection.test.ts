// Behavior tests for the one-time post-signup role prompt flag.
//
// /api/me arms `needsRoleSelection: true` ONLY when it creates a brand-new
// user doc — accounts that existed before the field shipped never get it, so
// they never see the modal. PATCH /api/profile may clear the flag (any answer
// or dismissal) but can never re-arm it.
//
// Mocking strategy mirrors tickets.resolve.test.ts: an in-memory Firestore
// double plus thin doubles for auth, rate limiting and the push service.

import express from "express";
import request from "supertest";
import { TERMS_VERSION } from "../../shared/firestore-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TestUser {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
  profile?: Record<string, unknown>;
}
let currentUser: TestUser = { uid: "new-uid", email: "new@example.com" };

type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {
  users: new Map(),
  // First-ever /api/me auto-links pending tenancy invites by email.
  tenants: new Map(),
};

let staffNotifications: Array<Record<string, unknown>> = [];

beforeEach(() => {
  currentUser = { uid: "new-uid", email: "new@example.com" };
  for (const m of Object.values(store)) m.clear();
  staffNotifications = [];
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
    // Mirrors Firestore's atomic create(): rejects with ALREADY_EXISTS
    // (gRPC code 6) when the doc is present.
    async create(data: Row) {
      if (store[col].has(id)) {
        const err = new Error("6 ALREADY_EXISTS: Document already exists") as Error & {
          code: number;
        };
        err.code = 6;
        throw err;
      }
      store[col].set(id, data);
    },
  };
}

function makeQuery(col: string) {
  const filters: Array<{ field: string; value: unknown }> = [];
  const q = {
    where(field: string, op: string, value: unknown) {
      if (op !== "==") throw new Error(`unsupported op ${op}`);
      filters.push({ field, value });
      return q;
    },
    async get() {
      let rows = Array.from(store[col].entries()).map(([id, data]) => ({ id, data }));
      for (const f of filters) rows = rows.filter((r) => r.data[f.field] === f.value);
      return {
        empty: rows.length === 0,
        docs: rows.map((r) => ({ id: r.id, exists: true, data: () => r.data })),
      };
    },
  };
  return q;
}

const fakeDb = {
  collection(name: string) {
    return {
      doc(id?: string) {
        return makeRef(name, id ?? `auto_${store[name].size}`);
      },
      where(field: string, op: string, value: unknown) {
        return makeQuery(name).where(field, op, value);
      },
    };
  },
  batch() {
    return {
      update(ref: { set: (d: Row, o?: { merge?: boolean }) => Promise<void> }, data: Row) {
        void ref.set(data, { merge: true });
      },
      async commit() {},
    };
  },
};

vi.mock("../firebase", () => ({
  db: () => fakeDb,
  auth: () => ({}),
  bucket: () => ({}),
  storageBucketName: "test-bucket",
}));

vi.mock("../auth", () => ({
  requireAuth: (req: { user?: TestUser }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
}));

vi.mock("../services/rateLimit", () => ({
  checkAndIncrement: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("../services/push", () => ({
  notifyStaff: async (input: Record<string, unknown>) => {
    staffNotifications.push(input);
  },
}));

vi.mock("../services/mirrorRemotePhoto", () => ({
  mirrorRemotePhotoToStorage: async () => null,
}));

vi.mock("../services/portfolioBanking", () => ({
  loadPortfolioBanking: async () => ({}),
}));

vi.mock("../services/userDelete", () => ({
  deleteUserCascade: async () => ({}),
  findHardDeleteBlockers: async () => [],
  hardDeleteBlockerMessage: () => "",
}));

import { registerProfileRoutes } from "./profile";

function makeApp() {
  const app = express();
  app.use(express.json());
  registerProfileRoutes(app);
  return app;
}

describe("post-signup role prompt flag", () => {
  it("arms needsRoleSelection when /api/me creates a brand-new user", async () => {
    const res = await request(makeApp()).get("/api/me");

    expect(res.status).toBe(200);
    expect(res.body.needsRoleSelection).toBe(true);
    expect(res.body.ownerModeEnabled).toBe(false);
    expect(res.body.roles).toEqual(["tenant"]);
    expect(store.users.get("new-uid")?.needsRoleSelection).toBe(true);
    expect(staffNotifications).toHaveLength(1);
  });

  it("records proof-of-consent (terms version + timestamp) on signup", async () => {
    const res = await request(makeApp()).get("/api/me");
    expect(res.status).toBe(200);
    expect(res.body.consent).toMatchObject({ termsVersion: TERMS_VERSION, source: "signup" });
    expect(Number.isNaN(Date.parse(res.body.consent.acceptedAt))).toBe(false);
    // Persisted on the doc, not just echoed in the response.
    expect(store.users.get("new-uid")?.consent?.termsVersion).toBe(TERMS_VERSION);
  });

  it("returns the winner's doc when two first sign-in calls race (no overwrite)", async () => {
    // Simulate the signup race: another /api/me already created the doc, but
    // THIS request's auth middleware read happened before that write landed,
    // so req.user.profile is still undefined.
    const winner = {
      id: "new-uid",
      email: "new@example.com",
      roles: ["tenant"],
      ownerModeEnabled: false,
      needsRoleSelection: true,
      portfolioId: "OLIO-WINNER1",
      status: "active",
      joinedAt: "2026-06-10T00:00:00.000Z",
    };
    store.users.set("new-uid", winner);

    const res = await request(makeApp()).get("/api/me");

    expect(res.status).toBe(200);
    // The loser must return what the winner wrote — same portfolioId, no
    // re-rolled doc — and must not fire a second staff notification.
    expect(res.body.portfolioId).toBe("OLIO-WINNER1");
    expect(store.users.get("new-uid")?.portfolioId).toBe("OLIO-WINNER1");
    expect(staffNotifications).toHaveLength(0);
  });

  it("records fresh proof-of-consent at the current version on re-accept", async () => {
    const existing = {
      id: "u-stale",
      email: "s@example.com",
      roles: ["tenant"],
      status: "active",
      joinedAt: "2025-01-01T00:00:00.000Z",
      consent: {
        termsVersion: "2020-01-01",
        acceptedAt: "2020-01-01T00:00:00.000Z",
        source: "signup",
      },
    };
    store.users.set("u-stale", existing);
    currentUser = { uid: "u-stale", email: "s@example.com", profile: existing };

    const res = await request(makeApp()).post("/api/me/accept-terms");

    expect(res.status).toBe(200);
    expect(res.body.consent.termsVersion).toBe(TERMS_VERSION);
    expect(res.body.consent.source).toBe("reconsent");
    const stored = store.users.get("u-stale");
    expect(stored?.consent?.termsVersion).toBe(TERMS_VERSION);
    expect(stored?.email).toBe("s@example.com"); // merge preserved other fields
  });

  it("404s re-accept when the profile doesn't exist", async () => {
    currentUser = { uid: "ghost", email: "g@example.com" };
    const res = await request(makeApp()).post("/api/me/accept-terms");
    expect(res.status).toBe(404);
  });

  it("does NOT arm the flag for pre-existing users", async () => {
    const existing = {
      id: "old-uid",
      email: "old@example.com",
      roles: ["tenant"],
      portfolioId: "OLIO-OLD001",
      status: "active",
      joinedAt: "2025-01-01T00:00:00.000Z",
    };
    store.users.set("old-uid", existing);
    currentUser = { uid: "old-uid", email: "old@example.com", profile: existing };

    const res = await request(makeApp()).get("/api/me");

    expect(res.status).toBe(200);
    expect(res.body.needsRoleSelection).toBeUndefined();
    expect(store.users.get("old-uid")?.needsRoleSelection).toBeUndefined();
  });

  it("promotes an admin-invited account to active on first sign-in", async () => {
    // The admin invite flow pre-creates the doc as status:"invited". The first
    // authenticated /api/me IS that sign-in, so it must flip to "active" —
    // otherwise the staffer stays excluded from notifyStaff (active-only) and
    // shows as a pending invite in the admin UI forever.
    const invited = {
      id: "staff-uid",
      email: "staff@example.com",
      firstName: "Sam",
      lastName: "Staff",
      roles: ["admin"],
      status: "invited",
      joinedAt: "2026-07-01T00:00:00.000Z",
    };
    store.users.set("staff-uid", invited);
    currentUser = { uid: "staff-uid", email: "staff@example.com", profile: invited };

    const res = await request(makeApp()).get("/api/me");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(store.users.get("staff-uid")?.status).toBe("active");
    // Not a fresh signup: no second staff notification, no role prompt armed.
    expect(staffNotifications).toHaveLength(0);
    expect(res.body.needsRoleSelection).toBeUndefined();
  });

  it("does NOT resurrect a suspended account on sign-in", async () => {
    // Promotion is scoped strictly to "invited"; a signed-in but suspended
    // account must stay suspended.
    const suspended = {
      id: "susp-uid",
      email: "susp@example.com",
      roles: ["tenant"],
      portfolioId: "OLIO-SUSP01",
      status: "suspended",
      joinedAt: "2025-01-01T00:00:00.000Z",
    };
    store.users.set("susp-uid", suspended);
    currentUser = { uid: "susp-uid", email: "susp@example.com", profile: suspended };

    const res = await request(makeApp()).get("/api/me");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("suspended");
    expect(store.users.get("susp-uid")?.status).toBe("suspended");
  });

  it("PATCH clears the flag (tenant / dismiss answer)", async () => {
    store.users.set("new-uid", { id: "new-uid", needsRoleSelection: true });

    const res = await request(makeApp()).patch("/api/profile").send({ needsRoleSelection: false });

    expect(res.status).toBe(200);
    expect(res.body.needsRoleSelection).toBe(false);
    expect(store.users.get("new-uid")?.needsRoleSelection).toBe(false);
  });

  it("PATCH clears the flag and enables owner mode together (owner answer)", async () => {
    store.users.set("new-uid", {
      id: "new-uid",
      needsRoleSelection: true,
      ownerModeEnabled: false,
    });

    const res = await request(makeApp())
      .patch("/api/profile")
      .send({ ownerModeEnabled: true, needsRoleSelection: false });

    expect(res.status).toBe(200);
    expect(store.users.get("new-uid")).toMatchObject({
      ownerModeEnabled: true,
      needsRoleSelection: false,
    });
  });

  it("PATCH cannot re-arm the prompt", async () => {
    store.users.set("new-uid", { id: "new-uid", needsRoleSelection: false });

    const res = await request(makeApp()).patch("/api/profile").send({ needsRoleSelection: true });

    // The only field in the body is rejected, so the request has nothing
    // updatable left.
    expect(res.status).toBe(400);
    expect(store.users.get("new-uid")?.needsRoleSelection).toBe(false);
  });
});
