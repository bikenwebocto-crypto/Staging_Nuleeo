// Behavior tests for the maintenance-ticket status-change push — the
// tenant-directed notification added to PATCH /api/admin/tickets/:id
// (server/routes/adminContent.ts ~409-430).
//
// Regression focus: a real STATUS change on a property/maintenance ticket
// must push the ticket's CREATOR (existing.userId) under the "maintenance"
// category — previously no tenant-directed maintenance push existed at all,
// so the user's "Maintenance updates" preference toggle was inert. Two
// invariants are pinned:
//   • a property ticket whose status actually changes pushes the creator
//     with category "maintenance" (and NOT on a no-op / non-property /
//     non-status patch);
//   • the category gate is honored end-to-end: a creator with
//     notificationPrefs.maintenance === false is NOT delivered to, while
//     the master pushEnabled switch is independently honored.
//
// Mocking strategy: rather than stub notifyUser and re-implement the gate in
// the test, we exercise the REAL push chain (notifyUser → sendPushToUser →
// gate → sendPush). sendPushToUser reads notificationPrefs from the SAME
// in-memory Firestore double the route writes to, so the gate runs for real;
// only the network boundary (global fetch + the REST-key env var) is stubbed.
// A fetch call therefore means "a push was actually delivered", and its
// absence means the gate (or no-status-change guard) suppressed it. The
// fetch body carries category indirectly via headings/contents, so we assert
// the targeting + suppression that the gate controls.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mutable test state ─────────────────────────────────────────────────
let currentUser: { uid: string; email?: string; profile?: Record<string, unknown> };

type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {
  tickets: new Map(),
  users: new Map(),
  partners: new Map(),
  marketplaceListings: new Map(),
  marketplaceLeads: new Map(),
  suggestionRequests: new Map(),
};

// Captured OneSignal HTTP sends. One entry == one delivered push; an empty
// log == the gate (or the no-change guard) suppressed delivery.
interface SentPush {
  externalIds: string[];
  title: string;
  message: string;
  url?: string;
}
let sentPushes: SentPush[] = [];

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
  sentPushes = [];
  currentUser = {
    uid: "admin-uid",
    email: "a@x.com",
    profile: { roles: ["admin"], platformRole: "support" },
  };
  // The real sendPush() short-circuits with a 500 PushError when the REST key
  // is unset; set it so the gate (not a missing-key throw) is what governs.
  process.env.ONESIGNAL_REST_API_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ONESIGNAL_REST_API_KEY;
});

// ── Firestore double ───────────────────────────────────────────────────

function snapFor(col: string, id: string) {
  const data = store[col].get(id);
  return { exists: !!data, id, data: () => data };
}

function makeRef(col: string, id: string) {
  return {
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
    async delete() {
      store[col].delete(id);
    },
    collection(sub: string) {
      // Sub-collection (tickets/{id}/messages) isn't exercised by the
      // status-change tests; a thin stub keeps the surface coherent.
      const key = `${col}/${id}/${sub}`;
      store[key] ??= new Map();
      return makeColApi(key);
    },
  };
}

function makeColApi(col: string) {
  const filters: Array<{ field: string; value: unknown }> = [];
  const q = {
    where(field: string, op: string, value: unknown) {
      if (op !== "==") throw new Error(`unsupported op ${op}`);
      filters.push({ field, value });
      return q;
    },
    orderBy() {
      return q;
    },
    async get() {
      let rows = Array.from(store[col].entries()).map(([id, data]) => ({ id, data }));
      for (const f of filters) rows = rows.filter((r) => r.data[f.field] === f.value);
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((r) => ({ id: r.id, ref: makeRef(col, r.id), data: () => r.data })),
      };
    },
    doc(id?: string) {
      return makeRef(col, id ?? `auto_${store[col].size}`);
    },
  };
  return q;
}

const fakeDb = {
  collection(name: string) {
    store[name] ??= new Map();
    return makeColApi(name);
  },
};

// ── Module mocks ───────────────────────────────────────────────────────
// Both the route module AND push.ts import `db` from "../firebase", so a
// single mock backs the ticket read/write AND the prefs read inside the gate.
vi.mock("../firebase", () => ({ db: () => fakeDb }));

vi.mock("../auth", () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
}));

// IMPORTANT: services/push is NOT mocked. The real notifyUser → sendPushToUser
// → gate → sendPush runs; only fetch is stubbed (below, per test app build) so
// the gate decision is exercised for real.

import { registerAdminContentRoutes } from "./adminContent";

type Mw = (req: unknown, res: unknown, next: () => void) => void;
function makeApp() {
  // Stub the OneSignal transport. A 200 means "delivered"; we record the
  // targeted external_id(s) + payload so the test can assert WHO got pushed.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        include_aliases: { external_id: string[] };
        headings: { en: string };
        contents: { en: string };
        url?: string;
      };
      sentPushes.push({
        externalIds: body.include_aliases.external_id,
        title: body.headings.en,
        message: body.contents.en,
        url: body.url,
      });
      return {
        status: 200,
        async json() {
          return { id: "notif_1", recipients: 1 };
        },
        async text() {
          return "";
        },
      } as unknown as Response;
    }),
  );

  const app = express();
  app.use(express.json());
  // Admin gating is enforced by the injected middleware in production; these
  // tests target the post-authorization push behavior, so the doubles pass
  // through (the real gates are covered by adminQueries.security.test.ts).
  const requireRole =
    (..._roles: string[]): Mw =>
    (_req, _res, next) =>
      next();
  const requirePlatformPrivilege =
    (_priv: string): Mw =>
    (_req, _res, next) =>
      next();
  registerAdminContentRoutes(app, {
    requireRole: requireRole as never,
    requirePlatformPrivilege: requirePlatformPrivilege as never,
  });
  return app;
}

// Seed a property (maintenance) ticket raised by a tenant, plus that tenant's
// user doc carrying notification preferences.
function seedPropertyTicket(prefs?: Record<string, unknown>) {
  store.tickets.set("tk-1", {
    id: "tk-1",
    subject: "Leaking tap",
    userId: "tenant-uid",
    userEmail: "t@example.com",
    category: "property",
    priority: "medium",
    status: "open",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  store.users.set("tenant-uid", {
    id: "tenant-uid",
    email: "t@example.com",
    ...(prefs ? { notificationPrefs: prefs } : {}),
  });
}

describe("PATCH /api/admin/tickets/:id — maintenance status-change push", () => {
  it("pushes the ticket creator with the maintenance copy on a real status change", async () => {
    seedPropertyTicket(); // no prefs → opt-in-by-default, gate passes
    const res = await request(makeApp())
      .patch("/api/admin/tickets/tk-1")
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");

    // Exactly one push, addressed to the CREATOR (existing.userId), carrying
    // the maintenance-update copy with the human status label + the subject.
    expect(sentPushes).toHaveLength(1);
    expect(sentPushes[0].externalIds).toEqual(["tenant-uid"]);
    expect(sentPushes[0].title).toBe("Maintenance request updated");
    expect(sentPushes[0].message).toContain("in progress");
    expect(sentPushes[0].message).toContain("Leaking tap");
    expect(sentPushes[0].url).toBe("https://app.oliowallet.com/tenant");
  });

  it("does NOT push when the status is unchanged (no-op patch)", async () => {
    seedPropertyTicket();
    // Re-sending the current status is not a "real" change → guarded out.
    const res = await request(makeApp()).patch("/api/admin/tickets/tk-1").send({ status: "open" });

    expect(res.status).toBe(200);
    expect(sentPushes).toHaveLength(0);
  });

  it("does NOT push for a non-property ticket even when status changes", async () => {
    // A billing ticket changing status is support traffic, not maintenance —
    // the maintenance push is scoped to property-category tickets only.
    store.tickets.set("tk-2", {
      id: "tk-2",
      subject: "Invoice question",
      userId: "tenant-uid",
      userEmail: "t@example.com",
      category: "billing",
      priority: "low",
      status: "open",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    store.users.set("tenant-uid", { id: "tenant-uid", email: "t@example.com" });
    const res = await request(makeApp())
      .patch("/api/admin/tickets/tk-2")
      .send({ status: "resolved" });

    expect(res.status).toBe(200);
    expect(sentPushes).toHaveLength(0);
  });

  it("does NOT push when only priority changes (no status change)", async () => {
    seedPropertyTicket();
    const res = await request(makeApp())
      .patch("/api/admin/tickets/tk-1")
      .send({ priority: "urgent" });

    expect(res.status).toBe(200);
    expect(res.body.priority).toBe("urgent");
    expect(sentPushes).toHaveLength(0);
  });
});

describe("PATCH /api/admin/tickets/:id — maintenance category gate (push.ts)", () => {
  it("suppresses delivery when the creator turned the maintenance category off", async () => {
    // The real sendPushToUser gate reads notificationPrefs.maintenance === false
    // and short-circuits before any network send — the user opted out of
    // maintenance pushes specifically.
    seedPropertyTicket({ maintenance: false });
    const res = await request(makeApp())
      .patch("/api/admin/tickets/tk-1")
      .send({ status: "resolved" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");
    // Gate suppressed it — no network send despite a genuine status change.
    expect(sentPushes).toHaveLength(0);
  });

  it("still delivers when an UNRELATED category is off but maintenance is on", async () => {
    // Turning off "messages" must not bleed into the maintenance gate.
    seedPropertyTicket({ messages: false, maintenance: true });
    const res = await request(makeApp())
      .patch("/api/admin/tickets/tk-1")
      .send({ status: "resolved" });

    expect(res.status).toBe(200);
    expect(sentPushes).toHaveLength(1);
    expect(sentPushes[0].externalIds).toEqual(["tenant-uid"]);
  });

  it("suppresses delivery when the master pushEnabled switch is off", async () => {
    // The master switch is honored independently of the category flag.
    seedPropertyTicket({ pushEnabled: false, maintenance: true });
    const res = await request(makeApp())
      .patch("/api/admin/tickets/tk-1")
      .send({ status: "closed" });

    expect(res.status).toBe(200);
    expect(sentPushes).toHaveLength(0);
  });
});
