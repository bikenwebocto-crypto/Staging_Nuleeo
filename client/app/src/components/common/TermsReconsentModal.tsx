// Re-consent prompt. When TERMS_VERSION bumps (or for accounts that predate
// proof-of-consent capture), the user's stored `consent.termsVersion` no longer
// matches the current version, so we ask them to review + accept the updated
// Terms/Privacy and record fresh proof-of-consent (POST /api/me/accept-terms,
// source "reconsent"). Mirrors RoleSelectionModal:
//   - hidden during staff View-As-User (impersonated) sessions, so an admin
//     can't accept on the real user's behalf;
//   - not shown while the one-time role-selection prompt is up (that goes first);
//   - "Remind me later" only hides it for the session — it re-shows next load
//     until accepted (we never record consent without an explicit accept).
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@ui/components/ui/dialog";
import { useAuth } from "@ui/lib/useAuth";
import { apiRequest } from "@ui/lib/queryClient";
import { TERMS_VERSION } from "@shared/firestore-schema";

export function TermsReconsentModal() {
  const { firebaseUser, profile, refreshProfile } = useAuth();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // null until resolved; stays hidden until we KNOW this isn't an impersonated
  // session (fail closed).
  const [impersonated, setImpersonated] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setImpersonated(null);
    if (!firebaseUser) return;
    firebaseUser
      .getIdTokenResult()
      .then((r) => {
        if (!cancelled) setImpersonated(r.claims.impersonated === true);
      })
      .catch(() => {
        // leave null — fail closed (modal hidden)
      });
    return () => {
      cancelled = true;
    };
  }, [firebaseUser]);

  const stale = !!profile && profile.consent?.termsVersion !== TERMS_VERSION;
  const open =
    !dismissed &&
    impersonated === false &&
    stale &&
    // role-selection prompt takes precedence for brand-new signups
    profile?.needsRoleSelection !== true;

  async function accept() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await apiRequest("POST", "/api/me/accept-terms");
      await refreshProfile();
      setDismissed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record your acceptance. Try again.");
    } finally {
      setSaving(false);
    }
  }

  function handleOpenChange(next: boolean) {
    // Esc / outside click = "remind me later" — hide for the session only.
    if (!next && !saving) setDismissed(true);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-foreground text-lg">
            We&apos;ve updated our terms
          </DialogTitle>
          <DialogDescription>
            We&apos;ve made changes to our{" "}
            <a
              href="/legal/terms"
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline underline-offset-2"
            >
              Terms of Use
            </a>{" "}
            and{" "}
            <a
              href="/legal/privacy"
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline underline-offset-2"
            >
              Privacy Policy
            </a>
            . Please review and accept to continue using Olio.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 pt-2">
          <button
            type="button"
            onClick={accept}
            disabled={saving}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
          >
            {saving && <Loader2 size={16} className="animate-spin" />}
            {saving ? "Saving…" : "I accept the updated terms"}
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            disabled={saving}
            className="w-full py-2 text-sm text-muted-foreground transition hover:text-foreground disabled:opacity-60"
          >
            Remind me later
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
