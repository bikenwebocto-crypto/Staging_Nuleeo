// Shared constants for Cloud Storage upload paths + MIME allowlists.
// Both the per-user avatar gateway and the per-property/per-listing
// photo gateways accept the same image MIME types — keeping the
// allowlist in one place means a new accepted format gets added once.
//
// The PREFIX constants double as the top-level Cloud Storage paths so
// `properties/{uid}/...`, `avatars/{uid}/...`, `listings/{uid}/...`
// all share the same uid-scoping pattern.

export const ALLOWED_IMAGE_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const AVATAR_PREFIX = "avatars";
export const PROPERTY_PHOTO_PREFIX = "properties";
export const LISTING_PHOTO_PREFIX = "listings";
export const DOCUMENT_PREFIX = "documents";
