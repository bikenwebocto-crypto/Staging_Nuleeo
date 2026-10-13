// Three-step marketplace-listing photo upload. Same gateway shape as
// uploadAvatar / uploadPropertyPhoto, gated by `comm.partners`.

import { apiRequest } from "./queryClient";
import { downscaleImage } from "./downscaleImage";

export const ALLOWED_LISTING_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_LISTING_PHOTO_BYTES = 8 * 1024 * 1024;

export async function uploadListingPhoto(file: File): Promise<string> {
  if (!ALLOWED_LISTING_PHOTO_TYPES.includes(file.type)) {
    throw new Error("Please pick a JPEG, PNG, or WebP image.");
  }
  if (file.size > MAX_LISTING_PHOTO_BYTES) {
    throw new Error("Image is larger than 8 MB. Please pick a smaller file.");
  }

  // Browser-side downscale before upload (see uploadPropertyPhoto for the
  // rationale). Only ever shrinks the upload; validation runs on the original.
  const upload = await downscaleImage(file);

  const presignRes = await apiRequest("POST", "/api/admin/listings/photo/upload-url", {
    contentType: upload.type,
  });
  const { uploadUrl, objectPath } = (await presignRes.json()) as {
    uploadUrl: string;
    objectPath: string;
  };

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": upload.type },
    body: upload,
  });
  if (!putRes.ok) {
    const text = (await putRes.text()) || putRes.statusText;
    throw new Error(`Upload failed: ${text}`);
  }

  const finalizeRes = await apiRequest("POST", "/api/admin/listings/photo/finalize", {
    objectPath,
  });
  const { photoURL } = (await finalizeRes.json()) as { photoURL: string };
  return photoURL;
}
