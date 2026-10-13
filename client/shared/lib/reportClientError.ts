// Client-side crash reporting. Ships real-user frontend errors to the server
// (POST /api/client-errors -> structured logger -> Cloud Logging) so a crash on
// a tenant's checkout/login screen is visible to the team instead of dying in
// their browser console.
//
// Design constraints (this code runs in the blast radius of a broken app):
//   - PROD only — local dev keeps the console-only behavior.
//   - Best-effort + never throws — reporting must not crash the app or, worse,
//     trigger more errors. The fetch is fire-and-forget with .catch(() => {}).
//   - Throttled + deduped — a render loop or a repeated rejection can't flood
//     the endpoint (the server is also IP-rate-limited as a backstop).
//   - keepalive so a report fired right before a navigation/unload still sends.
//
// Wired in client/{app,platform}/src/main.tsx. NOT used by the landing site,
// which is static and has no /api rewrite (see firebase.json).

type ErrorKind = "react" | "window.onerror" | "unhandledrejection";

const MAX_PER_SESSION = 8;
let sent = 0;
const seen = new Set<string>();
let appName = "app";

export function reportClientError(input: {
  kind: ErrorKind;
  message: string;
  stack?: string;
  componentStack?: string;
}): void {
  try {
    if (!import.meta.env.PROD) return;
    if (sent >= MAX_PER_SESSION) return;
    const message = String(input.message ?? "").slice(0, 1000);
    const dedupeKey = `${input.kind}:${message}`.slice(0, 300);
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    sent += 1;

    const payload = {
      kind: input.kind,
      message,
      stack: input.stack ? String(input.stack).slice(0, 4000) : undefined,
      componentStack: input.componentStack
        ? String(input.componentStack).slice(0, 2000)
        : undefined,
      path: typeof location !== "undefined" ? location.pathname : undefined,
      app: appName,
    };

    void fetch("/api/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {
      // Swallow — a failed error report must never surface or recurse.
    });
  } catch {
    // Reporting itself must never throw.
  }
}

// Registers global handlers for errors that escape React's render tree
// (event-handler throws, async/promise rejections, non-React scripts). Call
// once at app startup, before render. `app` tags which SPA the error came from.
export function installGlobalErrorReporting(app: string): void {
  appName = app;
  if (!import.meta.env.PROD) return;
  if (typeof window === "undefined") return;

  window.addEventListener("error", (e: ErrorEvent) => {
    reportClientError({
      kind: "window.onerror",
      message: e.message || "Uncaught error",
      stack: e.error instanceof Error ? e.error.stack : undefined,
    });
  });

  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const reason = e.reason as { message?: string; stack?: string } | string | undefined;
    reportClientError({
      kind: "unhandledrejection",
      message:
        typeof reason === "string" ? reason : (reason?.message ?? "Unhandled promise rejection"),
      stack: typeof reason === "object" ? reason?.stack : undefined,
    });
  });
}
