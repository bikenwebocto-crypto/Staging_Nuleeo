// Realtime SuperAdminDashboard banner-carousel selection backed by Firestore.
//
// Storage: a single Firestore doc at config/banners holds the `enabled` array
// of banner image paths. Admin-only read (see firestore.rules); the data isn't
// sensitive but there's no public consumer.
//
// Reads: components subscribe via onSnapshot through `useBannerSelection()`.
// Toggles in /admin/settings push to every admin's dashboard within ~1s.
//
// Writes: go through PUT /api/admin/banners, which requires the
// `platform.modifySettings` privilege and validates the payload server-side.
//
// First-paint cache: a tiny localStorage cache holds the last-seen selection
// so the page renders instantly while Firestore catches up.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";
import { apiRequest } from "./queryClient";
import {
  COL,
  CONFIG_DOC_BANNERS,
  DEFAULT_BANNER_SELECTION,
  ALL_BANNER_SRCS,
  type BannerSelection,
} from "@shared/firestore-schema";

const CACHE_KEY = "admin_banner_selection_cache";

function readCache(): string[] {
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return parsed.filter((s): s is string => ALL_BANNER_SRCS.includes(s));
      }
    }
  } catch {}
  return [...DEFAULT_BANNER_SELECTION.enabled];
}

function writeCache(enabled: string[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(enabled));
  } catch {}
}

export function useBannerSelection() {
  const [enabled, setEnabled] = useState<string[]>(() => readCache());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ref = doc(db, COL.config, CONFIG_DOC_BANNERS);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const stored = snap.data() as Partial<BannerSelection>;
          const cleaned = Array.isArray(stored.enabled)
            ? stored.enabled.filter((s): s is string => ALL_BANNER_SRCS.includes(s))
            : [...DEFAULT_BANNER_SELECTION.enabled];
          const next = cleaned.length > 0 ? cleaned : [...DEFAULT_BANNER_SELECTION.enabled];
          setEnabled(next);
          writeCache(next);
        } else {
          setEnabled([...DEFAULT_BANNER_SELECTION.enabled]);
        }
        setLoading(false);
      },
      (err) => {
        // Permission errors during sign-out are expected; log for everything else.
        if ((err as { code?: string })?.code !== "permission-denied") {
          console.error("banners onSnapshot failed:", err);
        }
        setLoading(false);
      },
    );
    return () => unsub();
  }, []);

  return { enabled, loading };
}

// Persist banner selection. Admin-only — server enforces via
// requirePlatformPrivilege("platform.modifySettings").
export async function saveBannerSelection(enabled: string[]): Promise<void> {
  await apiRequest("PUT", "/api/admin/banners", { enabled });
}
