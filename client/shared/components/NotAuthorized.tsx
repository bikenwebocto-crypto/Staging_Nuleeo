// Rendered by RequireAuth when the caller is signed in but their roles don't
// satisfy a route's `roles` guard — e.g. a tenant who lands on
// platform.oliowallet.com/admin. Without this panel the route would silently
// return null and the user would see a blank page with no idea what happened.
//
// The "Sign in as a different account" button signs them out so they can
// re-authenticate; we deliberately do NOT redirect cross-subdomain (per
// feedback_no_cross_subdomain_redirect) — staff who need the admin panel
// must navigate there manually.

import { ShieldOff } from "lucide-react";
import { useAuth } from "@ui/lib/useAuth";

export function NotAuthorized() {
  const { signOut, profile } = useAuth();
  const displayName =
    `${profile?.firstName ?? ""} ${profile?.lastName ?? ""}`.trim() ||
    profile?.email ||
    "this account";

  return (
    <div className="min-h-dvh flex items-center justify-center bg-neutral-950 px-6">
      <div role="alert" className="max-w-sm w-full text-center text-neutral-300">
        <ShieldOff className="mx-auto h-8 w-8 text-amber-400" aria-hidden="true" />
        <h1 className="mt-4 text-lg font-semibold text-white">
          You don't have access to this page
        </h1>
        <p className="mt-2 text-sm text-neutral-400">
          You're signed in as {displayName}, but this page requires a different role. Sign out and
          use the account that has access.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => signOut()}
            className="w-full bg-white text-neutral-900 font-semibold py-2.5 rounded-xl active:scale-[0.98] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
