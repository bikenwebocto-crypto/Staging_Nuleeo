// Derives the Stripe Connect status from the live user profile. Six states,
// each carrying the data the UI needs to render its action buttons + labels.
//
// Pure derivation: no extra fetch, no useState. Profile updates from useAuth
// flow through automatically.

import { useAuth } from "@ui/lib/useAuth";

export type ConnectStatus =
  | { kind: "none" }
  | { kind: "incomplete"; requirementsDue: string[] }
  | { kind: "pendingVerification"; items: string[] }
  | { kind: "active" }
  | { kind: "actionRequired"; pastDue: string[] }
  | { kind: "restricted"; reason: string };

export function useConnectStatus(): ConnectStatus {
  const { profile } = useAuth();
  if (!profile?.connectAccountId) return { kind: "none" };

  const reason = profile.connectDisabledReason;
  const pastDue = profile.connectRequirementsPastDue ?? [];
  const due = profile.connectRequirementsDue ?? [];
  const pending = profile.connectRequirementsPendingVerification ?? [];
  const detailsSubmitted = !!profile.connectDetailsSubmitted;
  const chargesEnabled = !!profile.connectChargesEnabled;
  const payoutsEnabled = !!profile.connectPayoutsEnabled;

  // Hard restrictions trump everything — Stripe disabled the account.
  if (reason) {
    return { kind: "restricted", reason };
  }

  // User exited the Stripe-hosted form before submitting.
  if (!detailsSubmitted) {
    return { kind: "incomplete", requirementsDue: due };
  }

  // Past-due items mean Stripe has set a deadline that's already passed —
  // owner must act NOW or capabilities flip off.
  if (pastDue.length > 0) {
    return { kind: "actionRequired", pastDue };
  }

  // Stripe is actively reviewing what the owner submitted.
  if (pending.length > 0 && (!chargesEnabled || !payoutsEnabled)) {
    return { kind: "pendingVerification", items: pending };
  }

  // Fully active — charges + payouts enabled.
  if (chargesEnabled && payoutsEnabled) {
    return { kind: "active" };
  }

  // Charges work but payouts don't (or vice versa) — Stripe is still
  // verifying. Treat as pending so the UI surfaces a "Check status" button.
  return {
    kind: "pendingVerification",
    items: pending.length > 0 ? pending : due.length > 0 ? due : ["awaiting_stripe_review"],
  };
}
