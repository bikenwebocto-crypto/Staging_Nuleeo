// Soft Origin/Referer allowlist — defense-in-depth on top of bearer-token
// auth. See SECURITY.md "Cross-site request forgery (CSRF)".
//
// The API is bearer-token authenticated (Firebase ID token in the
// Authorization header — NEVER a cookie), so it is structurally immune to
// classic CSRF: a forged cross-site request can't attach the victim's token
// because the browser only auto-attaches cookies, not Authorization headers.
// Bearer-token-not-cookies is the PRIMARY CSRF control.
//
// This guard is belt-and-suspenders. It is deliberately CONSERVATIVE — a
// false positive blocks a real user, which is worse than the residual risk it
// covers. The rules:
//
//   (a) Only STATE-CHANGING methods (POST/PUT/PATCH/DELETE) are checked. GET/
//       HEAD/OPTIONS pass untouched.
//   (b) If a browser-set Origin OR Referer header is present, its host must be
//       on the Olio allowlist — otherwise 403. A clearly-foreign browser
//       origin is the only thing this rejects.
//   (c) If NEITHER Origin NOR Referer is present, ALLOW. Server-to-server
//       callers, curl, mobile apps, and (critically) webhook deliveries send
//       no browser Origin — blocking them would break real, trusted traffic.
//   (d) Webhook + telemetry endpoints are EXEMPT entirely. Stripe/Resend sign
//       their deliveries (the real authenticity check); they must never be
//       blocked on an Origin technicality.
//
// The API is reached same-origin via the Hosting /api/** rewrite AND directly
// at *.run.app, so we match on HOST ONLY (not the full origin string) and
// accept both http (dev) and https.

// Hosts we accept as first-party. Mirrors safeRedirect.ts PROD_HOSTS — kept as
// a separate copy here because that set is not exported and this module must
// not import route/service code. Keep the two in sync if prod hosts change.
const ALLOWED_HOSTS = new Set([
  "app.oliowallet.com",
  "platform.oliowallet.com",
  "oliowallet.com",
  "www.oliowallet.com",
  // Dev origins (Vite dev server + local Functions emulator host).
  "localhost",
  "127.0.0.1",
]);

// Paths that must NEVER be blocked by this guard. Webhooks authenticate via
// HMAC signature, not Origin; CSP reports and client-error reports are
// fire-and-forget telemetry the browser POSTs (sometimes with an opaque Origin,
// e.g. during an unload-time beacon) and we want to keep receiving them.
const EXEMPT_PREFIXES = ["/api/webhooks/", "/api/csp-report", "/api/client-errors"];

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Extract the lowercased hostname from an Origin or Referer header value.
// Returns null when the value is absent or unparseable (treated as "no
// browser origin" → allowed by rule (c)).
function headerHost(value: string | undefined): string | null {
  if (!value) return null;
  // Some browsers send the literal string "null" as Origin for sandboxed/
  // privacy contexts. Treat that as "no usable origin" rather than foreign so
  // we don't block (e.g.) a privacy-mode browser; bearer auth still applies.
  if (value === "null") return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Optional staging/preview host from PUBLIC_APP_URL so a non-prod deploy works
// without a code change (parallels safeRedirect.publicAppHost()).
function publicAppHost(): string | null {
  const url = process.env.PUBLIC_APP_URL;
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowedHost(host: string): boolean {
  if (ALLOWED_HOSTS.has(host)) return true;
  const extra = publicAppHost();
  return Boolean(extra) && host === extra;
}

import type { RequestHandler } from "express";

export function originGuard(): RequestHandler {
  return (req, res, next) => {
    // Rule (a): only guard state-changing methods.
    if (!STATE_CHANGING.has(req.method)) return next();

    // Rule (d): never block webhook/telemetry endpoints.
    if (EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) return next();

    // Prefer Origin (sent on all cross-origin + most same-origin state-changing
    // fetches); fall back to Referer (older clients / form posts).
    const host = headerHost(req.headers.origin) ?? headerHost(req.headers.referer);

    // Rule (c): no usable browser origin → allow (server-to-server, curl,
    // mobile, webhooks-without-prefix-match).
    if (host === null) return next();

    // Rule (b): a present browser origin must be first-party.
    if (isAllowedHost(host)) return next();

    return res.status(403).json({ error: "Forbidden" });
  };
}
