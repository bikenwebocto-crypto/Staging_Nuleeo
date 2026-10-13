// Full-screen lockout shown when config/system.maintenanceMode.enabled is
// true. Mounted in the user app (app.oliowallet.com) above every route so
// it can take over before the Suspense fallback for the lazy-loaded page
// chunks even resolves. Superadmins bypass this — the guard in App.tsx
// checks their role before rendering us.

import { Wrench } from "lucide-react";
import { Logo } from "@ui/components/Logo";

interface MaintenanceScreenProps {
  message?: string;
  onSignOut?: () => void;
}

export function MaintenanceScreen({ message, onSignOut }: MaintenanceScreenProps) {
  return (
    <div className="min-h-[var(--app-vh)] flex items-center justify-center bg-neutral-950 px-6">
      <div className="max-w-md w-full text-center text-neutral-300">
        <Logo variant="symbol" color="white" className="mx-auto h-12 w-auto" />
        <div className="mt-8 inline-flex items-center justify-center h-12 w-12 rounded-full bg-neutral-900 border border-neutral-800">
          <Wrench className="h-5 w-5 text-neutral-400" aria-hidden="true" />
        </div>
        <h1 className="mt-6 text-xl font-semibold text-white">We'll be right back</h1>
        <p className="mt-3 text-sm text-neutral-400 leading-relaxed">
          {message?.trim() ||
            "Olio is undergoing scheduled maintenance. Hang tight — we'll be back online shortly."}
        </p>
        {onSignOut && (
          <button
            type="button"
            onClick={onSignOut}
            className="mt-8 text-xs text-neutral-500 hover:text-neutral-300 underline underline-offset-4 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
          >
            Sign out
          </button>
        )}
      </div>
    </div>
  );
}
