import { useEffect, useMemo, useState } from "react";
import {
  EmailAuthProvider,
  linkWithCredential,
  linkWithPopup,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  sendEmailVerification,
  unlink,
  updatePassword,
  verifyBeforeUpdateEmail,
  type AuthError,
} from "firebase/auth";
import { KeyRound, Loader2, Mail } from "lucide-react";
import { Input } from "@ui/components/ui/input";
import { useAuth } from "@ui/lib/useAuth";
import { googleProvider } from "@ui/lib/firebase";
import { useToast } from "@ui/hooks/use-toast";
import { apiRequest } from "@ui/lib/queryClient";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";

// Best-effort server audit of credential-lifecycle events (add password,
// connect/disconnect Google, request email change). Fire-and-forget: it must
// never block or fail the user-facing action. See POST /api/auth/account-event.
function recordAccountEvent(action: string) {
  apiRequest("POST", "/api/auth/account-event", { action }).catch(() => {});
}

type View = "list" | "add-password" | "change-password" | "change-email";

interface SignInMethodsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** View to land on when the dialog opens. Defaults to "list". */
  initialView?: View;
}

const PASSWORD_PROVIDER = "password";
const GOOGLE_PROVIDER = "google.com";

function authErrorMessage(err: unknown): string {
  const code = (err as AuthError)?.code ?? "";
  switch (code) {
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect password.";
    case "auth/weak-password":
      return "Password must be at least 6 characters.";
    case "auth/requires-recent-login":
      return "For security, sign out and sign back in, then try again.";
    case "auth/credential-already-in-use":
    case "auth/email-already-in-use":
      return "That email is already linked to another Olio account.";
    case "auth/invalid-email":
      return "That doesn't look like a valid email address.";
    case "auth/popup-closed-by-user":
      return "Sign-in was cancelled.";
    case "auth/popup-blocked":
      return "Your browser blocked the popup. Allow popups and try again.";
    case "auth/too-many-requests":
      return "Too many attempts. Try again in a moment.";
    default:
      return (err as Error)?.message ?? "Something went wrong. Try again.";
  }
}

export function SignInMethodsDialog({
  open,
  onOpenChange,
  initialView = "list",
}: SignInMethodsDialogProps) {
  const { firebaseUser, refreshFirebaseUser } = useAuth();
  const { toast } = useToast();
  const [view, setView] = useState<View>(initialView);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Bump after any link/unlink so the rendered provider list reflects reality.
  const [refreshTick, setRefreshTick] = useState(0);

  const providerIds = useMemo(
    () => firebaseUser?.providerData.map((p) => p.providerId) ?? [],
    // refreshTick included so this recomputes after reload().
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [firebaseUser, refreshTick],
  );
  const hasPassword = providerIds.includes(PASSWORD_PROVIDER);
  const hasGoogle = providerIds.includes(GOOGLE_PROVIDER);
  const linkedCount = providerIds.length;
  // Google is the account's only sign-in method — Disconnect is disabled
  // because removing it would lock the user out. Surfaced as a hint so the
  // dead button isn't a mystery (you must add a password first).
  const googleIsOnlyMethod = hasGoogle && linkedCount <= 1;
  const email = firebaseUser?.email ?? "";

  useEffect(() => {
    if (open) {
      setView(initialView);
      setError("");
      setBusy(null);
    } else {
      setView("list");
      setError("");
      setBusy(null);
    }
  }, [open, initialView]);

  async function refreshUser() {
    if (!firebaseUser) return;
    // Reload via the auth context so host pages (Settings, ProfileDrawer)
    // re-render with fresh providerData too — not just this dialog. The local
    // refreshTick keeps this dialog's useMemo in sync in the same tick.
    await refreshFirebaseUser();
    setRefreshTick((n) => n + 1);
  }

  async function handleConnectGoogle() {
    if (!firebaseUser) return;
    setBusy("connect-google");
    setError("");
    try {
      await linkWithPopup(firebaseUser, googleProvider);
      await refreshUser();
      recordAccountEvent("google-connected");
      toast({ title: "Google connected", description: "You can now sign in with Google." });
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect(providerId: string) {
    if (!firebaseUser) return;
    if (linkedCount <= 1) {
      setError("You can't remove your only sign-in method.");
      return;
    }
    setBusy(`disconnect-${providerId}`);
    setError("");
    try {
      await unlink(firebaseUser, providerId);
      await refreshUser();
      recordAccountEvent(
        providerId === GOOGLE_PROVIDER ? "google-disconnected" : "password-removed",
      );
      toast(
        providerId === GOOGLE_PROVIDER
          ? {
              title: "Google disconnected",
              description: "You'll now sign in with your email and password.",
            }
          : { title: "Password removed", description: "You'll now sign in with Google." },
      );
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const title =
    view === "list"
      ? "Sign-in methods"
      : view === "add-password"
        ? "Add a password"
        : view === "change-password"
          ? "Change password"
          : "Change email";
  const subtitle =
    view === "list"
      ? "Manage how you sign into your Olio account."
      : view === "add-password"
        ? `Create a password for ${email}. You'll then be able to sign in with either Google or email + password.`
        : view === "change-password"
          ? "Enter your current password and choose a new one."
          : "We'll send a verification link to your new address. Your sign-in email won't change until you click that link.";

  return (
    <ResponsiveDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      subtitle={subtitle}
      onBack={
        view !== "list"
          ? () => {
              setView("list");
              setError("");
            }
          : undefined
      }
    >
      {view === "list" && (
        <div className="space-y-3 py-2">
          <ProviderRow
            icon={<GoogleIcon />}
            title="Google"
            subtitle={
              hasGoogle
                ? (firebaseUser?.providerData.find((p) => p.providerId === GOOGLE_PROVIDER)
                    ?.email ?? "Connected")
                : "Not connected"
            }
            connected={hasGoogle}
            actionLabel={hasGoogle ? "Disconnect" : "Connect"}
            actionDisabled={busy !== null || googleIsOnlyMethod}
            actionTitle={
              googleIsOnlyMethod
                ? "Add a password first, then you can disconnect Google."
                : undefined
            }
            actionLoading={busy === "connect-google" || busy === `disconnect-${GOOGLE_PROVIDER}`}
            onAction={() => (hasGoogle ? handleDisconnect(GOOGLE_PROVIDER) : handleConnectGoogle())}
            hint={googleIsOnlyMethod ? "To remove Google, add a password first." : undefined}
          />

          <ProviderRow
            icon={<KeyRound size={20} className="text-foreground" />}
            title="Email and password"
            subtitle={hasPassword ? email : "Not set"}
            connected={hasPassword}
            actionLabel={hasPassword ? "Change" : "Add password"}
            actionDisabled={busy !== null}
            hint={
              !hasPassword
                ? "Add one to sign in with email — and to remove Google later if you want."
                : undefined
            }
            onAction={() => {
              setError("");
              setView(hasPassword ? "change-password" : "add-password");
            }}
            secondary={
              hasPassword && linkedCount > 1
                ? {
                    label: "Remove",
                    disabled: busy !== null,
                    loading: busy === `disconnect-${PASSWORD_PROVIDER}`,
                    onClick: () => handleDisconnect(PASSWORD_PROVIDER),
                  }
                : undefined
            }
          />

          <ProviderRow
            icon={<Mail size={20} className="text-foreground" />}
            title="Email address"
            subtitle={email || "Not set"}
            connected
            actionLabel="Change"
            actionDisabled={busy !== null || !email}
            onAction={() => {
              setError("");
              setView("change-email");
            }}
          />

          {error && (
            <p role="alert" className="text-red-500 text-sm font-medium text-center">
              {error}
            </p>
          )}
        </div>
      )}

      {view === "add-password" && (
        <AddPasswordForm
          email={email}
          busy={busy === "add-password"}
          error={error}
          onSubmit={async (newPassword) => {
            if (!firebaseUser || !email) return;
            setBusy("add-password");
            setError("");
            try {
              const cred = EmailAuthProvider.credential(email, newPassword);
              try {
                await linkWithCredential(firebaseUser, cred);
              } catch (err) {
                // A stale session can reject this with requires-recent-login.
                // A Google-only user has no password to reauth with, so re-prove
                // identity via the Google popup and retry once — rather than
                // dead-ending on "sign out and back in".
                if ((err as AuthError)?.code === "auth/requires-recent-login" && hasGoogle) {
                  await reauthenticateWithPopup(firebaseUser, googleProvider);
                  await linkWithCredential(firebaseUser, cred);
                } else {
                  throw err;
                }
              }
              recordAccountEvent("password-added");
              if (!firebaseUser.emailVerified) {
                sendEmailVerification(firebaseUser).catch((e) =>
                  console.warn("sendEmailVerification failed:", e),
                );
              }
              await refreshUser();
              setView("list");
              toast({
                title: "Password added",
                description: "You can now sign in with your email and password.",
              });
            } catch (err) {
              setError(authErrorMessage(err));
            } finally {
              setBusy(null);
            }
          }}
        />
      )}

      {view === "change-password" && (
        <ChangePasswordForm
          email={email}
          busy={busy === "change-password"}
          error={error}
          onSubmit={async (current, next) => {
            if (!firebaseUser || !email) return;
            setBusy("change-password");
            setError("");
            try {
              const cred = EmailAuthProvider.credential(email, current);
              await reauthenticateWithCredential(firebaseUser, cred);
              await updatePassword(firebaseUser, next);
              await refreshUser();
              setView("list");
              toast({ title: "Password updated" });
            } catch (err) {
              setError(authErrorMessage(err));
            } finally {
              setBusy(null);
            }
          }}
        />
      )}

      {view === "change-email" && (
        <ChangeEmailForm
          currentEmail={email}
          hasPassword={hasPassword}
          busy={busy === "change-email"}
          error={error}
          onSubmit={async (newEmail, currentPassword) => {
            if (!firebaseUser || !email) return;
            if (newEmail.trim().toLowerCase() === email.trim().toLowerCase()) {
              setError("That's already your email address.");
              return;
            }
            setBusy("change-email");
            setError("");
            try {
              if (hasPassword) {
                const cred = EmailAuthProvider.credential(email, currentPassword);
                await reauthenticateWithCredential(firebaseUser, cred);
              } else {
                // Google-only: reauthenticate via popup.
                await reauthenticateWithPopup(firebaseUser, googleProvider);
              }
              await verifyBeforeUpdateEmail(firebaseUser, newEmail.trim());
              recordAccountEvent("email-change-requested");
              setView("list");
              toast({
                title: "Verification email sent",
                description: hasPassword
                  ? `Open the link we sent to ${newEmail.trim()} to finish the change. Until then you keep signing in with ${email}.`
                  : `Open the link we sent to ${newEmail.trim()} to finish the change. Until then, keep using Continue with Google to sign in.`,
              });
            } catch (err) {
              setError(authErrorMessage(err));
            } finally {
              setBusy(null);
            }
          }}
        />
      )}
    </ResponsiveDrawer>
  );
}

interface ProviderRowProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  connected: boolean;
  actionLabel: string;
  actionDisabled?: boolean;
  actionLoading?: boolean;
  /** Native tooltip on the primary action — used to explain a disabled state. */
  actionTitle?: string;
  onAction: () => void;
  /** Small helper line under the row (e.g. why an action is unavailable). */
  hint?: string;
  secondary?: {
    label: string;
    disabled?: boolean;
    loading?: boolean;
    onClick: () => void;
  };
}

// Shared sizing so both buttons clear the ~44px touch-target guideline and
// show a visible keyboard focus ring.
const ROW_BUTTON_BASE =
  "min-h-[40px] inline-flex items-center justify-center rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background";

function ProviderRow({
  icon,
  title,
  subtitle,
  connected,
  actionLabel,
  actionDisabled,
  actionLoading,
  actionTitle,
  onAction,
  hint,
  secondary,
}: ProviderRowProps) {
  return (
    <div className="bg-background rounded-2xl p-3">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-card flex items-center justify-center flex-shrink-0">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground text-sm">{title}</span>
            {connected && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                Linked
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {secondary && (
            <button
              type="button"
              onClick={secondary.onClick}
              disabled={secondary.disabled}
              className={`${ROW_BUTTON_BASE} text-xs font-semibold text-destructive hover:bg-destructive/10 px-3`}
            >
              {secondary.loading ? <Loader2 size={14} className="animate-spin" /> : secondary.label}
            </button>
          )}
          <button
            type="button"
            onClick={onAction}
            disabled={actionDisabled}
            title={actionTitle}
            className={
              connected
                ? `${ROW_BUTTON_BASE} text-xs font-semibold text-foreground hover:text-foreground/80 px-3 bg-card border border-border`
                : `${ROW_BUTTON_BASE} text-xs font-bold text-primary-foreground bg-primary hover:bg-primary/90 px-3`
            }
          >
            {actionLoading ? <Loader2 size={14} className="animate-spin" /> : actionLabel}
          </button>
        </div>
      </div>
      {hint && <p className="text-[11px] text-muted-foreground mt-2 pl-[52px]">{hint}</p>}
    </div>
  );
}

function AddPasswordForm({
  email,
  busy,
  error,
  onSubmit,
}: {
  email: string;
  busy: boolean;
  error: string;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState("");

  function handle(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    if (password.length < 6) {
      setLocalError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setLocalError("Passwords don't match.");
      return;
    }
    onSubmit(password);
  }

  return (
    <form onSubmit={handle} className="space-y-3 py-2">
      {/* Hidden username so password managers bind the new credential to this
          email (the visible field below is disabled and won't be picked up). */}
      <input type="email" name="email" value={email} readOnly hidden autoComplete="username" />
      <div className="space-y-1.5">
        <label htmlFor="add-pw-email" className="text-xs font-bold text-muted-foreground uppercase">
          Email
        </label>
        <Input id="add-pw-email" type="email" value={email} disabled />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="add-pw-new" className="text-xs font-bold text-muted-foreground uppercase">
          New password
        </label>
        <Input
          id="add-pw-new"
          type="password"
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={6}
          required
        />
      </div>
      <div className="space-y-1.5">
        <label
          htmlFor="add-pw-confirm"
          className="text-xs font-bold text-muted-foreground uppercase"
        >
          Confirm password
        </label>
        <Input
          id="add-pw-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          minLength={6}
          required
        />
      </div>
      {(localError || error) && (
        <p role="alert" className="text-red-500 text-sm font-medium text-center">
          {localError || error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="w-full bg-primary text-primary-foreground font-bold py-3 rounded-xl shadow active:scale-[0.98] hover:bg-primary/90 transition disabled:opacity-50 flex items-center justify-center"
      >
        {busy ? <Loader2 size={18} className="animate-spin" /> : "Add password"}
      </button>
    </form>
  );
}

function ChangePasswordForm({
  email,
  busy,
  error,
  onSubmit,
}: {
  email: string;
  busy: boolean;
  error: string;
  onSubmit: (current: string, next: string) => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState("");

  function handle(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    if (next.length < 6) {
      setLocalError("New password must be at least 6 characters.");
      return;
    }
    if (next !== confirm) {
      setLocalError("Passwords don't match.");
      return;
    }
    onSubmit(current, next);
  }

  return (
    <form onSubmit={handle} className="space-y-3 py-2">
      <input type="email" name="email" value={email} readOnly hidden autoComplete="username" />
      <div className="space-y-1.5">
        <label
          htmlFor="change-pw-current"
          className="text-xs font-bold text-muted-foreground uppercase"
        >
          Current password
        </label>
        <Input
          id="change-pw-current"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <label
          htmlFor="change-pw-new"
          className="text-xs font-bold text-muted-foreground uppercase"
        >
          New password
        </label>
        <Input
          id="change-pw-new"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          minLength={6}
          required
        />
      </div>
      <div className="space-y-1.5">
        <label
          htmlFor="change-pw-confirm"
          className="text-xs font-bold text-muted-foreground uppercase"
        >
          Confirm new password
        </label>
        <Input
          id="change-pw-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          minLength={6}
          required
        />
      </div>
      {(localError || error) && (
        <p role="alert" className="text-red-500 text-sm font-medium text-center">
          {localError || error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="w-full bg-primary text-primary-foreground font-bold py-3 rounded-xl shadow active:scale-[0.98] hover:bg-primary/90 transition disabled:opacity-50 flex items-center justify-center"
      >
        {busy ? <Loader2 size={18} className="animate-spin" /> : "Update password"}
      </button>
    </form>
  );
}

function ChangeEmailForm({
  currentEmail,
  hasPassword,
  busy,
  error,
  onSubmit,
}: {
  currentEmail: string;
  hasPassword: boolean;
  busy: boolean;
  error: string;
  onSubmit: (newEmail: string, currentPassword: string) => void;
}) {
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [localError, setLocalError] = useState("");

  function handle(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    const trimmed = newEmail.trim();
    if (!trimmed || !trimmed.includes("@")) {
      setLocalError("Enter a valid email address.");
      return;
    }
    if (hasPassword && !currentPassword) {
      setLocalError("Enter your current password.");
      return;
    }
    onSubmit(trimmed, currentPassword);
  }

  return (
    <form onSubmit={handle} className="space-y-3 py-2">
      <div className="space-y-1.5">
        <label
          htmlFor="change-email-current"
          className="text-xs font-bold text-muted-foreground uppercase"
        >
          Current email
        </label>
        <Input id="change-email-current" type="email" value={currentEmail} disabled />
      </div>
      <div className="space-y-1.5">
        <label
          htmlFor="change-email-new"
          className="text-xs font-bold text-muted-foreground uppercase"
        >
          New email
        </label>
        <Input
          id="change-email-new"
          type="email"
          autoComplete="email"
          autoFocus
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          required
        />
      </div>
      {hasPassword && (
        <div className="space-y-1.5">
          <label
            htmlFor="change-email-password"
            className="text-xs font-bold text-muted-foreground uppercase"
          >
            Current password
          </label>
          <Input
            id="change-email-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </div>
      )}
      {!hasPassword && (
        <p className="text-xs text-muted-foreground">
          You'll be asked to sign in with Google again to confirm this change.
        </p>
      )}
      {(localError || error) && (
        <p role="alert" className="text-red-500 text-sm font-medium text-center">
          {localError || error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="w-full bg-primary text-primary-foreground font-bold py-3 rounded-xl shadow active:scale-[0.98] hover:bg-primary/90 transition disabled:opacity-50 flex items-center justify-center"
      >
        {busy ? <Loader2 size={18} className="animate-spin" /> : "Send verification link"}
      </button>
    </form>
  );
}

export function GoogleIcon() {
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
