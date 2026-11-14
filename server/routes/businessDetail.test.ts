// Behavior tests for Business Detail routes: owner-only access (404 for
// others), owner-experience gate on writes, shareholder save/replace, 100%
// confirmation, archive/unarchive, edit validation.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const DELETE = Symbol("delete");
const store = new Map<string, Map<string, Row>>();
let autoId = 0;
function col(name: string): Map<string, Row> {
  let c = store.get(name);
  if (!c) store.set(name, (c = new Map()));
  return c;
}
const snap = (id: string, data: Row | undefined) => ({
  id,
  exists: data !== undefined,
  data: () => data,
});
function merge(prev: Row, data: Row): Row {
  const out = { ...prev };
  for (const [k, v] of Object.entries(data)) {
    if (v === DELETE) delete out[k];
    else out[k] = v;
  }
  return out;
}
function query(name: string, filters: [string, unknown][]) {
  return {
    where: (f: string, _op: string, v: unknown) => query(name, [...filters, [f, v]]),
    async get() {
      const docs = [...col(name).entries()]
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([id, d]) => snap(id, d));
      return { docs, empty: !docs.length, size: docs.length };
    },
  };
}
function docRef(name: string, id: string) {
  return {
    id,
    __name: name,
    get: async () => snap(id, col(name).get(id)),
    update: async (data: Row) => {
      col(name).set(id, merge(col(name).get(id) ?? {}, data));
    },
  };
}

let currentUser: { uid: string; profile?: Row } = { uid: "alice" };
vi.mock("../auth", () => ({
  requireAuth: (req: { user?: unknown }, _r: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
}));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { delete: () => DELETE } }));
vi.mock("../firebase", () => ({
  db: () => ({
    collection: (name: string) => ({
      ...query(name, []),
      doc: (id?: string) => docRef(name, id ?? `auto${++autoId}`),
    }),
    batch: () => {
      const ops: (() => void)[] = [];
      return {
        delete: (r: { __name: string; id: string }) => ops.push(() => col(r.__name).delete(r.id)),
        set: (r: { __name: string; id: string }, d: Row) =>
          ops.push(() => col(r.__name).set(r.id, d)),
        update: (r: { __name: string; id: string }, d: Row) =>
          ops.push(() => col(r.__name).set(r.id, merge(col(r.__name).get(r.id) ?? {}, d))),
        commit: async () => ops.forEach((op) => op()),
      };
    },
  }),
}));
vi.mock("../services/commission", () => ({ resolveOwnerPlan: async () => "basic" }));

import { registerBusinessDetailRoutes } from "./businessDetail";

function app() {
  const a = express();
  a.use(express.json());
  registerBusinessDetailRoutes(a);
  return a;
}

const OWNER = { firstName: "Alice", lastName: "A", ownerModeEnabled: true };
const company = (id: string, ownerId: string, extra: Row = {}) =>
  col("entities").set(id, {
    id,
    ownerId,
    entityType: "COMPANY",
    name: id,
    legalName: `${id} Ltd`,
    businessType: "LIMITED_COMPANY",
    country: "CY",
    registrationNumber: "HE1",
    sector: "Advisory",
    vatRegistered: false,
    financialYearEnd: "12-31",
    status: "SETTING_UP",
    createdAt: "x",
    ...extra,
  });

beforeEach(() => {
  store.clear();
  currentUser = { uid: "alice", profile: { ...OWNER } };
  company("acme", "alice", { creatorRole: "BOTH", creatorSharePercent: 60 });
  company("holdco", "alice");
  company("bobco", "bob");
});

describe("authorization", () => {
  it("404s on another owner's business for every route", async () => {
    const a = app();
    expect((await request(a).get("/api/entities/bobco/detail")).status).toBe(404);
    expect((await request(a).patch("/api/entities/bobco").send({ legalName: "x" })).status).toBe(
      404,
    );
    expect((await request(a).post("/api/entities/bobco/archive")).status).toBe(404);
    expect(
      (await request(a).put("/api/entities/bobco/shareholders").send({ shareholders: [] })).status,
    ).toBe(404);
    expect(col("entities").get("bobco")!.archivedAt).toBeUndefined();
  });

  it("refuses writes without the owner experience", async () => {
    currentUser = { uid: "alice", profile: { ownerModeEnabled: false } };
    expect((await request(app()).post("/api/entities/acme/archive")).status).toBe(403);
  });

  it("cannot use another owner's company as a shareholder", async () => {
    const r = await request(app())
      .put("/api/entities/acme/shareholders")
      .send({ shareholders: [{ holderType: "ENTITY", holderEntityId: "bobco", percent: 10 }] });
    expect(r.status).toBe(400);
  });
});

describe("detail", () => {
  it("shows the creator's recorded share and honest empty financials", async () => {
    const r = await request(app()).get("/api/entities/acme/detail");
    expect(r.status).toBe(200);
    expect(r.body.shareholders).toEqual([
      expect.objectContaining({ isYou: true, percent: 60, label: "You (Alice A)" }),
    ]);
    expect(r.body.allocation).toEqual({ total: 60, complete: false });
    expect(r.body.kpis).toMatchObject({
      revenue30d: null,
      expenses30d: null,
      profitMarginPct: null,
    });
    expect(r.body.invoices).toMatchObject({ unpaid: null, creationAvailable: false });
    expect(r.body.companyOptions).toEqual([{ id: "holdco", name: "holdco" }]);
  });
});

describe("shareholders", () => {
  const full = [
    { holderType: "PERSON", holderUserId: "alice", percent: 60, role: "BOTH" },
    { holderType: "ENTITY", holderEntityId: "holdco", percent: 40 },
  ];

  it("saves, confirms 100%, and replaces the previous set", async () => {
    const r = await request(app())
      .put("/api/entities/acme/shareholders")
      .send({ shareholders: full, complete: true });
    expect(r.status).toBe(200);
    expect(r.body.allocation).toEqual({ total: 100, complete: true });
    expect(col("shareholdings").size).toBe(2);
    expect(col("entities").get("acme")).toMatchObject({
      ownershipComplete: true,
      creatorSharePercent: 60,
    });

    const r2 = await request(app())
      .put("/api/entities/acme/shareholders")
      .send({
        shareholders: [{ holderType: "PERSON", holderUserId: "alice", percent: 100 }],
        complete: true,
      });
    expect(r2.status).toBe(200);
    expect(col("shareholdings").size).toBe(1);
  });

  it("refuses to confirm when the total isn't 100%", async () => {
    const r = await request(app())
      .put("/api/entities/acme/shareholders")
      .send({ shareholders: [full[0]], complete: true });
    expect(r.status).toBe(400);
    expect(col("shareholdings").size).toBe(0);
  });

  it("rejects circular ownership across saves", async () => {
    // acme owns 40% of holdco…
    await request(app())
      .put("/api/entities/holdco/shareholders")
      .send({ shareholders: [{ holderType: "ENTITY", holderEntityId: "acme", percent: 40 }] });
    // …so holdco can't own acme.
    const r = await request(app())
      .put("/api/entities/acme/shareholders")
      .send({ shareholders: [{ holderType: "ENTITY", holderEntityId: "holdco", percent: 10 }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/circular/);
  });

  it("can't edit shareholders of an archived business", async () => {
    await request(app()).post("/api/entities/acme/archive");
    const r = await request(app())
      .put("/api/entities/acme/shareholders")
      .send({ shareholders: full });
    expect(r.status).toBe(409);
  });
});

describe("edit + archive", () => {
  it("validates edits server-side", async () => {
    expect((await request(app()).patch("/api/entities/acme").send({ legalName: "" })).status).toBe(
      400,
    );
    expect(
      (await request(app()).patch("/api/entities/acme").send({ vatRegistered: true })).status,
    ).toBe(400);
    const ok = await request(app())
      .patch("/api/entities/acme")
      .send({ tradingName: "Acme Co", ownerId: "bob" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: "Acme Co", ownerId: "alice" });
  });

  it("archive is soft and reversible", async () => {
    const a = await request(app()).post("/api/entities/acme/archive");
    expect(a.body.archivedAt).toBeTruthy();
    expect(col("entities").has("acme")).toBe(true);
    const u = await request(app()).post("/api/entities/acme/unarchive");
    expect(u.body.archivedAt).toBeUndefined();
  });
});
