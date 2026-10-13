// Resolve a URL on the user-app subdomain from the landing site.
// Mirrors the platformUrl helper in client/app/src/App.tsx so dev, preview, and
// the production custom domain all work without an env var.
export function appUrl(path: string = "/auth"): string {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return `http://localhost:5102${path}`;
  if (host.endsWith(".web.app")) return `https://oliowallet-app.web.app${path}`;
  if (host === "oliowallet.com" || host === "www.oliowallet.com") {
    return `https://app.oliowallet.com${path}`;
  }
  // Unknown host (custom tunnel, staging, etc.) — fall back to same-origin path.
  return path;
}
