// One-time post-signup prompt: "are you a tenant or a property owner?".
//
// Shows while `profile.needsRoleSelection === true` — a flag /api/me sets only
// when it creates a brand-new user doc, so existing accounts never see this.
// Every way out clears the flag server-side (it never re-appears):
//   owner   → ownerModeEnabled=true, land on /owner
//   tenant  → land on /tenant
//   skip / dismiss (X / Esc / outside click) → same as tenant
// A tenant who picks wrong isn't stuck: Tenant Settings → Activate Landlord
// View flips owner mode on at any time (and the modal copy says so).
//
// Hidden entirely during staff View-As-User sessions (detected via the
// `impersonated` custom-token claim minted in server/routes/adminUsers.ts):
// an admin browsing a fresh account must not consume the real user's one-time
// prompt or flip their owner mode.
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Building2, ChevronRight, KeyRound, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@ui/components/ui/dialog";
import { useAuth } from "@ui/lib/useAuth";
import { apiRequest } from "@ui/lib/queryClient";

type RoleChoice = "owner" | "tenant";

export function RoleSelectionModal() {
  const { firebaseUser, profile, refreshProfile } = useAuth();
  const [, setLocation] = useLocation();
  const [saving, setSaving] = useState<RoleChoice | null>(null);
  // Inline, not a toast: the toast viewport sits at z-[100] UNDER the dialog
  // overlay (z-[200]), so a toast here would render dimmed and unclickable —
  // and tapping toward it counts as an outside click, dismissing the prompt.
  const [error, setError] = useState<string | null>(null);
  // Closes the dialog immediately on dismiss, without waiting for the
  // best-effort PATCH + profile refresh to land.
  const [dismissed, setDismissed] = useState(false);
  // null = not yet resolved. The modal stays hidden until we KNOW this is
  // not an impersonated session.
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
        // Leave null — fail closed (modal hidden) rather than risk an
        // impersonating admin answering on the user's behalf.
      });
    return () => {
      cancelled = true;
    };
  }, [firebaseUser]);

  const open = !dismissed && impersonated === false && profile?.needsRoleSelection === true;

  async function choose(role: RoleChoice) {
    if (saving) return;
    setSaving(role);
    setError(null);
    try {
      await apiRequest(
        "PATCH",
        "/api/profile",
        role === "owner"
          ? { ownerModeEnabled: true, needsRoleSelection: false }
          : { needsRoleSelection: false },
      );
      // Refresh BEFORE navigating: /owner is gated on isOwnerExperience, so
      // the new ownerModeEnabled must be on the profile first or the route
      // guard bounces the user straight back to /tenant.
      await refreshProfile();
      setDismissed(true);
      setLocation(role === "owner" ? "/owner" : "/tenant");
    } catch (err: any) {
      setError(err?.message ?? "Could not save your choice. Please try again.");
    } finally {
      setSaving(null);
    }
  }

  // Skip button / X / Escape / outside click — treat as "tenant for now".
  // Persist the dismissal best-effort and never block the close on the network.
  function dismiss() {
    if (saving) return;
    setDismissed(true);
    void apiRequest("PATCH", "/api/profile", { needsRoleSelection: false })
      .then(() => refreshProfile())
      .catch(() => {});
    setLocation("/tenant");
  }

  function handleOpenChange(next: boolean) {
    if (!next) dismiss();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md rounded-2xl p-0 overflow-hidden">
        <div className="p-5 pb-0">
          <DialogHeader>
            <DialogTitle className="text-foreground text-lg">Welcome to Olio</DialogTitle>
            <DialogDescription>
              Tell us how you&apos;ll use Olio and we&apos;ll take you to the right place.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="px-5 pb-5 pt-4 space-y-3">
          <button
            onClick={() => choose("owner")}
            disabled={saving !== null}
            className="w-full bg-card border border-border rounded-2xl p-4 flex items-center gap-4 text-left hover:bg-muted/50 transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <div className="w-11 h-11 rounded-full bg-muted flex items-center justify-center shrink-0">
              <Building2 size={20} className="text-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-foreground">I&apos;m a property owner</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Manage properties, collect rent and track income
              </div>
            </div>
            {saving === "owner" ? (
              <Loader2 size={16} className="animate-spin text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight size={16} className="text-muted-foreground shrink-0" />
            )}
          </button>

          <button
            onClick={() => choose("tenant")}
            disabled={saving !== null}
            className="w-full bg-card border border-border rounded-2xl p-4 flex items-center gap-4 text-left hover:bg-muted/50 transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <div className="w-11 h-11 rounded-full bg-muted flex items-center justify-center shrink-0">
              <KeyRound size={20} className="text-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-foreground">I&apos;m a tenant</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Pay rent, track agreements and message your landlord
              </div>
            </div>
            {saving === "tenant" ? (
              <Loader2 size={16} className="animate-spin text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight size={16} className="text-muted-foreground shrink-0" />
            )}
          </button>

          {error && (
            <p role="alert" className="text-xs text-destructive text-center">
              {error}
            </p>
          )}

          <button
            onClick={dismiss}
            disabled={saving !== null}
            className="w-full py-2 text-sm text-muted-foreground hover:text-foreground transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Skip for now — continue as tenant
          </button>

          <p className="text-xs text-muted-foreground text-center">
            You can activate Landlord View anytime from Settings.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
