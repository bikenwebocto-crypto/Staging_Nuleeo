// Firestore-backed rate limiter. Works across function instances + cold
// starts because the counter lives in Firestore, not in process memory.
// Two callers hitting the same key concurrently can't both pass the
// check — the read+increment is wrapped in `runTransaction` for true
// atomicity.
//
// One Firestore doc per (key, window). The doc is recreated when the
// window resets, so cleanup is free — stale docs simply never get read
// again. (A periodic GC could trim them; ~hundreds of bytes apiece, so
// not worth the cron complexity yet.)

import { db } from "../firebase";

const COL_RATE_LIMITS = "rateLimits";

export interface RateLimitResult {
  allowed: boolean;
  // How long to wait before the next request will succeed.
  retryAfterSeconds: number;
  // Remaining quota inside the current window (0 once blocked).
  remaining: number;
}

interface RateLimitDoc {
  count: number;
  // Epoch ms when the current window expires.
  resetAt: number;
}

// Sanitize a key so it's safe as a Firestore doc id. Firestore allows
// most characters but disallows slashes; we also keep length bounded to
// avoid surprise from long client-supplied keys.
function sanitizeKey(key: string): string {
  return key.replace(/[\/.#]/g, "_").slice(0, 1500);
}

export async function checkAndIncrement(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const ref = db().collection(COL_RATE_LIMITS).doc(sanitizeKey(key));
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  return await db().runTransaction(async (t) => {
    const snap = await t.get(ref);
    const data = snap.exists ? (snap.data() as RateLimitDoc) : null;

    // No doc, or the previous window already expired — start fresh.
    if (!data || data.resetAt <= now) {
      t.set(ref, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSeconds: 0, remaining: limit - 1 };
    }

    if (data.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((data.resetAt - now) / 1000));
      return { allowed: false, retryAfterSeconds: retryAfter, remaining: 0 };
    }

    t.update(ref, { count: data.count + 1 });
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: limit - (data.count + 1),
    };
  });
}
