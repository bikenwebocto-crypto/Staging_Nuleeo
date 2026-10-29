// Platform sign-in. No sign-up — admin accounts are provisioned by an
// existing superadmin (Phase 7 invite flow). After Google sign-in resolves
// we verify the user has an admin/superadmin role; if not, we immediately
// sign them back out so no platform session exists, and surface a neutral
// "no access" message (no email echoed back).

import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { signInWithPopup, type AuthError } from "firebase/auth";
import { Logo } from "@ui/components/Logo";
import { auth, googleProvider } from "@ui/lib/firebase";
import { useAuth } from "@ui/lib/useAuth";

function authErrorMessage(err: unknown): string {
  const code = (err as AuthError)?.code ?? "";
  switch (code) {
    case "auth/popup-closed-by-user":
      return "Google sign-in was cancelled.";
    default:
      return (err as Error)?.message ?? "Something went wrong. Try again.";
  }
}

export default function Login() {
  const [, setLocation] = useLocation();
  const { firebaseUser, profile, loading: authLoading, signOut } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // Distinguishes "user just clicked Continue with Google" from "page mounted
  // with a leftover non-admin session." Without this flag, any stale session
  // (e.g. signed in on app.oliowallet.com on a shared device, or a previous
  // failed attempt here) trips the "no access" error before the user has done
  // anything — we'd rather silently sign them out and let them try fresh.
  const attemptedSignInRef = useRef(false);

  // Once auth state settles, route admins through; for everyone else, tear
  // down the Firebase session so no platform session ever exists for a
  // non-admin (covers both fresh sign-ins and stale sessions from demotions).
  useEffect(() => {
    if (authLoading) return;
    if (!firebaseUser || !profile) return;
    const isAdmin = profile.roles.includes("admin") || profile.roles.includes("superadmin");
    if (isAdmin) {
      setLocation("/");
      return;
    }
    if (attemptedSignInRef.current) {
      setError("This account doesn't have access.");
      attemptedSignInRef.current = false;
    }
    void signOut();
  }, [authLoading, firebaseUser, profile, setLocation, signOut]);

  async function handleGoogleSignIn() {
    setError("");
    setSubmitting(true);
    attemptedSignInRef.current = true;
    try {
      // Force the account picker every time so the user can pick a different
      // Google account on retry (without this, the popup may auto-select the
      // only Google account active in the browser).
      googleProvider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, googleProvider);
      // Role check + sign-out-on-deny happen in the effect above once the
      // profile from /api/me lands.
    } catch (err) {
      attemptedSignInRef.current = false;
      setError(authErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh w-full bg-[#060A0B] bg-[linear-gradient(180deg,#103E42E5_0%,#060A0B00_51%)] text-neutral-100 flex items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center space-y-2">
          <Logo variant="wordmark" color="white" className="h-10 w-auto" />
          <p className="text-neutral-400 text-sm">Admin platform</p>
        </div>

        <div className="bg-neutral-900 rounded-2xl p-6 space-y-4 border border-neutral-800">
          <button
            onClick={handleGoogleSignIn}
            disabled={submitting}
            className="w-full bg-neutral-100 text-neutral-900 font-medium py-3 rounded-xl hover:bg-white transition disabled:opacity-50 flex items-center justify-center gap-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900"
          >
            {submitting ? (
              <Loader2 className="animate-spin" size={18} />
            ) : (
              <>
                <svg viewBox="0 0 24 24" className="w-5 h-5" xmlns="http://www.w3.org/2000/svg">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.84z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
                </svg>
                Continue with Google
              </>
            )}
          </button>

          {error && (
            <p role="alert" className="text-red-400 text-sm text-center">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
