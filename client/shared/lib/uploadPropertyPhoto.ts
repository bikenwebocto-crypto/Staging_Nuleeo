// Three-step property photo upload, mirroring the avatar gateway in
// uploadAvatar.ts. Open to any authenticated user — owners upload photos
// for their own properties; admins do the same when registering units on
// behalf of an owner. Final authorization (admin override / owner-of-this-
// property) is enforced at the create/edit endpoint.

import { apiRequest } from "./queryClient";
import { downscaleImage } from "./downscaleImage";

export const ALLOWED_PROPERTY_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_PROPERTY_PHOTO_BYTES = 8 * 1024 * 1024;

export async function uploadPropertyPhoto(file: File): Promise<string> {
  if (!ALLOWED_PROPERTY_PHOTO_TYPES.includes(file.type)) {
    throw new Error("Please pick a JPEG, PNG, or WebP image.");
  }
  if (file.size > MAX_PROPERTY_PHOTO_BYTES) {
    throw new Error("Image is larger than 8 MB. Please pick a smaller file.");
  }

  // Downscale in the browser so we upload (and later serve) a ~1920px,
  // few-hundred-KB photo instead of the full-resolution original. Falls
  // back to the original file if the resize can't run, so this only ever
  // shrinks the upload — it never blocks one. Validation above runs on the
  // ORIGINAL, so what's accepted is unchanged.
  const upload = await downscaleImage(file);

  const presignRes = await apiRequest("POST", "/api/properties/photo/upload-url", {
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

  const finalizeRes = await apiRequest("POST", "/api/properties/photo/finalize", { objectPath });
  const { photoURL } = (await finalizeRes.json()) as { photoURL: string };
  return photoURL;
}
