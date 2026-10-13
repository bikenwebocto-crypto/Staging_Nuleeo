// Shared 30s-TTL cache for the hot `config/*` Firestore docs that get
// read on nearly every authenticated request. Without these caches:
//
//   - `loadPrivilegesConfig` runs on every privilege check (multiple
//     per request); a 10k-concurrent cold-start avalanche = 10k+
//     Firestore reads/sec on one doc.
//   - `loadSystemConfig` runs on the `maintenanceGate` for every
//     authenticated `/api/*` request.
//   - `loadPlanLabels` + `loadPlatformFeesConfig` run on every property
//     POST + every tenant rent-checkout respectively.
//
// Cache is intentionally module-scoped (one per Functions instance),
// not shared across instances — each instance reads the doc once per
// 30s + then serves from memory. Admin writes to `/api/privileges-
// config` / `/api/system-config` / `/api/admin/plan-labels` /
// `/api/admin/platform-fees` call the matching invalidator below so
// the saving admin sees their change on the very next request. Other
// instances catch up within the TTL.
//
// All loaders merge stored values OVER the defaults so a partial doc
// (e.g. only one tab saved) doesn't blank out un-edited keys.

import { db } from "../firebase";
import {
  CONFIG_DOC_FEATURE_FLAGS,
  CONFIG_DOC_PLAN_LABELS,
  CONFIG_DOC_PLATFORM_FEES,
  CONFIG_DOC_PRIVILEGES,
  CONFIG_DOC_SYSTEM,
  COL,
  DEFAULT_FEATURE_FLAGS_CONFIG,
  DEFAULT_PLAN_LABELS,
  DEFAULT_PLATFORM_FEES_CONFIG,
  DEFAULT_PRIVILEGES_CONFIG,
  DEFAULT_SYSTEM_CONFIG,
  withFixedPlanPrices,
  type FeatureFlagsConfig,
  type PlanLabelsConfig,
  type PlatformFeesConfig,
  type PrivilegesConfig,
  type SystemConfig,
} from "../../shared/firestore-schema";

const TTL_MS = 30_000;

interface Cached<T> {
  value: T;
  expiresAt: number;
}

let privilegesCache: Cached<PrivilegesConfig> | null = null;
let systemConfigCache: Cached<SystemConfig> | null = null;
let planLabelsCache: Cached<PlanLabelsConfig> | null = null;
let platformFeesCache: Cached<PlatformFeesConfig> | null = null;
let featureFlagsCache: Cached<FeatureFlagsConfig> | null = null;

// Test-only: drop all caches so unit tests don't see stale state
// between cases. Production code shouldn't call this — use the
// per-doc invalidator below.
export function _resetAllConfigCachesForTest(): void {
  privilegesCache = null;
  systemConfigCache = null;
  planLabelsCache = null;
  platformFeesCache = null;
  featureFlagsCache = null;
}

export function invalidateFeatureFlagsCache(): void {
  featureFlagsCache = null;
}
export function invalidatePrivilegesCache(): void {
  privilegesCache = null;
}
export function invalidateSystemConfigCache(): void {
  systemConfigCache = null;
}
export function invalidatePlanLabelsCache(): void {
  planLabelsCache = null;
}
export function invalidatePlatformFeesCache(): void {
  platformFeesCache = null;
}

export async function loadPrivilegesConfig(): Promise<PrivilegesConfig> {
  if (privilegesCache && privilegesCache.expiresAt > Date.now()) {
    return privilegesCache.value;
  }
  const snap = await db().collection(COL.config).doc(CONFIG_DOC_PRIVILEGES).get();
  let value: PrivilegesConfig;
  if (!snap.exists) {
    value = DEFAULT_PRIVILEGES_CONFIG;
  } else {
    const stored = snap.data() as Partial<PrivilegesConfig>;
    value = {
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
    };
  }
  privilegesCache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

export async function loadFeatureFlags(): Promise<FeatureFlagsConfig> {
  if (featureFlagsCache && featureFlagsCache.expiresAt > Date.now()) {
    return featureFlagsCache.value;
  }
  const snap = await db().collection(COL.config).doc(CONFIG_DOC_FEATURE_FLAGS).get();
  let value: FeatureFlagsConfig;
  if (!snap.exists) {
    value = DEFAULT_FEATURE_FLAGS_CONFIG;
  } else {
    const stored = snap.data() as Partial<FeatureFlagsConfig>;
    // Merge stored flags OVER the defaults so a newly-added flag (not yet in
    // the stored doc) reads as enabled rather than undefined.
    value = {
      flags: { ...DEFAULT_FEATURE_FLAGS_CONFIG.flags, ...(stored.flags ?? {}) },
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
    };
  }
  featureFlagsCache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

export async function loadSystemConfig(): Promise<SystemConfig> {
  if (systemConfigCache && systemConfigCache.expiresAt > Date.now()) {
    return systemConfigCache.value;
  }
  const snap = await db().collection(COL.config).doc(CONFIG_DOC_SYSTEM).get();
  let value: SystemConfig;
  if (!snap.exists) {
    value = DEFAULT_SYSTEM_CONFIG;
  } else {
    const stored = snap.data() as Partial<SystemConfig>;
    value = {
      maintenanceMode: {
        ...DEFAULT_SYSTEM_CONFIG.maintenanceMode,
        ...(stored.maintenanceMode ?? {}),
      },
      // Public-read doc — never surface the admin UID (updatedBy / startedBy).
      // New writes no longer persist it; this also drops it from legacy docs
      // on read. See config.ts (L-25).
      updatedAt: stored.updatedAt,
    };
  }
  systemConfigCache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

export async function loadPlanLabels(): Promise<PlanLabelsConfig> {
  if (planLabelsCache && planLabelsCache.expiresAt > Date.now()) {
    return planLabelsCache.value;
  }
  const snap = await db().collection(COL.config).doc(CONFIG_DOC_PLAN_LABELS).get();
  let value: PlanLabelsConfig;
  if (!snap.exists) {
    value = DEFAULT_PLAN_LABELS;
  } else {
    const stored = snap.data() as Partial<PlanLabelsConfig>;
    // Prices (yearlyAmount + proUpgradeFirstCycleAmount) are fixed in code —
    // overlay the canonical values so a stored override can't change what
    // owners are charged (e.g. the Growth→Pro upgrade coupon math).
    value = withFixedPlanPrices({
      plans: { ...DEFAULT_PLAN_LABELS.plans, ...(stored.plans ?? {}) },
      // Distinguish an explicit stored value (incl. null = "no discount") from
      // a legacy doc missing the key (→ default). Don't coalesce null to default.
      proUpgradeFirstCycleAmount:
        stored.proUpgradeFirstCycleAmount !== undefined
          ? stored.proUpgradeFirstCycleAmount
          : DEFAULT_PLAN_LABELS.proUpgradeFirstCycleAmount,
      // Public-read doc — don't surface the admin UID (see config.ts L-25).
      updatedAt: stored.updatedAt,
    });
  }
  planLabelsCache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

export async function loadPlatformFeesConfig(): Promise<PlatformFeesConfig> {
  if (platformFeesCache && platformFeesCache.expiresAt > Date.now()) {
    return platformFeesCache.value;
  }
  const snap = await db().collection(COL.config).doc(CONFIG_DOC_PLATFORM_FEES).get();
  let value: PlatformFeesConfig;
  if (!snap.exists) {
    value = DEFAULT_PLATFORM_FEES_CONFIG;
  } else {
    const stored = snap.data() as Partial<PlatformFeesConfig>;
    value = {
      rentCommission: {
        ...DEFAULT_PLATFORM_FEES_CONFIG.rentCommission,
        ...(stored.rentCommission ?? {}),
      },
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
    };
  }
  platformFeesCache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}
