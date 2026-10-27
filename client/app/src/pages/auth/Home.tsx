import { useState, useEffect, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { Loader2, ArrowLeft, Mail } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Select, SelectContent, SelectTrigger, SelectValue } from "@ui/components/ui/select";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithPopup,
  type AuthError,
  type AuthProvider,
} from "firebase/auth";
import { Logo } from "@ui/components/Logo";
import { auth, googleProvider, appleProvider } from "@ui/lib/firebase";
import { apiRequest } from "@ui/lib/queryClient";
import { useAuth } from "@ui/lib/useAuth";
import { useToast } from "@ui/hooks/use-toast";
import { COUNTRY_CODES, combinePhone } from "@ui/data/phoneCountries";

// Maps Firebase Auth error codes to short, user-readable messages.
// Note: with email-enumeration protection enabled, Firebase collapses
// user-not-found / wrong-password / invalid-email into `auth/invalid-credential`
// — we deliberately don't reveal which one to avoid leaking account existence.
function authErrorMessage(err: unknown): string {
  const code = (err as AuthError)?.code ?? "";
  switch (code) {
    case "auth/invalid-email":
      return "That email address looks invalid.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
      return "Incorrect email or password.";
    case "auth/email-already-in-use":
      // Hedged copy: avoid confirming the email exists. Keep enumeration protection intact.
      return "We couldn't create that account. If you already have one, try signing in instead.";
    case "auth/weak-password":
      return "Password must be at least 6 characters.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Sign-in was cancelled.";
    case "auth/popup-blocked":
      return "Your browser blocked the sign-in popup. Allow popups and try again.";
    case "auth/operation-not-allowed":
      return "This sign-in method isn't available yet.";
    case "auth/account-exists-with-different-credential":
      // Hedged: don't reveal which method the email is registered with.
      return "We couldn't sign you in this way. Try signing in with your email and password.";
    default:
      return (err as Error)?.message ?? "Something went wrong. Try again.";
  }
}

type Step = "welcome" | "email" | "register";

// Slide variants for the auth screen stack. `direction` is +1 when pushing
// deeper, -1 when popping back; that flips the slide axis so transitions
// match the user's mental model of a navigation stack.
const stackVariants = {
  enter: (dir: number) => ({ x: dir * 40, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir * -40, opacity: 0 }),
};
const stackTransition = { duration: 0.22, ease: [0.4, 0, 0.2, 1] as const };

// Order defines slide direction: forward goes deeper in the stack (slides
// left), back goes shallower (slides right). Keep this consistent with the
// navigation flow so animations match user intent.
const STEP_ORDER: Step[] = ["welcome", "email", "register"];

// The auth screen is locked to the dark brand look (teal-to-black gradient
// behind a charcoal card) regardless of the app theme, so it uses fixed
// colors instead of theme tokens.
const cardClass = "w-full rounded-[28px] bg-[#16191b] p-7 shadow-2xl"; // tokens-ok
const labelClass = "block text-xs font-medium text-white/70 mb-2";
const inputClass =
  "w-full bg-[#22272a] border-none rounded-full px-4 py-3 text-white font-medium placeholder:text-white/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 transition"; // tokens-ok
const primaryButtonClass =
  "w-full bg-white text-[#0b0d0e] font-semibold text-base py-3.5 rounded-xl active:scale-[0.98] transition hover:bg-white/90 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"; // tokens-ok
const socialButtonClass =
  "w-full bg-[#22272a] text-white font-medium py-3.5 rounded-xl transition hover:bg-[#2a3033] flex items-center justify-center gap-3 disabled:opacity-50"; // tokens-ok
const linkClass = "text-white underline underline-offset-2 hover:text-white/80";

function GoogleIcon() {
  return (
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
  );
}

function AppleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="w-5 h-5"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M16.37 12.73c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.71-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.87-.76-1.47.02-2.83.86-3.59 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.24 2.73 2.2 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.41 1.2-2.47-.03-.01-2.3-.88-2.32-3.5zM14.19 6.27c.6-.73 1.01-1.75.9-2.77-.87.04-1.92.58-2.54 1.31-.56.64-1.05 1.68-.92 2.67.97.08 1.96-.49 2.56-1.21z" />
    </svg>
  );
}

function SocialButtons({
  loading,
  onProvider,
}: {
  loading: boolean;
  onProvider: (provider: AuthProvider) => void;
}) {
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => onProvider(googleProvider)}
        disabled={loading}
        className={socialButtonClass}
      >
        <GoogleIcon />
        Continue with Google
      </button>
      <button
        type="button"
        onClick={() => onProvider(appleProvider)}
        disabled={loading}
        className={socialButtonClass}
      >
        <AppleIcon />
        Continue with Apple
      </button>
    </div>
  );
}

function OrDivider() {
  return <p className="text-center text-xs text-white/50 my-5">or</p>;
}

function ErrorText({ children }: { children: string }) {
  return (
    // tokens-ok: the auth card is always dark, so a fixed light red stays readable.
    <p role="alert" className="text-red-400 text-center text-sm font-medium">
      {children}
    </p>
  );
}

export default function Home() {
  const [, setLocation] = useLocation();
  const { refreshProfile } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState<Step>("welcome");
  // 1 = sliding forward (push), -1 = sliding back (pop). Drives the motion
  // variants so transitions feel like a real navigation stack.
  const [direction, setDirection] = useState<1 | -1>(1);
  const [resendCooldown, setResendCooldown] = useState(0);
  const cooldownRef = useRef<number | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneCountry, setPhoneCountry] = useState("CY");
  const phoneDial = useMemo(
    () => COUNTRY_CODES.find((c) => c.code === phoneCountry)?.dial ?? "+357",
    [phoneCountry],
  );
  const phoneMaxLength = useMemo(
    () => COUNTRY_CODES.find((c) => c.code === phoneCountry)?.len ?? 15,
    [phoneCountry],
  );
  const [showPassword, setShowPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function goTo(next: Step) {
    setError("");
    const currIdx = STEP_ORDER.indexOf(step);
    const nextIdx = STEP_ORDER.indexOf(next);
    setDirection(nextIdx >= currIdx ? 1 : -1);
    setStep(next);
  }

  function goBack(target: Step) {
    setError("");
    setDirection(-1);
    setStep(target);
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError("Enter a valid email to continue.");
      return;
    }
    setEmail(trimmed);
    setError("");
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, trimmed, password);
      // AuthProvider's onAuthStateChanged will load /api/me. Send to root,
      // which redirects based on role.
      setLocation("/");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  // Cooldown tick. Decrements once per second while > 0.
  useEffect(() => {
    if (resendCooldown <= 0) return;
    cooldownRef.current = window.setTimeout(
      () => setResendCooldown((s) => Math.max(0, s - 1)),
      1000,
    );
    return () => {
      if (cooldownRef.current) window.clearTimeout(cooldownRef.current);
    };
  }, [resendCooldown]);

  // Inline forgot-password: the user already typed their email on the
  // sign-in screen, so we send the reset directly through our backend
  // (which delivers via Resend with our branded template) and confirm
  // with a toast — no extra screen transition needed.
  async function sendResetLink() {
    const target = email.trim();
    if (!target || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
      setError("Enter your email first.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await apiRequest("POST", "/api/auth/forgot-password", { email: target });
      setResendCooldown(30);
      toast({
        title: "Check your inbox",
        description: `If an account exists for ${target}, we just sent a password reset link.`,
      });
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!acceptedTerms) {
      setError(
        "Please accept the Terms of Use, Privacy Policy, Cookie Policy and Acceptable Use Policy to continue.",
      );
      return;
    }
    // Normalize casing at signup so the new account's email matches the
    // lowercased email an owner used to invite this tenant — otherwise
    // the server-side auto-link (Firestore `==` is case-sensitive) never
    // connects them. Defense-in-depth; the server also lowercases.
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError("Enter a valid email to continue.");
      return;
    }
    setEmail(trimmedEmail);
    setError("");
    setLoading(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, trimmedEmail, password);
      // Fire-and-forget verification email. If sending fails (e.g. quota), we
      // don't block onboarding — the user can resend from Settings later.
      sendEmailVerification(cred.user).catch((e) =>
        console.warn("sendEmailVerification failed:", e),
      );
      // Provision the profile doc, then attach the form fields.
      await apiRequest("GET", "/api/me");
      await apiRequest("PATCH", "/api/profile", {
        firstName,
        lastName,
        phone: combinePhone(phoneCountry, phone),
      });
      await refreshProfile();
      toast({
        title: "Verify your email",
        description: `We sent a verification link to ${trimmedEmail}. Check your inbox to confirm your address.`,
      });
      // Land directly on the tenant dashboard — root redirects by role.
      setLocation("/");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleProvider(provider: AuthProvider) {
    setError("");
    setLoading(true);
    try {
      if (provider === googleProvider) {
        googleProvider.setCustomParameters({ prompt: "select_account" });
      }
      await signInWithPopup(auth, provider);
      // Popup succeeded — the user is now authenticated. Navigate immediately
      // and let the "/" route (HomeRedirect) own profile creation/load and its
      // retry UI. AuthProvider's onAuthStateChanged also fires here and loads
      // /api/me (which creates the doc on first sign-in), so a transient
      // /api/me failure no longer strands a signed-in user on /auth.
      setLocation("/");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  const passwordToggle = (
    <button
      type="button"
      onClick={() => setShowPassword(!showPassword)}
      className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-medium text-white/60 hover:text-white"
      aria-label={showPassword ? "Hide password" : "Show password"}
    >
      {showPassword ? "Hide" : "Show"}
    </button>
  );

  return (
    <div
      className="min-h-dvh w-full font-sans flex flex-col items-center px-4 pb-10 bg-[#07090a] bg-[linear-gradient(180deg,#123a3d_0%,#0a1a1c_30%,#07090a_60%)]" // tokens-ok
    >
      <div className="pt-16 pb-6 flex flex-col items-center">
        <Logo variant="wordmark" color="white" className="h-12 w-auto" />
        <p className="text-white text-sm font-medium mt-2">Know what you own.</p>
      </div>

      <div className="w-full max-w-md">
        <AnimatePresence mode="wait" custom={direction}>
          {step === "welcome" && (
            <motion.div
              key="welcome"
              custom={direction}
              variants={stackVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={stackTransition}
              className={cardClass}
            >
              <h1 className="text-3xl font-medium text-white">Welcome</h1>
              <p className="text-sm text-white/60 mt-2 mb-7">Sign in or create your account.</p>

              <button
                onClick={() => goTo("email")}
                disabled={loading}
                className={primaryButtonClass}
              >
                <Mail size={18} />
                Continue with email
              </button>

              <OrDivider />
              <SocialButtons loading={loading} onProvider={handleProvider} />

              {error && (
                <div className="mt-4">
                  <ErrorText>{error}</ErrorText>
                </div>
              )}

              <p className="text-center text-sm text-white/60 mt-6">
                New here?{" "}
                <button onClick={() => goTo("register")} className="font-semibold text-white">
                  Sign up
                </button>
              </p>
            </motion.div>
          )}

          {step === "email" && (
            <motion.div
              key="email"
              custom={direction}
              variants={stackVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={stackTransition}
              className={cardClass}
            >
              <div className="flex items-center gap-2">
                <button
                  onClick={() => goBack("welcome")}
                  className="-ml-1 p-1 text-white/70 hover:text-white rounded-full transition"
                  aria-label="Back"
                >
                  <ArrowLeft size={22} />
                </button>
                <h1 className="text-3xl font-medium text-white">Log in</h1>
              </div>
              <p className="text-sm text-white/60 mt-2 mb-7">Welcome back.</p>

              <form onSubmit={handleSignIn} className="space-y-5">
                <div>
                  <label htmlFor="login-email" className={labelClass}>
                    Email
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    required
                    autoFocus
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={inputClass}
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label htmlFor="login-password" className="text-xs font-medium text-white/70">
                      Password
                    </label>
                    <button
                      type="button"
                      onClick={() => sendResetLink()}
                      disabled={loading || resendCooldown > 0}
                      className="text-xs font-medium text-white/60 hover:text-white transition disabled:opacity-50"
                    >
                      {resendCooldown > 0
                        ? `Reset link sent (${resendCooldown}s)`
                        : "Forgot password?"}
                    </button>
                  </div>
                  <div className="relative">
                    <input
                      id="login-password"
                      type={showPassword ? "text" : "password"}
                      required
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={`${inputClass} pr-16`}
                    />
                    {passwordToggle}
                  </div>
                </div>

                {error && <ErrorText>{error}</ErrorText>}

                <button type="submit" disabled={loading} className={primaryButtonClass}>
                  {loading ? <Loader2 className="animate-spin" /> : "Log in"}
                </button>
              </form>

              {/* Social fallback — handles users who originally signed up with
                  Google/Apple (email-enumeration protection means we can't
                  detect this server-side, so we offer it here instead). */}
              <OrDivider />
              <SocialButtons loading={loading} onProvider={handleProvider} />

              <p className="text-center text-sm text-white/60 mt-6">
                New here?{" "}
                <button onClick={() => goTo("register")} className="font-semibold text-white">
                  Sign up
                </button>
              </p>
            </motion.div>
          )}

          {step === "register" && (
            <motion.div
              key="register"
              custom={direction}
              variants={stackVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={stackTransition}
              className={cardClass}
            >
              <h1 className="text-3xl font-medium text-white">Create your account</h1>
              <p className="text-sm text-white/60 mt-2 mb-7">Free to start. No card needed.</p>

              <form onSubmit={handleRegister} className="space-y-5">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="reg-first" className={labelClass}>
                      First name
                    </label>
                    <input
                      id="reg-first"
                      type="text"
                      required
                      autoComplete="given-name"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="reg-last" className={labelClass}>
                      Last name
                    </label>
                    <input
                      id="reg-last"
                      type="text"
                      required
                      autoComplete="family-name"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="reg-phone" className={labelClass}>
                    Phone number
                  </label>
                  <div
                    className="flex items-center bg-[#22272a] rounded-full focus-within:ring-2 focus-within:ring-white/40 transition" // tokens-ok
                  >
                    <Select
                      value={phoneCountry}
                      onValueChange={(next) => {
                        const nextLen = COUNTRY_CODES.find((c) => c.code === next)?.len ?? 15;
                        setPhoneCountry(next);
                        setPhone((p) => p.replace(/\D/g, "").slice(0, nextLen));
                      }}
                    >
                      <SelectTrigger
                        aria-label="Country code"
                        className="w-auto h-auto border-0 shadow-none rounded-l-full rounded-r-none pl-4 pr-1 py-3 bg-transparent font-medium text-white focus:ring-0 focus:outline-none gap-1 [&>span]:line-clamp-none [&>span]:flex [&>span]:items-center [&>svg]:text-white/50"
                      >
                        <SelectValue>
                          <span className="flex items-center gap-1.5">
                            <span>{phoneCountry}</span>
                            <span>{phoneDial}</span>
                          </span>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="max-h-72 min-w-[16rem] bg-popover border border-border text-popover-foreground shadow-2xl">
                        {COUNTRY_CODES.map((c) => (
                          <SelectPrimitive.Item
                            key={c.code}
                            value={c.code}
                            className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm py-2 pl-3 pr-3 text-sm outline-none text-popover-foreground hover:bg-accent focus:bg-accent data-[state=checked]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                          >
                            <SelectPrimitive.ItemText>
                              <span className="flex items-center gap-1.5 text-popover-foreground">
                                <span>{c.flag}</span>
                                <span>{c.dial}</span>
                              </span>
                            </SelectPrimitive.ItemText>
                            <span className="text-muted-foreground">{c.name}</span>
                          </SelectPrimitive.Item>
                        ))}
                      </SelectContent>
                    </Select>
                    <input
                      id="reg-phone"
                      type="tel"
                      required
                      inputMode="numeric"
                      autoComplete="tel-national"
                      value={phone}
                      maxLength={phoneMaxLength}
                      onChange={(e) =>
                        setPhone(e.target.value.replace(/\D/g, "").slice(0, phoneMaxLength))
                      }
                      className="flex-1 min-w-0 bg-transparent border-none rounded-r-full pl-2 pr-4 py-3 text-white font-medium focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="reg-email" className={labelClass}>
                    Email
                  </label>
                  <input
                    id="reg-email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={inputClass}
                  />
                </div>

                <div>
                  <label htmlFor="reg-password" className={labelClass}>
                    Password
                  </label>
                  <div className="relative">
                    <input
                      id="reg-password"
                      type={showPassword ? "text" : "password"}
                      required
                      minLength={6}
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={`${inputClass} pr-16`}
                    />
                    {passwordToggle}
                  </div>
                </div>

                <label className="flex items-start gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    required
                    checked={acceptedTerms}
                    onChange={(e) => setAcceptedTerms(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded accent-white cursor-pointer flex-shrink-0"
                  />
                  <span className="text-xs text-white/60 leading-snug">
                    I have read and agree to the{" "}
                    <a
                      href="/legal/terms"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={linkClass}
                    >
                      Terms of Use
                    </a>
                    ,{" "}
                    <a
                      href="/legal/privacy"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={linkClass}
                    >
                      Privacy Policy
                    </a>
                    ,{" "}
                    <a
                      href="/legal/cookies"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={linkClass}
                    >
                      Cookie Policy
                    </a>{" "}
                    and{" "}
                    <a
                      href="/legal/aup"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={linkClass}
                    >
                      Acceptable Use Policy
                    </a>
                    .{" "}
                    <a
                      href="/legal/owner-terms"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={linkClass}
                    >
                      Owner terms
                    </a>{" "}
                    apply to my account.
                  </span>
                </label>

                {error && <ErrorText>{error}</ErrorText>}

                <button
                  type="submit"
                  disabled={loading || !acceptedTerms}
                  className={primaryButtonClass}
                >
                  {loading ? <Loader2 className="animate-spin" /> : "Sign up"}
                </button>
              </form>

              <OrDivider />
              <SocialButtons loading={loading} onProvider={handleProvider} />

              <p className="text-center text-sm text-white/60 mt-6">
                Already have an account?{" "}
                <button onClick={() => goTo("email")} className="font-semibold text-white">
                  Log in
                </button>
              </p>
              <p className="text-center text-xs text-white/50 mt-4">
                Are you a tenant? Use the link in your invite email.
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-6 flex items-center justify-center gap-3 text-xs text-white/50 flex-wrap">
          <a href="/legal/privacy" className="hover:text-white underline underline-offset-2">
            Privacy
          </a>
          <span aria-hidden="true">·</span>
          <a href="/legal/terms" className="hover:text-white underline underline-offset-2">
            Terms
          </a>
          <span aria-hidden="true">·</span>
          <a href="/legal/cookies" className="hover:text-white underline underline-offset-2">
            Cookies
          </a>
          <span aria-hidden="true">·</span>
          <a href="/legal" className="hover:text-white underline underline-offset-2">
            All legal
          </a>
        </div>
      </div>
    </div>
  );
}
