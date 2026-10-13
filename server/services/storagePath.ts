// Extract the storage object path from a Firebase Storage download URL.
//
// Used by the property + unit delete cascade — `property.image` and
// `unit.image` are persisted as full URLs of shape:
//
//   https://firebasestorage.googleapis.com/v0/b/BUCKET/o/PATH?alt=media&token=TOKEN
//
// The PATH between `/o/` and `?` is URL-encoded; we decode it back
// to the bucket key (e.g. `properties/{uid}/{ts}-{uuid}.jpg`) so we
// can delete the specific object.
//
// Returns null for anything that doesn't match: external URLs,
// malformed input, paths that don't have the expected `/v0/b/.../o/`
// shape. The caller skips the cascade-delete on null — best-effort
// cleanup; never throw because cleanup failure shouldn't block the
// parent delete.

// Guard for the property-delete cascade: is this storage object path owned by
// `uid`? property.image / unit.image are client-supplied URLs, so a crafted
// firebasestorage URL could point a cascade delete at another user's object.
// Every legitimately-owned object the cascade touches lives under
// properties/{uid}/ (photos) or documents/{uid}/ (docs); reject anything else.
export function isOwnedStoragePath(path: string, uid: string): boolean {
  if (typeof path !== "string" || typeof uid !== "string" || uid.length === 0) {
    return false;
  }
  return path.startsWith(`properties/${uid}/`) || path.startsWith(`documents/${uid}/`);
}

export function extractFirebaseStoragePath(url: string): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Firebase Storage signed URLs are always https — reject anything
  // else to defend against ftp://, file://, javascript:, etc. URLs
  // that might parse cleanly but shouldn't reach bucket.file(...).delete.
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== "firebasestorage.googleapis.com") return null;
  const marker = "/o/";
  const idx = parsed.pathname.indexOf(marker);
  if (idx < 0) return null;
  const encoded = parsed.pathname.slice(idx + marker.length);
  if (encoded.length === 0) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    // Malformed percent-encoding — refuse rather than risk passing
    // garbage into bucket.file(path).delete().
    return null;
  }
}
