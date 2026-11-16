// Behavior tests for the project CRUD surface:
//   GET    /api/projects
//   POST   /api/projects
//   PATCH  /api/projects/:id
//   DELETE /api/projects/:id
//
// Project records are a separate Firestore collection from properties, but
// deleting a project must unassign its properties rather than delete them.
// These tests pin down portfolio scoping, authorization, duplicate names and
// the unassign-on-delete contract.

import express from "express";
import request from "supertest";
import { FieldValue } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TestUser {
  uid: string;
  email?: string;
}

let currentUser: TestUser = { uid: "owner-1", email: "owner@example.com" };

const projectsById = new Map<string, Record<string, unknown>>();
const propertiesById = new Map<string, Record<string, unknown>>();
const portfolioByOwner = new Map<string, string>();

beforeEach(() => {
  currentUser = { uid: "owner-1", email: "owner@example.com" };
  projectsById.clear();
  propertiesById.clear();
  portfolioByOwner.clear();
  portfolioByOwner.set("owner-1", "portfolio-1");
  portfolioByOwner.set("owner-2", "portfolio-2");
});

// ── Firestore double ───────────────────────────────────────────────────

function storeFor(collection: string) {
  if (collection === "projects") return projectsById;
  if (collection === "properties") return propertiesById;
  return new Map<string, Record<string, unknown>>();
}

function makeQuerySnap(
  collection: string,
  docs: Array<{ id: string; data: Record<string, unknown> }>,
) {
  return {
    empty: docs.length === 0,
    size: docs.length,
    docs: docs.map((doc) => ({
      id: doc.id,
      ref: makeDocRef(collection, doc.id),
      data: () => doc.data,
      exists: true,
    })),
  };
}

function makeDocRef(collection: string, id: string) {
  const ref = {
    id,
    collection,
    async get() {
      const data = storeFor(collection).get(id);
      return {
        exists: !!data,
        id,
        ref,
        data: () => data,
      };
    },
    async set(data: Record<string, unknown>) {
      storeFor(collection).set(id, data);
    },
    async update(updates: Record<string, unknown>) {
      const store = storeFor(collection);
      const existing = store.get(id);
      if (!existing) throw new Error(`No ${collection}/${id} to update`);
      const next = { ...existing };
      for (const [key, value] of Object.entries(updates)) {
        if (value instanceof FieldValue) delete next[key];
        else next[key] = value;
      }
      store.set(id, next);
    },
    async delete() {
      storeFor(collection).delete(id);
    },
  };
  return ref;
}

interface QueryBuilder {
  where: (field: string, op: string, value: unknown) => QueryBuilder;
  limit: (n: number) => QueryBuilder;
  get: () => Promise<ReturnType<typeof makeQuerySnap>>;
}

function makeQuery(collection: string, initial?: { field: string; op: string; value: unknown }) {
  const filters = initial ? [initial] : [];
  const limits: number[] = [];
  const evaluate = () => {
    let rows = Array.from(storeFor(collection).entries()).map(([id, data]) => ({ id, data }));
    for (const filter of filters) {
      if (filter.op !== "==") throw new Error(`unsupported op ${filter.op}`);
      rows = rows.filter((row) => row.data[filter.field] === filter.value);
    }
    if (limits.length) rows = rows.slice(0, Math.min(...limits));
    return rows;
  };
  const query: QueryBuilder = {
    where(field, op, value) {
      filters.push({ field, op, value });
      return query;
    },
    limit(n) {
      limits.push(n);
      return query;
    },
    async get() {
      return makeQuerySnap(collection, evaluate());
    },
  };
  return query;
}

function makeCollection(collection: string) {
  return {
    doc(id?: string) {
      const finalId = id ?? `auto_${Math.random().toString(36).slice(2, 10)}`;
      return makeDocRef(collection, finalId);
    },
    where(field: string, op: string, value: unknown) {
      return makeQuery(collection, { field, op, value });
    },
  };
}

const dbDouble = {
  collection: (collection: string) => makeCollection(collection),
  batch() {
    const writes: Array<{ ref: ReturnType<typeof makeDocRef>; updates: Record<string, unknown> }> =
      [];
    return {
      update(ref: ReturnType<typeof makeDocRef>, updates: Record<string, unknown>) {
        writes.push({ ref, updates });
      },
      delete() {},
      set() {},
      async commit() {
        for (const write of writes) await write.ref.update(write.updates);
      },
    };
  },
};

vi.mock("../firebase", () => ({
  db: () => dbDouble,
}));

vi.mock("../auth", () => ({
  requireAuth: (req: { user?: TestUser }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
}));

vi.mock("../services/portfolioBanking", () => ({
  getPortfolio: async (uid: string) => {
    const id = portfolioByOwner.get(uid);
    return id ? { id, ownerId: uid } : null;
  },
  ensurePortfolio: async (uid: string) => {
    const id = portfolioByOwner.get(uid) ?? `portfolio-${uid}`;
    portfolioByOwner.set(uid, id);
    return { id, ownerId: uid };
  },
}));

// ── Test app ───────────────────────────────────────────────────────────

const { registerProjectRoutes } = await import("./projects");

function buildApp() {
  const app = express();
  app.use(express.json());
  registerProjectRoutes(app);
  return app;
}

function seedProject(id: string, data: Partial<Record<string, unknown>> = {}) {
  projectsById.set(id, {
    id,
    ownerId: "owner-1",
    portfolioId: "portfolio-1",
    name: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...data,
  });
}

function seedProperty(id: string, data: Partial<Record<string, unknown>> = {}) {
  propertiesById.set(id, {
    id,
    ownerId: "owner-1",
    portfolioId: "portfolio-1",
    address: `${id} Test St`,
    propertyValue: 100000,
    acquisitionPrice: 80000,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...data,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("GET /api/projects", () => {
  it("returns only projects from the caller's portfolio, sorted by name", async () => {
    seedProject("p-b", { name: "Beta" });
    seedProject("p-a", { name: "Alpha" });
    seedProject("other-1", { name: "Other", ownerId: "owner-2", portfolioId: "portfolio-2" });

    const res = await request(buildApp()).get("/api/projects");

    expect(res.status).toBe(200);
    expect(res.body.projects.map((project: { name: string }) => project.name)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  it("returns an empty list when the caller has no portfolio yet", async () => {
    portfolioByOwner.delete("owner-1");

    const res = await request(buildApp()).get("/api/projects");

    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
  });
});

describe("POST /api/projects", () => {
  it("creates a project in the caller's portfolio", async () => {
    const res = await request(buildApp()).post("/api/projects").send({ name: "  Seafront  " });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ownerId: "owner-1",
      portfolioId: "portfolio-1",
      name: "Seafront",
    });
    expect(projectsById.size).toBe(1);
  });

  it("returns the existing project for an exact-name duplicate", async () => {
    seedProject("existing", { name: "Seafront" });

    const res = await request(buildApp()).post("/api/projects").send({ name: "Seafront" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("existing");
    expect(projectsById.size).toBe(1);
  });

  it("rejects a missing name", async () => {
    const res = await request(buildApp()).post("/api/projects").send({ name: "   " });

    expect(res.status).toBe(400);
    expect(projectsById.size).toBe(0);
  });
});

describe("PATCH /api/projects/:id", () => {
  it("renames a project in the caller's portfolio", async () => {
    seedProject("p-1", { name: "Old name" });

    const res = await request(buildApp()).patch("/api/projects/p-1").send({ name: "New name" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("New name");
    expect(res.body.updatedAt).toEqual(expect.any(String));
    expect(projectsById.get("p-1")?.name).toBe("New name");
  });

  it("rejects a project owned by someone else without changing it", async () => {
    seedProject("p-1", { name: "Theirs", ownerId: "owner-2", portfolioId: "portfolio-2" });

    const res = await request(buildApp()).patch("/api/projects/p-1").send({ name: "Hijacked" });

    expect(res.status).toBe(404);
    expect(projectsById.get("p-1")?.name).toBe("Theirs");
  });

  it("rejects a project outside the caller's portfolio", async () => {
    seedProject("p-1", { name: "Elsewhere", portfolioId: "portfolio-2" });

    const res = await request(buildApp()).patch("/api/projects/p-1").send({ name: "Moved" });

    expect(res.status).toBe(404);
    expect(projectsById.get("p-1")?.name).toBe("Elsewhere");
  });

  it("rejects a duplicate name in the same portfolio", async () => {
    seedProject("p-1", { name: "Alpha" });
    seedProject("p-2", { name: "Beta" });

    const res = await request(buildApp()).patch("/api/projects/p-1").send({ name: "Beta" });

    expect(res.status).toBe(409);
    expect(projectsById.get("p-1")?.name).toBe("Alpha");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(buildApp()).patch("/api/projects/missing").send({ name: "Nope" });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/projects/:id", () => {
  it("deletes the project and unassigns only its properties in the same portfolio", async () => {
    seedProject("p-1", { name: "Seafront" });
    seedProperty("property-1", { projectId: "p-1" });
    seedProperty("property-2", { projectId: "p-1" });
    seedProperty("property-3", { projectId: "other-project" });
    seedProperty("property-4", {
      projectId: "p-1",
      ownerId: "owner-2",
      portfolioId: "portfolio-2",
    });

    const res = await request(buildApp()).delete("/api/projects/p-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, unassigned: 2 });
    expect(projectsById.has("p-1")).toBe(false);
    expect(propertiesById.has("property-1")).toBe(true);
    expect(propertiesById.has("property-2")).toBe(true);
    expect(propertiesById.get("property-1")?.projectId).toBeUndefined();
    expect(propertiesById.get("property-2")?.projectId).toBeUndefined();
    expect(propertiesById.get("property-3")?.projectId).toBe("other-project");
    expect(propertiesById.get("property-4")?.projectId).toBe("p-1");
  });

  it("does not delete or unassign anything for another owner's project", async () => {
    seedProject("p-1", { ownerId: "owner-2", portfolioId: "portfolio-2" });
    seedProperty("property-1", {
      ownerId: "owner-2",
      portfolioId: "portfolio-2",
      projectId: "p-1",
    });

    const res = await request(buildApp()).delete("/api/projects/p-1");

    expect(res.status).toBe(404);
    expect(projectsById.has("p-1")).toBe(true);
    expect(propertiesById.get("property-1")?.projectId).toBe("p-1");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(buildApp()).delete("/api/projects/missing");

    expect(res.status).toBe(404);
  });
});
