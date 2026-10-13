# 3. Server-minted signed-URL gateway for all Storage uploads and downloads

- Status: Accepted
- Deciders: platform team
- Tags: security, storage, uploads

## Context

The app handles user blobs: avatars, property photos, marketplace listing
photos, and owner documents (leases, scanned PDFs). Firebase Storage offers
the same two access models as Firestore (see ADR 0001): client SDK direct with
Storage Rules, or a server gateway.

We already chose deny-by-default Storage rules (ADR 0001) — `storage.rules` is
`allow read, write: if false`, so the browser cannot read or write the bucket
at all. But the browser still has to get bytes **in** (upload a photo) and
**out** (view a document). We need a way to do that without opening the bucket
and without proxying every byte through the Cloud Function (which would be slow
and burn function memory on large PDFs).

## Decision

The Express API mints **short-lived, single-object signed URLs**; the browser
talks to Google Cloud Storage directly using only those URLs. The bucket stays
fully locked.

**Uploads — three-step protocol** (e.g. `server/routes/documents.ts`):

1. `POST .../upload-url` — server authorizes (auth + owner-plan privilege +
   ownership check, e.g. "is this your property?"), validates the **MIME type
   against an allowlist** and size cap, computes a uid-scoped object path
   (`documents/{uid}/{propertyId}/{ts}-{uuid}.ext`), and returns a
   **resumable-upload** URL.
2. Browser `PUT`s the bytes straight to GCS using that URL.
3. `POST .../finalize` — server records the Firestore row and (for docs) mints
   a download token / pushes the tenant.

Object paths share a uid-scoping convention via the prefix constants in
`server/services/storageTypes.ts` (`avatars/`, `properties/`, `listings/`,
`documents/`). The same 3-step shape is reused for all four upload types.

**Downloads — v4 signed read URLs** (`documents.ts`, `briefing.ts`): the
server signs a `version: "v4", action: "read"` URL with a **24h TTL**. The
client re-fetches the documents list per view (React Query), so it always gets
a fresh, still-valid link; the URL is never persisted long-term.

## Consequences

- **The bucket is never directly accessible.** Every grant is per-object,
  per-action, short-lived, and issued only after the API has authorized the
  caller — authZ lives in the same place as everything else (ADR 0001).
- **Bytes don't transit the function.** The browser uploads/downloads directly
  to GCS; the function only signs. No memory blowup on large files.
- **MIME + size enforced server-side at mint time**, not trusted from the
  client. Images use the shared image allowlist; documents use a broader
  PDF/Office allowlist local to that route, with a 25 MB cap.
- **Rate-limited.** Both `upload-url` and `finalize` carry their own per-uid
  caps (120/hr) — `finalize` separately, because it writes a Firestore row and
  notifies on every call, so a replay loop against an already-uploaded object
  must be bounded independently.
- **Download links expire, but issued tokens are a known gap.** Stored download
  tokens don't auto-expire after issuance; we rotate them on tenancy-end
  (`POST /api/owner/tenants/:id/end`) but not yet on owner-revokes-access. See
  `SECURITY.md` → Known gaps.
- **Prod prerequisite.** v4 `getSignedUrl` from the function requires the
  runtime service account to have token-creator + IAM Credentials API — wired
  for the `api` function (see project memory `project_functions_runtime_sa`).
