import { createRoot } from "react-dom/client";
import { Component, type ReactNode, type ErrorInfo } from "react";
import App from "./App";
import { reportClientError, installGlobalErrorReporting } from "@ui/lib/reportClientError";
import { CookieConsentBanner } from "@ui/components/common/CookieConsentBanner";
import "./index.css";

// Prevent pinch-to-zoom on mobile
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("gesturechange", (e) => e.preventDefault());
document.addEventListener("gestureend", (e) => e.preventDefault());
document.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length > 1) e.preventDefault();
  },
  { passive: false },
);
document.addEventListener(
  "touchmove",
  (e) => {
    if (e.touches.length > 1) e.preventDefault();
  },
  { passive: false },
);

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
      // In dev, dump the message + stack so engineers can debug fast. In
      // production, end users only see a friendly, non-technical fallback —
      // never the raw stack (which can leak internals and reads as a crash).
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
            minHeight: "var(--app-vh)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            padding: 24,
            textAlign: "center",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: "#6b7280", margin: 0, maxWidth: 360 }}>
            An unexpected error occurred. Reloading the page usually fixes it.
          </p>
          <button
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

installGlobalErrorReporting("app");

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
    <CookieConsentBanner />
  </ErrorBoundary>,
);
