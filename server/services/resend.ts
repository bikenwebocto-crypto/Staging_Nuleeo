// Resend email API client. Used by the email-campaign dispatcher and the
// /test endpoint to send a single email through Resend's REST API.
//
// Required secrets:
//   RESEND_API_KEY        — re_xxxxx workspace API key
//   RESEND_FROM           — verified sender, e.g. "Olio <noreply@oliowallet.com>"
//   RESEND_WEBHOOK_SECRET — whsec_… secret for Svix-signed webhook verification
//
// Docs:
//   https://resend.com/docs/api-reference/emails/send-email
//   https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests

import { createHmac, timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase";
import { logWarn } from "./log";
import { COL } from "../../shared/firestore-schema";

const RESEND_API_BASE = "https://api.resend.com";

// Resend free-tier ceilings. Documented here (not in a config doc) so the
// quota gate stays loud + obvious in code review — bumping these means we
// upgraded the Resend plan and must also change the public limits the
// /api/admin/email-quota endpoint returns.
export const RESEND_DAILY_LIMIT = 100;
export const RESEND_MONTHLY_LIMIT = 3000;

// UTC day key — "YYYY-MM-DD". We use UTC so the rollover boundary
// matches Resend's own dashboard (their cutoff is UTC midnight).
export function dailyQuotaKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// UTC month key — "YYYY-MM".
export function monthlyQuotaKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function dailyQuotaDocId(key: string): string {
  return `emailQuota_${key}`;
}

export function monthlyQuotaDocId(key: string): string {
  return `emailQuota_${key}`;
}

// Fire-and-forget counter bump. Two Firestore writes (daily + monthly)
// using FieldValue.increment so concurrent sends never race the counter
// — the merge happens server-side. We never await this from the send
// path: a counter-write hiccup must not turn a successful send into a
// failure the caller has to retry. Failures are logged via logWarn so
// they're still searchable in Cloud Logging.
export function incrementResendUsage(now: Date = new Date()): void {
  const dayKey = dailyQuotaKey(now);
  const monthKey = monthlyQuotaKey(now);
  const nowIso = now.toISOString();
  // Wrap in a try/catch around the synchronous setup; the network write
  // itself can only fail in the returned Promise.
  let dailyRef: FirebaseFirestore.DocumentReference;
  let monthlyRef: FirebaseFirestore.DocumentReference;
  try {
    const col = db().collection(COL.config);
    dailyRef = col.doc(dailyQuotaDocId(dayKey));
    monthlyRef = col.doc(monthlyQuotaDocId(monthKey));
  } catch (err) {
    logWarn("resend.quota.setup_failed", { dayKey, monthKey }, String(err));
    return;
  }
  void dailyRef
    .set(
      {
        period: "daily",
        date: dayKey,
        count: FieldValue.increment(1),
        updatedAt: nowIso,
      },
      { merge: true },
    )
    .catch((err: unknown) => {
      logWarn("resend.quota.daily_increment_failed", { dayKey }, String(err));
    });
  void monthlyRef
    .set(
      {
        period: "monthly",
        month: monthKey,
        count: FieldValue.increment(1),
        updatedAt: nowIso,
      },
      { merge: true },
    )
    .catch((err: unknown) => {
      logWarn("resend.quota.monthly_increment_failed", { monthKey }, String(err));
    });
}

export interface ResendUsage {
  dailyUsed: number;
  monthlyUsed: number;
  dailyLimit: number;
  monthlyLimit: number;
  // Remaining sends before the tighter of the two ceilings is hit (>= 0).
  headroom: number;
}

function asCount(data: FirebaseFirestore.DocumentData | undefined): number {
  const raw = data?.count;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

// Read the current daily + monthly Resend send counts and the remaining
// headroom before the tighter ceiling. The dispatch worker calls this BEFORE
// each batch (and per-recipient within a batch) so one large campaign can't
// blow past the Resend allowance and silently take down ALL email — including
// transactional password resets / invites — until the next billing cycle.
// (The counters here are the same docs incrementResendUsage bumps and the
// /api/admin/email-quota widget reads.)
export async function readResendUsage(now: Date = new Date()): Promise<ResendUsage> {
  const dayKey = dailyQuotaKey(now);
  const monthKey = monthlyQuotaKey(now);
  const col = db().collection(COL.config);
  const [dailySnap, monthlySnap] = await Promise.all([
    col.doc(dailyQuotaDocId(dayKey)).get(),
    col.doc(monthlyQuotaDocId(monthKey)).get(),
  ]);
  const dailyUsed = asCount(dailySnap.exists ? dailySnap.data() : undefined);
  const monthlyUsed = asCount(monthlySnap.exists ? monthlySnap.data() : undefined);
  const headroom = Math.max(
    0,
    Math.min(RESEND_DAILY_LIMIT - dailyUsed, RESEND_MONTHLY_LIMIT - monthlyUsed),
  );
  return {
    dailyUsed,
    monthlyUsed,
    dailyLimit: RESEND_DAILY_LIMIT,
    monthlyLimit: RESEND_MONTHLY_LIMIT,
    headroom,
  };
}

export interface ResendSendInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  // Tags allow filtering and reporting in the Resend dashboard. We pass
  // `campaign_id` so a single campaign's deliveries are easy to slice.
  tags?: Array<{ name: string; value: string }>;
  // RFC 8058 one-click unsubscribe support. When set, Resend forwards the
  // List-Unsubscribe + List-Unsubscribe-Post headers so Gmail / Yahoo
  // unsubscribe UX works without round-tripping through our endpoint.
  unsubscribeUrl?: string;
  // Override the channel-default sender — rarely needed; defaults to
  // RESEND_FROM at the env layer.
  from?: string;
  replyTo?: string;
}

export interface ResendSendResult {
  id: string;
}

// Resend validates tag names AND values against a strict charset: ASCII
// letters, numbers, underscores, or dashes only, max 256 chars. A single
// stray character — a colon in "filter:owners", whitespace, an accented
// letter — makes Resend reject the ENTIRE /emails request with a 422
// validation_error, so one bad tag silently fails every send in a campaign
// (this is exactly what took down filter-segmented marketing sends). We
// sanitize defensively here at the one choke point every send flows through
// so no caller can reintroduce the bug: replace each run of disallowed
// characters with "_", clamp to 256, and fall back to "unknown" if nothing
// survives (Resend also rejects an empty tag value).
export function sanitizeResendTag(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 256);
  return cleaned.length > 0 ? cleaned : "unknown";
}

export class ResendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ResendError";
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new ResendError(
      `Missing required env var: ${name}. Set it via firebase functions:secrets:set ${name}`,
      500,
      "",
    );
  }
  return v;
}

export async function sendEmailViaResend(input: ResendSendInput): Promise<ResendSendResult> {
  const apiKey = requireEnv("RESEND_API_KEY");
  const from = input.from || requireEnv("RESEND_FROM");

  const headers: Record<string, string> = {};
  if (input.unsubscribeUrl) {
    // RFC 8058: List-Unsubscribe-Post enables one-click unsubscribe so
    // Gmail / Yahoo can call our endpoint directly without rendering a
    // confirmation page. List-Unsubscribe is the fallback URL.
    headers["List-Unsubscribe"] = `<${input.unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const body: Record<string, unknown> = {
    from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(input.tags && input.tags.length
      ? {
          tags: input.tags.map((t) => ({
            name: sanitizeResendTag(t.name),
            value: sanitizeResendTag(t.value),
          })),
        }
      : {}),
  };

  const delaysMs = [0, 250, 1000];
  let lastErr: ResendError | null = null;
  for (const delay of delaysMs) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    // Node's fetch has no default timeout. sendEmailViaResend is awaited
    // per-recipient inside the emailDispatchTick cron, so a single stalled
    // socket would block the whole campaign batch until the function
    // timeout. Bound each attempt; a timeout aborts and retries.
    let resp: Response;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      resp = await fetch(`${RESEND_API_BASE}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      lastErr = new ResendError(`Resend request failed: ${String(err)}`, 0, "");
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 200 || resp.status === 202) {
      const json = (await resp.json()) as { id: string };
      // Fire-and-forget usage counter — bump the daily + monthly
      // Firestore docs the platform admin dashboard reads from. Wrapped
      // again here so even a synchronous throw (e.g. firebase not init
      // in a unit test) can't break a successful send.
      try {
        incrementResendUsage();
      } catch (err) {
        logWarn("resend.quota.increment_threw", undefined, String(err));
      }
      return { id: json.id };
    }

    const text = await resp.text();
    lastErr = new ResendError(
      `Resend API ${resp.status}: ${text.slice(0, 500)}`,
      resp.status,
      text,
    );
    // 4xx other than 429 won't recover on retry.
    if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
      throw lastErr;
    }
  }
  throw lastErr ?? new ResendError("Resend send failed", 0, "");
}

// Resend webhooks are signed by Svix. Three headers travel with each call:
//   svix-id          unique message id
//   svix-timestamp   unix-seconds for replay-window enforcement
//   svix-signature   space-separated list of "v1,<base64-hmac>" values
//
// The signature is HMAC-SHA256("<id>.<timestamp>.<body>", secret_bytes),
// where secret_bytes is the base64-decoded portion after "whsec_".
//
// Implementation refs:
//   https://docs.svix.com/receiving/verifying-payloads/how-manual
const SVIX_ID_HEADER = "svix-id";
const SVIX_TIMESTAMP_HEADER = "svix-timestamp";
const SVIX_SIGNATURE_HEADER = "svix-signature";
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export function verifyResendWebhookSignature(
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const secretRaw = process.env.RESEND_WEBHOOK_SECRET;
  if (!secretRaw) return false;

  const id = headerString(headers[SVIX_ID_HEADER]);
  const ts = headerString(headers[SVIX_TIMESTAMP_HEADER]);
  const sigHeader = headerString(headers[SVIX_SIGNATURE_HEADER]);
  if (!id || !ts || !sigHeader) return false;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - tsNum);
  if (ageSeconds > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  // Strip the "whsec_" prefix and base64-decode the remainder for the HMAC key.
  const secretBase = secretRaw.startsWith("whsec_") ? secretRaw.slice("whsec_".length) : secretRaw;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(secretBase, "base64");
  } catch {
    return false;
  }
  if (secretBytes.length === 0) return false;

  const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const signedContent = `${id}.${ts}.${bodyStr}`;
  const expected = createHmac("sha256", secretBytes).update(signedContent).digest("base64");

  // The header is a space-separated list like "v1,sig1 v1,sig2"; any
  // matching v1 signature counts as valid.
  const candidates = sigHeader.split(" ").filter(Boolean);
  for (const c of candidates) {
    const [version, sig] = c.split(",");
    if (version !== "v1" || !sig) continue;
    if (sig.length !== expected.length) continue;
    if (timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return true;
  }
  return false;
}

function headerString(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
