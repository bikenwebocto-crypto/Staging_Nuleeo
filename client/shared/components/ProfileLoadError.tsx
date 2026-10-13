// Rendered when the user is signed into Firebase but /api/me failed, so we
// have no profile to drive role-based routing. Offers a retry and a sign-out
// escape hatch so the user isn't stuck on a spinner forever.

import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useAuth } from "@ui/lib/useAuth";

export function ProfileLoadError() {
  const { profileError, refreshProfile, signOut } = useAuth();
  const [retrying, setRetrying] = useState(false);

  async function handleRetry() {
    setRetrying(true);
    try {
      await refreshProfile();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-neutral-950 px-6">
      <div role="alert" className="max-w-sm w-full text-center text-neutral-300">
        <AlertCircle className="mx-auto h-8 w-8 text-red-400" aria-hidden="true" />
        <h1 className="mt-4 text-lg font-semibold text-white">Couldn't load your profile</h1>
        <p className="mt-2 text-sm text-neutral-400">
          {profileError?.message ?? "Something went wrong loading your account."}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            onClick={handleRetry}
            disabled={retrying}
            className="w-full bg-white text-neutral-900 font-semibold py-2.5 rounded-xl active:scale-[0.98] transition disabled:opacity-50 flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
          >
            {retrying ? <Loader2 className="animate-spin h-4 w-4" /> : "Try again"}
          </button>
          <button
            type="button"
            onClick={() => signOut()}
            className="w-full text-neutral-400 text-sm py-2 hover:text-white transition rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
