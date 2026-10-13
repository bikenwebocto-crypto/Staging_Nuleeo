// Single-doc admin configuration endpoints. Each pair (GET + PUT)
// owns one config/* Firestore doc:
//
//   /api/privileges-config → config/privileges  (role x feature matrix)
//   /api/system-config     → config/system      (maintenance mode)
//   /api/compliance        → config/compliance  (legal documents)
//   /api/social            → config/social      (footer link URLs)
//   /api/admin/banners     → config/banners     (carousel selection)
//   /api/admin/platform-fees → config/platformFees (commission %)
//   /api/admin/plan-labels → config/planLabels  (subscription copy)
//
// Reads are mostly public (clients subscribe via Firestore onSnapshot
// for realtime sync); writes are gated behind platform privileges.
//
// Every PUT busts the in-process config cache (configCache.ts) so the
// NEXT request on this function instance reads the just-saved doc;
// other instances catch up within the 30s TTL.

import type { Express, RequestHandler } from "express";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { logWarn } from "../services/log";
import {
  invalidateFeatureFlagsCache,
  invalidatePlanLabelsCache,
  invalidatePlatformFeesCache,
  invalidatePrivilegesCache,
  invalidateSystemConfigCache,
  loadFeatureFlags,
  loadPlatformFeesConfig,
  loadPrivilegesConfig,
  loadSystemConfig,
} from "../services/configCache";
import {
  ALL_BANNER_SRCS,
  type BannerSelection,
  COL,
  CONFIG_DOC_BANNERS,
  CONFIG_DOC_COMPLIANCE,
  CONFIG_DOC_PLAN_LABELS,
  CONFIG_DOC_PLATFORM_FEES,
  CONFIG_DOC_PRIVILEGES,
  CONFIG_DOC_SOCIAL,
  CONFIG_DOC_SYSTEM,
  type ComplianceDocs,
  type ComplianceDocKey,
  DEFAULT_BANNER_SELECTION,
  DEFAULT_PLAN_LABELS,
  DEFAULT_PLATFORM_FEES_CONFIG,
  DEFAULT_PRIVILEGES_CONFIG,
  DEFAULT_SOCIAL_LINKS,
  type OwnerPlanKey,
  type PlanLabel,
  type PlanLabelsConfig,
  type PlatformFeesConfig,
  type PlatformPrivilegeKey,
  type PrivilegesConfig,
  type RentCommissionTier,
  type Role,
  type SocialLinkMap,
  type SocialLinks,
  type SocialPlatformKey,
  SOCIAL_PLATFORM_KEYS,
  type SystemConfig,
  normalizeSocialInput,
  CONFIG_DOC_FEATURE_FLAGS,
  DEFAULT_FEATURE_FLAGS_CONFIG,
  FEATURE_FLAGS,
  type FeatureFlag,
  type FeatureFlagsConfig,
  withFixedPlanPrices,
} from "../../shared/firestore-schema";
import { DEFAULT_COMPLIANCE_DOCS } from "../../shared/compliance-defaults";

export interface ConfigDeps {
  requireRole: (...roles: Role[]) => RequestHandler;
  requirePlatformPrivilege: (p: PlatformPrivilegeKey) => RequestHandler;
}

// Sanitize a client-submitted privilege-grants object against the known
// defaults: drop any privilege key OR role key not present in the defaults,
// and coerce every grant value to a strict boolean. config/privileges is the
// single source of truth for EVERY authorization check in the platform, so we
// must never persist client-supplied keys verbatim — an unknown/garbage key
// would be stored in the global authZ doc, and a non-boolean value could
// subtly change how downstream checks coerce it.
export function sanitizeGrants<T extends Record<string, Record<string, boolean>>>(
  incoming: unknown,
  defaults: T,
): Partial<T> {
  const out: Record<string, Record<string, boolean>> = {};
  if (!incoming || typeof incoming !== "object") return out as Partial<T>;
  const defaultsRec = defaults as Record<string, Record<string, boolean>>;
  for (const [privKey, roleMap] of Object.entries(incoming as Record<string, unknown>)) {
    const allowedRoles = defaultsRec[privKey];
    if (!allowedRoles) continue; // unknown privilege key — drop
    if (!roleMap || typeof roleMap !== "object") continue;
    const clean: Record<string, boolean> = {};
    for (const [roleKey, val] of Object.entries(roleMap as Record<string, unknown>)) {
      if (!(roleKey in allowedRoles)) continue; // unknown role key — drop
      clean[roleKey] = Boolean(val);
    }
    out[privKey] = clean;
  }
  return out as Partial<T>;
}

export function registerConfigRoutes(
  app: Express,
  { requireRole, requirePlatformPrivilege }: ConfigDeps,
): void {
  // ─── Privilege matrix ──────────────────────────────────────────────
  // Read by every signed-in user (drives client-side gates) and
  // written only by admins. Client also subscribes via Firestore
  // onSnapshot for realtime updates; this endpoint is the canonical
  // write path and the initial-load fallback.
  app.get("/api/privileges-config", requireAuth, async (_req, res) => {
    try {
      const config = await loadPrivilegesConfig();
      res.json(config);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load privileges") });
    }
  });

  app.put(
    "/api/privileges-config",
    requireAuth,
    // SUPERADMIN ONLY. config/privileges defines every other authorization
    // gate (platform, portfolio AND owner-plan), so the ability to write it
    // is effectively god-mode. Gating it on platform.modifySettings let any
    // holder of that one permission (incl. delegated managers) grant their
    // own role every other privilege. A superadmin already bypasses the
    // matrix entirely, so there's no self-escalation to guard against here.
    requireRole("superadmin"),
    async (req, res) => {
      const body = req.body as Partial<PrivilegesConfig> | null | undefined;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ error: "Invalid body" });
      }
      try {
        // Transactional read-then-write — same shape as compliance
        // PUT. Two admins editing different sections of the matrix
        // would otherwise overwrite each other; the transaction makes
        // concurrent commits safe by re-running the closure on
        // contention.
        const ref = db().collection(COL.config).doc(CONFIG_DOC_PRIVILEGES);
        const next = await db().runTransaction(async (t) => {
          const snap = await t.get(ref);
          const current = snap.exists ? (snap.data() as Partial<PrivilegesConfig>) : {};
          // Merge over the live current state instead of over
          // defaults so an admin patching just portfolio.foo doesn't
          // reset platform.bar that another admin set earlier.
          // Body grants are sanitized against the defaults (unknown
          // privilege/role keys dropped, values coerced to booleans) before
          // merging, so a malformed or hostile payload can't inject arbitrary
          // keys into the global authZ doc.
          const merged: PrivilegesConfig = {
            portfolio: {
              ...DEFAULT_PRIVILEGES_CONFIG.portfolio,
              ...(current.portfolio ?? {}),
              ...sanitizeGrants(body.portfolio, DEFAULT_PRIVILEGES_CONFIG.portfolio),
            },
            platform: {
              ...DEFAULT_PRIVILEGES_CONFIG.platform,
              ...(current.platform ?? {}),
              ...sanitizeGrants(body.platform, DEFAULT_PRIVILEGES_CONFIG.platform),
            },
            ownerPlan: {
              ...DEFAULT_PRIVILEGES_CONFIG.ownerPlan,
              ...(current.ownerPlan ?? {}),
              ...sanitizeGrants(body.ownerPlan, DEFAULT_PRIVILEGES_CONFIG.ownerPlan),
            },
            updatedAt: new Date().toISOString(),
            updatedBy: req.user!.uid,
          };
          t.set(ref, merged, { merge: false });
          return merged;
        });
        // Bust the in-process cache so the next request on THIS
        // function instance reads the freshly-saved matrix. Other
        // instances pick up the change within ~30s (the cache TTL).
        invalidatePrivilegesCache();
        res.json(next);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to save privileges") });
      }
    },
  );

  // ─── Feature flags (runtime kill-switches) ─────────────────────────
  // config/featureFlags gates the risky money/abuse paths so a superadmin can
  // disable one at runtime (no deploy) during an incident. Server-read only —
  // NOT client-readable (deny-by-default rules); the admin reads it here. GET is
  // admin+; PUT is superadmin-only (it can switch off rent collection).
  app.get(
    "/api/feature-flags",
    requireAuth,
    requireRole("admin", "superadmin"),
    async (_req, res) => {
      try {
        res.json(await loadFeatureFlags());
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load feature flags") });
      }
    },
  );

  app.put("/api/feature-flags", requireAuth, requireRole("superadmin"), async (req, res) => {
    const body = req.body as { flags?: Record<string, unknown> } | null | undefined;
    if (!body || typeof body !== "object" || !body.flags || typeof body.flags !== "object") {
      return res.status(400).json({ error: "Invalid body — expected { flags: {…} }" });
    }
    // Accept only known flags, coerced to strict booleans — an unknown or
    // non-boolean key can't be persisted into the doc.
    const patch: Partial<Record<FeatureFlag, boolean>> = {};
    for (const flag of FEATURE_FLAGS) {
      const v = (body.flags as Record<string, unknown>)[flag];
      if (typeof v === "boolean") patch[flag] = v;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No known feature flags provided" });
    }
    try {
      const ref = db().collection(COL.config).doc(CONFIG_DOC_FEATURE_FLAGS);
      const next = await db().runTransaction(async (t) => {
        const snap = await t.get(ref);
        const current = snap.exists ? (snap.data() as Partial<FeatureFlagsConfig>) : {};
        const merged: FeatureFlagsConfig = {
          flags: {
            ...DEFAULT_FEATURE_FLAGS_CONFIG.flags,
            ...(current.flags ?? {}),
            ...patch,
          },
          updatedAt: new Date().toISOString(),
          updatedBy: req.user!.uid,
        };
        t.set(ref, merged, { merge: false });
        return merged;
      });
      invalidateFeatureFlagsCache();
      // Flipping a kill-switch is a notable operational event — log it (WARNING
      // so it surfaces) with which flags changed and who did it.
      logWarn("feature.flags-updated", { flags: patch, by: req.user!.uid });
      res.json(next);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to save feature flags") });
    }
  });

  // ─── System config (maintenance mode) ──────────────────────────────
  // Single Firestore doc at config/system holds global flags —
  // currently just the maintenance lockout. The user app subscribes
  // via onSnapshot to render the maintenance screen instantly; this
  // endpoint is the canonical write path (superadmin only) and an
  // initial-load fallback.
  app.get("/api/system-config", async (_req, res) => {
    try {
      const config = await loadSystemConfig();
      res.json(config);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load system config") });
    }
  });

  app.put("/api/system-config", requireAuth, requireRole("superadmin"), async (req, res) => {
    const body = req.body as Partial<SystemConfig> | null | undefined;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Invalid body" });
    }
    try {
      const incoming: Partial<SystemConfig["maintenanceMode"]> = body.maintenanceMode ?? {};
      const current = await loadSystemConfig();
      const wasOn = current.maintenanceMode.enabled;
      const nextEnabled = Boolean(incoming.enabled);
      const next: SystemConfig = {
        maintenanceMode: {
          enabled: nextEnabled,
          message:
            typeof incoming.message === "string"
              ? incoming.message.trim() || undefined
              : current.maintenanceMode.message,
          // Stamp when the lockout first turns on; clear when it
          // turns off.
          startedAt: nextEnabled
            ? wasOn
              ? (current.maintenanceMode.startedAt ?? new Date().toISOString())
              : new Date().toISOString()
            : undefined,
          // NOTE: config/system is PUBLIC-read (firestore.rules
          // `allow read: if true`), so we deliberately do NOT persist
          // admin identity (`startedBy`) here — that would leak which
          // superadmin started maintenance to any anonymous visitor.
          // A timestamp (startedAt/updatedAt) is fine; it's not identity.
        },
        updatedAt: new Date().toISOString(),
      };
      await db().collection(COL.config).doc(CONFIG_DOC_SYSTEM).set(next, { merge: false });
      // Bust the cache so the very next maintenanceGate call on
      // this instance reflects the new state. Other instances catch
      // up within the 30s TTL.
      invalidateSystemConfigCache();
      res.json(next);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to save system config") });
    }
  });

  // ─── Compliance documents ──────────────────────────────────────────
  // Single Firestore doc at config/compliance holds every legal
  // document. Public reads happen client-side via Firestore
  // onSnapshot for realtime sync across all subdomains; this endpoint
  // is the canonical write path and an initial-load fallback.
  app.get("/api/compliance", async (_req, res) => {
    try {
      const snap = await db().collection(COL.config).doc(CONFIG_DOC_COMPLIANCE).get();
      if (!snap.exists) return res.json(DEFAULT_COMPLIANCE_DOCS);
      // PUBLIC-read endpoint — strip any legacy `updatedBy` (admin UID)
      // before echoing so old docs don't leak admin identity.
      const { updatedBy: _legacyUpdatedBy, ...stored } = snap.data() as Partial<ComplianceDocs>;
      res.json({ ...DEFAULT_COMPLIANCE_DOCS, ...stored });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load compliance docs") });
    }
  });

  app.put(
    "/api/compliance",
    requireAuth,
    requirePlatformPrivilege("platform.modifySettings"),
    async (req, res) => {
      const body = req.body as Partial<ComplianceDocs> | null | undefined;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ error: "Invalid body" });
      }
      const allowedKeys: ComplianceDocKey[] = [
        "terms",
        "privacy",
        "gdpr",
        "owner-terms",
        "tenant-terms",
        "cookies",
        "aup",
        "dpa",
        "subprocessors",
        "ai-terms",
        "payments-terms",
        "aml-kyc",
        "community-guidelines",
        "notice-takedown",
        "complaints",
        "accessibility",
        "security",
        "ip-policy",
      ];
      // Compliance docs are HTML rendered on public routes. Cap each
      // doc at 200kB — that's 5x the longest realistic compliance
      // text and well under Firestore's 1MB doc limit. Stops a
      // careless or malicious admin from saving a multi-MB blob that
      // bloats every /api/compliance fetch.
      const MAX_DOC_BYTES = 200_000;
      const patch: Partial<ComplianceDocs> = {};
      for (const k of allowedKeys) {
        const v = body[k];
        if (typeof v === "string") {
          if (v.length > MAX_DOC_BYTES) {
            return res.status(400).json({
              error: `${k} exceeds the ${MAX_DOC_BYTES.toLocaleString()}-character cap`,
            });
          }
          patch[k] = v;
        }
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "No document content provided" });
      }
      try {
        const ref = db().collection(COL.config).doc(CONFIG_DOC_COMPLIANCE);
        // Transactional read-then-write. Without this, two admins
        // editing different tabs simultaneously would each load the
        // doc, edit their tab, and overwrite each other's
        // un-touched-by-them tabs back to stale values — the
        // transaction makes it safe by ensuring t.get + t.set see a
        // consistent snapshot, with Firestore retrying the closure on
        // contention.
        const next = await db().runTransaction(async (t) => {
          const snap = await t.get(ref);
          const current = snap.exists ? (snap.data() as Partial<ComplianceDocs>) : {};
          // config/compliance is PUBLIC-read (firestore.rules
          // `allow read: if true`), so we deliberately do NOT persist
          // admin identity (`updatedBy`) — that would leak which admin
          // last edited the legal docs to any anonymous visitor. Drop any
          // legacy `updatedBy` carried over from `current` for the same
          // reason. A timestamp (updatedAt) is fine; it's not identity.
          const { updatedBy: _legacyUpdatedBy, ...currentClean } = current;
          const merged: ComplianceDocs = {
            ...DEFAULT_COMPLIANCE_DOCS,
            ...currentClean,
            ...patch,
            updatedAt: new Date().toISOString(),
          };
          t.set(ref, merged, { merge: false });
          return merged;
        });
        res.json(next);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to save compliance docs") });
      }
    },
  );

  // ─── Social-media links ────────────────────────────────────────────
  // Single Firestore doc at config/social holds the URL for each
  // supported platform. Public reads happen client-side via Firestore
  // onSnapshot so the landing footer and the app sidebar both update
  // in realtime when an admin saves a link. This endpoint is the
  // write path and a server-side fallback fetch.
  app.get("/api/social", async (_req, res) => {
    try {
      const snap = await db().collection(COL.config).doc(CONFIG_DOC_SOCIAL).get();
      if (!snap.exists) return res.json(DEFAULT_SOCIAL_LINKS);
      // PUBLIC-read endpoint — strip any legacy `updatedBy` (admin UID)
      // before echoing so old docs don't leak admin identity.
      const { updatedBy: _legacyUpdatedBy, ...stored } = snap.data() as Partial<SocialLinks>;
      res.json({ ...DEFAULT_SOCIAL_LINKS, ...stored });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load social links") });
    }
  });

  app.put(
    "/api/social",
    requireAuth,
    requirePlatformPrivilege("platform.modifySettings"),
    async (req, res) => {
      const body = req.body as Partial<SocialLinkMap> | null | undefined;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ error: "Invalid body" });
      }
      const patch: Partial<SocialLinkMap> = {};
      for (const k of SOCIAL_PLATFORM_KEYS) {
        const v = (body as Record<string, unknown>)[k];
        if (typeof v === "string") patch[k as SocialPlatformKey] = normalizeSocialInput(k, v);
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "No social links provided" });
      }
      try {
        const ref = db().collection(COL.config).doc(CONFIG_DOC_SOCIAL);
        const snap = await ref.get();
        const current = snap.exists ? (snap.data() as Partial<SocialLinks>) : {};
        // config/social is PUBLIC-read (firestore.rules
        // `allow read: if true`), so we deliberately do NOT persist admin
        // identity (`updatedBy`) — that would leak which admin last edited
        // the footer links to any anonymous visitor. Drop any legacy
        // `updatedBy` carried over from `current` for the same reason.
        const { updatedBy: _legacyUpdatedBy, ...currentClean } = current;
        const next: SocialLinks = {
          ...DEFAULT_SOCIAL_LINKS,
          ...currentClean,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        await ref.set(next, { merge: false });
        res.json(next);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to save social links") });
      }
    },
  );

  // ── Banner carousel selection (admin dashboard hero) ──────────────
  // Stored as a single config doc so toggling in /admin/settings
  // propagates to every admin's dashboard via onSnapshot. Reads are
  // gated to signed-in admins (the data isn't sensitive but only
  // admins consume it); writes go through PUT below.
  app.get(
    "/api/admin/banners",
    requireAuth,
    requireRole("admin", "superadmin"),
    async (_req, res) => {
      try {
        const snap = await db().collection(COL.config).doc(CONFIG_DOC_BANNERS).get();
        if (!snap.exists) return res.json(DEFAULT_BANNER_SELECTION);
        const stored = snap.data() as Partial<BannerSelection>;
        // Filter against the canonical option list so a renamed/
        // removed banner can't poison the selection.
        const enabled = Array.isArray(stored.enabled)
          ? stored.enabled.filter((s): s is string => ALL_BANNER_SRCS.includes(s as string))
          : DEFAULT_BANNER_SELECTION.enabled;
        res.json({
          enabled: enabled.length > 0 ? enabled : DEFAULT_BANNER_SELECTION.enabled,
          updatedAt: stored.updatedAt,
          updatedBy: stored.updatedBy,
        });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load banner selection") });
      }
    },
  );

  app.put(
    "/api/admin/banners",
    requireAuth,
    requirePlatformPrivilege("platform.modifySettings"),
    async (req, res) => {
      const body = (req.body ?? {}) as Partial<BannerSelection>;
      const incoming = Array.isArray(body.enabled) ? body.enabled : null;
      if (!incoming) {
        return res.status(400).json({ error: "enabled[] is required" });
      }
      // Dedupe + filter to the known options. Refuse an empty result
      // so the carousel always has something to show.
      const cleaned: string[] = [];
      for (const s of incoming) {
        if (typeof s === "string" && ALL_BANNER_SRCS.includes(s) && !cleaned.includes(s)) {
          cleaned.push(s);
        }
      }
      if (cleaned.length === 0) {
        return res.status(400).json({ error: "At least one banner must be enabled" });
      }
      try {
        const ref = db().collection(COL.config).doc(CONFIG_DOC_BANNERS);
        const next: BannerSelection = {
          enabled: cleaned,
          updatedAt: new Date().toISOString(),
          updatedBy: req.user!.uid,
        };
        await ref.set(next, { merge: false });
        res.json(next);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to save banner selection") });
      }
    },
  );

  // ── Platform fees (admin-managed commission per owner-subscription plan) ──
  // The same matrix is read by /api/tenant/payment/checkout to pass
  // `application_fee_amount` to Stripe. Default is 0% across the
  // board — no commission is charged until an admin explicitly sets a
  // rate.
  app.get(
    "/api/admin/platform-fees",
    requireAuth,
    requirePlatformPrivilege("platform.modifySettings"),
    async (_req, res) => {
      try {
        const config = await loadPlatformFeesConfig();
        res.json(config);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load platform fees") });
      }
    },
  );

  app.put(
    "/api/admin/platform-fees",
    requireAuth,
    requirePlatformPrivilege("platform.modifySettings"),
    async (req, res) => {
      const body = (req.body ?? {}) as Partial<PlatformFeesConfig>;
      const incoming = body.rentCommission;
      if (!incoming || typeof incoming !== "object") {
        return res.status(400).json({ error: "rentCommission object is required" });
      }
      const plans: OwnerPlanKey[] = ["basic", "advance", "pro", "business"];
      const next: Record<OwnerPlanKey, RentCommissionTier> = {
        ...DEFAULT_PLATFORM_FEES_CONFIG.rentCommission,
      };
      for (const plan of plans) {
        const tier = (incoming as Record<OwnerPlanKey, RentCommissionTier | undefined>)[plan];
        if (!tier) continue;
        const percent = tier.percent;
        const min = tier.minAmountCents;
        if (
          percent !== undefined &&
          (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100)
        ) {
          return res.status(400).json({
            error: `${plan}.percent must be a finite number between 0 and 100`,
          });
        }
        if (
          min !== undefined &&
          (typeof min !== "number" || !Number.isFinite(min) || min < 0 || !Number.isInteger(min))
        ) {
          return res.status(400).json({
            error: `${plan}.minAmountCents must be a non-negative integer`,
          });
        }
        next[plan] = {
          percent: percent ?? 0,
          minAmountCents: min ?? 0,
        };
      }
      try {
        const ref = db().collection(COL.config).doc(CONFIG_DOC_PLATFORM_FEES);
        const merged: PlatformFeesConfig = {
          rentCommission: next,
          updatedAt: new Date().toISOString(),
          updatedBy: req.user!.uid,
        };
        await ref.set(merged);
        invalidatePlatformFeesCache();
        res.json(merged);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to save platform fees") });
      }
    },
  );

  // ── Plan labels (admin-editable plan names + descriptions + unit caps) ──
  // Single Firestore doc `config/planLabels`, public-read so /landing
  // can subscribe via onSnapshot. Saves to the same doc via the PUT
  // below.
  app.get("/api/admin/plan-labels", async (_req, res) => {
    try {
      const snap = await db().collection(COL.config).doc(CONFIG_DOC_PLAN_LABELS).get();
      if (!snap.exists) {
        return res.json(DEFAULT_PLAN_LABELS);
      }
      const stored = snap.data() as Partial<PlanLabelsConfig>;
      // Merge over defaults so adding a new plan key never crashes
      // the UI. PUBLIC-read endpoint — deliberately omit `updatedBy`
      // (admin UID) so a legacy doc can't leak admin identity.
      // Prices (yearlyAmount + proUpgradeFirstCycleAmount) are fixed in code:
      // overlay the canonical values so the admin panel shows the locked price.
      const merged: PlanLabelsConfig = withFixedPlanPrices({
        plans: {
          ...DEFAULT_PLAN_LABELS.plans,
          ...(stored.plans ?? {}),
        },
        proUpgradeFirstCycleAmount:
          stored.proUpgradeFirstCycleAmount !== undefined
            ? stored.proUpgradeFirstCycleAmount
            : DEFAULT_PLAN_LABELS.proUpgradeFirstCycleAmount,
        updatedAt: stored.updatedAt,
      });
      res.json(merged);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load plan labels") });
    }
  });

  app.put(
    "/api/admin/plan-labels",
    requireAuth,
    requirePlatformPrivilege("platform.modifySettings"),
    async (req, res) => {
      const body = (req.body ?? {}) as Partial<PlanLabelsConfig>;
      if (!body.plans || typeof body.plans !== "object") {
        return res.status(400).json({ error: "plans object is required" });
      }
      const plans: OwnerPlanKey[] = ["basic", "advance", "pro", "business"];
      const next: Record<OwnerPlanKey, PlanLabel> = {
        ...DEFAULT_PLAN_LABELS.plans,
      };
      for (const plan of plans) {
        const incoming = (body.plans as Record<OwnerPlanKey, PlanLabel | undefined>)[plan];
        if (!incoming) continue;
        const label = typeof incoming.label === "string" ? incoming.label.trim() : "";
        const description =
          typeof incoming.description === "string" ? incoming.description.trim() : "";
        if (!label) {
          return res.status(400).json({ error: `${plan}.label cannot be empty` });
        }
        const unitCap =
          incoming.unitCap === null
            ? null
            : typeof incoming.unitCap === "number" &&
                Number.isFinite(incoming.unitCap) &&
                incoming.unitCap >= 0
              ? Math.floor(incoming.unitCap)
              : DEFAULT_PLAN_LABELS.plans[plan].unitCap;
        // Prices are FIXED in code and NOT admin-editable: ignore any incoming
        // yearlyAmount and always persist the canonical value, so the stored
        // doc stays consistent with what every reader overlays.
        const yearlyAmount = DEFAULT_PLAN_LABELS.plans[plan].yearlyAmount;
        next[plan] = {
          label,
          description,
          unitCap,
          yearlyAmount,
          ...(typeof incoming.ctaLabel === "string" && incoming.ctaLabel.trim()
            ? { ctaLabel: incoming.ctaLabel.trim() }
            : {}),
        };
      }
      // The Pro-upgrade first-cycle price is FIXED in code and NOT admin-
      // editable: ignore any incoming value and always persist the canonical
      // figure (readers overlay it anyway via withFixedPlanPrices).
      const proUpgradeFirstCycleAmount = DEFAULT_PLAN_LABELS.proUpgradeFirstCycleAmount;
      try {
        const ref = db().collection(COL.config).doc(CONFIG_DOC_PLAN_LABELS);
        // config/planLabels is PUBLIC-read (firestore.rules
        // `allow read: if true`), so we deliberately do NOT persist admin
        // identity (`updatedBy`) — that would leak which admin last edited
        // the plan copy to any anonymous landing visitor. A timestamp
        // (updatedAt) is fine; it's not identity.
        const merged: PlanLabelsConfig = {
          plans: next,
          proUpgradeFirstCycleAmount,
          updatedAt: new Date().toISOString(),
        };
        await ref.set(merged);
        invalidatePlanLabelsCache();
        res.json(merged);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to save plan labels") });
      }
    },
  );
}
