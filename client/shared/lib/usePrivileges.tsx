// Live subscription to the role privilege matrix at config/privileges.
//
// Mounted once at the app root via <PrivilegesProvider>. Inside the tree,
// `usePrivileges()` returns the current config plus `canPortfolio()` and
// `canPlatform()` checks that the rest of the UI consults to gate menus,
// buttons, and entire pages.
//
// Realtime: backed by Firestore onSnapshot, so an admin saving the matrix
// in /admin/settings causes every signed-in user to see the new gates
// within ~1s without a reload.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";
import { useAuth } from "./useAuth";
import {
  COL,
  CONFIG_DOC_PRIVILEGES,
  DEFAULT_PRIVILEGES_CONFIG,
  type OwnerPlanKey,
  type OwnerPlanPrivilegeKey,
  type PlatformPrivilegeKey,
  type PlatformRoleKey,
  type PortfolioPrivilegeKey,
  type PortfolioRoleKey,
  type PrivilegesConfig,
} from "@shared/firestore-schema";

interface PrivilegesState {
  config: PrivilegesConfig;
  loading: boolean;
  // Check a portfolio-level privilege for a specific role (or list of roles).
  // Use `usePortfolioCan()` instead when you want the caller's effective role
  // resolved automatically.
  canPortfolio: (
    privilege: PortfolioPrivilegeKey,
    role: PortfolioRoleKey | PortfolioRoleKey[],
  ) => boolean;
  // Check a platform-level privilege for the current signed-in admin.
  // Returns false for non-admins; superadmins always return true.
  canPlatform: (privilege: PlatformPrivilegeKey) => boolean;
  // Check an owner-plan feature flag for a specific plan tier. Use
  // `useCanOwnerPlan()` to get a checker bound to the caller's current plan.
  canOwnerPlan: (privilege: OwnerPlanPrivilegeKey, plan: OwnerPlanKey) => boolean;
}

const PrivilegesContext = createContext<PrivilegesState | null>(null);

export function PrivilegesProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<PrivilegesConfig>(DEFAULT_PRIVILEGES_CONFIG);
  const [loading, setLoading] = useState(true);
  const { profile } = useAuth();

  useEffect(() => {
    // Wait for auth to resolve before subscribing — Firestore rules require
    // request.auth != null on this doc.
    if (!profile) {
      setLoading(false);
      return;
    }
    const ref = doc(db, COL.config, CONFIG_DOC_PRIVILEGES);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const stored = snap.data() as Partial<PrivilegesConfig>;
          // Merge over defaults so any newly-added privilege keys remain
          // checkable even if the doc hasn't been re-saved with them.
          setConfig({
            portfolio: {
              ...DEFAULT_PRIVILEGES_CONFIG.portfolio,
              ...(stored.portfolio ?? {}),
            },
            platform: {
              ...DEFAULT_PRIVILEGES_CONFIG.platform,
              ...(stored.platform ?? {}),
            },
            ownerPlan: {
              ...DEFAULT_PRIVILEGES_CONFIG.ownerPlan,
              ...(stored.ownerPlan ?? {}),
            },
            updatedAt: stored.updatedAt,
            updatedBy: stored.updatedBy,
          });
        } else {
          setConfig(DEFAULT_PRIVILEGES_CONFIG);
        }
        setLoading(false);
      },
      (err) => {
        console.error("privileges onSnapshot failed:", err);
        setConfig(DEFAULT_PRIVILEGES_CONFIG);
        setLoading(false);
      },
    );
    return () => unsub();
  }, [profile?.id]);

  const value = useMemo<PrivilegesState>(() => {
    const canPortfolio: PrivilegesState["canPortfolio"] = (privilege, role) => {
      const grants = config.portfolio[privilege];
      if (!grants) return false;
      const roles = Array.isArray(role) ? role : [role];
      return roles.some((r) => grants[r]);
    };
    const canPlatform: PrivilegesState["canPlatform"] = (privilege) => {
      if (!profile) return false;
      if (profile.roles.includes("superadmin")) return true;
      if (!profile.roles.includes("admin")) return false;
      const role: PlatformRoleKey = profile.platformRole ?? "admin";
      return Boolean(config.platform[privilege]?.[role]);
    };
    const canOwnerPlan: PrivilegesState["canOwnerPlan"] = (privilege, plan) => {
      return Boolean(config.ownerPlan[privilege]?.[plan]);
    };
    return { config, loading, canPortfolio, canPlatform, canOwnerPlan };
  }, [config, loading, profile]);

  return <PrivilegesContext.Provider value={value}>{children}</PrivilegesContext.Provider>;
}

export function usePrivileges(): PrivilegesState {
  const ctx = useContext(PrivilegesContext);
  if (!ctx) {
    throw new Error("usePrivileges must be used inside <PrivilegesProvider>");
  }
  return ctx;
}

// Convenience: resolve the caller's effective portfolio role(s) for the
// portfolio they're currently viewing, then check a privilege against them.
//
// Pass `ownerId === profile.id` for the caller's own portfolio. Cross-
// portfolio access (legacy/legal/financial contact) is resolved against the
// `accessRole` arg, which the caller already has from /api/portfolios/accessible.
//
// NOTE: `ownerId` here is always a Firebase uid, never a Portfolio doc id —
// client-side scope ids stay uids by design (the portfolio re-key only changed
// API query params, not this hook's contract), so the `ownerId === profile.id`
// self-detection remains valid. An explicitly passed `accessRole` wins;
// "owner" is ONLY inferred from uid equality when no accessRole is given.
export function useCanPortfolio(
  ownerId: string | undefined | null,
  accessRole: PortfolioRoleKey | undefined,
) {
  const { canPortfolio } = usePrivileges();
  const { profile } = useAuth();
  return (privilege: PortfolioPrivilegeKey): boolean => {
    if (!profile || !ownerId) return false;
    const role: PortfolioRoleKey = accessRole ?? (ownerId === profile.id ? "owner" : "tenant");
    return canPortfolio(privilege, role);
  };
}

// Convenience: bind the owner-plan privilege check to a known plan tier.
// Pass the value returned by `usePlan()` so feature gates pick up plan
// changes as soon as the Stripe webhook flips the claim.
export function useCanOwnerPlan(plan: OwnerPlanKey | undefined | null) {
  const { canOwnerPlan } = usePrivileges();
  return (privilege: OwnerPlanPrivilegeKey): boolean => {
    if (!plan) return false;
    return canOwnerPlan(privilege, plan);
  };
}
