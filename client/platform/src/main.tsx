import { createRoot } from "react-dom/client";
import { Component, type ReactNode, type ErrorInfo } from "react";
import "./index.css";
import App from "./App";
import { reportClientError, installGlobalErrorReporting } from "@ui/lib/reportClientError";
import { CookieConsentBanner } from "@ui/components/common/CookieConsentBanner";

// Catches render-time throws so a single broken page can't white-screen the
// whole admin app. In production we show a friendly "reload" fallback; in dev
// (import.meta.env.DEV) we surface the message + stack to speed up debugging.
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("React error:", error, info);
    reportClientError({
      kind: "react",
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
  }
  render() {
    if (this.state.error) {
      if (import.meta.env.DEV) {
        return (
          <pre style={{ padding: 20, color: "red" }}>
            {this.state.error.message}
            {"\n"}
            {this.state.error.stack}
          </pre>
        );
      }
      return (
        <div
          style={{
            minHeight: "100dvh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            padding: 24,
            textAlign: "center",
            fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600 }}>Something went wrong</div>
          <div style={{ fontSize: 14, opacity: 0.7, maxWidth: 360 }}>
            An unexpected error occurred. Reloading usually fixes it.
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              fontSize: 14,
              fontWeight: 600,
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              cursor: "pointer",
              color: "#fff",
              background: "#111",
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

installGlobalErrorReporting("platform");

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
    {/* Cookie-consent banner — the Cookie Policy names all three subdomains, so
        the staff app must show it too (it was previously only on landing + app). */}
    <CookieConsentBanner />
  </ErrorBoundary>,
);
