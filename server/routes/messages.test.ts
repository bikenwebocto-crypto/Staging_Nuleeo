// Behavior tests for the conversation-list endpoint —
// GET /api/messages/conversations (server/routes/messages.ts).
//
// The list is the heart of the "one chat per counterpart" contract: it
// materializes a conversation doc for every ACTIVE tenancy whose tenant has
// signed up, so owners see one chat per active tenant and tenants one per
// landlord without anyone hunting for a start button. These tests pin:
//   • materialization for the owner side (active + signed-up only — no doc
//     for pending tenancies or un-accepted invites, none for self-rentals);
//   • materialization for the tenant side, incl. multiple landlords;
//   • one thread per (owner, tenantUser) pair even across several units,
//     stamped with the most recent tenancyId;
//   • idempotency — re-fetching creates nothing new;
//   • permanence — an existing thread keeps its history untouched (an
//     active tenancy must NOT reset it to empty) and a thread whose tenancy
//     ended still shows up;
//   • ordering — threads with messages first by recency, then empty
//     materialized threads A→Z.
//
// Mocking strategy mirrors tenant.respond.test.ts: an in-memory Firestore
// double plus thin doubles for auth/push/rate-limit, so the route logic is
// exercised in isolation.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mutable test state ─────────────────────────────────────────────────
interface TestUser {
  uid: string;
  email?: string;
  profile?: Record<string, unknown>;
}
let currentUser: TestUser = { uid: "owner-1", email: "o@example.com" };

type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {
  conversations: new Map(),
  tenants: new Map(),
  users: new Map(),
};

// Doc ids whose create() should fail with a transient (non-ALREADY_EXISTS)
// error — lets tests pin that a failed write never surfaces a phantom row.
const failCreates = new Set<string>();

beforeEach(() => {
  currentUser = { uid: "owner-1", email: "o@example.com" };
  for (const m of Object.values(store)) m.clear();
  failCreates.clear();
});

// ── Firestore double ───────────────────────────────────────────────────

function snapFor(col: string, id: string) {
  const data = store[col].get(id);
  return { exists: !!data, id, data: () => data };
}

function makeRef(col: string, id: string) {
  return {
    _col: col,
    _id: id,
    id,
    async get() {
      return snapFor(col, id);
    },
    async set(data: Row, opts?: { merge?: boolean }) {
      if (opts?.merge) {
        store[col].set(id, { ...(store[col].get(id) ?? {}), ...data });
      } else {
        store[col].set(id, data);
      }
    },
    // Firestore semantics: create() rejects when the doc already exists.
    // The list endpoint leans on this to never clobber an existing thread.
    // Error shape mirrors the real GoogleError (gRPC code 6 + message).
    async create(data: Row) {
      if (failCreates.has(id)) {
        throw Object.assign(new Error("14 UNAVAILABLE: The service is unavailable"), {
          code: 14,
        });
      }
      if (store[col].has(id)) {
        throw Object.assign(new Error(`6 ALREADY_EXISTS: Document already exists: ${id}`), {
          code: 6,
        });
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
        size: rows.length,
        docs: rows.map((r) => ({
          id: r.id,
          ref: makeRef(col, r.id),
          exists: true,
          data: () => r.data,
        })),
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
  async getAll(...refs: Array<{ _col: string; _id: string }>) {
    return refs.map((r) => snapFor(r._col, r._id));
  },
};

// ── Module mocks ───────────────────────────────────────────────────────

vi.mock("../firebase", () => ({ db: () => fakeDb }));

vi.mock("../auth", () => ({
  requireAuth: (req: { user?: TestUser }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
}));

vi.mock("../services/push", () => ({
  notifyUser: async () => undefined,
}));

vi.mock("../services/rateLimit", () => ({
  checkAndIncrement: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

import { registerMessageRoutes } from "./messages";

// ── Seed helpers ───────────────────────────────────────────────────────

function seedUser(id: string, firstName: string, lastName: string) {
  store.users.set(id, { id, firstName, lastName, email: `${id}@example.com` });
}

function seedTenancy(
  id: string,
  t: {
    ownerId: string;
    userId?: string;
    status?: string;
    propertyId?: string;
    createdAt?: string;
  },
) {
  store.tenants.set(id, {
    id,
    name: `${id}@invite.example.com`,
    email: `${id}@invite.example.com`,
    unitId: t.propertyId ?? "prop-1",
    propertyId: t.propertyId ?? "prop-1",
    ownerId: t.ownerId,
    userId: t.userId,
    rentAmount: 1000,
    status: t.status ?? "active",
    createdAt: t.createdAt ?? "2026-01-01T00:00:00.000Z",
  });
}

function seedConversation(ownerId: string, tenantUserId: string, extra: Partial<Row> = {}) {
  const id = `${ownerId}_${tenantUserId}`;
  store.conversations.set(id, {
    id,
    ownerId,
    tenantUserId,
    tenancyId: "ten-old",
    propertyId: "prop-1",
    lastMessageText: "",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    lastMessageSenderId: "",
    unreadByOwner: 0,
    unreadByTenant: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  registerMessageRoutes(app);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("GET /api/messages/conversations — thread materialization", () => {
  it("owner gets one chat per active signed-up tenant; pending/un-signed-up/self skipped", async () => {
    seedUser("u-alice", "Alice", "Anders");
    seedUser("u-bob", "Bob", "Brown");
    seedUser("u-carol", "Carol", "Clark");
    seedTenancy("ten-1", { ownerId: "owner-1", userId: "u-alice" });
    seedTenancy("ten-2", { ownerId: "owner-1", userId: "u-bob" });
    seedTenancy("ten-3", { ownerId: "owner-1" }); // invite not accepted
    seedTenancy("ten-4", { ownerId: "owner-1", userId: "u-carol", status: "pending" });
    seedTenancy("ten-5", { ownerId: "owner-1", userId: "owner-1" }); // self-rental

    const res = await request(makeApp()).get("/api/messages/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const names = res.body.map((c: Row) => c.counterpartName).sort();
    expect(names).toEqual(["Alice Anders", "Bob Brown"]);
    expect(store.conversations.has("owner-1_u-alice")).toBe(true);
    expect(store.conversations.has("owner-1_u-bob")).toBe(true);
    expect(store.conversations.size).toBe(2);
    for (const c of res.body) {
      expect(c.unread).toBe(0);
      expect(c.lastMessageText).toBe("");
    }
  });

  it("re-fetching is idempotent — no duplicate rows or docs", async () => {
    seedUser("u-alice", "Alice", "Anders");
    seedTenancy("ten-1", { ownerId: "owner-1", userId: "u-alice" });

    const app = makeApp();
    const first = await request(app).get("/api/messages/conversations");
    const second = await request(app).get("/api/messages/conversations");
    expect(first.body).toHaveLength(1);
    expect(second.body).toHaveLength(1);
    expect(store.conversations.size).toBe(1);
  });

  it("tenant gets one chat per landlord, including multiple landlords", async () => {
    currentUser = { uid: "u-tess", email: "t@example.com" };
    seedUser("owner-1", "Olive", "Owner");
    seedUser("owner-2", "Oscar", "Other");
    seedTenancy("ten-1", { ownerId: "owner-1", userId: "u-tess" });
    seedTenancy("ten-2", { ownerId: "owner-2", userId: "u-tess" });

    const res = await request(makeApp()).get("/api/messages/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const names = res.body.map((c: Row) => c.counterpartName).sort();
    expect(names).toEqual(["Olive Owner", "Oscar Other"]);
    expect(store.conversations.has("owner-1_u-tess")).toBe(true);
    expect(store.conversations.has("owner-2_u-tess")).toBe(true);
  });

  it("two units rented from the same owner collapse into one thread stamped with the newest tenancy", async () => {
    seedUser("u-alice", "Alice", "Anders");
    seedTenancy("ten-old", {
      ownerId: "owner-1",
      userId: "u-alice",
      propertyId: "prop-a",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    seedTenancy("ten-new", {
      ownerId: "owner-1",
      userId: "u-alice",
      propertyId: "prop-b",
      createdAt: "2026-05-01T00:00:00.000Z",
    });

    const res = await request(makeApp()).get("/api/messages/conversations");
    expect(res.body).toHaveLength(1);
    expect(res.body[0].tenancyId).toBe("ten-new");
    expect(res.body[0].propertyId).toBe("prop-b");
  });

  it("an existing thread with history is never reset by an active tenancy", async () => {
    seedUser("u-alice", "Alice", "Anders");
    seedTenancy("ten-1", { ownerId: "owner-1", userId: "u-alice" });
    seedConversation("owner-1", "u-alice", {
      lastMessageText: "see you Tuesday",
      lastMessageAt: "2026-06-01T10:00:00.000Z",
      lastMessageSenderId: "u-alice",
      unreadByOwner: 3,
    });

    const res = await request(makeApp()).get("/api/messages/conversations");
    expect(res.body).toHaveLength(1);
    expect(res.body[0].lastMessageText).toBe("see you Tuesday");
    expect(res.body[0].unread).toBe(3);
    expect(store.conversations.get("owner-1_u-alice")!.lastMessageText).toBe("see you Tuesday");
  });

  it("a thread whose tenancy ended still shows (history is permanent)", async () => {
    seedUser("u-gone", "Gina", "Gone");
    seedTenancy("ten-ended", { ownerId: "owner-1", userId: "u-gone", status: "expired" });
    seedConversation("owner-1", "u-gone", {
      lastMessageText: "thanks for everything",
      lastMessageAt: "2025-12-01T10:00:00.000Z",
      lastMessageSenderId: "owner-1",
    });

    const res = await request(makeApp()).get("/api/messages/conversations");
    expect(res.body).toHaveLength(1);
    expect(res.body[0].counterpartName).toBe("Gina Gone");
    expect(res.body[0].lastMessageText).toBe("thanks for everything");
  });

  it("orders live threads by recency, then empty materialized threads A→Z", async () => {
    seedUser("u-old", "Olga", "Older");
    seedUser("u-new", "Nina", "Newer");
    seedUser("u-zoe", "Zoe", "Zed");
    seedUser("u-adam", "Adam", "Abbot");
    // Two live threads: Nina's activity is more recent than Olga's, so she
    // must come first even though Olga sorts earlier alphabetically.
    seedConversation("owner-1", "u-old", {
      lastMessageText: "hi",
      lastMessageAt: "2026-06-01T10:00:00.000Z",
      lastMessageSenderId: "u-old",
    });
    seedConversation("owner-1", "u-new", {
      lastMessageText: "hello",
      lastMessageAt: "2026-06-05T10:00:00.000Z",
      lastMessageSenderId: "owner-1",
    });
    seedTenancy("ten-z", { ownerId: "owner-1", userId: "u-zoe" });
    seedTenancy("ten-a", { ownerId: "owner-1", userId: "u-adam" });

    const res = await request(makeApp()).get("/api/messages/conversations");
    expect(res.body.map((c: Row) => c.counterpartName)).toEqual([
      "Nina Newer",
      "Olga Older",
      "Adam Abbot",
      "Zoe Zed",
    ]);
  });

  it("a thread created in the query→create race window is preserved, not clobbered (create, not set)", async () => {
    // Simulate the race: the doc exists at the deterministic id (the
    // counterpart's poll won) but wasn't returned by the caller's
    // conversation queries — the field doesn't match, standing in for a
    // snapshot taken before the doc landed. The materializer must hit
    // ALREADY_EXISTS and leave the doc untouched; a set() would wipe it.
    seedUser("u-alice", "Alice", "Anders");
    seedTenancy("ten-1", { ownerId: "owner-1", userId: "u-alice" });
    store.conversations.set("owner-1_u-alice", {
      id: "owner-1_u-alice",
      ownerId: "someone-else", // hides it from the caller's queries
      tenantUserId: "u-alice",
      lastMessageText: "first message already sent",
      lastMessageAt: "2026-06-10T10:00:00.000Z",
      lastMessageSenderId: "u-alice",
      unreadByOwner: 1,
      unreadByTenant: 0,
    });

    const res = await request(makeApp()).get("/api/messages/conversations");
    expect(res.status).toBe(200);
    expect(store.conversations.get("owner-1_u-alice")!.lastMessageText).toBe(
      "first message already sent",
    );
    expect(store.conversations.get("owner-1_u-alice")!.unreadByOwner).toBe(1);
  });

  it("a create that fails transiently yields no phantom row", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      seedUser("u-alice", "Alice", "Anders");
      seedTenancy("ten-1", { ownerId: "owner-1", userId: "u-alice" });
      failCreates.add("owner-1_u-alice");

      const res = await request(makeApp()).get("/api/messages/conversations");
      expect(res.status).toBe(200);
      // The doc was never written, so listing it would 404 on open/send.
      expect(res.body).toEqual([]);
      expect(store.conversations.size).toBe(0);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a caller who is both owner and tenant gets both threads with per-row counterpart and unread", async () => {
    currentUser = { uid: "u-dual", email: "d@example.com" };
    seedUser("u-alice", "Alice", "Anders"); // rents FROM the caller
    seedUser("owner-2", "Oscar", "Other"); // rents TO the caller
    seedTenancy("ten-out", { ownerId: "u-dual", userId: "u-alice" });
    seedTenancy("ten-in", { ownerId: "owner-2", userId: "u-dual" });
    seedConversation("u-dual", "u-alice", {
      lastMessageText: "rent due",
      lastMessageAt: "2026-06-01T10:00:00.000Z",
      lastMessageSenderId: "u-alice",
      unreadByOwner: 7,
      unreadByTenant: 0,
    });
    seedConversation("owner-2", "u-dual", {
      lastMessageText: "boiler fixed",
      lastMessageAt: "2026-06-02T10:00:00.000Z",
      lastMessageSenderId: "owner-2",
      unreadByOwner: 0,
      unreadByTenant: 3,
    });

    const res = await request(makeApp()).get("/api/messages/conversations");
    expect(res.body).toHaveLength(2);
    const byName = Object.fromEntries(res.body.map((c: Row) => [c.counterpartName, c]));
    // Caller is the OWNER of the Alice thread → their unread is unreadByOwner.
    expect(byName["Alice Anders"].unread).toBe(7);
    expect(byName["Alice Anders"].counterpartUserId).toBe("u-alice");
    // Caller is the TENANT of the Oscar thread → their unread is unreadByTenant.
    expect(byName["Oscar Other"].unread).toBe(3);
    expect(byName["Oscar Other"].counterpartUserId).toBe("owner-2");
  });

  it("counterpart name falls back to email, then to 'Unknown'", async () => {
    // No first/last name on file → email shows. No User doc at all (account
    // deleted under an old thread) → "Unknown".
    store.users.set("u-noname", { id: "u-noname", email: "noname@example.com" });
    seedTenancy("ten-1", { ownerId: "owner-1", userId: "u-noname" });
    seedConversation("owner-1", "u-ghost", {
      lastMessageText: "old chat",
      lastMessageAt: "2026-01-02T10:00:00.000Z",
      lastMessageSenderId: "u-ghost",
    });

    const res = await request(makeApp()).get("/api/messages/conversations");
    const names = res.body.map((c: Row) => c.counterpartName).sort();
    expect(names).toEqual(["Unknown", "noname@example.com"]);
  });

  it("tenant side materializes nothing for non-active tenancies", async () => {
    currentUser = { uid: "u-tess", email: "t@example.com" };
    seedUser("owner-1", "Olive", "Owner");
    seedUser("owner-2", "Oscar", "Other");
    seedTenancy("ten-1", { ownerId: "owner-1", userId: "u-tess", status: "expired" });
    seedTenancy("ten-2", { ownerId: "owner-2", userId: "u-tess", status: "declined" });

    const res = await request(makeApp()).get("/api/messages/conversations");
    expect(res.body).toEqual([]);
    expect(store.conversations.size).toBe(0);
  });

  it("a malformed tenancy is skipped without taking down the list", async () => {
    seedUser("u-alice", "Alice", "Anders");
    seedUser("u-bob", "Bob", "Brown");
    seedTenancy("ten-ok", { ownerId: "owner-1", userId: "u-alice" });
    // Legacy row drift: active but missing propertyId — undefined fields
    // would make the SDK reject the create.
    store.tenants.set("ten-bad", {
      id: "ten-bad",
      ownerId: "owner-1",
      userId: "u-bob",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await request(makeApp()).get("/api/messages/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].counterpartName).toBe("Alice Anders");
  });
});
