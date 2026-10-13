// Route guard. Wrap a route's component to require authentication and
// (optionally) a specific role. Renders a loading state while auth resolves,
// redirects to a fallback path on unauth or wrong-role.
//
// Usage:
//   <RequireAuth><OwnerDashboard /></RequireAuth>
//   <RequireAuth roles={["admin", "superadmin"]} fallback="/login">...</RequireAuth>

import { useEffect, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@ui/lib/useAuth";
import { ProfileLoadError } from "@ui/components/ProfileLoadError";
import { AccountSuspended } from "@ui/components/AccountSuspended";
import { NotAuthorized } from "@ui/components/NotAuthorized";
import type { Role } from "@shared/firestore-schema";

interface Props {
  children: ReactNode;
  roles?: Role[];
  fallback?: string;
}

// Default targets the user-facing app subdomain's /auth route. Platform passes
// its own fallback="/login" since admin login lives on a separate route.
export function RequireAuth({ children, roles, fallback = "/auth" }: Props) {
  const { firebaseUser, profile, loading, profileError, suspended } = useAuth();
  const [, setLocation] = useLocation();

  // Only redirect signed-out users. If the user is signed in but the profile
  // fetch failed, we render an error+retry UI instead — bouncing them back to
  // /auth would just loop them through sign-in again.
  const shouldRedirect = !loading && !firebaseUser;
  const allowed =
    !!firebaseUser && !!profile && (!roles || roles.some((r) => profile.roles.includes(r)));

  useEffect(() => {
    if (shouldRedirect) setLocation(fallback);
  }, [shouldRedirect, fallback, setLocation]);

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-neutral-950 text-neutral-400">
        Loading…
      </div>
    );
  }

  // Suspension is a hard "no" — not retryable. Dedicated screen with a clean
  // sign-out, not the generic error+retry dialog.
  if (firebaseUser && suspended) {
    return <AccountSuspended />;
  }

  if (firebaseUser && !profile && profileError) {
    return <ProfileLoadError />;
  }

  // Signed in but wrong role: render an explicit "no access" panel instead
  // of a silent null. Without this the page was just blank and the user had
  // no idea what happened. Unauth (no firebaseUser) is handled by the
  // useEffect redirect above; this branch only fires when they ARE signed in.
  if (firebaseUser && profile && !allowed) {
    return <NotAuthorized />;
  }

  if (!allowed) return null;

  return <>{children}</>;
}
