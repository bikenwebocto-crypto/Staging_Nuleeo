import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, AlertCircle } from "lucide-react";
import { signInWithCustomToken } from "firebase/auth";
import { Logo } from "@ui/components/Logo";
import { auth } from "@ui/lib/firebase";

// Landing page for the platform-side "View As User" flow. The platform admin
// hits POST /api/admin/users/:id/impersonate which returns a Firebase custom
// token; the platform UI opens this page in a NEW TAB with the token in the
// URL fragment (#token=...). Fragments aren't sent to the server, so the
// token stays out of access logs; it still appears in browser history, but
// custom tokens expire in 1h.
//
// Once signed in, HomeRedirect on / takes the impersonated user to their
// owner/tenant dashboard. The admin's platform session is untouched because
// platform.oliowallet.com and app.oliowallet.com are different origins with
// separate Firebase Auth state.
export default function AuthImpersonatePage() {
  const [, setLocation] = useLocation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Fragments live on `location.hash` and arrive as "#token=eyJ..." — strip
    // the leading "#" and parse as URLSearchParams for forward-compat with
    // additional params we might add (e.g. &redirect=/owner/properties).
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);
    const token = params.get("token");

    if (!token) {
      setError("Missing impersonation token. Re-issue the link from the admin panel.");
      return;
    }

    (async () => {
      try {
        await signInWithCustomToken(auth, token);
        // Clear the token from the URL bar so a page reload doesn't replay it.
        window.history.replaceState({}, "", "/");
        setLocation("/");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setError(`Sign-in failed: ${msg}`);
      }
    })();
  }, [setLocation]);

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-neutral-950 text-neutral-400 px-6 text-center">
      <Logo variant="symbol" color="white" className="h-16 w-auto" />
      {error ? (
        <div className="mt-6 max-w-md">
          <div className="flex items-center justify-center gap-2 text-amber-400">
            <AlertCircle size={18} />
            <span className="text-sm font-medium">Impersonation failed</span>
          </div>
          <p className="mt-2 text-xs text-neutral-500">{error}</p>
        </div>
      ) : (
        <>
          <Loader2 className="mt-6 h-6 w-6 animate-spin text-neutral-500" aria-label="Loading" />
          <p className="mt-3 text-xs">Signing in as the selected user…</p>
        </>
      )}
    </div>
  );
}
