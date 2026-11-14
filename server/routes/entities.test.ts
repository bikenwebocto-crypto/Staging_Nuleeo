// Behavior tests for entity / business routes: owner scoping (never trusting a
// client ownerId), owner-experience gate, idempotent creation (duplicate
// submissions), draft save/resume/clear, portfolio filtering.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const store = new Map<string, Map<string, Row>>();
const DELETE = Symbol("delete");
function col(name: string): Map<string, Row> {
  let c = store.get(name);
  if (!c) store.set(name, (c = new Map()));
  return c;
}
const snap = (id: string, data: Row | undefined) => ({ id, exists: data !== undefined, data: () => data });
function applyMerge(prev: Row, data: Row): Row {
  const out = { ...prev };
  for (const [k, v] of Object.entries(data)) {
    if (v === DELETE) delete out[k];
    else out[k] = v;
  }
  return out;
}
function makeQuery(name: string, filters: [string, unknown][]) {
  return {
    where: (f: string, _op: string, v: unknown) => makeQuery(name, [...filters, [f, v]]),
    limit: () => makeQuery(name, filters),
    async get() {
      const docs = [...col(name).entries()]
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([id, d]) => snap(id, d));
      return { docs, empty: docs.length === 0, size: docs.length };
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
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { delete: () => DELETE } }));
vi.mock("../firebase", () => ({
  db: () => ({
    collection: (name: string) => ({
      ...makeQuery(name, []),
      doc: (id: string) => ({
        id,
        get: async () => snap(id, col(name).get(id)),
        create: async (data: Row) => {
          if (col(name).has(id)) throw Object.assign(new Error("exists"), { code: 6 });
          col(name).set(id, data);
        },
        set: async (data: Row, opts?: { merge?: boolean }) => {
          col(name).set(id, opts?.merge ? applyMerge(col(name).get(id) ?? {}, data) : data);
        },
        update: async (data: Row) => {
          if (!col(name).has(id)) throw Object.assign(new Error("missing"), { code: 5 });
          col(name).set(id, applyMerge(col(name).get(id)!, data));
        },
      }),
    }),
  }),
}));
vi.mock("../services/commission", () => ({ resolveOwnerPlan: async () => "basic" }));

import { registerEntityRoutes } from "./entities";

function app() {
  const a = express();
  a.use(express.json());
  registerEntityRoutes(a);
  return a;
}

const OWNER = { firstName: "A", roles: ["owner"], ownerModeEnabled: true };
const DATA = {
  businessType: "LIMITED_COMPANY",
  legalName: "Acme Holdings Ltd",
  country: "CY",
  registrationNumber: "HE1",
  sector: "Advisory",
  vatRegistered: false,
  financialYearEnd: "12-31",
  role: "SHAREHOLDER",
  sharePercent: 40,
  bankingPreference: "PAYABL_ACCOUNT",
};

beforeEach(() => {
  store.clear();
  currentUser = { uid: "alice", profile: { ...OWNER } };
  col("users").set("alice", { id: "alice" });
  col("users").set("bob", { id: "bob" });
});

describe("POST /api/entities/business", () => {
  it("creates a SETTING_UP business owned by the caller, ignoring a client ownerId", async () => {
    const r = await request(app())
      .post("/api/entities/business")
      .send({ submissionId: "sub-12345678", data: { ...DATA, ownerId: "bob" }, ownerId: "bob" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      ownerId: "alice",
      entityType: "COMPANY",
      status: "SETTING_UP",
      bankingPreference: "PAYABL_ACCOUNT",
      bankingStatus: "NOT_STARTED",
      creatorRole: "SHAREHOLDER",
      creatorSharePercent: 40,
    });
  });

  it("a duplicate submission returns the same business instead of a second one", async () => {
    const body = { submissionId: "sub-dupe-0001", data: DATA };
    const [a, b] = await Promise.all([
      request(app()).post("/api/entities/business").send(body),
      request(app()).post("/api/entities/business").send(body),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(col("entities").size).toBe(1);
  });

  it("rejects incomplete data with the failing step", async () => {
    const r = await request(app())
      .post("/api/entities/business")
      .send({ submissionId: "sub-12345678", data: { ...DATA, vatRegistered: true } });
    expect(r.status).toBe(400);
    expect(r.body.step).toBe(2);
    expect(col("entities").size).toBe(0);
  });

  it("requires a submissionId", async () => {
    expect((await request(app()).post("/api/entities/business").send({ data: DATA })).status).toBe(400);
  });

  it("is forbidden without the owner experience", async () => {
    currentUser = { uid: "alice", profile: { ownerModeEnabled: false } };
    const r = await request(app())
      .post("/api/entities/business")
      .send({ submissionId: "sub-12345678", data: DATA });
    expect(r.status).toBe(403);
  });

  it("clears the wizard draft after creation", async () => {
    await request(app()).put("/api/entities/draft").send({ step: 4, data: DATA });
    expect(col("users").get("alice")!.businessDraft).toBeTruthy();
    await request(app()).post("/api/entities/business").send({ submissionId: "sub-12345678", data: DATA });
    expect(col("users").get("alice")!.businessDraft).toBeUndefined();
  });
});

describe("wizard draft", () => {
  it("saves incomplete data and resumes it", async () => {
    const put = await request(app())
      .put("/api/entities/draft")
      .send({ step: 2, data: { legalName: "Half done", sector: "Nope" } });
    expect(put.status).toBe(200);
    const get = await request(app()).get("/api/entities/draft");
    expect(get.body.draft).toMatchObject({ step: 2, data: { legalName: "Half done" } });
    expect(get.body.draft.data.sector).toBeUndefined();
  });

  it("validates the step and can be discarded", async () => {
    expect((await request(app()).put("/api/entities/draft").send({ step: 9 })).status).toBe(400);
    await request(app()).put("/api/entities/draft").send({ step: 1, data: {} });
    expect((await request(app()).delete("/api/entities/draft")).status).toBe(204);
    expect((await request(app()).get("/api/entities/draft")).body.draft).toBeNull();
  });

  it("drafts are per-user", async () => {
    await request(app()).put("/api/entities/draft").send({ step: 1, data: { legalName: "Alice Co" } });
    currentUser = { uid: "bob", profile: { ...OWNER } };
    expect((await request(app()).get("/api/entities/draft")).body.draft).toBeNull();
  });
});

describe("portfolio + detail scoping", () => {
  beforeEach(() => {
    col("entities").set("a1", { ownerId: "alice", name: "Alpha", entityType: "COMPANY", status: "SETTING_UP", createdAt: "x" });
    col("entities").set("a2", { ownerId: "alice", name: "Beta", entityType: "COMPANY", status: "ACTIVE", createdAt: "x", archivedAt: "y" });
    col("entities").set("b1", { ownerId: "bob", name: "Bob Co", entityType: "COMPANY", status: "ACTIVE", createdAt: "x" });
  });

  it("lists only the caller's businesses, with search and views", async () => {
    const r = await request(app()).get("/api/entities/portfolio");
    expect(r.body.businesses.map((b: { id: string }) => b.id)).toEqual(["a1"]);
    expect(r.body.counts).toEqual({ active: 1, archived: 1 });
    expect(r.body.summary.revenueYtd).toBeNull();
    const arch = await request(app()).get("/api/entities/portfolio?view=archived");
    expect(arch.body.businesses.map((b: { id: string }) => b.id)).toEqual(["a2"]);
    const none = await request(app()).get("/api/entities/portfolio?q=zzz");
    expect(none.body.businesses).toEqual([]);
    expect(none.body.total).toBe(2);
  });

  it("detail is 404 for another owner's business", async () => {
    expect((await request(app()).get("/api/entities/a1")).status).toBe(200);
    expect((await request(app()).get("/api/entities/b1")).status).toBe(404);
  });
});
