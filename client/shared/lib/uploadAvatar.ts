// Three-step profile photo upload via the server's signed-URL gateway:
//   1. POST /api/profile/photo/upload-url with the file's Content-Type to get
//      a one-time signed PUT URL and the object path the server reserved.
//   2. PUT the raw file bytes to that URL (browser → Firebase Storage direct;
//      the server is not in the data path).
//   3. POST /api/profile/photo/finalize so the server marks the object public
//      and writes the resulting URL onto the user's profile.
//
// Returns the new photoURL on success.

import { apiRequest } from "./queryClient";

export const ALLOWED_AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB

export async function uploadAvatar(file: File): Promise<string> {
  if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
    throw new Error("Please pick a JPEG, PNG, or WebP image.");
  }
  if (file.size > MAX_AVATAR_BYTES) {
    throw new Error("Image is larger than 5 MB. Please pick a smaller file.");
  }

  const presignRes = await apiRequest("POST", "/api/profile/photo/upload-url", {
    contentType: file.type,
  });
  const { uploadUrl, objectPath } = (await presignRes.json()) as {
    uploadUrl: string;
    objectPath: string;
  };

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!putRes.ok) {
    const text = (await putRes.text()) || putRes.statusText;
    throw new Error(`Upload failed: ${text}`);
  }

  const finalizeRes = await apiRequest("POST", "/api/profile/photo/finalize", {
    objectPath,
  });
  const { photoURL } = (await finalizeRes.json()) as { photoURL: string };
  return photoURL;
}
