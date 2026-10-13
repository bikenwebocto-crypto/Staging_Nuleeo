// Rendered when /api/me returned 403 because the user's Firestore profile is
// status="suspended". Replaces the generic ProfileLoadError so the user sees
// a clear reason and a clean exit (sign out) instead of a raw error string.

import { Ban } from "lucide-react";
import { useAuth } from "@ui/lib/useAuth";

export function AccountSuspended() {
  const { signOut } = useAuth();
  return (
    <div className="min-h-dvh flex items-center justify-center bg-neutral-950 px-6">
      <div role="alert" className="max-w-sm w-full text-center text-neutral-300">
        <Ban className="mx-auto h-8 w-8 text-red-400" aria-hidden="true" />
        <h1 className="mt-4 text-lg font-semibold text-white">Your account has been suspended</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Access to Olio is currently blocked for this account. If you think this is a mistake,
          please contact support.
        </p>
        <div className="mt-6">
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
