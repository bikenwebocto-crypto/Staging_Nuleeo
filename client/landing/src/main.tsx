import { createRoot } from "react-dom/client";
import { Component, type ReactNode, type ErrorInfo } from "react";
import "./index.css";
import LandingPage from "./pages/LandingPage";
import { CookieConsentBanner } from "@ui/components/common/CookieConsentBanner";
import { appUrl } from "@/lib/appUrl";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("React error:", error, info);
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
        <div style={{ padding: 20, textAlign: "center" }}>
          Something went wrong — please reload.
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <LandingPage />
    <CookieConsentBanner cookiePolicyHref={appUrl("/legal/cookies")} />
  </ErrorBoundary>,
);
