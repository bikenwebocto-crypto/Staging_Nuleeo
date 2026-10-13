// Builds the Express app. Consumed by:
//   - server/index.ts (local dev — wraps in http.createServer and listens)
//   - functions/src/index.ts (Firebase Functions 2nd gen — wraps via onRequest)

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { initFirebase } from "./firebase";
import { registerRoutes } from "./routes";
import { originGuard } from "./originGuard";
import { enableAsyncErrorForwarding } from "./asyncErrors";
import { logError, logInfo } from "./services/log";
import { stripeMode } from "./stripe";

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

function logLine(message: string, source = "express") {
  // Routed through the structured logger so Cloud Logging gets a searchable
  // `event`/`source`, while `message` keeps the human-readable request line
  // (e.g. "GET /api/x 200 in 5ms :: {…}") that's handy in local dev.
  logInfo("http.request", { source }, `[${source}] ${message}`);
}

export function createApp(): Express {
  initFirebase();

  // Record which Stripe mode this instance booted in. Mode is implied by the
  // loaded secret key (not a code flag), so this one structured line is the
  // observable, in-code signal that production is running LIVE — and the tripwire
  // for an accidental test-key deploy. Query it with:
  //   gcloud logging read 'jsonPayload.event="stripe.mode"' --limit 1
  logInfo("stripe.mode", { mode: stripeMode() ?? "unconfigured" });

  const app = express();

  // Make async handlers fail safely. Express 5 forwards a rejected promise to
  // the error middleware natively, so this is belt-and-suspenders defense-in-
  // depth kept for explicitness (under Express 4 an unhandled rejection in an
  // async route would hang the request until the platform timeout). Patch the
  // app's routing methods BEFORE any middleware/route is registered so the
  // whole surface (and any future handler) is covered. See server/asyncErrors.ts.
  enableAsyncErrorForwarding(app);

  // Cloud Functions sits behind Google's frontend, which forwards the
  // real client IP via x-forwarded-for. Trust the first hop so req.ip
  // reflects the caller (needed for IP-keyed rate limits) instead of
  // the GFE address.
  app.set("trust proxy", 1);

  // Disable Express's "X-Powered-By: Express" advertisement — minor,
  // but no reason to broadcast the stack.
  app.disable("x-powered-by");

  // Baseline security headers on every API response. We don't add
  // Content-Security-Policy here — the SPA bundles need their own
  // careful CSP coordinated with Firebase Hosting; these headers are
  // the universal-safe set that protect every API caller without
  // breaking anything.
  app.use((_req, res, next) => {
    // Force HTTPS for a year + apply to subdomains + register for the
    // browser preload list. Cloud Functions is HTTPS-only anyway, but
    // a redirected http:// hit would still leak the request body once.
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    // Block MIME-sniffing — defends against the classic "image upload
    // serves as HTML with executable script" attack on signed-URL
    // responses (defense in depth alongside the content-type allowlist
    // on briefing.ts).
    res.setHeader("X-Content-Type-Options", "nosniff");
    // The API is JSON; nothing should ever frame it. Blocks
    // clickjacking via iframe embedding of error pages.
    res.setHeader("X-Frame-Options", "DENY");
    // Limit referrer leakage to other origins (don't leak deep API
    // paths or query strings to third parties the browser might follow
    // links to). Same-origin still gets full referrer for our own
    // analytics.
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // The API doesn't need camera, microphone, geolocation, payment
    // request, etc. Lock them down so a compromised endpoint can't
    // request them.
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()",
    );
    // Cross-origin opener isolation — keep `window.opener` null on
    // cross-origin navigations so a popup'd OAuth flow can't reach
    // back into us. Compatible with Firebase Auth popups when set on
    // API responses only (we don't set it on the SPA).
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    next();
  });

  // Soft Origin/Referer allowlist — defense-in-depth on top of bearer-token
  // auth (which is the PRIMARY CSRF control: the API never reads cookies, so
  // a forged cross-site request can't attach the victim's Authorization
  // header). This guard only 403s a clearly-foreign BROWSER origin on a
  // state-changing request; no-origin (curl/mobile/webhooks) and webhook/CSP
  // paths pass untouched. Mounted before the body parser so a foreign POST is
  // rejected without spending memory on its payload. It does NOT touch auth —
  // requireAuth still runs per-route inside registerRoutes. See
  // server/originGuard.ts + SECURITY.md.
  app.use(originGuard());

  // Body-size limit is the first line of DOS protection. 1MB lets the
  // largest legitimate endpoint (compliance HTML save) succeed while
  // rejecting payloads that could exhaust memory under concurrent load.
  // Per-route input caps (slice() in handlers) tighten this further.
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as Request & { rawBody: unknown }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  // Request logger — /api only. We capture the response body but REDACT
  // every field that could contain a credential, signed URL, or PII
  // before writing to logs. Without this redaction, Cloud Logging
  // retains things like Firebase impersonation customTokens, one-time
  // password-setup invite links, tokenized GCS download URLs, IBANs,
  // and Stripe Express login URLs — all of which are reusable by
  // anyone with log-viewer access or a compromised log sink.
  const SENSITIVE_KEYS = new Set([
    // Credentials + signed URLs
    "customToken",
    "idToken",
    "accessToken",
    "refreshToken",
    "inviteLink",
    "uploadUrl",
    "downloadURL",
    "url", // login-link, account-link return shapes use this
    "secret",
    "apiKey",
    "password",
    // Financial / contact PII — never persist these to Cloud Logs.
    // GDPR-noteworthy retention for a property-management app with EU users.
    "iban",
    "swift",
    "holder",
    "photoURL",
    "proofUrl",
    "email",
    "firstName",
    "lastName",
    "name",
    "phone",
    "address",
    // Free-text user content (messages, ticket descriptions, transaction
    // notes, push titles/messages) — may contain PII or sensitive details
    // we don't need replicated to logs.
    "text",
    "description",
    "notes",
    "message",
    "title",
    "preview",
  ]);
  function redactForLog(value: unknown, depth = 0): unknown {
    if (depth > 4) return "[…]"; // bound recursion on deep responses
    if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEYS.has(k)) {
          out[k] = "[redacted]";
        } else {
          out[k] = redactForLog(v, depth + 1);
        }
      }
      return out;
    }
    return value;
  }
  app.use((req, res, next) => {
    const start = Date.now();
    const p = req.path;
    let captured: unknown;
    const origJson = res.json.bind(res);
    res.json = (body: unknown, ...args: unknown[]) => {
      captured = body;
      return (origJson as (...a: unknown[]) => Response)(body, ...args);
    };
    res.on("finish", () => {
      if (!p.startsWith("/api")) return;
      const dur = Date.now() - start;
      let line = `${req.method} ${p} ${res.statusCode} in ${dur}ms`;
      if (captured !== undefined) {
        try {
          // Cap serialized body at ~2kB so a 1MB compliance-doc fetch
          // doesn't bloat every log line.
          const json = JSON.stringify(redactForLog(captured));
          line += ` :: ${json.length > 2000 ? `${json.slice(0, 2000)}…` : json}`;
        } catch {
          line += " :: [unserializable response]";
        }
      }
      logLine(line);
    });
    next();
  });

  registerRoutes(app);

  // Last-chance error handler for anything a route didn't try/catch. We
  // log the raw err server-side but only ship a generic message to the
  // caller — the per-route handlers already provide informative messages
  // for expected error paths.
  app.use(
    (
      err: Error & { status?: number; statusCode?: number },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      const status = err.status || err.statusCode || 500;
      logError("express.fallback-handler", err);
      res.status(status).json({ error: "Internal Server Error" });
    },
  );

  return app;
}

export { logLine as log };
