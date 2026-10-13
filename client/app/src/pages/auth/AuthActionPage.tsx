import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, Eye, EyeOff, CheckCircle2, AlertCircle } from "lucide-react";
import { motion } from "framer-motion";
import {
  applyActionCode,
  confirmPasswordReset,
  signInWithEmailAndPassword,
  verifyPasswordResetCode,
} from "firebase/auth";
import { Logo } from "@ui/components/Logo";
import { auth } from "@ui/lib/firebase";
import bg from "@/assets/images/bg-carousel-1.jpg";

// Branded handler for Firebase Auth email-action links (password reset, email
// verification, email recovery). Firebase Console → Authentication → Templates
// → "Customize action URL" must be set to https://app.oliowallet.com/auth/action
// so the links Firebase generates land here instead of firebaseapp.com.
//
// Query params Firebase appends: mode, oobCode, apiKey, continueUrl, lang.
type Mode = "resetPassword" | "verifyEmail" | "recoverEmail";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "resetForm"; email: string }
  | { kind: "submitting" }
  | { kind: "success"; message: string; continueUrl: string };

export default function AuthActionPage() {
  const [, setLocation] = useLocation();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const mode = params.get("mode") as Mode | null;
  const oobCode = params.get("oobCode");
  const continueUrl = params.get("continueUrl") || "https://app.oliowallet.com/";

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!mode || !oobCode) {
      setPhase({ kind: "error", message: "Invalid or missing link parameters." });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        if (mode === "resetPassword") {
          const email = await verifyPasswordResetCode(auth, oobCode);
          if (!cancelled) setPhase({ kind: "resetForm", email });
        } else if (mode === "verifyEmail") {
          await applyActionCode(auth, oobCode);
          if (!cancelled)
            setPhase({
              kind: "success",
              message: "Your email is verified. You can now sign in.",
              continueUrl,
            });
        } else if (mode === "recoverEmail") {
          await applyActionCode(auth, oobCode);
          if (!cancelled)
            setPhase({
              kind: "success",
              message: "Your email was restored. You can now sign in.",
              continueUrl,
            });
        } else {
          if (!cancelled) setPhase({ kind: "error", message: `Unsupported action: ${mode}` });
        }
      } catch (err: any) {
        const msg = mapAuthError(err?.code) ?? "This link is invalid or has expired.";
        if (!cancelled) setPhase({ kind: "error", message: msg });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mode, oobCode, continueUrl]);

  const handleSubmitReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (password.length < 6) {
      setFormError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setFormError("Passwords don't match.");
      return;
    }

    const email = phase.kind === "resetForm" ? phase.email : null;
    if (!email || !oobCode) return;

    setPhase({ kind: "submitting" });
    try {
      await confirmPasswordReset(auth, oobCode, password);
      try {
        await signInWithEmailAndPassword(auth, email, password);
      } catch (signInErr) {
        // Sign-in failure here isn't fatal — the password reset succeeded,
        // and the user can sign in manually from /login. Log it so we can
        // see in observability if this starts failing systematically (e.g.
        // Firebase revoke-on-reset behaviour changed).
        console.warn("[AuthActionPage] reset succeeded but auto sign-in failed:", signInErr);
      }
      setPhase({
        kind: "success",
        message: "Password set. Taking you to your dashboard…",
        continueUrl,
      });
    } catch (err: any) {
      setPhase({ kind: "resetForm", email });
      setFormError(mapAuthError(err?.code) ?? "Something went wrong. Try again.");
    }
  };

  // Auto-redirect on success after a short pause so the user sees confirmation.
  useEffect(() => {
    if (phase.kind !== "success") return;
    const t = setTimeout(() => {
      // continueUrl arrives as a query param after Firebase's verify/reset
      // flow. Validate strictly: only http(s) on the allowed Olio hosts.
      // Without this, `javascript:alert(...)` would parse cleanly (origin
      // === "null") and `window.location.href` would execute the script
      // in the just-signed-in user's session — full account takeover via
      // a crafted link sent to the victim.
      let target: URL | null = null;
      try {
        target = new URL(phase.continueUrl);
      } catch {
        setLocation("/");
        return;
      }
      const ALLOWED_HOSTS = new Set([
        "app.oliowallet.com",
        "platform.oliowallet.com",
        "oliowallet.com",
        "www.oliowallet.com",
      ]);
      const isSafeProtocol =
        target.protocol === "https:" ||
        (target.protocol === "http:" &&
          (target.hostname === "localhost" || target.hostname === "127.0.0.1"));
      const isSafeHost =
        target.origin === window.location.origin || ALLOWED_HOSTS.has(target.hostname);
      if (!isSafeProtocol || !isSafeHost) {
        setLocation("/");
        return;
      }
      if (target.origin === window.location.origin) {
        setLocation(target.pathname + target.search + target.hash || "/");
      } else {
        window.location.href = target.href;
      }
    }, 1600);
    return () => clearTimeout(t);
  }, [phase, setLocation]);

  return (
    <div className="min-h-dvh w-full relative overflow-hidden font-sans flex flex-col">
      <div className="absolute inset-0 z-0">
        <img src={bg} alt="" className="absolute w-full h-full object-cover" />
        <div className="absolute inset-0 bg-black/40" />
      </div>

      <div className="relative z-10 pt-16 flex flex-col items-center">
        <Logo variant="wordmark" color="white" className="h-12 w-auto" />
        <p className="text-white/80 text-lg font-medium mt-4">Your real estate wallet</p>
      </div>

      <div className="flex-1 relative z-10 flex flex-col justify-center pb-10 px-6">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="w-full max-w-md mx-auto"
        >
          <div className="bg-card/95 backdrop-blur-md rounded-3xl p-6 shadow-xl">
            {phase.kind === "loading" && (
              <div className="flex flex-col items-center gap-3 py-6">
                <Loader2 className="animate-spin text-foreground/70" size={28} />
                <p className="text-foreground/70 text-sm">Verifying your link…</p>
              </div>
            )}

            {phase.kind === "error" && (
              <div role="alert" className="flex flex-col items-center gap-3 py-2 text-center">
                <AlertCircle className="text-destructive" size={32} />
                <h2 className="text-xl font-bold text-foreground">Link can't be used</h2>
                <p className="text-foreground/70 text-sm">{phase.message}</p>
                <button
                  onClick={() => setLocation("/auth")}
                  className="mt-3 w-full bg-foreground text-background font-bold text-base py-3 rounded-xl shadow-lg active:scale-[0.98] transition hover:bg-foreground/90"
                >
                  Go to sign in
                </button>
              </div>
            )}

            {phase.kind === "success" && (
              <div role="status" className="flex flex-col items-center gap-3 py-2 text-center">
                <CheckCircle2 className="text-success" size={32} />
                <h2 className="text-xl font-bold text-foreground">All set</h2>
                <p className="text-foreground/70 text-sm">{phase.message}</p>
                <Loader2 className="animate-spin text-foreground/40 mt-2" size={18} />
              </div>
            )}

            {(phase.kind === "resetForm" || phase.kind === "submitting") && (
              <form onSubmit={handleSubmitReset} className="space-y-3">
                <div className="text-center pb-1">
                  <h2 className="text-xl font-bold text-foreground">Set your password</h2>
                  <p className="text-foreground/60 text-sm mt-1">
                    for{" "}
                    <span className="font-medium text-foreground">
                      {phase.kind === "resetForm" ? phase.email : ""}
                    </span>
                  </p>
                  <p className="text-foreground/50 text-xs mt-2">
                    You'll be able to sign in with this email and password. Any other sign-in
                    methods on your account (like Google) keep working.
                  </p>
                </div>

                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="New password (6+ characters)"
                    autoFocus
                    disabled={phase.kind === "submitting"}
                    className="w-full bg-background border-none rounded-xl px-4 py-3 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition font-medium placeholder:text-muted-foreground/70 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>

                <input
                  type={showPassword ? "text" : "password"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Confirm password"
                  disabled={phase.kind === "submitting"}
                  className="w-full bg-background border-none rounded-xl px-4 py-3 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition font-medium placeholder:text-muted-foreground/70"
                />

                {formError && (
                  <p role="alert" className="text-destructive text-sm font-medium text-center">
                    {formError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={phase.kind === "submitting"}
                  className="w-full bg-foreground text-background font-bold text-lg py-3.5 rounded-xl shadow-lg active:scale-[0.98] transition hover:bg-foreground/90 flex items-center justify-center gap-2 mt-2 disabled:opacity-50"
                >
                  {phase.kind === "submitting" ? (
                    <>
                      <Loader2 className="animate-spin" size={18} />
                      Saving…
                    </>
                  ) : (
                    "Save password"
                  )}
                </button>
              </form>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function mapAuthError(code: string | undefined): string | null {
  switch (code) {
    case "auth/expired-action-code":
      return "This link has expired. Ask the admin to generate a new one.";
    case "auth/invalid-action-code":
      return "This link is invalid or has already been used.";
    case "auth/user-disabled":
      return "This account has been disabled. Contact support.";
    case "auth/user-not-found":
      return "We couldn't find an account for this link.";
    case "auth/weak-password":
      return "Password is too weak. Use at least 6 characters.";
    default:
      return null;
  }
}
