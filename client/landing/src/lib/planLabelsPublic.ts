// Landing-only realtime plan-labels hook.
//
// Mirrors socialPublic.ts: a Firestore-only Firebase init (no auth bundle)
// subscribed to the public `config/planLabels` doc. Admin edits on the
// platform settings page propagate to the live landing in ~1s.

import { useEffect, useState } from "react";
import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getFirestore, doc, onSnapshot } from "firebase/firestore";
import {
  COL,
  CONFIG_DOC_PLAN_LABELS,
  DEFAULT_PLAN_LABELS,
  withFixedPlanPrices,
  type PlanLabelsConfig,
} from "@shared/firestore-schema";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const landingApp: FirebaseApp = getApps()[0] ?? initializeApp(config);
const landingDb = getFirestore(landingApp);

const CACHE_KEY = "plan_labels_cache";

function readCache(): PlanLabelsConfig {
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<PlanLabelsConfig>;
      // Prices are fixed in code — overlay canonical values over any cached doc.
      return withFixedPlanPrices({
        plans: { ...DEFAULT_PLAN_LABELS.plans, ...(parsed.plans ?? {}) },
        proUpgradeFirstCycleAmount:
          parsed.proUpgradeFirstCycleAmount !== undefined
            ? parsed.proUpgradeFirstCycleAmount
            : DEFAULT_PLAN_LABELS.proUpgradeFirstCycleAmount,
        updatedAt: parsed.updatedAt,
        updatedBy: parsed.updatedBy,
      });
    }
  } catch {}
  return DEFAULT_PLAN_LABELS;
}

function writeCache(c: PlanLabelsConfig) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {}
}

export function usePlanLabels(): PlanLabelsConfig {
  const [labels, setLabels] = useState<PlanLabelsConfig>(() => readCache());

  useEffect(() => {
    const ref = doc(landingDb, COL.config, CONFIG_DOC_PLAN_LABELS);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const stored = snap.data() as Partial<PlanLabelsConfig>;
          // Prices are fixed in code — overlay canonical values over the doc.
          const merged: PlanLabelsConfig = withFixedPlanPrices({
            plans: { ...DEFAULT_PLAN_LABELS.plans, ...(stored.plans ?? {}) },
            proUpgradeFirstCycleAmount:
              stored.proUpgradeFirstCycleAmount !== undefined
                ? stored.proUpgradeFirstCycleAmount
                : DEFAULT_PLAN_LABELS.proUpgradeFirstCycleAmount,
            updatedAt: stored.updatedAt,
            updatedBy: stored.updatedBy,
          });
          setLabels(merged);
          writeCache(merged);
        } else {
          setLabels(DEFAULT_PLAN_LABELS);
        }
      },
      (err) => {
        console.error("planLabels onSnapshot failed:", err);
      },
    );
    return () => unsub();
  }, []);

  return labels;
}
