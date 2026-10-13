// Read a fetch() Response body into a Buffer while enforcing a hard byte cap
// DURING the read, not after the whole body is already in memory. Without this,
// an authenticated user who points a remote-image fetch (avatar mirror, briefing
// property photo) at a slow/large body they control can force an oversized
// allocation before the post-hoc `byteLength > max` check ever runs — a
// memory-amplification / mild DoS against a shared Cloud Function.
//
// Defenses, in order:
//   1. Reject on an honest oversized Content-Length before reading a byte.
//   2. Stream the body and abort the moment the running total exceeds the cap,
//      so a server that lies about (or omits) Content-Length, or sends a chunked
//      oversized body, is still bounded.
// Returns null if the cap is exceeded or the read errors.

export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const body = res.body;
  if (!body) {
    // No readable stream (unusual for a real fetch) — fall back to arrayBuffer
    // but still enforce the cap.
    try {
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.byteLength > maxBytes ? null : buf;
    } catch {
      return null;
    }
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}
