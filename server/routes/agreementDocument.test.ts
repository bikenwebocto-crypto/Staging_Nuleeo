// Behavior tests for the signed-lease document endpoints on an agreement —
// the three-step signed-URL gateway scoped to ONE lease, PDF-only
// (server/routes/portfolio.ts, "Signed-lease document" section):
//
//   • POST /api/owner/agreements/:id/document/upload-url — mints a resumable
//     upload URL under a per-agreement object path. PDF-only, owner-self.
//   • POST /api/owner/agreements/:id/document/finalize — confirms the uploaded
//     object (path confined to the agreement folder, ≤25 MB, application/pdf),
//     writes agreement.signedLeaseDocument, replaces any prior object, notifies
//     the tenant, and returns the freshly signed read URL.
//   • DELETE /api/owner/agreements/:id/document — clears the field and deletes
//     the stored object.
//
// Mocking strategy mirrors portfolio.test.ts (same module, sibling file) and
// documents.signedUrl.test.ts (same signed-URL gateway pattern): an in-memory
// Firestore double for agreements + tenants, a Storage double whose file()
// handle records every createResumableUpload/exists/getMetadata/delete call so
// we can assert the replace + validation branches, a pass-through requireAuth
// injecting a test-controlled req.user, a permissive privilege gate (the gate
// itself is covered by the routes.integration surface test), and a notifyUser
// spy. registerPortfolioRoutes is imported AFTER the mocks are registered.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mutable test state ─────────────────────────────────────────────────

interface TestUser {
  uid: string;
  email?: string;
  profile?: Record<string, unknown>;
}

let currentUser: TestUser = { uid: "owner-uid", email: "owner@example.com" };

// Per-collection in-memory stores.
const agreementsById = new Map<string, Record<string, unknown>>();
const tenantsById = new Map<string, Record<string, unknown>>();

// Storage double state. `existingObjects` keyed by objectPath → metadata the
// getMetadata() call should return (size + contentType). createResumableUpload,
// exists, getMetadata, and delete calls are recorded so tests can assert the
// path that was signed and which objects were deleted (replace semantics).
const existingObjects = new Map<string, { size: number; contentType: string }>();
const resumableCalls: Array<{ objectPath: string; opts: Record<string, unknown> }> = [];
const deleteCalls: string[] = [];

// notifyUser spy.
const notifyUserSpy = vi.fn(async () => undefined);

beforeEach(() => {
  currentUser = { uid: "owner-uid", email: "owner@example.com" };
  agreementsById.clear();
  tenantsById.clear();
  existingObjects.clear();
  resumableCalls.length = 0;
  deleteCalls.length = 0;
  notifyUserSpy.mockClear();
});

// ── Firestore double ───────────────────────────────────────────────────

function makeQuerySnap(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  return {
    empty: docs.length === 0,
    size: docs.length,
    docs: docs.map((d) => ({
      id: d.id,
      ref: { id: d.id },
      data: () => d.data,
      exists: true,
    })),
  };
}

function makeDocRef(store: Map<string, Record<string, unknown>>, id: string) {
  return {
    id,
    async get() {
      const data = store.get(id);
      return { exists: !!data, id, data: () => data };
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const existing = store.get(id);
      store.set(id, opts?.merge ? { ...existing, ...data } : data);
    },
    async update(updates: Record<string, unknown>) {
      const existing = store.get(id);
      if (!existing) throw new Error(`no doc ${id}`);
      store.set(id, { ...existing, ...updates });
    },
  };
}

const dbDouble = {
  collection: (name: string) => ({
    doc: (id?: string) => {
      const finalId = id ?? `auto_${Math.random().toString(36).slice(2, 10)}`;
      if (name === "agreements") return makeDocRef(agreementsById, finalId);
      if (name === "tenants") return makeDocRef(tenantsById, finalId);
      return makeDocRef(new Map(), finalId);
    },
    where: (_field: string, _op: string, _value: unknown) => {
      const q: {
        where: (f: string, o: string, v: unknown) => typeof q;
        get: () => Promise<ReturnType<typeof makeQuerySnap>>;
      } = {
        where: () => q,
        get: async () => makeQuerySnap([]),
      };
      return q;
    },
  }),
};

// ── Storage double ─────────────────────────────────────────────────────
//
// Each file(objectPath) returns a handle whose ops resolve against
// existingObjects + record into the call logs. getSignedUrl is included so the
// real signReadUrl service (which calls bucket().file().getSignedUrl) yields a
// deterministic v4-looking URL on the finalize success path.

function makeFile(objectPath: string) {
  return {
    async createResumableUpload(opts: Record<string, unknown>) {
      resumableCalls.push({ objectPath, opts });
      return [`https://storage.googleapis.com/resumable/${encodeURIComponent(objectPath)}`];
    },
    async exists() {
      return [existingObjects.has(objectPath)];
    },
    async getMetadata() {
      const meta = existingObjects.get(objectPath);
      return [
        {
          size: meta?.size ?? 0,
          contentType: meta?.contentType ?? "",
        },
      ];
    },
    async delete() {
      deleteCalls.push(objectPath);
      existingObjects.delete(objectPath);
      return undefined;
    },
    async getSignedUrl(opts: Record<string, unknown>) {
      const exp = String(opts.expires ?? "");
      return [
        `https://storage.googleapis.com/olio-wallet/${encodeURIComponent(objectPath)}` +
          `?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Expires=86400&X-Goog-Date=${exp}` +
          `&X-Goog-Signature=deadbeef`,
      ];
    },
  };
}

const bucketDouble = {
  file: (objectPath: string) => makeFile(objectPath),
};

// ── Module mocks ───────────────────────────────────────────────────────

vi.mock("../firebase", () => ({
  db: () => dbDouble,
  bucket: () => bucketDouble,
  storageBucketName: "test-bucket",
  initFirebase: () => ({}),
  auth: () => ({
    async getUserByEmail() {
      const err = new Error("no user") as Error & { code?: string };
      err.code = "auth/user-not-found";
      throw err;
    },
  }),
}));

vi.mock("../auth", () => ({
  requireAuth: (req: { user?: TestUser }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../services/rateLimit", () => ({
  checkAndIncrement: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("../services/push", () => ({
  notifyUser: notifyUserSpy,
  sendPush: vi.fn(),
  PushError: class extends Error {
    status = 0;
  },
  getPushIntegrationStatus: () => ({ configured: false }),
}));

vi.mock("../services/transactionalEmail", () => ({
  sendTenantAgreementInviteEmail: vi.fn(),
  sendUserInviteEmail: vi.fn(),
  sendPortfolioAccessInviteEmail: vi.fn(),
}));

// Banking lookup runs only on the agreement-create endpoint, but the module
// imports it at load time — stub it so the import chain stays inert.
vi.mock("../services/portfolioBanking", () => ({
  loadPortfolioBanking: async () => currentUser.profile ?? {},
}));

// ── Build the test app ────────────────────────────────────────────────

const { registerPortfolioRoutes } = await import("./portfolio");

function buildApp() {
  const app = express();
  app.use(express.json());
  registerPortfolioRoutes(app, {
    requireOwnerPlanPrivilege: () => (_req, _res, next) => next(),
  });
  return app;
}

// ── Helpers ────────────────────────────────────────────────────────────

function seedAgreement(id: string, ownerId: string, overrides: Record<string, unknown> = {}) {
  agreementsById.set(id, {
    id,
    tenantId: `tenant_${id}`,
    propertyId: "prop1",
    ownerId,
    status: "active",
    monthlyRent: 1500,
    ...overrides,
  });
}

// The per-agreement object-path prefix the endpoints confine uploads to.
function prefixFor(uid: string, propertyId: string, agreementId: string) {
  return `documents/${uid}/${propertyId}/agreements/${agreementId}/`;
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/owner/agreements/:id/document/upload-url
// ──────────────────────────────────────────────────────────────────────

describe("POST /api/owner/agreements/:id/document/upload-url", () => {
  it("returns 400 when the contentType is not application/pdf", async () => {
    seedAgreement("agr1", "owner-uid");
    const res = await request(buildApp())
      .post("/api/owner/agreements/agr1/document/upload-url")
      .send({ contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be a PDF/i);
    // No upload URL was minted.
    expect(resumableCalls).toHaveLength(0);
  });

  it("returns 403 when the agreement belongs to another owner", async () => {
    seedAgreement("agr2", "someone-else");
    const res = await request(buildApp())
      .post("/api/owner/agreements/agr2/document/upload-url")
      .send({ contentType: "application/pdf" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not your agreement/i);
    expect(resumableCalls).toHaveLength(0);
  });

  it("returns 404 when the agreement does not exist", async () => {
    const res = await request(buildApp())
      .post("/api/owner/agreements/missing/document/upload-url")
      .send({ contentType: "application/pdf" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/agreement not found/i);
    expect(resumableCalls).toHaveLength(0);
  });

  it("mints an upload URL with an objectPath under the per-agreement prefix", async () => {
    seedAgreement("agr3", "owner-uid", { propertyId: "prop9" });
    const res = await request(buildApp())
      .post("/api/owner/agreements/agr3/document/upload-url")
      .send({ contentType: "application/pdf" });

    expect(res.status).toBe(200);
    expect(res.body.contentType).toBe("application/pdf");
    expect(typeof res.body.uploadUrl).toBe("string");
    expect(res.body.uploadUrl.length).toBeGreaterThan(0);

    const expectedPrefix = prefixFor("owner-uid", "prop9", "agr3");
    expect(String(res.body.objectPath).startsWith(expectedPrefix)).toBe(true);
    expect(String(res.body.objectPath).endsWith(".pdf")).toBe(true);

    // The resumable upload was created for exactly that object, carrying the
    // PDF content type in its metadata.
    expect(resumableCalls).toHaveLength(1);
    expect(resumableCalls[0].objectPath).toBe(res.body.objectPath);
    expect((resumableCalls[0].opts.metadata as Record<string, unknown>).contentType).toBe(
      "application/pdf",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/owner/agreements/:id/document/finalize
// ──────────────────────────────────────────────────────────────────────

describe("POST /api/owner/agreements/:id/document/finalize", () => {
  it("returns 400 when objectPath is outside the per-agreement prefix", async () => {
    seedAgreement("agr1", "owner-uid");
    // A path under a DIFFERENT agreement's folder — a forged graft attempt.
    const forged = "documents/owner-uid/prop1/agreements/other-agr/123-x.pdf";
    existingObjects.set(forged, { size: 1000, contentType: "application/pdf" });

    const res = await request(buildApp())
      .post("/api/owner/agreements/agr1/document/finalize")
      .send({ objectPath: forged });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid object path/i);
    // Nothing written to the agreement.
    expect(agreementsById.get("agr1")?.signedLeaseDocument).toBeUndefined();
  });

  it("returns 404 when the uploaded object does not exist", async () => {
    seedAgreement("agr1", "owner-uid");
    const objectPath = `${prefixFor("owner-uid", "prop1", "agr1")}123-x.pdf`;
    // existingObjects intentionally left empty → exists() resolves false.

    const res = await request(buildApp())
      .post("/api/owner/agreements/agr1/document/finalize")
      .send({ objectPath });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/upload not found/i);
    expect(agreementsById.get("agr1")?.signedLeaseDocument).toBeUndefined();
  });

  it("writes signedLeaseDocument with the right shape and returns 201 with the signed URL", async () => {
    seedAgreement("agr1", "owner-uid");
    const objectPath = `${prefixFor("owner-uid", "prop1", "agr1")}123-abc.pdf`;
    existingObjects.set(objectPath, { size: 4242, contentType: "application/pdf" });

    const res = await request(buildApp())
      .post("/api/owner/agreements/agr1/document/finalize")
      .send({ objectPath, name: "Signed Lease 2026.pdf" });

    expect(res.status).toBe(201);
    // Response shape.
    expect(res.body.documentName).toBe("Signed Lease 2026.pdf");
    expect(res.body.documentSize).toBe(4242);
    expect(typeof res.body.documentUploadedAt).toBe("string");
    expect(res.body.documentUrl).toContain("X-Goog-Signature=");

    // Persisted document descriptor.
    const stored = agreementsById.get("agr1")?.signedLeaseDocument as Record<string, unknown>;
    expect(stored).toMatchObject({
      storagePath: objectPath,
      name: "Signed Lease 2026.pdf",
      contentType: "application/pdf",
      size: 4242,
      uploadedBy: "owner-uid",
    });
    expect(typeof stored.uploadedAt).toBe("string");
    // uploadedAt on the doc matches the returned documentUploadedAt.
    expect(stored.uploadedAt).toBe(res.body.documentUploadedAt);
  });

  it("returns 413 and deletes the object when it exceeds 25 MB", async () => {
    seedAgreement("agr1", "owner-uid");
    const objectPath = `${prefixFor("owner-uid", "prop1", "agr1")}big.pdf`;
    existingObjects.set(objectPath, {
      size: 26 * 1024 * 1024,
      contentType: "application/pdf",
    });

    const res = await request(buildApp())
      .post("/api/owner/agreements/agr1/document/finalize")
      .send({ objectPath });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/25 MB/i);
    // Oversized object was deleted, and nothing was persisted.
    expect(deleteCalls).toContain(objectPath);
    expect(agreementsById.get("agr1")?.signedLeaseDocument).toBeUndefined();
  });

  it("returns 400 and deletes the object when the stored contentType is not a PDF", async () => {
    seedAgreement("agr1", "owner-uid");
    const objectPath = `${prefixFor("owner-uid", "prop1", "agr1")}sneaky.pdf`;
    existingObjects.set(objectPath, { size: 1000, contentType: "image/png" });

    const res = await request(buildApp())
      .post("/api/owner/agreements/agr1/document/finalize")
      .send({ objectPath });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be a PDF/i);
    expect(deleteCalls).toContain(objectPath);
    expect(agreementsById.get("agr1")?.signedLeaseDocument).toBeUndefined();
  });

  it("replace semantics: deletes the previously attached object when swapping the signed copy", async () => {
    const prevPath = `${prefixFor("owner-uid", "prop1", "agr1")}old.pdf`;
    seedAgreement("agr1", "owner-uid", {
      signedLeaseDocument: {
        storagePath: prevPath,
        name: "Old.pdf",
        contentType: "application/pdf",
        size: 100,
        uploadedAt: "2026-01-01T00:00:00.000Z",
        uploadedBy: "owner-uid",
      },
    });
    const newPath = `${prefixFor("owner-uid", "prop1", "agr1")}new.pdf`;
    existingObjects.set(newPath, { size: 2000, contentType: "application/pdf" });

    const res = await request(buildApp())
      .post("/api/owner/agreements/agr1/document/finalize")
      .send({ objectPath: newPath });

    expect(res.status).toBe(201);
    // The prior object was deleted (orphan cleanup), the new one kept.
    expect(deleteCalls).toContain(prevPath);
    expect(deleteCalls).not.toContain(newPath);
    // The descriptor now points at the new object.
    expect(
      (agreementsById.get("agr1")?.signedLeaseDocument as Record<string, unknown>).storagePath,
    ).toBe(newPath);
  });

  it("notifies the linked tenant (best-effort) that the signed lease is available", async () => {
    seedAgreement("agr1", "owner-uid");
    tenantsById.set("tenant_agr1", {
      id: "tenant_agr1",
      ownerId: "owner-uid",
      userId: "tenant-uid-123",
      status: "active",
    });
    const objectPath = `${prefixFor("owner-uid", "prop1", "agr1")}123-abc.pdf`;
    existingObjects.set(objectPath, { size: 1000, contentType: "application/pdf" });

    const res = await request(buildApp())
      .post("/api/owner/agreements/agr1/document/finalize")
      .send({ objectPath });

    expect(res.status).toBe(201);
    expect(notifyUserSpy).toHaveBeenCalledTimes(1);
    const args = notifyUserSpy.mock.calls[0][0] as {
      externalUserId?: string;
      category?: string;
    };
    expect(args.externalUserId).toBe("tenant-uid-123");
    expect(args.category).toBe("documents");
  });
});

// ──────────────────────────────────────────────────────────────────────
// DELETE /api/owner/agreements/:id/document
// ──────────────────────────────────────────────────────────────────────

describe("DELETE /api/owner/agreements/:id/document", () => {
  it("clears signedLeaseDocument, deletes the stored object, and returns 204", async () => {
    const storagePath = `${prefixFor("owner-uid", "prop1", "agr1")}old.pdf`;
    seedAgreement("agr1", "owner-uid", {
      signedLeaseDocument: {
        storagePath,
        name: "Lease.pdf",
        contentType: "application/pdf",
        size: 100,
        uploadedAt: "2026-01-01T00:00:00.000Z",
        uploadedBy: "owner-uid",
      },
    });
    existingObjects.set(storagePath, { size: 100, contentType: "application/pdf" });

    const res = await request(buildApp()).delete("/api/owner/agreements/agr1/document");

    expect(res.status).toBe(204);
    // Field nulled (merge), storage object deleted.
    expect(agreementsById.get("agr1")?.signedLeaseDocument).toBeNull();
    expect(deleteCalls).toContain(storagePath);
  });

  it("returns 204 even when there is no attached document (idempotent), with no delete", async () => {
    seedAgreement("agr1", "owner-uid"); // no signedLeaseDocument

    const res = await request(buildApp()).delete("/api/owner/agreements/agr1/document");

    expect(res.status).toBe(204);
    expect(agreementsById.get("agr1")?.signedLeaseDocument).toBeNull();
    expect(deleteCalls).toHaveLength(0);
  });

  it("returns 403 when the agreement belongs to another owner", async () => {
    const storagePath = `${prefixFor("someone-else", "prop1", "agr2")}old.pdf`;
    seedAgreement("agr2", "someone-else", {
      signedLeaseDocument: {
        storagePath,
        name: "Lease.pdf",
        contentType: "application/pdf",
        size: 100,
        uploadedAt: "2026-01-01T00:00:00.000Z",
        uploadedBy: "someone-else",
      },
    });

    const res = await request(buildApp()).delete("/api/owner/agreements/agr2/document");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not your agreement/i);
    // Untouched — the document descriptor survives and no delete fired.
    expect(agreementsById.get("agr2")?.signedLeaseDocument).toBeTruthy();
    expect(deleteCalls).toHaveLength(0);
  });
});
