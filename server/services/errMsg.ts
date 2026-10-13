// Sanitizes a thrown value into a client-safe error string.
//
// Returns ONLY the caller-supplied fallback to the client — raw err.message
// is logged server-side (via the structured logger) but never sent back. The
// raw-message pattern that lived in per-file helpers risked leaking
// Firestore/SDK internals (collection paths, "5 NOT_FOUND: no entity to
// update: app: ..." text, etc.) to anyone watching the network tab.
//
// Use this in 500-level catch blocks; for caller-error responses where the
// message is intentional (e.g. "valid email is required"), return the
// custom string directly and skip this helper.

import { logError } from "./log";

export function errMsg(err: unknown, fallback: string, ctx?: string): string {
  if (err !== null && err !== undefined) {
    logError(ctx ? `errMsg.${ctx}` : "errMsg", err, ctx ? { ctx } : undefined);
  }
  return fallback;
}
