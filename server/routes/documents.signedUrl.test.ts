// M-23 regression: owner document downloads must hand the client an EXPIRING
// v4 signed URL, not a permanent `firebaseStorageDownloadTokens` capability URL
// (which never expires, bypasses storage.rules, and is revocable only by
// rotating/deleting the token).
//
// These tests pin the contract on the read path the client actually consumes —
// GET /api/owner/documents — asserting (a) the returned downloadURL is a v4
// signed URL, never a firebasestorage token URL, and (b) the underlying
// getSignedUrl call is `version:"v4", action:"read"` with a future expiry.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COL } from "../../shared/firestore-schema";

// ── Mutable test state ─────────────────────────────────────────────────
let currentUser: { uid: string; email?: string } = { uid: "owner-uid" };

const propertiesById = new Map<string, Record<string, unknown>>();
const documentRows: Array<Record<string, unknown>> = [];
// Phase 4: the owner list keys SOLELY off the stamped portfolioId, resolved
// via ensurePortfolio → a portfolios `ownerId ==` query — so the double
// serves a portfolios collection too.
const portfolioRows: Array<Record<string, unknown>> = [];

// Records the options passed to getSignedUrl so we can assert on them.
const getSignedUrlCalls: Array<{ storagePath: string; opts: Record<string, unknown> }> = [];

// ── Mocks ──────────────────────────────────────────────────────────────
function makeQuerySnap(rows: Array<Record<string, unknown>>) {
  return {
    empty: rows.length === 0,
    size: rows.length,
    docs: rows.map((data, i) => ({
      id: (data.id as string) ?? String(i),
      ref: { id: (data.id as string) ?? String(i) },
      data: () => data,
      exists: true,
    })),
  };
}

function makeQuery(rows: Array<Record<string, unknown>>) {
  const filters: Array<{ field: string; value: unknown }> = [];
  let limit: number | null = null;
  const builder = {
    where(field: string, _op: string, value: unknown) {
      filters.push({ field, value });
      return builder;
    },
    // getPortfolio resolves the owner's portfolio via .limit(1).
    limit(n: number) {
      limit = n;
      return builder;
    },
    async get() {
      let out = rows;
      for (const f of filters) out = out.filter((r) => r[f.field] === f.value);
      if (limit != null) out = out.slice(0, limit);
      return makeQuerySnap(out);
    },
  };
  return builder;
}

vi.mock("../firebase", () => ({
  db: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        async get() {
          if (name === COL.properties) {
            const d = propertiesById.get(id);
            return { exists: !!d, data: () => (d ? { id, ...d } : undefined) };
          }
          return { exists: false, data: () => undefined };
        },
      }),
      where: (field: string, op: string, value: unknown) =>
        makeQuery(
          name === COL.documents ? documentRows : name === COL.portfolios ? portfolioRows : [],
        ).where(field, op, value),
    }),
  }),
  bucket: () => ({
    file: (storagePath: string) => ({
      getSignedUrl: async (opts: Record<string, unknown>) => {
        getSignedUrlCalls.push({ storagePath, opts });
        // Shape mirrors a real GCS v4 signed URL: storage.googleapis.com host
        // with X-Goog-* query params — deliberately NOT the firebasestorage
        // token URL the old code produced.
        const exp = String(opts.expires ?? "");
        return [
          `https://storage.googleapis.com/olio-wallet/${encodeURIComponent(storagePath)}` +
            `?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Expires=86400&X-Goog-Date=${exp}` +
            `&X-Goog-Signature=deadbeef`,
        ];
      },
    }),
  }),
}));

vi.mock("../auth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user: unknown }).user = currentUser;
    next();
  },
}));

vi.mock("../services/rateLimit", () => ({
  checkAndIncrement: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("../services/push", () => ({
  notifyUser: async () => undefined,
}));

// Import AFTER mocks are registered.
import { registerDocumentRoutes } from "./documents";

function makeApp() {
  const app = express();
  app.use(express.json());
  // requireOwnerPlanPrivilege is a no-op pass-through here; this test pins the
  // URL shape, not the privilege gate (covered elsewhere).
  registerDocumentRoutes(app, {
    requireOwnerPlanPrivilege:
      () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
        next(),
  });
  return app;
}

beforeEach(() => {
  currentUser = { uid: "owner-uid" };
  propertiesById.clear();
  documentRows.length = 0;
  portfolioRows.length = 0;
  getSignedUrlCalls.length = 0;
  propertiesById.set("prop1", { ownerId: "owner-uid", name: "Makariou III Ave" });
  portfolioRows.push({ id: "pf-owner", ownerId: "owner-uid" });
  documentRows.push({
    id: "doc1",
    ownerId: "owner-uid",
    // Phase 4: every row is stamped; the list queries by this key only.
    portfolioId: "pf-owner",
    propertyId: "prop1",
    name: "Lease.pdf",
    contentType: "application/pdf",
    size: 1234,
    storagePath: "documents/owner-uid/prop1/lease.pdf",
    // Stale/legacy value on the stored doc — must NOT be what we return.
    downloadURL:
      "https://firebasestorage.googleapis.com/v0/b/olio-wallet.firebasestorage.app/o/x?alt=media&token=abc",
    createdAt: "2026-06-01T00:00:00.000Z",
  });
});

describe("GET /api/owner/documents — expiring signed URLs (M-23)", () => {
  it("returns a v4 signed URL, not a permanent firebasestorage token URL", async () => {
    const res = await request(makeApp()).get("/api/owner/documents?propertyId=prop1");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const url: string = res.body[0].downloadURL;

    // The hallmark of a v4 signed URL: a signature + expiry in the query.
    expect(url).toContain("X-Goog-Signature=");
    expect(url).toContain("X-Goog-Expires=");
    // And it must NOT be the permanent capability URL.
    expect(url).not.toContain("firebasestorage.googleapis.com");
    expect(url).not.toContain("token=");
  });

  it("signs each doc with version v4, action read, and a future expiry", async () => {
    const before = Date.now();
    await request(makeApp()).get("/api/owner/documents?propertyId=prop1");

    expect(getSignedUrlCalls).toHaveLength(1);
    const { storagePath, opts } = getSignedUrlCalls[0];
    expect(storagePath).toBe("documents/owner-uid/prop1/lease.pdf");
    expect(opts.version).toBe("v4");
    expect(opts.action).toBe("read");
    // Expiry must be in the future (short-lived, not permanent).
    expect(Number(opts.expires)).toBeGreaterThan(before);
  });

  it("re-signs on every request (fresh per-request URL, never cached server-side)", async () => {
    const app = makeApp();
    await request(app).get("/api/owner/documents?propertyId=prop1");
    await request(app).get("/api/owner/documents?propertyId=prop1");
    // Two requests → two independent signing calls. The endpoint never reuses
    // a stored URL, so the client always gets a still-valid link.
    expect(getSignedUrlCalls).toHaveLength(2);
  });
});
