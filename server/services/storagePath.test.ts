import { describe, it, expect } from "vitest";
import { extractFirebaseStoragePath, isOwnedStoragePath } from "./storagePath";

// H6 regression: the property-delete cascade must only delete storage objects
// under the caller's own prefix. property.image is a client-supplied URL, so a
// crafted firebasestorage URL pointing at another user's object path must NOT
// be considered owned (and therefore must not be deleted).
describe("isOwnedStoragePath (H6 — cross-user storage deletion guard)", () => {
  const uid = "me123";

  it("accepts the caller's own property-photo path", () => {
    expect(isOwnedStoragePath(`properties/${uid}/123-abc.jpg`, uid)).toBe(true);
  });

  it("accepts the caller's own document path", () => {
    expect(isOwnedStoragePath(`documents/${uid}/prop-1/lease.pdf`, uid)).toBe(true);
  });

  it("REJECTS another user's property-photo path (the attack)", () => {
    expect(isOwnedStoragePath("properties/victim999/secret.jpg", uid)).toBe(false);
  });

  it("REJECTS another user's document path", () => {
    expect(isOwnedStoragePath("documents/victim999/prop-x/lease.pdf", uid)).toBe(false);
  });

  it("rejects a uid-prefix-collision attempt (victim id starts with caller id)", () => {
    // "me123" must NOT match "properties/me123EVIL/..." — the trailing slash
    // in the prefix prevents this.
    expect(isOwnedStoragePath("properties/me123EVIL/x.jpg", uid)).toBe(false);
  });

  it("rejects unrelated top-level prefixes (avatars, listings, etc.)", () => {
    expect(isOwnedStoragePath(`avatars/${uid}/a.png`, uid)).toBe(false);
    expect(isOwnedStoragePath(`listings/${uid}/a.png`, uid)).toBe(false);
  });

  it("rejects empty / non-string inputs", () => {
    expect(isOwnedStoragePath("", uid)).toBe(false);
    // @ts-expect-error runtime safety
    expect(isOwnedStoragePath(null, uid)).toBe(false);
    expect(isOwnedStoragePath(`properties/${uid}/x.jpg`, "")).toBe(false);
  });
});

describe("extractFirebaseStoragePath", () => {
  it("extracts the path from a standard firebasestorage URL", () => {
    const url =
      "https://firebasestorage.googleapis.com/v0/b/olio-wallet.firebasestorage.app/o/properties%2Fuid123%2F123-abc.jpg?alt=media&token=xyz";
    expect(extractFirebaseStoragePath(url)).toBe("properties/uid123/123-abc.jpg");
  });

  it("decodes URL-encoded slashes in the path", () => {
    const url =
      "https://firebasestorage.googleapis.com/v0/b/bucket/o/avatars%2Fuid%2Ffile.png?alt=media&token=tok";
    expect(extractFirebaseStoragePath(url)).toBe("avatars/uid/file.png");
  });

  it("handles paths with spaces, parens, and other special chars", () => {
    const url =
      "https://firebasestorage.googleapis.com/v0/b/bucket/o/documents%2Fuid%2Flease%20(2026).pdf?alt=media&token=tok";
    expect(extractFirebaseStoragePath(url)).toBe("documents/uid/lease (2026).pdf");
  });

  it("works without the alt=media + token query (the path is still extractable)", () => {
    expect(
      extractFirebaseStoragePath(
        "https://firebasestorage.googleapis.com/v0/b/bucket/o/path%2Ffoo.png",
      ),
    ).toBe("path/foo.png");
  });

  // ── Rejection set ────────────────────────────────────────────────

  it("returns null for non-firebasestorage hosts", () => {
    expect(extractFirebaseStoragePath("https://evil.com/v0/b/bucket/o/secret")).toBeNull();
    expect(
      extractFirebaseStoragePath("https://storage.googleapis.com/bucket/o/file.png"),
    ).toBeNull();
  });

  it("returns null for URLs that don't have the /o/ marker", () => {
    expect(
      extractFirebaseStoragePath(
        "https://firebasestorage.googleapis.com/v0/b/bucket/something-else",
      ),
    ).toBeNull();
  });

  it("returns null for empty path after /o/", () => {
    expect(
      extractFirebaseStoragePath("https://firebasestorage.googleapis.com/v0/b/bucket/o/"),
    ).toBeNull();
  });

  it("returns null for malformed inputs", () => {
    expect(extractFirebaseStoragePath("")).toBeNull();
    expect(extractFirebaseStoragePath("not a url")).toBeNull();
    expect(
      extractFirebaseStoragePath("ftp://firebasestorage.googleapis.com/v0/b/bucket/o/x"),
    ).toBeNull();
  });

  it("returns null for null / undefined / non-string", () => {
    // @ts-expect-error — testing runtime safety
    expect(extractFirebaseStoragePath(null)).toBeNull();
    // @ts-expect-error
    expect(extractFirebaseStoragePath(undefined)).toBeNull();
    // @ts-expect-error
    expect(extractFirebaseStoragePath(123)).toBeNull();
  });

  it("returns null for malformed percent-encoding (refuses garbage)", () => {
    // `%` not followed by 2 hex chars throws on decodeURIComponent —
    // we catch + return null rather than passing through.
    expect(
      extractFirebaseStoragePath("https://firebasestorage.googleapis.com/v0/b/bucket/o/%ZZbad"),
    ).toBeNull();
  });

  it("safely rejects URLs trying to abuse the host check (subdomain)", () => {
    expect(
      extractFirebaseStoragePath("https://firebasestorage.googleapis.com.evil.com/v0/b/x/o/y"),
    ).toBeNull();
  });
});
