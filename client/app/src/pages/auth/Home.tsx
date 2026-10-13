import { useState, useEffect, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { Loader2, Eye, EyeOff, ArrowLeft, ArrowRight, Mail } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Select, SelectContent, SelectTrigger, SelectValue } from "@ui/components/ui/select";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithPopup,
  type AuthError,
} from "firebase/auth";
import { Logo } from "@ui/components/Logo";
import { auth, googleProvider } from "@ui/lib/firebase";
import { apiRequest } from "@ui/lib/queryClient";
import { useAuth } from "@ui/lib/useAuth";
import { useToast } from "@ui/hooks/use-toast";
import { COUNTRY_CODES, combinePhone } from "@ui/data/phoneCountries";
import bg1 from "@/assets/images/bg-carousel-1.jpg";
import bg2 from "@/assets/images/bg-carousel-2.jpg";
import bg3 from "@/assets/images/bg-carousel-3.jpg";
import bg4 from "@/assets/images/bg-carousel-4.jpg";
import bg5 from "@/assets/images/bg-carousel-5.jpg";
import bg6 from "@/assets/images/bg-carousel-6.jpg";
import bg7 from "@/assets/images/bg-carousel-7.jpg";
import bg8 from "@/assets/images/bg-carousel-8.jpg";
import bg9 from "@/assets/images/bg-carousel-9.jpg";
import bg10 from "@/assets/images/bg-carousel-10.jpg";

const images = [bg1, bg2, bg3, bg4, bg5, bg6, bg7, bg8, bg9, bg10];

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
      return "Google sign-in was cancelled.";
    case "auth/popup-blocked":
      return "Your browser blocked the Google popup. Allow popups and try again.";
    case "auth/account-exists-with-different-credential":
      // Hedged: don't reveal that the email is registered with another method.
      return "We couldn't sign you in with Google. Try signing in with your email and password.";
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

export default function Home() {
  const [, setLocation] = useLocation();
  const { refreshProfile } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState<Step>("welcome");
  // 1 = sliding forward (push), -1 = sliding back (pop). Drives the motion
  // variants so transitions feel like a real navigation stack.
  const [direction, setDirection] = useState<1 | -1>(1);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
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
  const phoneFlag = useMemo(
    () => COUNTRY_CODES.find((c) => c.code === phoneCountry)?.flag ?? "🇨🇾",
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

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentImageIndex((prev) => (prev + 1) % images.length);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

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

  async function handleGoogle() {
    setError("");
    setLoading(true);
    try {
      googleProvider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, googleProvider);
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

  return (
    <div className="min-h-dvh w-full relative overflow-hidden font-sans flex flex-col">
      {/* Background carousel */}
      <div className="absolute inset-0 z-0">
        <AnimatePresence mode="wait">
          <motion.img
            key={currentImageIndex}
            src={images[currentImageIndex]}
            alt="Welcome Background"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 2.5, ease: "easeInOut" }}
            className="absolute w-full h-full object-cover"
          />
        </AnimatePresence>
        <div className="absolute inset-0 bg-black/30" />
      </div>

      <div className="relative z-10 pt-16 flex flex-col items-center">
        <Logo variant="wordmark" color="white" className="h-12 w-auto" />
        <p className="text-white/80 text-lg font-medium mt-4">Your real estate wallet</p>
      </div>

      <div className="flex-1 relative z-10 flex flex-col justify-end pb-10 px-6">
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
              className="w-full max-w-md mx-auto space-y-3"
            >
              <button
                onClick={handleGoogle}
                disabled={loading}
                className="w-full bg-card text-foreground font-bold text-lg py-4 rounded-full shadow-lg active:scale-[0.98] transition hover:bg-card/90 flex items-center justify-center gap-3 disabled:opacity-50"
              >
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
              </button>

              <div className="flex items-center gap-3 py-1">
                <div className="flex-1 h-px bg-white/20" />
                <span className="text-white/60 text-xs font-medium uppercase tracking-wider">
                  or
                </span>
                <div className="flex-1 h-px bg-white/20" />
              </div>

              <button
                onClick={() => goTo("email")}
                disabled={loading}
                className="w-full bg-card/10 backdrop-blur-md text-white font-bold text-lg py-4 rounded-full shadow-lg border border-white/20 active:scale-[0.98] transition hover:bg-card/20 disabled:opacity-50 flex items-center justify-center gap-3"
              >
                <Mail size={18} />
                Continue with email
              </button>

              {error && (
                <motion.p
                  role="alert"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  // tokens-ok: error sits on an always-dark bg-black/50 glass pill over the welcome photo, so a theme-adaptive destructive token would go near-black (unreadable) in light mode.
                  className={
                    "text-red-400 text-center text-sm font-medium bg-black/50 py-2 rounded-lg backdrop-blur-sm" // tokens-ok
                  }
                >
                  {error}
                </motion.p>
              )}
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
              className="w-full max-w-md mx-auto"
            >
              <div className="bg-card/95 backdrop-blur-md rounded-3xl p-6 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <button
                    onClick={() => goBack("welcome")}
                    className="p-1 hover:bg-secondary rounded-full transition"
                    aria-label="Back"
                  >
                    <ArrowLeft size={20} />
                  </button>
                  <h2 className="text-xl font-bold text-foreground">What's your email?</h2>
                </div>

                <form onSubmit={handleSignIn} className="space-y-3">
                  <input
                    type="email"
                    required
                    autoFocus
                    autoComplete="email"
                    aria-label="Email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-background border-none rounded-xl px-4 py-3 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition font-medium placeholder:text-muted-foreground/70"
                  />

                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      required
                      autoComplete="current-password"
                      aria-label="Password"
                      placeholder="Password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full bg-background border-none rounded-xl px-4 py-3 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition font-medium placeholder:text-muted-foreground/70 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/70 hover:text-muted-foreground p-1"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>

                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => sendResetLink()}
                      disabled={loading || resendCooldown > 0}
                      className="text-xs font-medium text-muted-foreground hover:text-foreground transition disabled:opacity-50"
                    >
                      {resendCooldown > 0
                        ? `Reset link sent (${resendCooldown}s)`
                        : "Forgot password?"}
                    </button>
                  </div>

                  {error && (
                    <p role="alert" className="text-destructive text-center text-sm font-medium">
                      {error}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-foreground text-background font-bold text-lg py-3.5 rounded-xl shadow-lg active:scale-[0.98] transition hover:bg-foreground/90 flex items-center justify-center gap-2 mt-2 disabled:opacity-50"
                  >
                    {loading ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <>
                        Login <ArrowRight size={18} />
                      </>
                    )}
                  </button>
                </form>

                {/* Inline Google fallback — handles users who originally signed
                    up with Google (email-enumeration protection means we can't
                    detect this server-side, so we offer it here instead). */}
                <div className="flex items-center gap-3 my-4">
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                    or
                  </span>
                  <div className="flex-1 h-px bg-border" />
                </div>

                <button
                  type="button"
                  onClick={handleGoogle}
                  disabled={loading}
                  className="w-full bg-background border border-border text-foreground font-semibold py-3 rounded-xl transition hover:bg-secondary flex items-center justify-center gap-3 disabled:opacity-50"
                >
                  <svg viewBox="0 0 24 24" className="w-4 h-4" xmlns="http://www.w3.org/2000/svg">
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
                </button>

                <button
                  onClick={() => goTo("register")}
                  className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition mt-4"
                >
                  New here? <span className="font-semibold text-foreground">Create an account</span>
                </button>
              </div>
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
              className="w-full max-w-md mx-auto"
            >
              <div className="bg-card/95 backdrop-blur-md rounded-3xl p-6 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <button
                    onClick={() => goBack("welcome")}
                    className="p-1 hover:bg-secondary rounded-full transition"
                    aria-label="Back"
                  >
                    <ArrowLeft size={20} />
                  </button>
                  <h2 className="text-xl font-bold text-foreground">Create account</h2>
                </div>

                <form onSubmit={handleRegister} className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <input
                      type="text"
                      required
                      autoComplete="given-name"
                      aria-label="First name"
                      placeholder="First name"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      className="w-full bg-background border-none rounded-xl px-4 py-3 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition font-medium placeholder:text-muted-foreground/70"
                    />
                    <input
                      type="text"
                      required
                      autoComplete="family-name"
                      aria-label="Last name"
                      placeholder="Last name"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      className="w-full bg-background border-none rounded-xl px-4 py-3 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition font-medium placeholder:text-muted-foreground/70"
                    />
                  </div>

                  <div className="flex items-stretch bg-background rounded-xl focus-within:ring-2 focus-within:ring-ring transition">
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
                        className="w-auto h-auto border-0 shadow-none rounded-l-xl rounded-r-none pl-3 pr-2 py-3 bg-transparent font-medium text-foreground focus:ring-0 focus:outline-none gap-1.5 [&>span]:line-clamp-none [&>span]:flex [&>span]:items-center"
                      >
                        <SelectValue>
                          <span className="flex items-center gap-1.5">
                            <span>{phoneFlag}</span>
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
                    <div className="w-px bg-muted-foreground/20 my-2" aria-hidden="true" />
                    <input
                      type="tel"
                      required
                      inputMode="numeric"
                      autoComplete="tel-national"
                      placeholder="Phone number"
                      value={phone}
                      maxLength={phoneMaxLength}
                      onChange={(e) =>
                        setPhone(e.target.value.replace(/\D/g, "").slice(0, phoneMaxLength))
                      }
                      className="flex-1 min-w-0 bg-transparent border-none rounded-r-xl px-4 py-3 text-foreground focus:outline-none transition font-medium placeholder:text-muted-foreground/70"
                    />
                  </div>

                  <input
                    type="email"
                    required
                    autoComplete="email"
                    aria-label="Email"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-background border-none rounded-xl px-4 py-3 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition font-medium placeholder:text-muted-foreground/70"
                  />

                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      required
                      minLength={6}
                      autoComplete="new-password"
                      aria-label="Password"
                      placeholder="Create password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full bg-background border-none rounded-xl px-4 py-3 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition font-medium placeholder:text-muted-foreground/70 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/70 hover:text-muted-foreground p-1"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>

                  <label className="flex items-start gap-2.5 pt-1 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      required
                      checked={acceptedTerms}
                      onChange={(e) => setAcceptedTerms(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-muted-foreground/40 accent-black cursor-pointer flex-shrink-0"
                    />
                    <span className="text-xs text-muted-foreground leading-snug">
                      I have read and agree to the{" "}
                      <a
                        href="/legal/terms"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-foreground underline underline-offset-2 hover:text-foreground/80"
                      >
                        Terms of Use
                      </a>
                      ,{" "}
                      <a
                        href="/legal/privacy"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-foreground underline underline-offset-2 hover:text-foreground/80"
                      >
                        Privacy Policy
                      </a>
                      ,{" "}
                      <a
                        href="/legal/cookies"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-foreground underline underline-offset-2 hover:text-foreground/80"
                      >
                        Cookie Policy
                      </a>{" "}
                      and{" "}
                      <a
                        href="/legal/aup"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-foreground underline underline-offset-2 hover:text-foreground/80"
                      >
                        Acceptable Use Policy
                      </a>
                      . Persona-specific{" "}
                      <a
                        href="/legal/owner-terms"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-foreground underline underline-offset-2 hover:text-foreground/80"
                      >
                        Owner
                      </a>{" "}
                      and{" "}
                      <a
                        href="/legal/tenant-terms"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-foreground underline underline-offset-2 hover:text-foreground/80"
                      >
                        Tenant
                      </a>{" "}
                      terms apply when you use the respective role. See all legal documents on the{" "}
                      <a
                        href="/legal"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-foreground underline underline-offset-2 hover:text-foreground/80"
                      >
                        Legal index
                      </a>
                      .
                    </span>
                  </label>

                  {error && (
                    <p role="alert" className="text-destructive text-center text-sm font-medium">
                      {error}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={loading || !acceptedTerms}
                    className="w-full bg-foreground text-background font-bold text-lg py-3.5 rounded-xl shadow-lg active:scale-[0.98] transition hover:bg-foreground/90 flex items-center justify-center gap-2 mt-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? <Loader2 className="animate-spin" /> : "Sign up"}
                  </button>
                </form>

                <button
                  onClick={() => goBack("email")}
                  className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition mt-4"
                >
                  Already have an account?{" "}
                  <span className="font-semibold text-foreground">Sign in</span>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="w-full max-w-md mx-auto mt-6 flex items-center justify-center gap-3 text-xs text-white/70 flex-wrap">
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
