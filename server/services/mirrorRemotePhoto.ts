// Mirror a remote OAuth profile photo (e.g. a Google `lh3.googleusercontent.com`
// URL) into our own Cloud Storage bucket, returning a Firebase Storage download
// URL. This removes the avatar's dependence on a third-party CDN URL that can
// rotate/expire over time and that must otherwise be allowlisted in our CSP.
// Firebase Storage URLs are already CSP-allowlisted, so a mirrored photo is the
// durable form.
//
// Best-effort by design: any failure (SSRF guard, fetch error/timeout,
// non-image content-type, oversize, upload error) returns null so the caller
// can fall back to keeping the original remote URL. The CSP also allows
// *.googleusercontent.com as a safety net for that fallback path.
//
// Used by:
//   - GET /api/me (server/routes/profile.ts): first Google sign-in + backfill.
//   - script/mirrorGoogleAvatars.ts: one-off backfill of existing users.

import { randomUUID } from "node:crypto";
import { bucket, storageBucketName } from "../firebase";
import { ALLOWED_IMAGE_MIME_TO_EXT, AVATAR_PREFIX } from "./storageTypes";
import { isPublicHttpsUrl } from "./safeRedirect";
import { readBodyCapped } from "./fetchCapped";
import { logWarn } from "./log";

// Avatars are tiny (Google serves ~96px thumbnails); 5 MB is generous headroom
// and matches the cap on the user-initiated avatar upload in profile.ts.
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;

export async function mirrorRemotePhotoToStorage(
  uid: string,
  remoteUrl: string,
): Promise<string | null> {
  // SSRF guard — never fetch a private/loopback/metadata address even though
  // the URL comes from a verified provider claim. Mirrors briefing.ts's posture.
  if (!isPublicHttpsUrl(remoteUrl)) {
    logWarn("mirrorPhoto.blocked-url", { uid });
    return null;
  }

  // Bump Google's default `=s96-c` thumbnail to a crisper size for the larger
  // avatar slots. No-op for any URL that doesn't carry that size param.
  const url = remoteUrl.replace(/=s\d+(-c)?$/, "=s400$1");

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    // redirect:"error" blocks redirect-based SSRF bypass; Google avatar URLs
    // serve the image directly with no redirect.
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal, redirect: "error" });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      logWarn("mirrorPhoto.fetch-not-ok", { uid, status: res.status });
      return null;
    }

    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = ALLOWED_IMAGE_MIME_TO_EXT[contentType];
    if (!ext) {
      logWarn("mirrorPhoto.bad-content-type", { uid, contentType });
      return null;
    }

    const buf = await readBodyCapped(res, MAX_PHOTO_BYTES);
    if (!buf || buf.byteLength === 0) {
      logWarn("mirrorPhoto.bad-size", { uid, bytes: buf?.byteLength ?? -1 });
      return null;
    }

    // Same object-path + download-token shape as the avatar upload finalize
    // (profile.ts), so a mirrored photo is indistinguishable from an uploaded
    // one and the orphan-photo sweep treats them identically.
    const objectPath = `${AVATAR_PREFIX}/${uid}/${Date.now()}.${ext}`;
    const file = bucket().file(objectPath);
    const token = randomUUID();
    await file.save(buf, { resumable: false, contentType });
    await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });

    return `https://firebasestorage.googleapis.com/v0/b/${storageBucketName}/o/${encodeURIComponent(
      objectPath,
    )}?alt=media&token=${token}`;
  } catch (err: unknown) {
    logWarn("mirrorPhoto.failed", { uid, err: String(err).slice(0, 200) });
    return null;
  }
}
