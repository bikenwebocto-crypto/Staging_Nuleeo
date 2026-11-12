// Behavior tests for the workspace routes (list / create / open).
//
// Focus: backward compatibility (an existing owner gets a real-estate
// workspace around the portfolio they already have, exactly once), membership
// derived from ACTIVE portfolio-access grants (revocation drops access), the
// owner-experience gate on create, one-per-type limits, and input validation.
//
// Firestore is replaced by a tiny in-memory double that supports just the
// calls the service makes: doc get/create/set(merge), equality where(),
// select(), get(). create() throws ALREADY_EXISTS (code 6) like the Admin SDK.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const store = new Map<string, Map<string, Row>>();
function col(name: string): Map<string, Row> {
  let c = store.get(name);
  if (!c) {
    c = new Map();
    store.set(name, c);
  }
  return c;
}
function snap(id: string, data: Row | undefined) {
  return { id, exists: data !== undefined, data: () => data };
}
function makeQuery(name: string, filters: [string, unknown][]) {
  return {
    where(field: string, op: string, value: unknown) {
      if (op !== "==") throw new Error(`Unsupported op ${op} in mock`);
      return makeQuery(name, [...filters, [field, value]]);
    },
    select() {
      return makeQuery(name, filters);
    },
    async get() {
      const docs = [...col(name).entries()]
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([id, d]) => snap(id, d));
      return { docs, size: docs.length };
    },
  };
}

let currentUser: { uid: string; profile?: Row } = { uid: "alice" };

vi.mock("../auth", () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
}));

vi.mock("../firebase", () => ({
  db: () => ({
    collection: (name: string) => ({
      ...makeQuery(name, []),
      doc: (id: string) => ({
        get: async () => snap(id, col(name).get(id)),
        create: async (data: Row) => {
          if (col(name).has(id)) throw Object.assign(new Error("exists"), { code: 6 });
          col(name).set(id, data);
        },
        set: async (data: Row, opts?: { merge?: boolean }) => {
          col(name).set(id, opts?.merge ? { ...(col(name).get(id) ?? {}), ...data } : data);
        },
      }),
    }),
  }),
}));

// One portfolio per owner, id `pf_<ownerId>`. `getPortfolio` only finds
// portfolios that were "ensured" (i.e. that exist).
const portfolios = new Set<string>();
vi.mock("../services/portfolioBanking", () => ({
  ensurePortfolio: async (ownerId: string) => {
    portfolios.add(ownerId);
    return { id: `pf_${ownerId}`, ownerId, createdAt: "2026-01-01" };
  },
  getPortfolio: async (ownerId: string) =>
    portfolios.has(ownerId) ? { id: `pf_${ownerId}`, ownerId, createdAt: "2026-01-01" } : null,
}));

vi.mock("../services/commission", () => ({
  resolveOwnerPlan: async () => "basic",
}));

import { registerWorkspaceRoutes } from "./workspaces";

function app() {
  const a = express();
  a.use(express.json());
  registerWorkspaceRoutes(a);
  return a;
}

const OWNER_PROFILE = {
  firstName: "Thanos",
  lastName: "Thoma",
  email: "t@x.cy",
  roles: ["owner"],
  ownerModeEnabled: true,
};

function signIn(uid: string, profile: Row | undefined) {
  currentUser = { uid, profile };
}

beforeEach(() => {
  store.clear();
  portfolios.clear();
  signIn("alice", { ...OWNER_PROFILE });
});

describe("GET /api/workspaces", () => {
  it("wraps an existing owner's portfolio in a real-estate workspace, once", async () => {
    col("properties").set("p1", { portfolioId: "pf_alice" });
    col("properties").set("p2", { portfolioId: "pf_alice", status: "inactive" });
    col("tenants").set("t1", { portfolioId: "pf_alice", status: "active" });
    col("tenants").set("t2", { portfolioId: "pf_alice", status: "pending" });

    const first = await request(app()).get("/api/workspaces");
    expect(first.status).toBe(200);
    expect(first.body.workspaces).toHaveLength(1);
    expect(first.body.workspaces[0]).toMatchObject({
      id: "re_pf_alice",
      type: "real_estate",
      name: "Thanos Real Estate",
      portfolioDocId: "pf_alice",
      role: "owner",
      isSelf: true,
      // Soft-deactivated properties and non-active tenancies are excluded.
      stats: { properties: 1, activeTenants: 1 },
    });
    expect(first.body.canCreate).toEqual(["business"]);
    expect(first.body.lastWorkspaceId).toBeNull();

    const second = await request(app()).get("/api/workspaces");
    expect(second.body.workspaces).toHaveLength(1);
    expect(col("workspaces").size).toBe(1);
  });

  it("gives a tenant-only account no workspaces and nothing to create", async () => {
    signIn("tina", { firstName: "Tina", roles: ["tenant"], ownerModeEnabled: false });
    const res = await request(app()).get("/api/workspaces");
    expect(res.body).toEqual({ workspaces: [], lastWorkspaceId: null, canCreate: [] });
    expect(col("workspaces").size).toBe(0);
  });

  it("lists a portfolio shared through an ACTIVE grant, and drops it once revoked", async () => {
    portfolios.add("alice");
    col("users").set("alice", { ...OWNER_PROFILE });
    col("portfolioAccessContacts").set("g1", {
      ownerId: "alice",
      portfolioId: "pf_alice",
      contactUserId: "bob",
      type: "financial",
      permissions: ["view"],
      status: "active",
    });
    signIn("bob", { firstName: "Bob", roles: ["owner"], ownerModeEnabled: true });

    const res = await request(app()).get("/api/workspaces");
    const shared = res.body.workspaces.find((w: Row) => w.ownerId === "alice");
    expect(shared).toMatchObject({
      id: "re_pf_alice",
      role: "financial",
      permissions: ["view"],
      isSelf: false,
      ownerName: "Thanos Thoma",
    });
    // Bob's own workspace sorts first.
    expect(res.body.workspaces[0]).toMatchObject({ ownerId: "bob", isSelf: true });

    col("portfolioAccessContacts").get("g1")!.status = "revoked";
    const after = await request(app()).get("/api/workspaces");
    expect(after.body.workspaces.some((w: Row) => w.ownerId === "alice")).toBe(false);
    const open = await request(app()).post("/api/workspaces/re_pf_alice/open");
    expect(open.status).toBe(404);
  });
});

describe("POST /api/workspaces", () => {
  it("creates a business workspace once, then refuses a second", async () => {
    const created = await request(app())
      .post("/api/workspaces")
      .send({ type: "business", name: "  Thoma Group  " });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: "biz_alice",
      type: "business",
      name: "Thoma Group",
      stats: null,
      role: "owner",
    });

    const again = await request(app()).post("/api/workspaces").send({ type: "business" });
    expect(again.status).toBe(409);
  });

  it("defaults the name from the owner's first name", async () => {
    const res = await request(app()).post("/api/workspaces").send({ type: "business" });
    expect(res.body.name).toBe("Thanos Businesses");
  });

  it("refuses a second real-estate workspace (one per portfolio)", async () => {
    await request(app()).get("/api/workspaces"); // auto-creates it
    const res = await request(app()).post("/api/workspaces").send({ type: "real_estate" });
    expect(res.status).toBe(409);
  });

  it("validates type and name length", async () => {
    expect((await request(app()).post("/api/workspaces").send({ type: "farm" })).status).toBe(400);
    const long = await request(app())
      .post("/api/workspaces")
      .send({ type: "business", name: "x".repeat(61) });
    expect(long.status).toBe(400);
    expect(col("workspaces").size).toBe(0);
  });

  it("requires the owner experience", async () => {
    signIn("tina", { firstName: "Tina", roles: ["tenant"], ownerModeEnabled: false });
    const res = await request(app()).post("/api/workspaces").send({ type: "business" });
    expect(res.status).toBe(403);
    expect(col("workspaces").size).toBe(0);
  });
});

describe("POST /api/workspaces/:id/open", () => {
  it("records the opened workspace and echoes it back on list", async () => {
    await request(app()).post("/api/workspaces").send({ type: "business" });
    const open = await request(app()).post("/api/workspaces/biz_alice/open");
    expect(open.status).toBe(204);
    expect(col("users").get("alice")).toMatchObject({ lastWorkspaceId: "biz_alice" });

    signIn("alice", { ...OWNER_PROFILE, lastWorkspaceId: "biz_alice" });
    const list = await request(app()).get("/api/workspaces");
    expect(list.body.lastWorkspaceId).toBe("biz_alice");
  });

  it("returns 404 for someone else's workspace and for unknown or malformed ids", async () => {
    await request(app()).post("/api/workspaces").send({ type: "business" });
    signIn("bob", { firstName: "Bob", roles: ["owner"], ownerModeEnabled: true });
    expect((await request(app()).post("/api/workspaces/biz_alice/open")).status).toBe(404);
    expect((await request(app()).post("/api/workspaces/nope/open")).status).toBe(404);
    expect((await request(app()).post("/api/workspaces/a.b/open")).status).toBe(404);
    expect(col("users").get("bob")).toBeUndefined();
  });
});
