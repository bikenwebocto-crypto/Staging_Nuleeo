// Read the current user's Stripe-derived plan.
//
// Source of truth: the `stripeRole` custom claim that the Firebase Stripe Payments
// extension writes onto the Auth token whenever the user's subscription state changes.
// The claim's value comes from the `firebaseRole` metadata field set on each Stripe
// product (we use "advance" and "pro"; the absence of a claim means "basic").
//
// Custom claims propagate on token refresh. After a successful checkout, call
// `refreshPlan()` (which force-refreshes the ID token) so the new plan shows up
// immediately rather than after the ~1h auto-refresh.

import { useEffect, useState, useCallback } from "react";
import { onIdTokenChanged } from "firebase/auth";
import { auth } from "./firebase";
import type { Plan } from "@shared/firestore-schema";

// Includes "business" so an admin-granted Business comp plan surfaces here
// once it lands as a stripeRole claim. Business has no Stripe product —
// the claim is set directly by POST /api/admin/users/:id/comp-plan.
const PLAN_VALUES: Plan[] = ["basic", "advance", "pro", "business"];

function planFromClaim(claim: unknown): Plan {
  return typeof claim === "string" && (PLAN_VALUES as string[]).includes(claim)
    ? (claim as Plan)
    : "basic";
}

export function usePlan(): { plan: Plan; loading: boolean; refreshPlan: () => Promise<void> } {
  const [plan, setPlan] = useState<Plan>("basic");
  const [loading, setLoading] = useState(true);

  const refreshPlan = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) {
      setPlan("basic");
      return;
    }
    const result = await user.getIdTokenResult(true);
    setPlan(planFromClaim(result.claims.stripeRole));
  }, []);

  useEffect(() => {
    return onIdTokenChanged(auth, async (user) => {
      if (!user) {
        setPlan("basic");
        setLoading(false);
        return;
      }
      const result = await user.getIdTokenResult();
      setPlan(planFromClaim(result.claims.stripeRole));
      setLoading(false);
    });
  }, []);

  return { plan, loading, refreshPlan };
}
