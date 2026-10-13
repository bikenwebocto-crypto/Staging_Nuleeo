// Signed unsubscribe tokens. Each campaign send embeds a one-click link per
// recipient that flips their `notificationPrefs.marketingEmails` to false.
// The token is base64url(`uid.issuedAtSec`) + "." + base64url(HMAC-SHA256).
// Signed with UNSUBSCRIBE_SECRET so a leaked link can't be forged for
// another user.
//
// Tokens are accepted up to MAX_TOKEN_AGE_DAYS old — long enough that an
// unsubscribe link in an archived email still works a year later, but
// finite so a stolen secret can be rotated.

import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_TOKEN_AGE_DAYS = 365;

export interface UnsubscribePayload {
  userId: string;
  issuedAt: number; // unix seconds
}

export function signUnsubscribeToken(userId: string, now: Date = new Date()): string {
  const secret = requireSecret();
  const payload = `${userId}.${Math.floor(now.getTime() / 1000)}`;
  const sig = createHmac("sha256", secret).update(payload).digest();
  return `${b64url(Buffer.from(payload, "utf8"))}.${b64url(sig)}`;
}

export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  const secret = requireSecret();
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  let payloadBuf: Buffer;
  let sigBuf: Buffer;
  try {
    payloadBuf = b64urlDecode(payloadB64);
    sigBuf = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(payloadBuf).digest();
  if (expected.length !== sigBuf.length) return null;
  if (!timingSafeEqual(expected, sigBuf)) return null;

  const payloadStr = payloadBuf.toString("utf8");
  const dot = payloadStr.indexOf(".");
  if (dot <= 0) return null;
  const userId = payloadStr.slice(0, dot);
  const issuedAt = Number(payloadStr.slice(dot + 1));
  if (!userId || !Number.isFinite(issuedAt)) return null;

  const ageSec = Math.floor(Date.now() / 1000) - issuedAt;
  if (ageSec < 0 || ageSec > MAX_TOKEN_AGE_DAYS * 24 * 60 * 60) return null;

  return { userId, issuedAt };
}

// Public URL the recipient clicks. Lives on the app subdomain — both
// app.* and platform.* rewrite /api/** to the same Express function, but
// the app domain is the user-facing one most readers expect.
export function buildUnsubscribeUrl(userId: string, baseUrl?: string): string {
  const base = baseUrl || process.env.PUBLIC_APP_URL || "https://app.oliowallet.com";
  const token = signUnsubscribeToken(userId);
  return `${base.replace(/\/$/, "")}/api/u/${token}`;
}

function requireSecret(): string {
  const s = process.env.UNSUBSCRIBE_SECRET;
  if (!s) {
    throw new Error(
      "Missing UNSUBSCRIBE_SECRET. Set it via firebase functions:secrets:set UNSUBSCRIBE_SECRET",
    );
  }
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}
