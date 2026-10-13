// Reads where the current owner's plan came from — "paid" (a real Stripe
// subscription), "gifted" (an admin comp grant with no subscription) or "none".
//
// This drives the upgrade UI: a paid owner upgrades by SWAPPING their existing
// subscription (POST /api/owner/plan/upgrade), while a gifted/none owner starts
// a brand-new Stripe Checkout. It also surfaces the renewal date for honest
// "renews on X" copy. Server endpoint: GET /api/owner/plan/source (self-only).
//
// Fetched on demand (when the pricing UI opens) rather than via a realtime
// snapshot — it depends on the Stripe extension's customer mirror, which isn't
// publicly readable.

import { useCallback, useEffect, useState } from "react";
import { auth } from "./firebase";
import { apiRequest } from "./queryClient";
import type { OwnerPlanKey } from "@shared/firestore-schema";

export interface PlanSourceInfo {
  source: "paid" | "gifted" | "none";
  plan: OwnerPlanKey;
  // Subscription renewal date (paid only). ISO 8601 or null.
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  // Gift hard-expiry (gifted only). ISO 8601 or null.
  giftExpiresAt: string | null;
}

export function usePlanSource(enabled: boolean): {
  info: PlanSourceInfo | null;
  loading: boolean;
  refresh: () => Promise<PlanSourceInfo | null>;
} {
  const [info, setInfo] = useState<PlanSourceInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<PlanSourceInfo | null> => {
    if (!auth.currentUser) {
      setInfo(null);
      return null;
    }
    setLoading(true);
    try {
      const res = await apiRequest("GET", "/api/owner/plan/source");
      const next = (await res.json()) as PlanSourceInfo;
      setInfo(next);
      return next;
    } catch {
      setInfo(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  return { info, loading, refresh };
}
