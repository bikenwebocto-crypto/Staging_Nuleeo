// Three-step upload for the signed/physical lease PDF attached to one
// agreement, mirroring uploadPropertyDocument.ts but PDF-only and scoped to an
// agreement instead of a property. Backed by the gateway at
// /api/owner/agreements/:id/document/* (server/routes/portfolio.ts).
//
// The server is the source of truth — it re-verifies ownership, the PDF MIME,
// and the 25 MB cap, and mints the durable storagePath. We mirror the type/size
// checks here only so the owner gets a fast, friendly error before a round-trip.
// finalize returns the freshly-signed download URL + metadata for the new
// attachment.

import { apiRequest } from "./queryClient";

export const MAX_LEASE_DOC_BYTES = 25 * 1024 * 1024; // 25 MB
// PDF only — the signed lease is always a PDF. The native picker filters to it.
export const LEASE_DOC_ACCEPT = ".pdf,application/pdf";

export interface AgreementDocumentResult {
  documentUrl: string;
  documentName: string;
  documentSize: number;
  documentUploadedAt: string;
}

export async function uploadAgreementDocument(
  file: File,
  agreementId: string,
): Promise<AgreementDocumentResult> {
  // Some browsers report an empty type for files dragged from odd sources; if a
  // type is present it must be PDF. The server re-checks regardless.
  if (file.type && file.type !== "application/pdf") {
    throw new Error("The signed lease must be a PDF.");
  }
  if (file.size > MAX_LEASE_DOC_BYTES) {
    throw new Error("File exceeds 25 MB. Compress or split the document.");
  }

  // Step 1: get a resumable upload URL scoped to this agreement.
  const urlRes = await apiRequest(
    "POST",
    `/api/owner/agreements/${agreementId}/document/upload-url`,
    { contentType: "application/pdf" },
  );
  const { uploadUrl, objectPath } = (await urlRes.json()) as {
    uploadUrl: string;
    objectPath: string;
  };

  // Step 2: PUT the bytes straight to Cloud Storage. The session URL carries its
  // own auth, so no Authorization header is needed.
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: file,
  });
  if (!putRes.ok) {
    const text = (await putRes.text()) || putRes.statusText;
    throw new Error(`Upload failed: ${text}`);
  }

  // Step 3: finalize — server validates the object, writes signedLeaseDocument
  // onto the agreement, notifies the tenant, and returns the signed URL + meta.
  const finalizeRes = await apiRequest(
    "POST",
    `/api/owner/agreements/${agreementId}/document/finalize`,
    { objectPath, name: file.name },
  );
  return (await finalizeRes.json()) as AgreementDocumentResult;
}

export async function removeAgreementDocument(agreementId: string): Promise<void> {
  await apiRequest("DELETE", `/api/owner/agreements/${agreementId}/document`);
}
