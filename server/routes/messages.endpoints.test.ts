// Behavior tests for the message endpoints the materialization suite
// (messages.test.ts) does NOT cover: start / start-with-landlord, send,
// list-messages (pagination), and mark-read — plus the participant-
// authorization gate (IDOR boundary) that protects all of them.
//
// This needs a richer Firestore double than the list suite: subcollections
// (the `messages` collection under each conversation), batch(), runTransaction()
// (send + read are transactional), FieldValue.increment, FieldPath.documentId(),
// and orderBy/limit/startAfter for pagination. It's path-keyed (one flat map of
// "col/id" / "col/id/sub/id2") so subcollections fall out naturally.

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

// Rate-limit knob — flip to deny to exercise the 429 path. `rateLimitCalls`
// lets tests prove quota is metered only AFTER validation + access (L-3).
let rateLimitAllowed = true;
let rateLimitRetryAfter = 0;
let rateLimitCalls = 0;

// Captured push sends so tests can assert category / deep-link / title.
const pushCalls: Array<Record<string, unknown>> = [];

// Flat path-keyed store: "conversations/abc", "conversations/abc/messages/m1".
const docs = new Map<string, Record<string, unknown>>();
let autoSeq = 0;

// Doc paths whose NEXT get() reports not-exists even though the doc is present —
// used to simulate the start-endpoint create() race (the doc lands in the
// get→create gap), forcing the ALREADY_EXISTS catch branch (M-1).
const hideOnFirstGet = new Set<string>();

beforeEach(() => {
  currentUser = {
    uid: "owner-1",
    email: "o@example.com",
    profile: { firstName: "Olive", lastName: "Owner", email: "o@example.com" },
  };
  rateLimitAllowed = true;
  rateLimitRetryAfter = 0;
  rateLimitCalls = 0;
  pushCalls.length = 0;
  docs.clear();
  hideOnFirstGet.clear();
  autoSeq = 0;
});

// ── FieldValue / FieldPath sentinels ───────────────────────────────────
const INCREMENT = "__increment__";
function isIncrement(v: unknown): v is { [INCREMENT]: number } {
  return !!v && typeof v === "object" && INCREMENT in (v as object);
}

// ── Firestore double ───────────────────────────────────────────────────
function applyMerge(target: Record<string, unknown>, data: Record<string, unknown>) {
  for (const [k, v] of Object.entries(data)) {
    target[k] = isIncrement(v) ? ((target[k] as number) ?? 0) + v[INCREMENT] : v;
  }
}

function snapFor(path: string, id: string) {
  const data = docs.get(path);
  return { exists: !!data, id, data: () => data };
}

function makeRef(path: string) {
  const id = path.split("/").pop()!;
  return {
    _path: path,
    id,
    async get() {
      if (hideOnFirstGet.has(path)) {
        hideOnFirstGet.delete(path);
        return { exists: false, id, data: () => undefined };
      }
      return snapFor(path, id);
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      if (opts?.merge) {
        const cur = docs.get(path) ?? {};
        applyMerge(cur, data);
        docs.set(path, cur);
      } else {
        docs.set(path, { ...data });
      }
    },
    async create(data: Record<string, unknown>) {
      if (docs.has(path)) {
        throw Object.assign(new Error(`6 ALREADY_EXISTS: ${path}`), { code: 6 });
      }
      docs.set(path, { ...data });
    },
    async update(data: Record<string, unknown>) {
      const cur = docs.get(path) ?? {};
      applyMerge(cur, data);
      docs.set(path, cur);
    },
    async delete() {
      docs.delete(path);
    },
    collection(sub: string) {
      return makeCollection(`${path}/${sub}`);
    },
  };
}
type Ref = ReturnType<typeof makeRef>;

interface OrderBy {
  field: string;
  dir: "asc" | "desc";
}
function valOf(entry: { id: string; data: Record<string, unknown> }, field: string) {
  return field === "__name__" ? entry.id : entry.data[field];
}

function makeQuery(collPath: string) {
  const filters: Array<{ field: string; value: unknown }> = [];
  const orderBys: OrderBy[] = [];
  let limitN = Infinity;
  let cursor: unknown[] | null = null;
  const q = {
    where(field: string, op: string, value: unknown) {
      if (op !== "==") throw new Error(`unsupported op ${op}`);
      filters.push({ field, value });
      return q;
    },
    orderBy(field: unknown, dir: "asc" | "desc" = "asc") {
      // FieldPath.documentId() is mocked to the string "__name__".
      orderBys.push({ field: field === "__name__" ? "__name__" : (field as string), dir });
      return q;
    },
    limit(n: number) {
      limitN = n;
      return q;
    },
    startAfter(...vals: unknown[]) {
      cursor = vals;
      return q;
    },
    async get() {
      // Direct children of collPath only (no deeper nesting).
      let rows = Array.from(docs.entries())
        .filter(
          ([p]) => p.startsWith(collPath + "/") && !p.slice(collPath.length + 1).includes("/"),
        )
        .map(([p, data]) => ({ id: p.split("/").pop()!, path: p, data }));
      for (const f of filters) rows = rows.filter((r) => r.data[f.field] === f.value);
      if (orderBys.length) {
        rows.sort((a, b) => {
          for (const ob of orderBys) {
            const av = valOf(a, ob.field) as any;
            const bv = valOf(b, ob.field) as any;
            if (av < bv) return ob.dir === "desc" ? 1 : -1;
            if (av > bv) return ob.dir === "desc" ? -1 : 1;
          }
          return 0;
        });
      }
      if (cursor) {
        rows = rows.filter((r) => {
          for (let i = 0; i < cursor!.length; i++) {
            const ob = orderBys[i];
            const dv = valOf(r, ob.field) as any;
            const cv = cursor![i] as any;
            if (dv === cv) continue;
            const lt = dv < cv;
            return ob.dir === "desc" ? lt : !lt;
          }
          return false;
        });
      }
      if (limitN !== Infinity) rows = rows.slice(0, limitN);
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((r) => ({
          id: r.id,
          ref: makeRef(r.path),
          exists: true,
          data: () => r.data,
        })),
      };
    },
  };
  return q;
}

function makeCollection(path: string) {
  return {
    doc(id?: string) {
      return makeRef(`${path}/${id ?? `auto_${(autoSeq += 1)}`}`);
    },
    where(field: string, op: string, value: unknown) {
      return makeQuery(path).where(field, op, value);
    },
    orderBy(field: unknown, dir?: "asc" | "desc") {
      return makeQuery(path).orderBy(field, dir);
    },
  };
}

const fakeDb = {
  collection(name: string) {
    return makeCollection(name);
  },
  async getAll(...refs: Ref[]) {
    return refs.map((r) => snapFor(r._path, r.id));
  },
  batch() {
    const ops: Array<() => Promise<void>> = [];
    return {
      set: (ref: Ref, data: Record<string, unknown>, opts?: { merge?: boolean }) =>
        ops.push(() => ref.set(data, opts)),
      delete: (ref: Ref) => ops.push(() => ref.delete()),
      update: (ref: Ref, data: Record<string, unknown>) => ops.push(() => ref.update(data)),
      async commit() {
        for (const op of ops) await op();
      },
    };
  },
  async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
    const ops: Array<() => Promise<void>> = [];
    const t = {
      get: (ref: Ref) => ref.get(),
      set: (ref: Ref, data: Record<string, unknown>, opts?: { merge?: boolean }) =>
        ops.push(() => ref.set(data, opts)),
      update: (ref: Ref, data: Record<string, unknown>) => ops.push(() => ref.update(data)),
      delete: (ref: Ref) => ops.push(() => ref.delete()),
    };
    const result = await fn(t);
    for (const op of ops) await op();
    return result;
  },
};

// ── Module mocks ───────────────────────────────────────────────────────
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { increment: (n: number) => ({ [INCREMENT]: n }) },
  FieldPath: { documentId: () => "__name__" },
}));

vi.mock("../firebase", () => ({ db: () => fakeDb }));

vi.mock("../auth", () => ({
  requireAuth: (req: { user?: TestUser }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
}));

vi.mock("../services/push", () => ({
  notifyUser: async (input: Record<string, unknown>) => {
    pushCalls.push(input);
  },
}));

vi.mock("../services/rateLimit", () => ({
  checkAndIncrement: async () => {
    rateLimitCalls += 1;
    return { allowed: rateLimitAllowed, retryAfterSeconds: rateLimitRetryAfter };
  },
}));

import { registerMessageRoutes } from "./messages";

// ── Seed helpers ───────────────────────────────────────────────────────
function seedUser(id: string, firstName?: string, lastName?: string, email?: string) {
  docs.set(`users/${id}`, { id, firstName, lastName, email: email ?? `${id}@example.com` });
}
function seedTenancy(
  id: string,
  t: {
    ownerId: string;
    userId?: string;
    status?: string;
    propertyId?: string | null;
    createdAt?: string;
  },
) {
  docs.set(`tenants/${id}`, {
    id,
    ownerId: t.ownerId,
    userId: t.userId,
    status: t.status ?? "active",
    propertyId: t.propertyId === null ? undefined : (t.propertyId ?? "prop-1"),
    createdAt: t.createdAt ?? "2026-01-01T00:00:00.000Z",
  });
}
function seedConversation(
  ownerId: string,
  tenantUserId: string,
  extra: Record<string, unknown> = {},
) {
  const id = `${ownerId}_${tenantUserId}`;
  docs.set(`conversations/${id}`, {
    id,
    ownerId,
    tenantUserId,
    tenancyId: "ten-1",
    propertyId: "prop-1",
    lastMessageText: "",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    lastMessageSenderId: "",
    unreadByOwner: 0,
    unreadByTenant: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  });
  return id;
}
function seedMessage(
  convId: string,
  id: string,
  m: { senderId: string; text: string; createdAt: string },
) {
  docs.set(`conversations/${convId}/messages/${id}`, {
    id,
    conversationId: convId,
    senderId: m.senderId,
    text: m.text,
    createdAt: m.createdAt,
  });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  registerMessageRoutes(app);
  return app;
}

// ── POST /api/messages/start (owner) ───────────────────────────────────
describe("POST /api/messages/start", () => {
  it("400 without tenancyId", async () => {
    const res = await request(makeApp()).post("/api/messages/start").send({});
    expect(res.status).toBe(400);
  });
  it("404 when the tenancy doesn't exist", async () => {
    const res = await request(makeApp()).post("/api/messages/start").send({ tenancyId: "nope" });
    expect(res.status).toBe(404);
  });
  it("403 when the tenancy isn't the caller's", async () => {
    seedTenancy("ten-1", { ownerId: "someone-else", userId: "u-a" });
    const res = await request(makeApp()).post("/api/messages/start").send({ tenancyId: "ten-1" });
    expect(res.status).toBe(403);
  });
  it("400 when the tenant hasn't signed up", async () => {
    seedTenancy("ten-1", { ownerId: "owner-1" });
    const res = await request(makeApp()).post("/api/messages/start").send({ tenancyId: "ten-1" });
    expect(res.status).toBe(400);
  });
  it("400 when the tenancy is missing propertyId (legacy drift), not a 500", async () => {
    seedTenancy("ten-1", { ownerId: "owner-1", userId: "u-a", propertyId: null });
    const res = await request(makeApp()).post("/api/messages/start").send({ tenancyId: "ten-1" });
    expect(res.status).toBe(400);
    expect(docs.has("conversations/owner-1_u-a")).toBe(false);
  });
  it("201 creates the thread, idempotent on re-call", async () => {
    seedTenancy("ten-1", { ownerId: "owner-1", userId: "u-a" });
    const app = makeApp();
    const first = await request(app).post("/api/messages/start").send({ tenancyId: "ten-1" });
    expect(first.status).toBe(201);
    expect(first.body.id).toBe("owner-1_u-a");
    const second = await request(app).post("/api/messages/start").send({ tenancyId: "ten-1" });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe("owner-1_u-a");
  });
  it("never clobbers a populated thread back to empty (returns the live doc)", async () => {
    seedTenancy("ten-1", { ownerId: "owner-1", userId: "u-a" });
    seedConversation("owner-1", "u-a", {
      lastMessageText: "already chatting",
      lastMessageSenderId: "u-a",
      unreadByOwner: 2,
    });
    const res = await request(makeApp()).post("/api/messages/start").send({ tenancyId: "ten-1" });
    expect(res.status).toBe(200);
    expect(res.body.lastMessageText).toBe("already chatting");
    expect(docs.get("conversations/owner-1_u-a")!.lastMessageText).toBe("already chatting");
  });

  it("M-1: the create() ALREADY_EXISTS race branch returns the live doc, not an empty one", async () => {
    // The thread is populated, but the handler's first existence-check get() is
    // hidden (the doc lands in the get→create gap), so it proceeds to create(),
    // hits ALREADY_EXISTS (code 6), and must return the live doc untouched —
    // exercising the catch branch that the seed-first idempotency test skips.
    seedTenancy("ten-1", { ownerId: "owner-1", userId: "u-a" });
    seedConversation("owner-1", "u-a", {
      lastMessageText: "raced in first",
      lastMessageSenderId: "u-a",
      unreadByOwner: 1,
    });
    hideOnFirstGet.add("conversations/owner-1_u-a");
    const res = await request(makeApp()).post("/api/messages/start").send({ tenancyId: "ten-1" });
    expect(res.status).toBe(200);
    expect(res.body.lastMessageText).toBe("raced in first");
    expect(docs.get("conversations/owner-1_u-a")!.lastMessageText).toBe("raced in first");
  });
});

// ── POST /api/messages/start-with-landlord (tenant) ────────────────────
describe("POST /api/messages/start-with-landlord", () => {
  it("400 with no active tenancy", async () => {
    currentUser = { uid: "u-t" };
    const res = await request(makeApp()).post("/api/messages/start-with-landlord");
    expect(res.status).toBe(400);
  });
  it("201 creates the thread keyed by (owner, tenant)", async () => {
    currentUser = { uid: "u-t" };
    seedTenancy("ten-1", { ownerId: "owner-9", userId: "u-t" });
    const res = await request(makeApp()).post("/api/messages/start-with-landlord");
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("owner-9_u-t");
  });
  it("400 when the resolved tenancy is missing propertyId", async () => {
    currentUser = { uid: "u-t" };
    seedTenancy("ten-1", { ownerId: "owner-9", userId: "u-t", propertyId: null });
    const res = await request(makeApp()).post("/api/messages/start-with-landlord");
    expect(res.status).toBe(400);
  });
});

// ── POST /api/messages/conversations/:id/messages (send) ───────────────
describe("POST send", () => {
  beforeEach(() => {
    seedUser("owner-1", "Olive", "Owner");
    seedUser("u-a", "Alice", "Anders");
  });
  it("400 on empty text WITHOUT metering rate-limit quota (L-3)", async () => {
    seedConversation("owner-1", "u-a");
    const res = await request(makeApp())
      .post("/api/messages/conversations/owner-1_u-a/messages")
      .send({ text: "   " });
    expect(res.status).toBe(400);
    expect(rateLimitCalls).toBe(0);
  });
  it("400 on oversized text", async () => {
    seedConversation("owner-1", "u-a");
    const res = await request(makeApp())
      .post("/api/messages/conversations/owner-1_u-a/messages")
      .send({ text: "x".repeat(4001) });
    expect(res.status).toBe(400);
  });
  it("400 on a malformed conversation id (path-injection guard)", async () => {
    const res = await request(makeApp())
      .post("/api/messages/conversations/" + encodeURIComponent("a/b/c") + "/messages")
      .send({ text: "hi" });
    expect(res.status).toBe(400);
  });
  it("403 for a non-participant WITHOUT metering quota (L-3)", async () => {
    seedConversation("owner-1", "u-a");
    currentUser = { uid: "intruder" };
    const res = await request(makeApp())
      .post("/api/messages/conversations/owner-1_u-a/messages")
      .send({ text: "let me in" });
    expect(res.status).toBe(403);
    expect(rateLimitCalls).toBe(0);
  });
  it("404 when the conversation doesn't exist", async () => {
    const res = await request(makeApp())
      .post("/api/messages/conversations/owner-1_u-missing/messages")
      .send({ text: "hi" });
    expect(res.status).toBe(404);
    expect(rateLimitCalls).toBe(0);
  });
  it("201 owner→tenant: writes the message, bumps unreadByTenant, pushes with deep-link + sender-name title", async () => {
    seedConversation("owner-1", "u-a");
    const res = await request(makeApp())
      .post("/api/messages/conversations/owner-1_u-a/messages")
      .send({ text: "Hello Alice" });
    expect(res.status).toBe(201);
    const conv = docs.get("conversations/owner-1_u-a")!;
    expect(conv.unreadByTenant).toBe(1);
    expect(conv.unreadByOwner).toBe(0);
    expect(conv.lastMessageText).toBe("Hello Alice");
    expect(conv.lastMessageSenderId).toBe("owner-1");
    // metered exactly once, AFTER validation + access passed (L-3)
    expect(rateLimitCalls).toBe(1);
    // one message in the subcollection
    const msgs = Array.from(docs.keys()).filter((k) =>
      k.startsWith("conversations/owner-1_u-a/messages/"),
    );
    expect(msgs).toHaveLength(1);
    // push: messages category + ?c= deep-link to this thread + name title (L-14)
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].externalUserId).toBe("u-a");
    expect(pushCalls[0].category).toBe("messages");
    expect(pushCalls[0].title).toBe("Olive Owner");
    expect(String(pushCalls[0].url)).toContain("/tenant/messages?c=owner-1_u-a");
  });
  it("L-14: push title falls back name → email → 'New message'", async () => {
    seedConversation("owner-1", "u-a");
    const app = makeApp();
    // No names on the profile → email.
    currentUser = { uid: "owner-1", profile: { email: "olive@example.com" } };
    await request(app).post("/api/messages/conversations/owner-1_u-a/messages").send({ text: "a" });
    expect(pushCalls[0].title).toBe("olive@example.com");
    // No profile at all → "New message".
    currentUser = { uid: "owner-1" };
    await request(app).post("/api/messages/conversations/owner-1_u-a/messages").send({ text: "b" });
    expect(pushCalls[1].title).toBe("New message");
  });
  it("tenant→owner bumps unreadByOwner and deep-links to /owner/messages", async () => {
    seedConversation("owner-1", "u-a");
    currentUser = { uid: "u-a", profile: { firstName: "Alice", lastName: "Anders" } };
    await request(makeApp())
      .post("/api/messages/conversations/owner-1_u-a/messages")
      .send({ text: "Hi Olive" });
    const conv = docs.get("conversations/owner-1_u-a")!;
    expect(conv.unreadByOwner).toBe(1);
    expect(conv.unreadByTenant).toBe(0);
    expect(String(pushCalls[0].url)).toContain("/owner/messages?c=owner-1_u-a");
  });
  it("429 when rate-limited, with Retry-After header", async () => {
    seedConversation("owner-1", "u-a");
    rateLimitAllowed = false;
    rateLimitRetryAfter = 42;
    const res = await request(makeApp())
      .post("/api/messages/conversations/owner-1_u-a/messages")
      .send({ text: "spam" });
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("42");
    expect(res.body.retryAfterSeconds).toBe(42);
    // No write, no push when throttled.
    expect(Array.from(docs.keys()).some((k) => k.includes("/messages/"))).toBe(false);
    expect(pushCalls).toHaveLength(0);
  });
  it("does NOT advance lastMessage* when an out-of-order (older) send lands after a newer one", async () => {
    // A newer message already set the preview to a future timestamp; a send
    // stamped earlier must still increment unread but must NOT roll the preview
    // back to its older text.
    seedConversation("owner-1", "u-a", {
      lastMessageText: "newest already",
      lastMessageAt: "2099-01-01T00:00:00.000Z",
      lastMessageSenderId: "u-a",
    });
    const res = await request(makeApp())
      .post("/api/messages/conversations/owner-1_u-a/messages")
      .send({ text: "stale straggler" });
    expect(res.status).toBe(201);
    const conv = docs.get("conversations/owner-1_u-a")!;
    expect(conv.lastMessageText).toBe("newest already");
    expect(conv.unreadByTenant).toBe(1); // still counted
  });
});

// ── GET /api/messages/conversations/:id/messages (list) ────────────────
describe("GET messages", () => {
  beforeEach(() => {
    seedConversation("owner-1", "u-a");
  });
  it("returns messages ascending by createdAt", async () => {
    seedMessage("owner-1_u-a", "m2", {
      senderId: "u-a",
      text: "second",
      createdAt: "2026-02-02T00:00:00.000Z",
    });
    seedMessage("owner-1_u-a", "m1", {
      senderId: "owner-1",
      text: "first",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const res = await request(makeApp()).get("/api/messages/conversations/owner-1_u-a/messages");
    expect(res.status).toBe(200);
    expect(res.body.map((m: Record<string, unknown>) => m.text)).toEqual(["first", "second"]);
  });
  it("clamps the limit and honors it (newest window, returned ascending)", async () => {
    for (let i = 0; i < 5; i++) {
      seedMessage("owner-1_u-a", `m${i}`, {
        senderId: "owner-1",
        text: `t${i}`,
        createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      });
    }
    const res = await request(makeApp()).get(
      "/api/messages/conversations/owner-1_u-a/messages?limit=2",
    );
    expect(res.body).toHaveLength(2);
    // newest two (m3,m4) returned ascending
    expect(res.body.map((m: Record<string, unknown>) => m.text)).toEqual(["t3", "t4"]);
  });
  it("403 for a non-participant", async () => {
    currentUser = { uid: "intruder" };
    const res = await request(makeApp()).get("/api/messages/conversations/owner-1_u-a/messages");
    expect(res.status).toBe(403);
  });
  it("400 on a malformed conversation id", async () => {
    const res = await request(makeApp()).get(
      "/api/messages/conversations/" + encodeURIComponent("a/b/c") + "/messages",
    );
    expect(res.status).toBe(400);
  });
  it("L-1: the compound ?before cursor pages through same-millisecond messages without skip or duplicate", async () => {
    const ts = "2026-03-03T00:00:00.000Z";
    seedMessage("owner-1_u-a", "m1", { senderId: "owner-1", text: "one", createdAt: ts });
    seedMessage("owner-1_u-a", "m2", { senderId: "owner-1", text: "two", createdAt: ts });
    const app = makeApp();
    const base = "/api/messages/conversations/owner-1_u-a/messages";
    // Page 1: newest single message (desc by createdAt, docId tiebreak).
    const p1 = await request(app).get(`${base}?limit=1`);
    expect(p1.body).toHaveLength(1);
    const first = p1.body[0];
    // Page 2: strictly older than (createdAt|docId) → the OTHER same-ms message.
    const before1 = encodeURIComponent(`${first.createdAt}|${first.id}`);
    const p2 = await request(app).get(`${base}?limit=1&before=${before1}`);
    expect(p2.body).toHaveLength(1);
    expect(p2.body[0].id).not.toBe(first.id);
    // Page 3: nothing left — the tiebreaker prevents an infinite same-ms loop.
    const before2 = encodeURIComponent(`${p2.body[0].createdAt}|${p2.body[0].id}`);
    const p3 = await request(app).get(`${base}?limit=1&before=${before2}`);
    expect(p3.body).toHaveLength(0);
    // Union of both pages = both messages, no duplication.
    expect([first.id, p2.body[0].id].sort()).toEqual(["m1", "m2"]);
  });
});

// ── POST /api/messages/conversations/:id/read (mark read) ──────────────
describe("POST read", () => {
  it("zeroes the caller's counter (owner side)", async () => {
    seedConversation("owner-1", "u-a", { unreadByOwner: 4, unreadByTenant: 1 });
    const res = await request(makeApp())
      .post("/api/messages/conversations/owner-1_u-a/read")
      .send({});
    expect(res.status).toBe(200);
    const conv = docs.get("conversations/owner-1_u-a")!;
    expect(conv.unreadByOwner).toBe(0);
    expect(conv.unreadByTenant).toBe(1); // counterpart untouched
  });
  it("does NOT clear when a newer message than the watermark exists (lost-update guard)", async () => {
    seedConversation("owner-1", "u-a", {
      unreadByOwner: 3,
      lastMessageAt: "2026-06-10T12:00:00.000Z",
    });
    const res = await request(makeApp())
      .post("/api/messages/conversations/owner-1_u-a/read")
      .send({ lastSeenAt: "2026-06-10T11:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(false);
    expect(docs.get("conversations/owner-1_u-a")!.unreadByOwner).toBe(3);
  });
  it("clears when the watermark is current", async () => {
    seedConversation("owner-1", "u-a", {
      unreadByOwner: 3,
      lastMessageAt: "2026-06-10T12:00:00.000Z",
    });
    const res = await request(makeApp())
      .post("/api/messages/conversations/owner-1_u-a/read")
      .send({ lastSeenAt: "2026-06-10T12:00:00.000Z" });
    expect(res.body.cleared).toBe(true);
    expect(docs.get("conversations/owner-1_u-a")!.unreadByOwner).toBe(0);
  });
  it("zeroes the caller's counter (tenant side) and leaves the owner's", async () => {
    seedConversation("owner-1", "u-a", { unreadByOwner: 2, unreadByTenant: 5 });
    currentUser = { uid: "u-a" };
    const res = await request(makeApp())
      .post("/api/messages/conversations/owner-1_u-a/read")
      .send({});
    expect(res.status).toBe(200);
    const conv = docs.get("conversations/owner-1_u-a")!;
    expect(conv.unreadByTenant).toBe(0);
    expect(conv.unreadByOwner).toBe(2);
  });
  it("403 for a non-participant", async () => {
    seedConversation("owner-1", "u-a");
    currentUser = { uid: "intruder" };
    const res = await request(makeApp())
      .post("/api/messages/conversations/owner-1_u-a/read")
      .send({});
    expect(res.status).toBe(403);
  });
  it("404 when the conversation doesn't exist", async () => {
    const res = await request(makeApp())
      .post("/api/messages/conversations/owner-1_u-missing/read")
      .send({});
    expect(res.status).toBe(404);
  });
  it("400 on a malformed conversation id", async () => {
    const res = await request(makeApp())
      .post("/api/messages/conversations/" + encodeURIComponent("a/b/c") + "/read")
      .send({});
    expect(res.status).toBe(400);
  });
});
