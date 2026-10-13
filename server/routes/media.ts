// Photo-upload signed-URL gateways. Same 3-step pattern as avatars +
// documents — the browser asks for a resumable URL, PUTs the bytes,
// then asks the server to finalize (which size-checks + mints a
// download token).
//
//   /api/properties/photo/upload-url     → property photos (any user;
//                                          ownership checked at attach)
//   /api/properties/photo/finalize
//
//   /api/admin/listings/photo/upload-url → marketplace listing photos
//                                          (admin + comm.partners)
//   /api/admin/listings/photo/finalize
//
// Property photos are uid-scoped under PROPERTY_PHOTO_PREFIX; listing
// photos under LISTING_PHOTO_PREFIX. finalize() enforces the prefix
// match so a forged objectPath can't overwrite another user's storage.

import type { Express, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { bucket, storageBucketName } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import {
  ALLOWED_IMAGE_MIME_TO_EXT,
  LISTING_PHOTO_PREFIX,
  PROPERTY_PHOTO_PREFIX,
} from "../services/storageTypes";
import type { PlatformPrivilegeKey, Role } from "../../shared/firestore-schema";

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export interface MediaDeps {
  requireRole: (...roles: Role[]) => RequestHandler;
  requirePlatformPrivilege: (p: PlatformPrivilegeKey) => RequestHandler;
}

export function registerMediaRoutes(
  app: Express,
  { requireRole, requirePlatformPrivilege }: MediaDeps,
): void {
  // ── Property photos ───────────────────────────────────────────────
  // Any authenticated user can upload to their own uid subfolder;
  // final authorization (admin override OR owner-of-this-property) is
  // enforced at the create/edit endpoint where the photo URL is
  // actually attached. One object per call (no sweep of older files)
  // since each property keeps its own image.
  app.post("/api/properties/photo/upload-url", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const limit = await rateLimit(`property-photo-url:${uid}`, 120, 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many upload attempts. Try again shortly.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const contentType = typeof body.contentType === "string" ? body.contentType : "";
    const ext = ALLOWED_IMAGE_MIME_TO_EXT[contentType];
    if (!ext) {
      return res.status(400).json({ error: "Unsupported image type. Use JPEG, PNG, or WebP." });
    }

    const objectPath = `${PROPERTY_PHOTO_PREFIX}/${uid}/${Date.now()}-${randomUUID()}.${ext}`;
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
  });

  app.post("/api/properties/photo/finalize", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const objectPath = typeof body.objectPath === "string" ? body.objectPath : "";

    // finalize re-mints a download token on every call. Cap it (mirroring
    // the upload-url 120/hr limit) so it can't be looped — the upstream
    // cap only bounds object creation, not finalize replays.
    const limit = await rateLimit(`photo-finalize:${uid}`, 120, 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many uploads. Try again shortly.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    // Confine the user's writes to their own property-photo folder
    // so a forged objectPath can't overwrite arbitrary storage.
    const expectedPrefix = `${PROPERTY_PHOTO_PREFIX}/${uid}/`;
    if (!objectPath.startsWith(expectedPrefix)) {
      return res.status(400).json({ error: "Invalid object path" });
    }

    const file = bucket().file(objectPath);
    try {
      const [exists] = await file.exists();
      if (!exists) {
        return res.status(404).json({ error: "Upload not found. Try uploading again." });
      }

      // Size cap — listing/property photos should never exceed 10
      // MB. Without this, an authenticated user could PUT arbitrary
      // bytes (GCS doesn't enforce content-shape on resumable
      // uploads) and finalize, leaving the object in storage
      // forever.
      const [photoMeta] = await file.getMetadata();
      const photoSize = Number(photoMeta.size ?? 0);
      if (photoSize > MAX_PHOTO_BYTES) {
        await file.delete().catch(() => undefined);
        return res.status(413).json({
          error: "Image exceeds 10 MB. Compress or pick a smaller photo.",
        });
      }

      const token = randomUUID();
      await file.setMetadata({
        metadata: { firebaseStorageDownloadTokens: token },
      });
      const photoURL = `https://firebasestorage.googleapis.com/v0/b/${storageBucketName}/o/${encodeURIComponent(
        objectPath,
      )}?alt=media&token=${token}`;

      res.json({ photoURL });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to finalize photo") });
    }
  });

  // ── Marketplace listing photos (admin only) ───────────────────────
  // Same shape as the property gateway but gated by `comm.partners`
  // since admins on the marketing side may have that privilege
  // without `properties.editAny`.
  app.post(
    "/api/admin/listings/photo/upload-url",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.partners"),
    async (req, res) => {
      const { uid } = req.user!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const contentType = typeof body.contentType === "string" ? body.contentType : "";
      const ext = ALLOWED_IMAGE_MIME_TO_EXT[contentType];
      if (!ext) {
        return res.status(400).json({ error: "Unsupported image type. Use JPEG, PNG, or WebP." });
      }

      const objectPath = `${LISTING_PHOTO_PREFIX}/${uid}/${Date.now()}-${randomUUID()}.${ext}`;
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
    "/api/admin/listings/photo/finalize",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.partners"),
    async (req, res) => {
      const { uid } = req.user!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const objectPath = typeof body.objectPath === "string" ? body.objectPath : "";

      const expectedPrefix = `${LISTING_PHOTO_PREFIX}/${uid}/`;
      if (!objectPath.startsWith(expectedPrefix)) {
        return res.status(400).json({ error: "Invalid object path" });
      }

      const file = bucket().file(objectPath);
      try {
        const [exists] = await file.exists();
        if (!exists) {
          return res.status(404).json({ error: "Upload not found. Try uploading again." });
        }

        const [photoMeta] = await file.getMetadata();
        const photoSize = Number(photoMeta.size ?? 0);
        if (photoSize > MAX_PHOTO_BYTES) {
          await file.delete().catch(() => undefined);
          return res.status(413).json({
            error: "Image exceeds 10 MB. Compress or pick a smaller photo.",
          });
        }

        const token = randomUUID();
        await file.setMetadata({
          metadata: { firebaseStorageDownloadTokens: token },
        });
        const photoURL = `https://firebasestorage.googleapis.com/v0/b/${storageBucketName}/o/${encodeURIComponent(
          objectPath,
        )}?alt=media&token=${token}`;

        res.json({ photoURL });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to finalize photo") });
      }
    },
  );
}
