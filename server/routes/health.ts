// Public health + CSP-report endpoints. Mounted from server/routes.ts.
//
// Both are intentionally unauthenticated:
//   - GET /api/health/firebase: liveness probe; touches Firestore read-
//     only so a real outage surfaces but never writes (attacker can't
//     burn credits by hammering it).
//   - POST /api/csp-report: browsers send CSP-violation reports here
//     without our auth header (per spec). IP-rate-limited so a
//     misbehaving browser looping on a single violation can't flood
//     the log stream.

import type { Express } from "express";
import { db } from "../firebase";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { logError, logWarn } from "../services/log";

export function registerHealthRoutes(app: Express): void {
  // Pure read-only liveness check. 500s log the underlying err
  // server-side but only surface a generic message to the caller —
  // the endpoint is public and we don't want to leak SDK internals.
  app.get("/api/health/firebase", async (_req, res) => {
    try {
      const snap = await db().collection("_health").doc("ping").get();
      res.json({ ok: true, exists: snap.exists });
    } catch (err) {
      logError("health.firebase-failed", err);
      res.status(500).json({ ok: false, error: "Health check failed" });
    }
  });

  // CSP violation report sink. Body shape per CSP3:
  //   { "csp-report": { "document-uri": ..., "violated-directive": ...,
  //     "blocked-uri": ..., ... } }
  // Some browsers send the modern `application/reports+json` envelope
  // (an array of {body: {...}}). We handle both.
  app.post("/api/csp-report", async (req, res) => {
    try {
      // Two-tier limit. The per-IP cap stops a single misbehaving browser, but
      // req.ip derives from X-Forwarded-For, which an attacker can spoof to mint
      // a fresh "IP" per request and slip the per-IP cap. The GLOBAL cap bounds
      // total volume across ALL ips so a spoofed-IP flood can't balloon log cost
      // or poison log-based alerts. The global ceiling is generous vs. real CSP
      // traffic but a hard stop on abuse.
      const [perIp, global] = await Promise.all([
        rateLimit(`csp-report:${req.ip ?? "unknown"}`, 100, 60 * 60),
        rateLimit("csp-report:global", 5000, 60 * 60),
      ]);
      if (!perIp.allowed || !global.allowed) {
        return res.status(204).end(); // silently drop — CSP spec ignores response
      }
      const body = req.body as Record<string, unknown> | unknown[] | undefined;
      let report: Record<string, unknown> = {};
      if (Array.isArray(body)) {
        report = (body[0] as { body?: Record<string, unknown> })?.body ?? {};
      } else if (body && typeof body === "object") {
        const cspReport = (body as { "csp-report"?: Record<string, unknown> })["csp-report"];
        report = cspReport ?? (body as Record<string, unknown>);
      }
      logWarn("csp.violation", {
        documentUri: report["document-uri"] ?? report["documentURL"],
        violatedDirective: report["violated-directive"] ?? report["effectiveDirective"],
        blockedUri: report["blocked-uri"] ?? report["blockedURL"],
        sourceFile: report["source-file"] ?? report["sourceFile"],
        lineNumber: report["line-number"] ?? report["lineNumber"],
        columnNumber: report["column-number"] ?? report["columnNumber"],
        scriptSample:
          typeof report["script-sample"] === "string"
            ? (report["script-sample"] as string).slice(0, 200)
            : undefined,
        userAgent: req.headers["user-agent"] ?? null,
      });
    } catch (err) {
      // Don't error on malformed reports — browsers send weird stuff.
      logWarn("csp.report-parse-failed", { err: String(err).slice(0, 200) });
    }
    res.status(204).end();
  });

  // Client-side error sink. The app + platform SPAs POST here from their React
  // ErrorBoundary and global window error/unhandledrejection handlers (see
  // client/shared/lib/reportClientError.ts), so real-user frontend crashes land
  // in Cloud Logging as `client.error` instead of dying silently in the
  // browser console. Logged at WARNING (not ERROR) so it stays searchable +
  // alertable on its own without inflating the server-side error-rate alert.
  // Public + IP-rate-limited so a misbehaving tab can't flood the log stream,
  // and ALWAYS 204 so a failed report never triggers more reports. The client
  // already bounds + throttles + dedupes what it sends; we re-bound here too.
  app.post("/api/client-errors", async (req, res) => {
    try {
      // Per-IP + global cap (see /api/csp-report): the global tier bounds total
      // volume even when X-Forwarded-For is spoofed to dodge the per-IP cap.
      const [perIp, global] = await Promise.all([
        rateLimit(`client-error:${req.ip ?? "unknown"}`, 60, 60 * 60),
        rateLimit("client-error:global", 3000, 60 * 60),
      ]);
      if (!perIp.allowed || !global.allowed) return res.status(204).end();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const str = (v: unknown, max: number) =>
        typeof v === "string" && v ? v.slice(0, max) : undefined;
      const kind = str(body.kind, 40);
      const KINDS = new Set(["react", "window.onerror", "unhandledrejection"]);
      logWarn("client.error", {
        kind: kind && KINDS.has(kind) ? kind : "unknown",
        message: str(body.message, 1000),
        stack: str(body.stack, 4000),
        componentStack: str(body.componentStack, 2000),
        path: str(body.path, 200),
        app: str(body.app, 40),
        userAgent: str(req.headers["user-agent"], 300),
      });
    } catch (err) {
      logWarn("client.error-sink-failed", { err: String(err).slice(0, 200) });
    }
    res.status(204).end();
  });
}
