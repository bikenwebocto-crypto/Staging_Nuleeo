// Owner-document signed-URL gateway. Three-step write protocol
// (upload-url → browser PUT → finalize) gated on the owner-plan
// privilege `documents.upload`. Plus list + delete endpoints scoped
// to the owner's properties.

import type { Express, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { bucket, db } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { notifyUser } from "../services/push";
import { ensurePortfolio } from "../services/portfolioBanking";
import { DOCUMENT_PREFIX } from "../services/storageTypes";
import { sanitizeText } from "../services/unicodeSanitize";
import { reqStr } from "../util";
import {
  COL,
  type DocumentRecord,
  type OwnerPlanPrivilegeKey,
  type Property,
  type Tenant,
} from "../../shared/firestore-schema";

export interface DocumentsDeps {
  requireOwnerPlanPrivilege: (p: OwnerPlanPrivilegeKey) => RequestHandler;
}

// Doc upload MIME allowlist — broader than the image-only set
// (avatars/property/listing photos) because documents include PDFs +
// Office formats. Local to this module because no other endpoint
// shares it.
const ALLOWED_DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
};

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024; // 25 MB — enough for scanned PDFs.

// TTL for the v4 signed download URLs we hand the client. 24h matches the
// briefing-route document links (server/routes/briefing.ts). The client
// re-fetches the documents list per view (React Query), so it always gets a
// fresh, still-valid URL — the link is never persisted long-term.
const DOC_DOWNLOAD_URL_TTL_MS = 24 * 60 * 60 * 1000;

// Mints a short-lived v4 signed read URL for one stored object. Best-effort:
// returns "" on failure so a single un-signable object doesn't break the whole
// list response. Mirrors the briefing route's per-document signing.
async function signDownloadUrl(storagePath: string): Promise<string> {
  if (!storagePath) return "";
  try {
    const [url] = await bucket()
      .file(storagePath)
      .getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + DOC_DOWNLOAD_URL_TTL_MS,
      });
    return url;
  } catch {
    return "";
  }
}

export function registerDocumentRoutes(
  app: Express,
  { requireOwnerPlanPrivilege }: DocumentsDeps,
): void {
  app.post(
    "/api/owner/documents/upload-url",
    requireAuth,
    requireOwnerPlanPrivilege("documents.upload"),
    async (req, res) => {
      const { uid } = req.user!;
      // 120/hour cap on signed-URL mints — bulk doc uploads should be
      // possible but a tight loop shouldn't drain GCS quota.
      const limit = await rateLimit(`doc-url:${uid}`, 120, 60 * 60);
      if (!limit.allowed) {
        res.set("Retry-After", String(limit.retryAfterSeconds));
        return res.status(429).json({
          error: "Too many upload attempts. Try again shortly.",
          retryAfterSeconds: limit.retryAfterSeconds,
        });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const contentType = typeof body.contentType === "string" ? body.contentType : "";
      const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
      const ext = ALLOWED_DOCUMENT_TYPES[contentType];
      if (!ext) {
        return res
          .status(400)
          .json({ error: "Unsupported file type. Use PDF, JPG, PNG, DOCX, or XLSX." });
      }
      if (!propertyId) {
        return res.status(400).json({ error: "propertyId is required" });
      }

      // Confirm the property belongs to the caller — no cross-portfolio
      // uploads from this endpoint.
      const propSnap = await db().collection(COL.properties).doc(propertyId).get();
      if (!propSnap.exists) {
        return res.status(404).json({ error: "Property not found" });
      }
      if ((propSnap.data() as Property).ownerId !== uid) {
        return res.status(403).json({ error: "Not your property" });
      }

      const objectPath = `${DOCUMENT_PREFIX}/${uid}/${propertyId}/${Date.now()}-${randomUUID()}.${ext}`;
      const file = bucket().file(objectPath);
      try {
        const [uploadUrl] = await file.createResumableUpload({
          metadata: { contentType },
          origin: (req.headers.origin as string | undefined) ?? undefined,
        });
        res.json({ uploadUrl, objectPath, contentType });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to issue upload URL") });
      }
    },
  );

  app.post(
    "/api/owner/documents/finalize",
    requireAuth,
    requireOwnerPlanPrivilege("documents.upload"),
    async (req, res) => {
      const { uid } = req.user!;
      // finalize writes a NEW documents row, mints a download token, AND
      // (when tenantId is set) pushes the tenant on EVERY call. The
      // upstream upload-url cap only bounds object creation, not finalize
      // replays against an already-uploaded object — so without its own
      // limit an authenticated owner could loop finalize to spam Firestore
      // rows + tenant notifications. Mirror the upload-url 120/hr cap.
      const limit = await rateLimit(`doc-finalize:${uid}`, 120, 60 * 60);
      if (!limit.allowed) {
        res.set("Retry-After", String(limit.retryAfterSeconds));
        return res.status(429).json({
          error: "Too many uploads. Try again shortly.",
          retryAfterSeconds: limit.retryAfterSeconds,
        });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const objectPath = typeof body.objectPath === "string" ? body.objectPath : "";
      const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
      const displayName =
        typeof body.name === "string" && body.name.trim()
          ? // Display string (admin lists, push body) — strip bidi/zero-width
            // controls so a doc name can't spoof or render reversed.
            sanitizeText(body.name.trim(), 200) || "Document"
          : "Document";
      // Optional tenant attachment. When the owner uploads a document
      // for a specific tenant (lease, inventory list, etc.), we emit a
      // push so the tenant knows there's something new waiting.
      const tenantId =
        typeof body.tenantId === "string" && body.tenantId.trim()
          ? body.tenantId.trim()
          : undefined;

      // Confine each user's documents to their own folder so a forged
      // objectPath can't reference someone else's storage.
      const expectedPrefix = `${DOCUMENT_PREFIX}/${uid}/${propertyId}/`;
      if (!propertyId || !objectPath.startsWith(expectedPrefix)) {
        return res.status(400).json({ error: "Invalid object path" });
      }

      const file = bucket().file(objectPath);
      try {
        const [exists] = await file.exists();
        if (!exists) {
          return res.status(404).json({ error: "Upload not found. Try uploading again." });
        }

        const [metadata] = await file.getMetadata();
        const size = Number(metadata.size ?? 0);
        if (size > MAX_DOCUMENT_BYTES) {
          // Reject + clean up; the user is over the cap.
          await file.delete().catch(() => undefined);
          return res
            .status(413)
            .json({ error: "File exceeds 25 MB. Compress or split the document." });
        }
        const contentType = String(metadata.contentType ?? "application/octet-stream");

        // M-23: do NOT bake a permanent firebaseStorageDownloadTokens
        // capability URL into the doc — those never expire, bypass
        // storage.rules, and are revocable only by rotating/deleting the
        // token. `storagePath` is the durable source of truth; every read
        // path (the GET list below) mints a fresh, expiring v4 signed URL.
        // The stored downloadURL is signed once for the immediate client
        // response and will go stale — that's intentional, the list re-signs.
        const downloadURL = await signDownloadUrl(objectPath);

        // Phase-1 portfolio re-key: stamp the owner's STABLE portfolio doc id
        // on the new record at creation (reads still key off ownerId).
        const pf = await ensurePortfolio(uid);

        const now = new Date().toISOString();
        const docRef = db().collection(COL.documents).doc();
        const doc: DocumentRecord = {
          id: docRef.id,
          ownerId: uid,
          portfolioId: pf.id,
          propertyId,
          name: displayName,
          contentType,
          size,
          storagePath: objectPath,
          downloadURL,
          createdAt: now,
          ...(tenantId ? { tenantId } : {}),
        };
        await docRef.set(doc);

        // Push the tenant the doc is attached to, if any. We push to
        // the tenant's User.id (lives on the tenancy doc) — NOT the
        // tenantId body field, which is the tenancy doc id.
        if (tenantId) {
          try {
            const tenancySnap = await db().collection(COL.tenants).doc(tenantId).get();
            if (tenancySnap.exists) {
              const tenancy = tenancySnap.data() as Tenant;
              if (tenancy.userId && tenancy.ownerId === uid) {
                await notifyUser({
                  externalUserId: tenancy.userId,
                  category: "documents",
                  title: "New document from your landlord",
                  message: displayName,
                  url: "https://app.oliowallet.com/",
                });
              }
            }
          } catch {
            // Non-fatal — the doc is saved either way.
          }
        }

        res.status(201).json(doc);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to finalize document") });
      }
    },
  );

  // GET /api/owner/documents?propertyId=…  — list docs for one of the
  // caller's properties. propertyId is required because documents are
  // attached per-property; a future portfolio-wide endpoint can drop it.
  app.get(
    "/api/owner/documents",
    requireAuth,
    requireOwnerPlanPrivilege("documents.upload"),
    async (req, res) => {
      const { uid } = req.user!;
      const propertyId =
        typeof req.query.propertyId === "string" ? req.query.propertyId.trim() : "";
      if (!propertyId) {
        return res.status(400).json({ error: "propertyId is required" });
      }
      try {
        const propSnap = await db().collection(COL.properties).doc(propertyId).get();
        if (!propSnap.exists) {
          return res.status(404).json({ error: "Property not found" });
        }
        if ((propSnap.data() as Property).ownerId !== uid) {
          return res.status(403).json({ error: "Not your property" });
        }

        // Phase-4 portfolio re-key: list SOLELY by the STABLE portfolio id
        // (survives an owner transfer) + propertyId — every row is stamped
        // (backfill verified), so the Phase-2 legacy ownerId leg and its
        // dedupe-merge are gone. Two equality filters ride single-field
        // indexes (zigzag merge), no composite index to manage. The portfolio
        // resolution is required now: if it fails, the outer catch 500s
        // rather than silently serving an empty list.
        const portfolioId = (await ensurePortfolio(uid)).id;
        const docsSnap = await db()
          .collection(COL.documents)
          .where("portfolioId", "==", portfolioId)
          .where("propertyId", "==", propertyId)
          .get();
        const docs = docsSnap.docs
          .map((d) => d.data() as DocumentRecord)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        // M-23: hand the client a freshly-minted, short-lived signed URL per
        // request rather than the (now-stale, formerly-permanent) value stored
        // on the doc. The client uses these immediately and never persists
        // them, so a 24h TTL is ample.
        const withFreshUrls = await Promise.all(
          docs.map(async (d) => ({ ...d, downloadURL: await signDownloadUrl(d.storagePath) })),
        );
        res.json(withFreshUrls);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load documents") });
      }
    },
  );

  // DELETE /api/owner/documents/:id — remove both the Firestore doc and
  // the underlying storage object. Caller must own the document.
  app.delete(
    "/api/owner/documents/:id",
    requireAuth,
    requireOwnerPlanPrivilege("documents.upload"),
    async (req, res) => {
      const { uid } = req.user!;
      const docRef = db().collection(COL.documents).doc(reqStr(req.params.id));
      try {
        const snap = await docRef.get();
        if (!snap.exists) {
          return res.status(404).json({ error: "Document not found" });
        }
        const doc = snap.data() as DocumentRecord;
        if (doc.ownerId !== uid) {
          return res.status(403).json({ error: "Not your document" });
        }
        await Promise.all([
          docRef.delete(),
          bucket()
            .file(doc.storagePath)
            .delete()
            .catch(() => undefined),
        ]);
        res.status(204).end();
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to delete document") });
      }
    },
  );
}
