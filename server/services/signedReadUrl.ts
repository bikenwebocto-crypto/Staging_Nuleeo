// Shared v4 signed read-URL minting. Cloud Storage is deny-by-default
// (storage.rules) — the only read path is a short-lived, server-signed URL.
//
// Per M-23 (see server/routes/documents.ts), we never persist a permanent
// firebaseStorageDownloadTokens capability URL: those never expire, bypass
// storage.rules, and are revocable only by rotating/deleting the token. The
// durable source of truth is always the storagePath; every read mints a fresh,
// expiring URL via this helper. Used by the agreement read endpoints
// (portfolio.ts owner read, tenant.ts tenant read, adminQueries.ts) to hand the
// client a still-valid link for the signed-lease PDF attached to a lease.

import { bucket } from "../firebase";

// 24h matches the documents-route + briefing-route links. Clients re-fetch the
// agreement list per view (React Query), so they always receive a fresh,
// still-valid URL — the link is used immediately and never persisted long-term.
export const DEFAULT_READ_URL_TTL_MS = 24 * 60 * 60 * 1000;

// Mints a short-lived v4 signed read URL for one stored object. Best-effort:
// returns "" on failure (or empty path) so a single un-signable object never
// breaks a whole list response. Mirrors documents.ts `signDownloadUrl`.
export async function signReadUrl(
  storagePath: string,
  ttlMs: number = DEFAULT_READ_URL_TTL_MS,
): Promise<string> {
  if (!storagePath) return "";
  try {
    const [url] = await bucket()
      .file(storagePath)
      .getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + ttlMs,
      });
    return url;
  } catch {
    return "";
  }
}
