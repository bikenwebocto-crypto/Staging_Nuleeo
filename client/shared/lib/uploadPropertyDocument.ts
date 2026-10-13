// Three-step property document upload, mirroring uploadPropertyPhoto.ts and the
// inline pipeline that PropertyDocumentsSection.tsx used to carry. Backed by the
// signed-URL gateway at /api/owner/documents/* (server/routes/documents.ts).
//
// The server gates these endpoints on the `documents.upload` owner-plan
// privilege, verifies the caller owns `propertyId`, and enforces the 25 MB cap
// and the allowed MIME set. We mirror size/type here so the user gets a fast,
// friendly error before we spend a round-trip — the server stays the source of
// truth. Unlike the photo helper this returns nothing: the finalize response is
// the new DocumentRecord, but callers here only need success/failure.

import { apiRequest } from "./queryClient";

// Keep in lockstep with ALLOWED_DOCUMENT_TYPES in server/routes/documents.ts.
export const ALLOWED_DOCUMENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.ms-excel",
];
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024; // 25 MB

// File-input `accept` string covering both extensions and MIME types, so the
// native picker filters sensibly across browsers.
export const DOCUMENT_ACCEPT =
  ".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx," + ALLOWED_DOCUMENT_TYPES.join(",");

export async function uploadPropertyDocument(
  file: File,
  propertyId: string,
  tenantId?: string,
): Promise<void> {
  // Some browsers report an empty type for older .doc/.xls files; let the
  // server be the judge there rather than rejecting a valid upload locally.
  if (file.type && !ALLOWED_DOCUMENT_TYPES.includes(file.type)) {
    throw new Error("Unsupported file type. Use PDF, image, Word, or Excel.");
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new Error("File exceeds 25 MB. Compress or split the document.");
  }

  // Step 1: get a resumable upload URL scoped to this property.
  const urlRes = await apiRequest("POST", "/api/owner/documents/upload-url", {
    contentType: file.type,
    propertyId,
  });
  const { uploadUrl, objectPath } = (await urlRes.json()) as {
    uploadUrl: string;
    objectPath: string;
  };

  // Step 2: PUT bytes straight to Cloud Storage. The session URL carries its
  // own auth, so no Authorization header is needed.
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!putRes.ok) {
    const text = (await putRes.text()) || putRes.statusText;
    throw new Error(`Upload failed: ${text}`);
  }

  // Step 3: finalize — server attaches a download token, writes metadata, and
  // (when tenantId is set) pushes the tenant under the `documents` category.
  await apiRequest("POST", "/api/owner/documents/finalize", {
    objectPath,
    propertyId,
    name: file.name,
    ...(tenantId ? { tenantId } : {}),
  });
}
