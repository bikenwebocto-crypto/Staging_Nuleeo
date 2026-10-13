// Realtime system-config store backed by Firestore.
//
// Storage: a single Firestore doc at config/system holds global flags —
// currently the maintenance lockout. Public read is permitted by
// firestore.rules so the user app shell can subscribe before the API
// round-trip resolves and lock the UI instantly.
//
// Reads: components subscribe via Firestore onSnapshot through
// `useSystemConfig()`. Edits made on the platform admin app propagate to
// every connected client (across both subdomains) within ~1s.
//
// Writes: go through PUT /api/system-config, which requires superadmin and
// validates the payload server-side. Direct client writes are blocked by
// rules.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";
import { apiRequest } from "./queryClient";
import {
  COL,
  CONFIG_DOC_SYSTEM,
  DEFAULT_SYSTEM_CONFIG,
  type SystemConfig,
} from "@shared/firestore-schema";

export type { SystemConfig };

export function useSystemConfig() {
  const [config, setConfig] = useState<SystemConfig>(DEFAULT_SYSTEM_CONFIG);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ref = doc(db, COL.config, CONFIG_DOC_SYSTEM);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const stored = snap.data() as Partial<SystemConfig>;
          setConfig({
            maintenanceMode: {
              ...DEFAULT_SYSTEM_CONFIG.maintenanceMode,
              ...(stored.maintenanceMode ?? {}),
            },
            updatedAt: stored.updatedAt,
            updatedBy: stored.updatedBy,
          });
        } else {
          setConfig(DEFAULT_SYSTEM_CONFIG);
        }
        setLoading(false);
      },
      (err) => {
        console.error("system config onSnapshot failed:", err);
        setLoading(false);
      },
    );
    return () => unsub();
  }, []);

  return { config, loading };
}

// Persist the system config. Superadmin-only — server enforces via
// requireRole("superadmin").
export async function saveSystemConfig(next: Partial<SystemConfig>): Promise<SystemConfig> {
  const res = await apiRequest("PUT", "/api/system-config", next);
  return (await res.json()) as SystemConfig;
}
