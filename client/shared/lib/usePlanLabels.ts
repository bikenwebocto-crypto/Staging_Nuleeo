// Realtime subscription to admin-editable plan display names + descriptions
// + unit caps + headline yearly amounts at config/planLabels.
//
// Public-read doc (firestore.rules): no auth required. Subscribes via
// onSnapshot so admin saves on /admin/owner-plans propagate to every
// signed-in user's PricingModal within ~1s.
//
// Defaults are merged over any partial doc so adding a new plan key never
// crashes the UI before the admin re-saves.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";
import {
  COL,
  CONFIG_DOC_PLAN_LABELS,
  DEFAULT_PLAN_LABELS,
  withFixedPlanPrices,
  type PlanLabelsConfig,
} from "@shared/firestore-schema";

export function usePlanLabels(): {
  config: PlanLabelsConfig;
  loading: boolean;
} {
  const [config, setConfig] = useState<PlanLabelsConfig>(DEFAULT_PLAN_LABELS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ref = doc(db, COL.config, CONFIG_DOC_PLAN_LABELS);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const stored = snap.data() as Partial<PlanLabelsConfig>;
          // Prices (yearlyAmount + proUpgradeFirstCycleAmount) are fixed in
          // code — overlay the canonical values so a stored override never
          // changes what owners see.
          setConfig(
            withFixedPlanPrices({
              plans: { ...DEFAULT_PLAN_LABELS.plans, ...(stored.plans ?? {}) },
              proUpgradeFirstCycleAmount:
                stored.proUpgradeFirstCycleAmount !== undefined
                  ? stored.proUpgradeFirstCycleAmount
                  : DEFAULT_PLAN_LABELS.proUpgradeFirstCycleAmount,
              updatedAt: stored.updatedAt,
              updatedBy: stored.updatedBy,
            }),
          );
        } else {
          setConfig(DEFAULT_PLAN_LABELS);
        }
        setLoading(false);
      },
      (err) => {
        console.error("planLabels onSnapshot failed:", err);
        setConfig(DEFAULT_PLAN_LABELS);
        setLoading(false);
      },
    );
    return () => unsub();
  }, []);

  return { config, loading };
}
