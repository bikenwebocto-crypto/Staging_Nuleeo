// Firestore collection paths and entity types. Shared between client and server.
//
// Conventions:
// - IDs are strings. For `users`, the doc ID is the Firebase Auth UID.
// - Timestamps are ISO-8601 strings ("2026-04-23T12:00:00.000Z").
// - Money is stored in major units (e.g. 1500 = $1,500), matching the existing UI.
// - Cross-collection references are stored as `{entity}Id` fields, not DocumentReference.

export const COL = {
  users: "users",
  // Banking container for a portfolio (IBAN + Stripe Connect state). Keyed by
  // a stable id (NOT the owner's uid) so the portfolio can change owners later
  // without losing its banking. One doc per owner today. See `Portfolio`.
  portfolios: "portfolios",
  properties: "properties",
  units: "units",
  tenants: "tenants",
  agreements: "agreements",
  transactions: "transactions",
  partners: "partners",
  tickets: "tickets",
  broadcasts: "broadcasts",
  paymentMethods: "paymentMethods",
  invites: "invites",
  expertApplications: "expertApplications",
  portfolioAccessContacts: "portfolioAccessContacts",
  marketplaceListings: "marketplaceListings",
  complimentaryPlans: "complimentaryPlans",
  emailCampaigns: "emailCampaigns",
  emailTemplates: "emailTemplates",
  impersonations: "impersonations",
  userAudit: "userAudit",
  documents: "documents",
  config: "config",
  // Idempotency log for the daily rent-reminder scheduler. One row per
  // (agreementId, sentOn) so a function retry / cold-start replay won't
  // double-push the tenant. See functions/src/rentReminders.ts.
  rentReminderLog: "rentReminderLog",
  // Idempotency log for the daily rent-indexation sweep. One row per
  // (agreementId, effectiveOn, kind) so a retry / replay can't double-apply
  // an increase or double-notify. See functions/src/rentIndexation.ts.
  rentIndexationLog: "rentIndexationLog",
  // Idempotency log for the daily lease-expiry sweep. One row per
  // (agreementId, endDate, kind) so a retry / replay can't double-expire,
  // double-renew, or double-notify. See functions/src/leaseExpiry.ts.
  leaseLifecycleLog: "leaseLifecycleLog",
  // Owner ↔ tenant direct-message threads. One doc per (owner, tenant)
  // pair; messages live as a subcollection.
  conversations: "conversations",
  // Owner-submitted "find me a property" leads from the AddPropertyDrawer
  // suggest step. Surfaced to platform admins as a queue of investment
  // intent to follow up on.
  suggestionRequests: "suggestionRequests",
  // Per-listing buyer interest: created when an owner clicks "I'm interested"
  // on a marketplace listing detail page. Distinct from suggestionRequests
  // (those are open-ended). Snapshots the listing summary so the admin queue
  // is still readable if the underlying listing is later edited or removed.
  marketplaceLeads: "marketplaceLeads",
  // Tombstones for hard-deleted (GDPR-erased) users. One doc per erased uid,
  // holding only { deletedAt } — NO personal data. requireAuth rejects any
  // still-valid ID token whose uid is tombstoned here, so a token that outlives
  // deletion by up to ~1h can't re-provision the account via GET /api/me.
  // Written by deleteUserCascade; safe to retain (also a proof-of-deletion).
  deletedUsers: "deletedUsers",
} as const;

// Tombstone for a hard-deleted user (see COL.deletedUsers). Intentionally holds
// no personal data — just when the erasure happened.
export interface DeletedUserTombstone {
  deletedAt: string;
}

// Owner ↔ tenant direct-message thread. One thread per (owner, tenantUser)
// pair; the doc id is deterministic (`${ownerId}_${tenantUserId}`) so the
// same pair can never get two parallel threads. Messages live as a
// `messages` subcollection on this doc, ordered by `createdAt`.
//
// `unreadByOwner` and `unreadByTenant` are denormalized counters bumped on
// send and zeroed on read — lets the UI render a badge without scanning
// the whole message list. `tenancyId` is the most recent tenancy linking
// these two; the thread itself outlives the tenancy (a re-rent next year
// can keep the same conversation history).
export interface Conversation {
  id: string;
  ownerId: string; // User.id
  tenantUserId: string; // User.id
  tenancyId: string; // Tenant.id (the tenancy doc)
  propertyId: string;
  lastMessageText: string;
  lastMessageAt: string;
  lastMessageSenderId: string;
  unreadByOwner: number;
  unreadByTenant: number;
  createdAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  senderId: string; // User.id
  text: string;
  createdAt: string;
}

// Audit trail entry written every time a platform admin opens an impersonation
// session (View As User from /admin/users). Read-only — write happens server-
// side via the Admin SDK; client reads not currently exposed.
export interface ImpersonationLog {
  id: string;
  actorUid: string;
  actorEmail: string;
  targetUid: string;
  targetEmail: string;
  createdAt: string;
}

// Owner-uploaded document attached to a property (lease PDFs, inspection
// reports, tax forms, etc.). Stored in Cloud Storage at
// documents/{ownerId}/{propertyId}/{uuid}.{ext}; the firestore doc holds the
// metadata + the firebasestorage download URL keyed by a per-object token.
// Created via the 3-step signed-URL gateway (upload-url → PUT → finalize),
// gated on the owner-plan privilege `documents.upload`.
export interface DocumentRecord {
  id: string;
  ownerId: string;
  // Stable portfolio this record belongs to (Portfolio.id — survives an owner
  // transfer, unlike ownerId). Stamped on creation; legacy rows backfilled by
  // script/stampPortfolioIds.ts.
  portfolioId?: string;
  propertyId: string;
  name: string; // user-facing display name (typically the original filename)
  contentType: string;
  size: number; // bytes
  storagePath: string; // path inside the GCS bucket
  downloadURL: string; // firebasestorage URL keyed by per-object download token
  createdAt: string;
  // Optional tenant association. When the owner attaches a document to a
  // specific tenant (e.g. lease PDF, move-in inventory), this stores the
  // User.id. The /api/owner/documents/finalize endpoint emits a push to
  // that user under the `documents` category when set. Cleared to `null`
  // by the end-tenancy handler (portfolio.ts) so an ex-tenant association
  // is severed when their tenancy ends.
  tenantId?: string | null;
}

// Audit trail entry written every time a platform admin changes roles,
// platformRole, or status on a user other than themselves via PATCH
// /api/admin/users/:id. Self-edits (contact info on your own profile)
// don't generate audit rows. Same pattern as ImpersonationLog —
// server-side writes via Admin SDK; client reads not currently exposed.
export interface UserAuditEntry {
  id: string;
  actorUid: string;
  actorEmail: string;
  targetUid: string;
  targetEmail: string;
  // Before/after snapshots for each field that actually changed. Undefined
  // when the field wasn't touched. `null` is used to encode "field was
  // cleared" (relevant for platformRole demotion).
  beforeRoles?: string[];
  afterRoles?: string[];
  beforePlatformRole?: string | null;
  afterPlatformRole?: string | null;
  beforeStatus?: string;
  afterStatus?: string;
  // Set for self-initiated credential-lifecycle events (add/remove password,
  // connect/disconnect Google, request email change) written by
  // POST /api/auth/account-event. Mutually exclusive in practice with the
  // before/after role/status diffs, which come from admin-driven changes.
  action?: string;
  createdAt: string;
}

// Subcollection under emailCampaigns/{id}: per-recipient delivery status.
export const SUBCOL_EMAIL_RECIPIENTS = "recipients" as const;

// Single-doc path for the role privilege matrix. Read by all signed-in users
// (drives client-side gates) and written by admins in /admin/settings.
export const CONFIG_DOC_PRIVILEGES = "privileges" as const;

// Single-doc path for the compliance documents. Read publicly — legal pages
// are linked from signup and OAuth consent screens, before sign-in. Written
// by admins in /admin/compliance.
//
// The set covers the surface required for a Cyprus-based property
// management SaaS operating in the EU: platform terms, privacy/GDPR
// notices, persona-specific terms (owner/tenant), data processor agreement,
// subprocessors list, cookie + ePrivacy notice, payments + consumer
// withdrawal rights, AML/KYC, AI transparency (EU AI Act), DSA
// notice-and-action, accessibility (EAA), security, IP, community rules,
// and complaints/ODR.
export const CONFIG_DOC_COMPLIANCE = "compliance" as const;

export type ComplianceDocKey =
  | "terms"
  | "privacy"
  | "gdpr"
  | "owner-terms"
  | "tenant-terms"
  | "cookies"
  | "aup"
  | "dpa"
  | "subprocessors"
  | "ai-terms"
  | "payments-terms"
  | "aml-kyc"
  | "community-guidelines"
  | "notice-takedown"
  | "complaints"
  | "accessibility"
  | "security"
  | "ip-policy";

export interface ComplianceDocs {
  terms: string;
  privacy: string;
  gdpr: string;
  "owner-terms": string;
  "tenant-terms": string;
  cookies: string;
  aup: string;
  dpa: string;
  subprocessors: string;
  "ai-terms": string;
  "payments-terms": string;
  "aml-kyc": string;
  "community-guidelines": string;
  "notice-takedown": string;
  complaints: string;
  accessibility: string;
  security: string;
  "ip-policy": string;
  updatedAt?: string;
  updatedBy?: string;
}

// Stable display order + grouping for admin editor and public hub.
// Grouped so 18 docs stay browsable. Keep in sync with ComplianceDocKey.
export const COMPLIANCE_DOC_GROUPS: ReadonlyArray<{
  group: string;
  docs: ReadonlyArray<{ key: ComplianceDocKey; label: string }>;
}> = [
  {
    group: "Core",
    docs: [
      { key: "terms", label: "Terms of Use" },
      { key: "privacy", label: "Privacy Policy" },
      { key: "cookies", label: "Cookie Policy" },
      { key: "aup", label: "Acceptable Use Policy" },
    ],
  },
  {
    group: "Persona Terms",
    docs: [
      { key: "owner-terms", label: "Owner Terms" },
      { key: "tenant-terms", label: "Tenant Terms" },
    ],
  },
  {
    group: "Data Protection",
    docs: [
      { key: "gdpr", label: "GDPR Notice" },
      { key: "dpa", label: "Data Processing Agreement" },
      { key: "subprocessors", label: "Subprocessors" },
      { key: "security", label: "Security & Incidents" },
    ],
  },
  {
    group: "Payments",
    docs: [
      { key: "payments-terms", label: "Payments & Refunds" },
      { key: "aml-kyc", label: "AML / KYC" },
    ],
  },
  {
    group: "AI",
    docs: [{ key: "ai-terms", label: "AI (AskOlio)" }],
  },
  {
    group: "Trust & Safety",
    docs: [
      { key: "community-guidelines", label: "Community Guidelines" },
      { key: "notice-takedown", label: "Illegal Content / Takedown" },
      { key: "ip-policy", label: "Intellectual Property" },
    ],
  },
  {
    group: "Rights & Access",
    docs: [
      { key: "complaints", label: "Complaints & ODR" },
      { key: "accessibility", label: "Accessibility" },
    ],
  },
];

// Single-doc path for the platform-fee table — admin sets the commission %
// (and optional minimum) per owner-subscription plan. Read by the tenant
// payment checkout to compute `application_fee_amount`. Admin-only writes
// via PUT /api/admin/platform-fees.
export const CONFIG_DOC_PLATFORM_FEES = "platformFees" as const;

// Lowercase plan keys match the Stripe Payments extension's `stripeRole`
// custom claim. The first three are wired to Stripe products
// (firebaseRole = advance | pro). "business" is sales-led — no Stripe
// product; granted as a comp-plan or by an admin. Display names + per-plan
// descriptions live in `config/planLabels` (admin-editable, realtime).
export type OwnerPlanKey = "basic" | "advance" | "pro" | "business";

// Admin-editable display surface for the four owner plans. The keys remain
// the internal `OwnerPlanKey` values; only what users see on the pricing
// modal and landing pricing section is editable here. Realtime via
// onSnapshot — both /app and /landing subscribe to this doc so admin
// edits propagate without a redeploy.
export const CONFIG_DOC_PLAN_LABELS = "planLabels" as const;

export interface PlanLabel {
  label: string;
  description: string;
  // Cap on units across the owner's portfolio. `null` = unlimited.
  // Enforced at /api/properties/:id/units POST and surfaced to UI.
  unitCap: number | null;
  // Yearly price in major units (EUR). For "basic" → 0. For "business" →
  // null (custom quote, no Stripe product). FIXED in code — NOT admin-
  // editable: every reader of config/planLabels overlays the canonical value
  // from DEFAULT_PLAN_LABELS via `withFixedPlanPrices()`, so a stored override
  // can never change what owners see or are charged. To change a price, edit
  // DEFAULT_PLAN_LABELS below and redeploy.
  yearlyAmount: number | null;
  // Free-form CTA copy for the pricing UI's primary button. Falls back to
  // "Get started" when blank.
  ctaLabel?: string;
}

// Discounted first-cycle price (EUR, major units) charged when a PAYING Growth
// owner upgrades to Pro. They forfeit unused Growth time and get a fresh
// 12-month Pro term for this amount; renewals bill the normal Pro yearlyAmount.
// Realised as a one-time Stripe coupon of (proPrice − this) on the standard Pro
// price — see server/services/planBilling.ts. FIXED in code — NOT admin-
// editable: readers overlay this canonical value via `withFixedPlanPrices()`.
export const DEFAULT_PRO_UPGRADE_FIRST_CYCLE_EUR = 200;

export interface PlanLabelsConfig {
  plans: Record<OwnerPlanKey, PlanLabel>;
  // Discounted first-cycle price (EUR major units) for a PAID Growth→Pro
  // upgrade. null = no intro discount (charge the full Pro price). FIXED in
  // code (overlaid via `withFixedPlanPrices()`); realised as a one-time Stripe
  // coupon at upgrade time.
  proUpgradeFirstCycleAmount: number | null;
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_PLAN_LABELS: PlanLabelsConfig = {
  plans: {
    basic: {
      label: "Starter",
      description: "Organise your properties",
      unitCap: 2,
      yearlyAmount: 0,
      ctaLabel: "Get started free",
    },
    advance: {
      label: "Growth",
      description: "Start managing rentals",
      unitCap: 5,
      yearlyAmount: 69,
      ctaLabel: "Start Growth",
    },
    pro: {
      label: "Pro",
      description: "Automate and scale",
      unitCap: 20,
      yearlyAmount: 290,
      ctaLabel: "Go Pro",
    },
    business: {
      label: "Business",
      description: "Advanced management",
      unitCap: null,
      yearlyAmount: null,
      ctaLabel: "Contact sales",
    },
  },
  proUpgradeFirstCycleAmount: DEFAULT_PRO_UPGRADE_FIRST_CYCLE_EUR,
};

// Owner-plan PRICES are fixed in code, NOT admin-editable: each plan's
// `yearlyAmount` and the single `proUpgradeFirstCycleAmount`. Admins may still
// edit names, descriptions, unit caps and rent commission. Every reader of
// config/planLabels (app, landing, server) passes the merged config through
// this overlay so the canonical prices from DEFAULT_PLAN_LABELS always win —
// a stale or hand-edited Firestore override can never change what owners are
// shown or charged. DEFAULT_PLAN_LABELS is the single source of truth: change
// a price there and redeploy.
export function withFixedPlanPrices(config: PlanLabelsConfig): PlanLabelsConfig {
  const plans = { ...config.plans };
  (Object.keys(plans) as OwnerPlanKey[]).forEach((key) => {
    const fixed = DEFAULT_PLAN_LABELS.plans[key];
    if (!fixed) return;
    plans[key] = { ...plans[key], yearlyAmount: fixed.yearlyAmount };
  });
  return {
    ...config,
    plans,
    proUpgradeFirstCycleAmount: DEFAULT_PLAN_LABELS.proUpgradeFirstCycleAmount,
  };
}

export interface RentCommissionTier {
  // Whole-number percent applied to gross. 0 / undefined → no percent.
  percent?: number;
  // Minimum fee in cents. Applied if percent*gross would fall below it.
  minAmountCents?: number;
}

export interface PlatformFeesConfig {
  rentCommission: Record<OwnerPlanKey, RentCommissionTier>;
  updatedAt?: string;
  updatedBy?: string;
}

// Used (a) when the doc doesn't exist yet, and (b) as the "Reset to defaults"
// target in the admin UI. Default is 0% across the board so we never
// silently start charging until an admin explicitly turns it on.
export const DEFAULT_PLATFORM_FEES_CONFIG: PlatformFeesConfig = {
  rentCommission: {
    basic: { percent: 0, minAmountCents: 0 },
    advance: { percent: 0, minAmountCents: 0 },
    pro: { percent: 0, minAmountCents: 0 },
    business: { percent: 0, minAmountCents: 0 },
  },
};

// Single-doc path for global system flags (currently: maintenance mode).
// Public read so the app shell can subscribe via onSnapshot and lock the
// UI without a round-trip; writes happen through PUT /api/system-config
// (superadmin-only). When maintenanceMode.enabled is true, the user app
// renders <MaintenanceScreen> for everyone except superadmins, and the
// Express API returns 503 for non-superadmin requests.
export const CONFIG_DOC_SYSTEM = "system" as const;

export interface MaintenanceMode {
  enabled: boolean;
  // Optional copy shown on the maintenance screen. Falls back to a default
  // when empty.
  message?: string;
  startedAt?: string;
  startedBy?: string;
}

export interface SystemConfig {
  maintenanceMode: MaintenanceMode;
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  maintenanceMode: {
    enabled: false,
  },
};

// Single-doc path for runtime feature kill-switches. SERVER-READ ONLY — NOT in
// the client-read allowlist in firestore.rules; the server enforces the flags,
// the client never reads this doc. A superadmin toggles them via
// PUT /api/feature-flags (or by editing the doc in the Firestore console); the
// change takes effect within the 30s config-cache TTL with NO deploy. This is
// the "stop the bleeding" lever for the money/abuse paths (see the incident
// runbook in SECURITY.md). Each flag defaults to ENABLED — a missing flag (or a
// whole missing doc) reads as on; set a flag to false to KILL that capability.
export const CONFIG_DOC_FEATURE_FLAGS = "featureFlags" as const;

export const FEATURE_FLAGS = [
  "rentCheckout", // tenant card rent payments via Stripe Checkout
  "connectOnboarding", // owner Stripe Connect onboarding-link creation
  "planUpgrades", // owner plan upgrade / checkout
  "askOlio", // the AskOlio AI assistant
  "rentIndexation", // the daily automatic rent-increase sweep (cron)
] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export interface FeatureFlagsConfig {
  flags: Record<FeatureFlag, boolean>;
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_FEATURE_FLAGS_CONFIG: FeatureFlagsConfig = {
  flags: {
    rentCheckout: true,
    connectOnboarding: true,
    planUpgrades: true,
    askOlio: true,
    rentIndexation: true,
  },
};

// Single-doc path for the social-media link table. Read publicly so the
// landing footer can render without auth; written by admins in
// /admin/social-media. Both the landing footer and the app sidebar
// subscribe via onSnapshot so admin edits propagate instantly.
export const CONFIG_DOC_SOCIAL = "social" as const;

export type SocialPlatformKey =
  | "instagram"
  | "facebook"
  | "x"
  | "linkedin"
  | "youtube"
  | "tiktok"
  | "pinterest"
  | "snapchat"
  | "whatsapp"
  | "threads"
  | "telegram";

export const SOCIAL_PLATFORM_KEYS: readonly SocialPlatformKey[] = [
  "instagram",
  "facebook",
  "x",
  "linkedin",
  "youtube",
  "tiktok",
  "pinterest",
  "snapchat",
  "whatsapp",
  "threads",
  "telegram",
] as const;

export interface SocialPlatformMeta {
  key: SocialPlatformKey;
  label: string;
  placeholder: string;
}

export const SOCIAL_PLATFORM_META: Record<SocialPlatformKey, SocialPlatformMeta> = {
  instagram: {
    key: "instagram",
    label: "Instagram",
    placeholder: "https://instagram.com/yourpage",
  },
  facebook: { key: "facebook", label: "Facebook", placeholder: "https://facebook.com/yourpage" },
  x: { key: "x", label: "X (Twitter)", placeholder: "https://x.com/yourhandle" },
  linkedin: {
    key: "linkedin",
    label: "LinkedIn",
    placeholder: "https://linkedin.com/company/yourcompany",
  },
  youtube: { key: "youtube", label: "YouTube", placeholder: "https://youtube.com/@yourchannel" },
  tiktok: { key: "tiktok", label: "TikTok", placeholder: "https://tiktok.com/@yourhandle" },
  pinterest: {
    key: "pinterest",
    label: "Pinterest",
    placeholder: "https://pinterest.com/yourprofile",
  },
  snapchat: {
    key: "snapchat",
    label: "Snapchat",
    placeholder: "https://snapchat.com/add/yourusername",
  },
  whatsapp: {
    key: "whatsapp",
    label: "WhatsApp",
    placeholder: "+39 333 123 4567 or https://wa.me/…",
  },
  threads: { key: "threads", label: "Threads", placeholder: "https://threads.net/@yourhandle" },
  telegram: { key: "telegram", label: "Telegram", placeholder: "@yourchannel or https://t.me/…" },
};

export type SocialLinkMap = Record<SocialPlatformKey, string>;

export interface SocialLinks extends SocialLinkMap {
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_SOCIAL_LINKS: SocialLinkMap = {
  instagram: "",
  facebook: "",
  x: "",
  linkedin: "",
  youtube: "",
  tiktok: "",
  pinterest: "",
  snapchat: "",
  whatsapp: "",
  threads: "",
  telegram: "",
};

// Single-doc path for the SuperAdminDashboard banner carousel selection.
// Stores which of the available banner images should be cycled. Shared
// across all admins / devices so toggling in /admin/settings affects every
// admin's dashboard immediately.
export const CONFIG_DOC_BANNERS = "banners" as const;

// Canonical list of available banner images. Adding a new banner = drop the
// file in /public and append the path here. The selection at runtime is
// whichever of these the admin has enabled.
export const BANNER_IMAGE_OPTIONS = [
  { src: "/banner-key.jpg", label: "Golden Key" },
  { src: "/banner-skyline.jpg", label: "City Skyline" },
  { src: "/banner-towers.jpg", label: "Glass Towers" },
] as const;

export const ALL_BANNER_SRCS: readonly string[] = BANNER_IMAGE_OPTIONS.map((b) => b.src);

export interface BannerSelection {
  // Subset of ALL_BANNER_SRCS the admin has enabled. Order is preserved so the
  // carousel cycles in the same order the admin saw in settings.
  enabled: string[];
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_BANNER_SELECTION: BannerSelection = {
  enabled: [...ALL_BANNER_SRCS],
};

// Normalize raw admin input into the canonical URL we store. Empty stays
// empty (= "delete"). WhatsApp & Telegram also accept a bare phone number
// or @handle for convenience; other platforms pass through trimmed.
export function normalizeSocialInput(key: SocialPlatformKey, raw: string): string {
  // Cap length first to bound the work + the persisted doc size.
  const v = raw.trim().slice(0, 500);
  if (!v) return "";
  if (key === "whatsapp") {
    if (/^https?:\/\//i.test(v)) return v;
    const digits = v.replace(/\D+/g, "");
    return digits ? `https://wa.me/${digits}` : "";
  }
  if (key === "telegram") {
    if (/^https?:\/\//i.test(v)) return v;
    const handle = v.replace(/^@+/, "");
    return handle ? `https://t.me/${handle}` : "";
  }
  // Every other platform expects a full URL. Reject anything that's not
  // http(s) — otherwise a malicious admin saving `javascript:alert(1)`
  // as their Facebook link would XSS every landing-page visitor (the
  // footer renders these as <a href={...}>).
  return /^https?:\/\//i.test(v) ? v : "";
}

export type Role = "tenant" | "owner" | "admin" | "superadmin";

// ──────────────────────────────────────────────────────────────────────────
// Role privilege matrix
//
// Three parallel matrices, all stored in a single Firestore doc at
// `config/privileges`:
//   • portfolio — what each property-level role (Owner / Legacy Owner /
//     Legal / Financial / Tenant) can do inside a portfolio.
//   • platform — what each platform-level role (Admin / Manager / …) can
//     do inside the admin panel.
//   • ownerPlan — what each owner subscription plan (Basic / Advance / PRO)
//     unlocks for the owner (drives feature gates the app currently checks
//     via `usePlan()`).
//
// The CATALOG below (privilege keys + labels + categories) is hardcoded.
// Firestore stores only the boolean grants. To add a new privilege, add it
// here and update the gates that consult `usePrivileges()`.
// ──────────────────────────────────────────────────────────────────────────

export type PortfolioRoleKey = "owner" | "legacyOwner" | "legal" | "financial" | "tenant";

export type PlatformRoleKey =
  "admin" | "manager" | "legal" | "financial" | "support" | "sales" | "marketing";

export type PortfolioPrivilegeKey =
  | "property.view"
  | "property.edit"
  | "property.units.manage"
  | "property.transferOwnership"
  | "property.delete"
  | "tenant.view"
  | "tenant.manage"
  | "finance.viewHistory"
  | "finance.recordPayment"
  | "finance.manageBanking"
  | "agreement.view"
  | "agreement.edit"
  | "agreement.terminate"
  | "analytics.viewProperty"
  | "analytics.viewPortfolio"
  | "analytics.export"
  | "access.invite"
  | "access.manageRoles"
  | "activity.view";

export type PlatformPrivilegeKey =
  | "users.viewAll"
  | "users.manage"
  | "users.suspend"
  | "users.assignRoles"
  | "platform.viewSettings"
  | "platform.modifySettings"
  | "platform.maintenance"
  | "platform.branding"
  | "finance.viewAll"
  | "finance.reports"
  | "legal.viewAll"
  | "legal.compliance"
  | "comm.email"
  | "comm.activityLog"
  | "comm.partners"
  | "properties.viewAll"
  | "properties.editAny"
  | "properties.delete";

// Feature toggles for owner subscription plans. Each key represents one
// capability that the app gates per-plan; the matrix says which plans grant
// it. Read by `useCanOwnerPlan()` and consulted by the existing `usePlan()`
// callsites instead of hardcoded `plan === 'basic'` checks.
export type OwnerPlanPrivilegeKey =
  | "properties.add"
  | "units.unlimited"
  | "tenants.invite"
  | "rent.tracking"
  | "rent.collectStripe"
  | "rent.autoIndex"
  | "notifications.tenant"
  | "notifications.rentReminders"
  | "analytics.basic"
  | "analytics.advanced"
  | "network.access"
  | "analytics.history"
  | "documents.upload"
  | "contracts.create"
  | "briefing.property"
  | "briefing.portfolio"
  | "askOlio.access"
  | "calculator.access"
  | "marketplace.list";

export const PORTFOLIO_ROLES: readonly PortfolioRoleKey[] = [
  "owner",
  "legacyOwner",
  "legal",
  "financial",
  "tenant",
] as const;

export const PLATFORM_ROLES: readonly PlatformRoleKey[] = [
  "admin",
  "manager",
  "legal",
  "financial",
  "support",
  "sales",
  "marketing",
] as const;

export const OWNER_PLANS: readonly OwnerPlanKey[] = [
  "basic",
  "advance",
  "pro",
  "business",
] as const;

export interface PrivilegeCatalogEntry<K extends string> {
  key: K;
  label: string;
}

export interface PrivilegeCategory<K extends string> {
  category: string;
  privileges: PrivilegeCatalogEntry<K>[];
}

export const PORTFOLIO_PRIVILEGE_CATALOG: PrivilegeCategory<PortfolioPrivilegeKey>[] = [
  {
    category: "Property Management",
    privileges: [
      { key: "property.view", label: "View property details" },
      { key: "property.edit", label: "Edit property information" },
      { key: "property.units.manage", label: "Add / remove units" },
      { key: "property.transferOwnership", label: "Transfer property ownership" },
      { key: "property.delete", label: "Delete property" },
    ],
  },
  {
    category: "Tenant Management",
    privileges: [
      { key: "tenant.view", label: "View tenant list" },
      { key: "tenant.manage", label: "Add / remove tenants" },
    ],
  },
  {
    category: "Financial",
    privileges: [
      { key: "finance.viewHistory", label: "View rent & payment history" },
      { key: "finance.recordPayment", label: "Record / process payments" },
      { key: "finance.manageBanking", label: "Manage banking (IBAN & Stripe payouts)" },
    ],
  },
  {
    category: "Legal & Agreements",
    privileges: [
      { key: "agreement.view", label: "View agreements" },
      { key: "agreement.edit", label: "Create / edit agreements" },
      { key: "agreement.terminate", label: "Terminate agreements" },
    ],
  },
  {
    category: "Analytics & Insights",
    privileges: [
      { key: "analytics.viewProperty", label: "View property analytics" },
      { key: "analytics.viewPortfolio", label: "View portfolio overview" },
      { key: "analytics.export", label: "Export data" },
    ],
  },
  {
    category: "Access & Permissions",
    privileges: [
      { key: "access.invite", label: "Invite users to property" },
      { key: "access.manageRoles", label: "Manage role assignments" },
      { key: "activity.view", label: "View activity log" },
    ],
  },
];

export const OWNER_PLAN_PRIVILEGE_CATALOG: PrivilegeCategory<OwnerPlanPrivilegeKey>[] = [
  {
    category: "Properties & Units",
    privileges: [
      { key: "properties.add", label: "Add properties" },
      { key: "units.unlimited", label: "Unlimited units (overrides unit cap)" },
    ],
  },
  {
    category: "Tenants & Rent",
    privileges: [
      { key: "tenants.invite", label: "Invite tenants" },
      { key: "rent.tracking", label: "Rent tracking" },
      { key: "rent.collectStripe", label: "Collect rent (Stripe)" },
      { key: "rent.autoIndex", label: "Automatic rent increases (indexation)" },
      { key: "notifications.tenant", label: "Notifications to tenant" },
      { key: "notifications.rentReminders", label: "Rent reminders to tenant" },
    ],
  },
  {
    category: "Analytics & Insights",
    privileges: [
      { key: "analytics.basic", label: "Analytics" },
      { key: "analytics.advanced", label: "Advanced analytics" },
      { key: "network.access", label: "Real Estate Network" },
      { key: "analytics.history", label: "Property History" },
    ],
  },
  {
    category: "Documents & Briefings",
    privileges: [
      { key: "documents.upload", label: "Documents" },
      { key: "contracts.create", label: "Agreements" },
      { key: "briefing.property", label: "Property Briefing" },
      { key: "briefing.portfolio", label: "Portfolio Briefing" },
      { key: "askOlio.access", label: "AI + PDF Analysis" },
    ],
  },
  {
    category: "Tools",
    privileges: [
      { key: "calculator.access", label: "Smart Calculator" },
      { key: "marketplace.list", label: "Marketplace listings" },
    ],
  },
];

export const PLATFORM_PRIVILEGE_CATALOG: PrivilegeCategory<PlatformPrivilegeKey>[] = [
  {
    category: "User Management",
    privileges: [
      { key: "users.viewAll", label: "View all users" },
      { key: "users.manage", label: "Create / edit users" },
      { key: "users.suspend", label: "Suspend / deactivate users" },
      { key: "users.assignRoles", label: "Assign user roles" },
    ],
  },
  {
    category: "Platform Settings",
    privileges: [
      { key: "platform.viewSettings", label: "View platform settings" },
      { key: "platform.modifySettings", label: "Modify platform settings" },
      { key: "platform.maintenance", label: "Enable / disable maintenance mode" },
      { key: "platform.branding", label: "Manage platform branding" },
    ],
  },
  {
    category: "Financial Operations",
    privileges: [
      { key: "finance.viewAll", label: "View all transactions" },
      { key: "finance.reports", label: "Generate financial reports" },
    ],
  },
  {
    category: "Legal & Compliance",
    privileges: [
      { key: "legal.viewAll", label: "View all agreements" },
      { key: "legal.compliance", label: "Manage compliance settings" },
    ],
  },
  {
    category: "Content & Communication",
    privileges: [
      { key: "comm.email", label: "Manage email marketing" },
      { key: "comm.activityLog", label: "View activity log" },
      { key: "comm.partners", label: "Manage partner listings" },
    ],
  },
  {
    category: "Property & Unit Oversight",
    privileges: [
      { key: "properties.viewAll", label: "View all properties" },
      { key: "properties.editAny", label: "Edit any property" },
      { key: "properties.delete", label: "Delete properties" },
    ],
  },
];

export type PortfolioGrants = Record<PortfolioPrivilegeKey, Record<PortfolioRoleKey, boolean>>;

// Cells in the portfolio matrix that are force-ON and can't be toggled off in
// the admin UI. The owner is the portfolio's original/admin owner and must
// always be able to manage its banking — the server already guarantees this
// (authorizePortfolioRead short-circuits isSelf); this just reflects it in the
// matrix so an admin can't appear to disable it. role → list of locked privileges.
export const PORTFOLIO_PRIVILEGE_LOCKS: Partial<Record<PortfolioRoleKey, PortfolioPrivilegeKey[]>> =
  {
    owner: ["finance.manageBanking"],
  };
export type PlatformGrants = Record<PlatformPrivilegeKey, Record<PlatformRoleKey, boolean>>;
export type OwnerPlanGrants = Record<OwnerPlanPrivilegeKey, Record<OwnerPlanKey, boolean>>;

export interface PrivilegesConfig {
  portfolio: PortfolioGrants;
  platform: PlatformGrants;
  ownerPlan: OwnerPlanGrants;
  // ISO 8601 — set on every PUT.
  updatedAt?: string;
  // User.id of the admin who last saved.
  updatedBy?: string;
}

// Defaults match the matrix shipped in AdminSettingsPage prior to wiring.
// Used (a) as the response when the config doc doesn't exist yet, and
// (b) as the "Reset to Defaults" target.
export const DEFAULT_PORTFOLIO_GRANTS: PortfolioGrants = {
  "property.view": { owner: true, legacyOwner: true, legal: true, financial: true, tenant: true },
  "property.edit": {
    owner: true,
    legacyOwner: false,
    legal: false,
    financial: false,
    tenant: false,
  },
  "property.units.manage": {
    owner: true,
    legacyOwner: false,
    legal: false,
    financial: false,
    tenant: false,
  },
  "property.transferOwnership": {
    owner: true,
    legacyOwner: false,
    legal: true,
    financial: false,
    tenant: false,
  },
  "property.delete": {
    owner: true,
    legacyOwner: false,
    legal: false,
    financial: false,
    tenant: false,
  },
  "tenant.view": { owner: true, legacyOwner: true, legal: true, financial: true, tenant: false },
  "tenant.manage": {
    owner: true,
    legacyOwner: false,
    legal: false,
    financial: false,
    tenant: false,
  },
  "finance.viewHistory": {
    owner: true,
    legacyOwner: true,
    legal: false,
    financial: true,
    tenant: true,
  },
  "finance.recordPayment": {
    owner: true,
    legacyOwner: false,
    legal: false,
    financial: true,
    tenant: false,
  },
  // Edit the portfolio's banking (IBAN + Stripe Connect). Owner is always
  // allowed regardless of this row (authorizePortfolioRead short-circuits
  // isSelf, and the matrix UI locks the owner cell on — see
  // PORTFOLIO_PRIVILEGE_LOCKS). The financial contact is on by default; an
  // admin can toggle it per role in the realtime privileges matrix.
  "finance.manageBanking": {
    owner: true,
    legacyOwner: false,
    legal: false,
    financial: true,
    tenant: false,
  },
  "agreement.view": { owner: true, legacyOwner: true, legal: true, financial: false, tenant: true },
  "agreement.edit": {
    owner: true,
    legacyOwner: false,
    legal: true,
    financial: false,
    tenant: false,
  },
  "agreement.terminate": {
    owner: true,
    legacyOwner: false,
    legal: true,
    financial: false,
    tenant: false,
  },
  "analytics.viewProperty": {
    owner: true,
    legacyOwner: true,
    legal: false,
    financial: true,
    tenant: false,
  },
  "analytics.viewPortfolio": {
    owner: true,
    legacyOwner: true,
    legal: false,
    financial: true,
    tenant: false,
  },
  "analytics.export": {
    owner: true,
    legacyOwner: false,
    legal: true,
    financial: true,
    tenant: false,
  },
  "access.invite": {
    owner: true,
    legacyOwner: false,
    legal: false,
    financial: false,
    tenant: false,
  },
  "access.manageRoles": {
    owner: true,
    legacyOwner: false,
    legal: false,
    financial: false,
    tenant: false,
  },
  "activity.view": { owner: true, legacyOwner: true, legal: true, financial: true, tenant: false },
};

export const DEFAULT_PLATFORM_GRANTS: PlatformGrants = {
  "users.viewAll": {
    admin: true,
    manager: true,
    legal: false,
    financial: false,
    support: true,
    sales: true,
    marketing: false,
  },
  "users.manage": {
    admin: true,
    manager: true,
    legal: false,
    financial: false,
    support: false,
    sales: false,
    marketing: false,
  },
  "users.suspend": {
    admin: true,
    manager: false,
    legal: false,
    financial: false,
    support: false,
    sales: false,
    marketing: false,
  },
  "users.assignRoles": {
    admin: true,
    manager: false,
    legal: false,
    financial: false,
    support: false,
    sales: false,
    marketing: false,
  },
  "platform.viewSettings": {
    admin: true,
    manager: true,
    legal: true,
    financial: true,
    support: false,
    sales: false,
    marketing: false,
  },
  "platform.modifySettings": {
    admin: true,
    manager: false,
    legal: false,
    financial: false,
    support: false,
    sales: false,
    marketing: false,
  },
  "platform.maintenance": {
    admin: true,
    manager: false,
    legal: false,
    financial: false,
    support: false,
    sales: false,
    marketing: false,
  },
  "platform.branding": {
    admin: true,
    manager: true,
    legal: false,
    financial: false,
    support: false,
    sales: false,
    marketing: true,
  },
  "finance.viewAll": {
    admin: true,
    manager: true,
    legal: false,
    financial: true,
    support: false,
    sales: false,
    marketing: false,
  },
  "finance.reports": {
    admin: true,
    manager: false,
    legal: false,
    financial: true,
    support: false,
    sales: false,
    marketing: false,
  },
  "legal.viewAll": {
    admin: true,
    manager: true,
    legal: true,
    financial: false,
    support: false,
    sales: false,
    marketing: false,
  },
  "legal.compliance": {
    admin: true,
    manager: false,
    legal: true,
    financial: false,
    support: false,
    sales: false,
    marketing: false,
  },
  "comm.email": {
    admin: true,
    manager: true,
    legal: false,
    financial: false,
    support: false,
    sales: false,
    marketing: true,
  },
  "comm.activityLog": {
    admin: true,
    manager: true,
    legal: true,
    financial: true,
    support: true,
    sales: false,
    marketing: false,
  },
  "comm.partners": {
    admin: true,
    manager: true,
    legal: false,
    financial: false,
    support: false,
    sales: true,
    marketing: false,
  },
  "properties.viewAll": {
    admin: true,
    manager: true,
    legal: true,
    financial: true,
    support: true,
    sales: true,
    marketing: false,
  },
  "properties.editAny": {
    admin: true,
    manager: true,
    legal: false,
    financial: false,
    support: false,
    sales: false,
    marketing: false,
  },
  "properties.delete": {
    admin: true,
    manager: false,
    legal: false,
    financial: false,
    support: false,
    sales: false,
    marketing: false,
  },
};

// Defaults mirror the new four-tier matrix:
//   Starter  (basic)    — light onboarding tier (units cap = 2)
//   Growth   (advance)  — adds tenants/rent/docs/agreements (units cap = 5)
//   Pro      (pro)      — full feature set (units cap = 20)
//   Business (business) — Pro features + unlimited units (sales-led)
export const DEFAULT_OWNER_PLAN_GRANTS: OwnerPlanGrants = {
  "properties.add": { basic: true, advance: true, pro: true, business: true },
  "units.unlimited": { basic: false, advance: false, pro: false, business: true },
  "tenants.invite": { basic: false, advance: true, pro: true, business: true },
  "rent.tracking": { basic: false, advance: true, pro: true, business: true },
  "rent.collectStripe": { basic: false, advance: true, pro: true, business: true },
  "rent.autoIndex": { basic: false, advance: true, pro: true, business: true },
  "notifications.tenant": { basic: false, advance: true, pro: true, business: true },
  "notifications.rentReminders": { basic: false, advance: true, pro: true, business: true },
  "analytics.basic": { basic: false, advance: true, pro: true, business: true },
  "analytics.advanced": { basic: false, advance: false, pro: true, business: true },
  "network.access": { basic: true, advance: true, pro: true, business: true },
  "analytics.history": { basic: true, advance: true, pro: true, business: true },
  "documents.upload": { basic: false, advance: true, pro: true, business: true },
  "contracts.create": { basic: false, advance: true, pro: true, business: true },
  "briefing.property": { basic: false, advance: true, pro: true, business: true },
  "briefing.portfolio": { basic: false, advance: true, pro: true, business: true },
  "askOlio.access": { basic: false, advance: true, pro: true, business: true },
  "calculator.access": { basic: true, advance: true, pro: true, business: true },
  "marketplace.list": { basic: false, advance: true, pro: true, business: true },
};

export const DEFAULT_PRIVILEGES_CONFIG: PrivilegesConfig = {
  portfolio: DEFAULT_PORTFOLIO_GRANTS,
  platform: DEFAULT_PLATFORM_GRANTS,
  ownerPlan: DEFAULT_OWNER_PLAN_GRANTS,
};

export type UserStatus = "active" | "suspended" | "invited" | "pending";

export type Plan = OwnerPlanKey;

// The current plan is derived from the Stripe Payments extension at read time —
// either from the `stripeRole` custom claim on the Firebase Auth token, or by
// reading the active doc in `customers/{uid}/subscriptions`. Use the `usePlan()`
// hook in client code. The `User` document does not store plan — it is fully
// owned by Stripe.

// Push notification preferences. `pushEnabled` is the master toggle; the
// per-category flags only take effect when the master is on. Reads as `true`
// (opt-out by default) when a key is missing — see notificationPrefDefault().
export interface NotificationPrefs {
  pushEnabled?: boolean;
  // Per-category opt-outs (missing key => opted-in). Annotated with the
  // persona(s) each category is actually pushed to today:
  rentReminders?: boolean; // tenant — rent due / overdue
  rentPayments?: boolean; // owner (rent logged/received) + tenant (owner confirmed your payment)
  propertyActivity?: boolean; // tenant (new lease, tenancy ended) + owner (lease accepted/declined, plan changes)
  messages?: boolean; // tenant + owner (chat) + tenant (Olio Support)
  maintenance?: boolean; // owner (new request) + tenant (status updates)
  documents?: boolean; // tenant — new document from landlord (owners receive none)
  // Rent-increase (indexation) notices — sent to BOTH the tenant and the owner
  // by the rent-indexation sweep: an advance heads-up before a step and a
  // confirmation when rent is bumped. Kept separate from rentReminders so a
  // tenant who mutes payment reminders still receives legally-relevant
  // increase notices.
  rentIncrease?: boolean;
  // Email opt-out for marketing campaigns sent via /admin/email-marketing.
  // Flipped to `false` by the Resend webhook handler when an unsubscribe or
  // spam-complaint event arrives, and surfaced as a user-facing toggle in
  // Settings.
  marketingEmails?: boolean;
  // Push opt-out for marketing/promotional broadcasts sent via
  // /admin/notification-marketing. Separate from `pushEnabled` (the master
  // switch covering all transactional push) so a user can keep contract-basis
  // notifications (rent due, new message) while declining promotional pushes —
  // the consent granularity the privacy policy promises. Missing => opted-in
  // (default-opt-in, matching marketingEmails); only an explicit `false` blocks.
  marketingPush?: boolean;
}

export const NOTIFICATION_PREF_KEYS: ReadonlyArray<keyof NotificationPrefs> = [
  "pushEnabled",
  "rentReminders",
  "rentPayments",
  "propertyActivity",
  "messages",
  "maintenance",
  "documents",
  "rentIncrease",
  "marketingEmails",
];

export type EntityType = "person" | "company";

// Current Terms-of-Use / Privacy-Policy version that users consent to at
// signup. A plain date tag — bump it ONLY on a MATERIAL change to those docs
// (not a typo fix). Recorded on User.consent as proof of what was accepted, and
// (once a re-consent flow exists) compared to re-prompt users after a bump.
// Shared so the client can detect a stale acceptance. Keep in step with the
// "Last updated" date on the Terms/Privacy docs in compliance-defaults.ts.
export const TERMS_VERSION = "2026-06-17" as const;

// Proof-of-consent record stored on User.consent — legal evidence of which
// Terms/Privacy version a user accepted and when. Captured server-side at
// account creation (signup is gated on the acceptance checkbox, so account
// creation IS the acceptance); IP/UA are best-effort request metadata.
export interface Consent {
  termsVersion: string;
  acceptedAt: string; // server ISO timestamp
  ip?: string;
  userAgent?: string;
  source?: "signup" | "reconsent";
}

export interface User {
  id: string; // == Firebase Auth UID
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  address?: string;
  // Whether this owner files as an individual or a legal entity. Collected via
  // PATCH /api/profile but currently has no consumer — it is NOT yet read to
  // pre-fill the Stripe Connect `business_type` (that wiring doesn't exist).
  // Collected-but-unused; kept so the value persists for when it's wired up.
  entityType?: EntityType;
  // Public URL of the user's avatar. Populated from the OAuth provider on first
  // sign-in (Google `picture` claim) and updatable via PATCH /api/profile.
  photoURL?: string;
  // Short, human-friendly identifier for this user's portfolio (e.g. "OLIO-A4F2K9").
  // Stable for the lifetime of the user — generated on first sign-in and
  // backfilled on /api/me for pre-existing users.
  portfolioId?: string;
  roles: Role[];
  // Explicit opt-in for the owner experience. New signups default to `false`
  // (tenant only). Flipped to `true` from Tenant Settings → Activate Landlord
  // View; flipped back from Owner Settings. Drives `isOwner` in the client +
  // gates the Switch-Mode button. If `undefined`, treat as legacy and fall
  // back to roles/plan so existing paid owners keep their UI.
  ownerModeEnabled?: boolean;
  // One-time post-signup role prompt. Set `true` when /api/me creates the
  // profile doc; the app shows a "tenant or property owner?" modal while this
  // is true and clears it (PATCH /api/profile { needsRoleSelection: false })
  // on any answer — including dismiss. PATCH only accepts `false`, so nothing
  // can re-arm the prompt. Absent (`undefined`) on accounts created before
  // this shipped: they never see the modal.
  needsRoleSelection?: boolean;
  // Sub-role within the admin panel (Manager / Support / Sales / …).
  // Only meaningful when `roles` includes "admin". Drives the Platform Roles
  // privilege matrix; if unset, an admin gets the "admin" column (full power).
  // "superadmin" bypasses the matrix entirely.
  platformRole?: PlatformRoleKey;
  status: UserStatus;
  joinedAt: string;
  lastLoginAt?: string;
  // Bumped by POST /api/heartbeat while the user has an open, signed-in tab on
  // app.oliowallet.com. The platform admin compares this to "now" to render the
  // green/grey online dot and a Last Seen column. Not security-critical — it's
  // a UX signal, not an entitlement.
  lastSeenAt?: string;
  // Proof-of-consent: the Terms/Privacy version accepted at signup + when (see
  // TERMS_VERSION / Consent). Set once at account creation; deleted with the
  // user on erasure. Undefined for accounts that predate this capture.
  consent?: Consent;
  // Stripe Connect Standard account for owners who accept rent via card.
  // Rent runs on direct charges: the tenant is charged on the owner's own
  // account and the owner bears chargeback liability. Set after the owner
  // finishes Connect onboarding; until then, tenants of this owner can only
  // record offline payments (cash / bank transfer / off-platform card).
  //
  // Banking (the IBAN + all Stripe Connect state) no longer lives on the user
  // — it belongs to the PORTFOLIO so it can survive an owner change and be
  // edited by an authorized financial contact. `portfolioRef` points at that
  // doc; the banking fields themselves live on `Portfolio` (see below). The
  // GET /api/me response still surfaces them (hydrated from the portfolio via
  // PortfolioBanking) so the owner's Banking screen keeps working unchanged.
  portfolioRef?: string;
  // Push notification preferences. Missing keys are treated as opted-in.
  notificationPrefs?: NotificationPrefs;
}

// The banking payload that used to live on `User`, now owned by `Portfolio`.
// Extracted so the resolver, the migration, and the /api/me read-view can all
// share one shape. Every Connect field is mirrored from `Stripe.Account` by
// `mirrorConnectAccount()` (server/services/connectMirror.ts), which both the
// account.updated webhook and the manual /refresh endpoint flow through, so
// this stays in sync with what Stripe actually has.
export interface PortfolioBanking {
  connectAccountId?: string;
  connectChargesEnabled?: boolean;
  connectPayoutsEnabled?: boolean;
  // True once the owner has submitted the Stripe-hosted onboarding form.
  // Until then, the AccountLink is the only way back into the form; after,
  // owners manage their account by signing in at dashboard.stripe.com (full
  // Stripe Dashboard — Standard accounts can't use one-time login links).
  connectDetailsSubmitted?: boolean;
  // Stripe machine codes that Stripe needs the owner to address. Currently-due
  // = next action; past-due = overdue; pending-verification = Stripe reviewing.
  // The UI maps these to friendly labels via connectRequirements.ts.
  connectRequirementsDue?: string[];
  connectRequirementsPastDue?: string[];
  connectRequirementsPendingVerification?: string[];
  // Set by Stripe when the account is restricted (e.g. "rejected.fraud").
  // null when the account resolved a prior restriction — connectMirror
  // writes the cleared state explicitly so the UI doesn't stay jammed.
  connectDisabledReason?: string | null;
  // Per-capability status. Match Stripe's enum: "active" | "pending" | "inactive" | "restricted".
  connectCardPaymentsStatus?: "active" | "pending" | "inactive" | "restricted" | null;
  connectTransfersStatus?: "active" | "pending" | "inactive" | "restricted" | null;
  // Stamped by both webhook and manual /refresh — useful for surfacing
  // "last checked X ago" in the UI.
  connectLastSyncedAt?: string;
  // Saved IBAN for owners who prefer bank transfers over Stripe Connect.
  bankDetails?: { holder: string; iban: string; swift: string };
}

// Banking container for one portfolio. Lives in COL.portfolios, keyed by a
// STABLE generated id (NOT the owner's uid) so the portfolio can later change
// owners without losing its banking. One doc per owner today; resolve it by
// `where("ownerId","==",uid)` (or, for Stripe webhooks, by connectAccountId).
// An authorized financial contact can edit it — gated by the realtime
// "finance.manageBanking" portfolio privilege (the owner is always allowed).
export interface Portfolio extends PortfolioBanking {
  // Stable doc id — independent of who owns the portfolio.
  id: string;
  // Current owner (User.id). Changes if/when ownership transfers; the doc
  // (and its banking) stays put. This is the queryable foreign key.
  ownerId: string;
  // The human-friendly label mirrored from User.portfolioId (e.g. "OLIO-A4F2K9").
  portfolioId?: string;
  createdAt: string;
  updatedAt?: string;
}

export type PropertyType = "Apartment" | "House" | "Villa" | "Commercial" | "Plot";
// "F-G" = merged low-efficiency class; "N/A" = rating unknown. Legacy "A+"/"F"/"G"
// remain valid so previously-saved properties still type-check and display.
export type EnergyClass = "A+" | "A" | "B" | "C" | "D" | "E" | "F" | "G" | "F-G" | "N/A";
export type OwnershipType = "individual" | "company";
export type TitleDeedsStatus = "issued" | "pending";
export type DevelopmentStatus = "off_plan" | "under_construction" | "fully_developed";
// How the owner uses the property. "owner_occupied" = they live in it
// themselves (mutually exclusive with renting it out / holding it). It used to
// live on OccupancyStatus below; that legacy value is still read for back-compat
// and the Edit drawer migrates it up to this use on the next save.
export type PropertyUse = "hold" | "rent" | "owner_occupied";
// Owner-declared current occupancy. Distinct from the auto-derived
// `occupied` boolean (which is computed from whether a unit has a tenant):
// this is what the owner states during onboarding. "owner_occupied" is retained
// only for legacy docs — new properties express owner-occupancy via PropertyUse
// above, so the live UI only offers "rented" / "vacant" here.
export type OccupancyStatus = "rented" | "vacant" | "owner_occupied";

export interface Property {
  id: string;
  ownerId: string; // User.id
  // Stable portfolio this property belongs to (Portfolio.id — survives an
  // owner transfer, unlike ownerId). Stamped on creation; legacy rows
  // backfilled by script/stampPortfolioIds.ts.
  portfolioId?: string;
  address: string;
  // Street/house number, collected separately from the free-text `address`
  // so it survives even when the address autocomplete omits it.
  addressNumber?: string;
  // Owner-chosen display name ("Seaside Apartment"). Falls back to
  // `address` at render sites when missing.
  name?: string;
  image?: string;
  lat?: number;
  lng?: number;
  propertyValue: number;
  acquisitionPrice: number;
  createdAt: string;

  // Optional extended descriptors collected by AddPropertyDrawer.
  // Persisted from the owner-side form; consumed by the tenant Agreements page.
  propertyType?: PropertyType;
  buildingName?: string;
  floor?: string;
  sqm?: string;
  // Collected by the owner AddPropertyDrawer / EditPropertyDrawer (persisted
  // via the owner property POST/PATCH allowlists in server/routes/properties.ts)
  // AND set via the admin/listing path (adminUnits.ts / adminContent.ts).
  bedrooms?: number;
  baths?: number;
  builtYear?: string;
  energyClass?: EnergyClass;
  city?: string;
  postalCode?: string;
  country?: string;
  parking?: number;
  elevator?: boolean;
  heating?: boolean;
  cooling?: boolean;
  solarPanels?: boolean;
  storageUnit?: boolean;
  ownershipType?: OwnershipType;
  companyName?: string;
  titleDeedsStatus?: TitleDeedsStatus;
  developmentStatus?: DevelopmentStatus;
  acquisitionYear?: string;
  developmentYear?: string;
  propertyUse?: PropertyUse;
  occupancyStatus?: OccupancyStatus;
  rentPrice?: number;
  // Lifecycle status, mirroring Unit.status. Set to "inactive" by the
  // plan-downgrade soft-deactivation (server/services/planReconcile.ts) so the
  // property — and any owner-created property that has no Unit doc at all
  // (unitId === propertyId) — disappears from the owner's lists while its
  // transaction history stays visible. Absent ⇒ "active". Cleared on restore.
  status?: UnitStatus;
  // ISO 8601. Stamped when the property is soft-deactivated; cleared on restore.
  deactivatedAt?: string;
  // ISO 8601. Stamped by the 30-day sweep once this property's documents have
  // been purged (idempotency: already-purged properties are skipped). The
  // property/agreement/tenant/activity are RETAINED — only documents are gone.
  docsPurgedAt?: string;
}

// "active" — normal, owner-visible. "inactive" — soft-deactivated by the
// plan-downgrade reconcile (server/services/planReconcile.ts) when the owner's
// new tier can't cover this unit's property. Inactive units are HIDDEN from the
// owner's property/unit lists & dashboards but NOTHING is deleted — the unit,
// its tenancy, its agreement and (critically) its transaction history are all
// retained. A 30-day grace lets the owner re-upgrade (or free up cap) and
// restore; after 30 days the sweep purges only the unit's documents and the
// data lives on, admin-visible. Absent on legacy Unit docs → treated as active.
export type UnitStatus = "active" | "inactive";

export interface Unit {
  id: string;
  propertyId: string; // Property.id
  label?: string; // e.g. "Apt 3B"
  rentAmount: number;
  currentTenantId?: string; // Tenant.id
  paymentStatus: "paid" | "pending" | "overdue";
  nextPaymentDate?: string;
  leaseEnd?: string;
  createdAt: string;
  // Lifecycle status. Absent ⇒ "active" (every read uses `status !== "inactive"`
  // so legacy docs without the field behave as active). Set to "inactive" by the
  // plan-downgrade soft-deactivation; cleared back to "active" on restore.
  status?: UnitStatus;
  // ISO 8601. Stamped when soft-deactivated; cleared on restore. The 30-day
  // grace window (and the sweepInactiveUnits cron) measure from this.
  deactivatedAt?: string;
  // ISO 8601. Stamped by the 30-day sweep once this unit's documents have been
  // purged, so the sweep is idempotent (already-purged units are skipped).
  docsPurgedAt?: string;
}

// "invited" — owner added this email but no Olio account exists yet (linked on
// signup). "pending" — account linked, lease awaiting the tenant's approval.
// "active" — tenant approved. "declined" — tenant rejected the lease.
export type TenantStatus = "active" | "expired" | "pending" | "invited" | "declined";

export interface Tenant {
  id: string;
  userId?: string; // User.id once they accept the invite
  name: string;
  email: string;
  unitId: string; // Unit.id
  propertyId: string; // Property.id (denormalized for admin queries)
  ownerId: string; // User.id
  // Stable portfolio this tenancy belongs to (Portfolio.id — survives an
  // owner transfer, unlike ownerId). Stamped on creation; legacy rows
  // backfilled by script/stampPortfolioIds.ts.
  portfolioId?: string;
  rentAmount: number;
  status: TenantStatus;
  // Cleared to `null` by the end-tenancy handler (portfolio.ts) when the
  // tenancy ends; otherwise an ISO date string.
  nextPayment?: string | null;
  createdAt: string;
  // Set by the server when a tenancy ends (status → "expired"): the
  // end-tenancy handler in portfolio.ts and the plan-downgrade reconcile in
  // planReconcile.ts both stamp this. ISO 8601.
  endedAt?: string;
  // Rent still owed when the tenancy ended with unpaid in-term cycles (major
  // units, EUR). Set by the lease-expiry sweep / manual end-tenancy handler so
  // the ex-tenant can still settle and the owner sees the arrear; cleared to 0
  // / removed once paid in full. Mirrors Agreement.closingBalance.amount.
  outstandingBalance?: number;
}

// "pending_tenant" — owner created the lease; awaiting the tenant's in-app
// Approve/Decline. Becomes "active" once the tenant accepts, "declined" if they
// reject. "draft" is a reserved, never-surfaced editable state — both owner and
// tenant Agreements reads show every status EXCEPT "draft", so a freshly-created
// lease (now "pending_tenant") is visible to both sides immediately.
// "suspended" — a plan-downgrade hold. The owner's tier can no longer cover
// this lease's property (cap exceeded, or rent.collectStripe lost), so the
// agreement is paused — NOT terminated. nextPaymentDate is deliberately
// PRESERVED (unlike termination, which nulls it) so a re-upgrade within the
// 30-day grace resumes the original schedule untouched. After 30 days the sweep
// transitions suspended → terminated and the owner must create a new lease.
export type AgreementStatus =
  "draft" | "pending_tenant" | "active" | "declined" | "expired" | "terminated" | "suspended";
export type LeaseType = "Residential Lease" | "Commercial Lease";
export type PaymentFrequency = "monthly" | "quarterly" | "yearly";
export type AutoRenewalMode = "none" | "auto" | "fixed";
export type CpiIndexationType = "fixed" | "cpi" | "custom";

// Hard ceiling on a fixed/custom indexation rate (percent). Enforced server-
// side at agreement creation AND clamped defensively inside the indexation
// sweep, so a typo (e.g. 50 meaning €50 typed into a % field) or a crafted
// request can't auto-apply a runaway compound rent increase. Sized for a
// rent-controlled jurisdiction (Cyprus/EU); raise deliberately if needed.
export const MAX_INDEXATION_RATE_PCT = 25;

// Unpaid rent captured when a lease closes (expiry or early termination) with
// in-term cycles still outstanding. The lease stops scheduling NEW rent, drops
// out of forward revenue, and stops reminders/indexation — but this balance is
// PRESERVED so the ex-tenant can still settle it and the owner can still see /
// collect it. Cleared (set to null) once paid in full.
export interface AgreementClosingBalance {
  // Total unpaid rent at close, in major units (EUR).
  amount: number;
  // How many billing cycles went unpaid (1 for a single missed month; >1 when
  // the tenant fell several cycles behind before the lease ended).
  cycles: number;
  // The earliest unpaid cycle's due date (YYYY-MM-DD) — the start of the arrear.
  fromPeriod: string;
  // Why the lease closed.
  reason: "expiry" | "termination";
  // When the balance was recorded (ISO 8601).
  recordedAt: string;
}

export interface AgreementIndexation {
  type: CpiIndexationType;
  // Percentage applied at each indexation step. Only meaningful when type !== "cpi" (CPI pulls from
  // an external feed; this remains undefined). Stored as a decimal e.g. 2.5 → 2.5%.
  rate?: number;
  // Months after signing before the first indexation applies (rent freeze period).
  delayMonths?: number;
  // How often indexation is reapplied after the delay window.
  frequency?: PaymentFrequency;

  // ── Auto-application tracking (managed by the rent-indexation sweep) ──
  // Seeded at lease creation as anchor(signing) + delayMonths, then advanced
  // by the frequency stride after each applied step. The daily sweep keys off
  // this; the UI surfaces it as "Next increase". Undefined on legacy docs
  // until the seed migration (script/seedIndexationDates.ts) runs.
  nextIncreaseDate?: string; // YYYY-MM-DD
  // When the most recent increase was applied (YYYY-MM-DD).
  lastAppliedDate?: string;
  // Count of increases applied so far by the sweep.
  appliedSteps?: number;
  // Monthly rent at signing — audit/display anchor. Compounding takes the rate
  // off the CURRENT rent, so this is not used in the math.
  baseRent?: number;
}

// Kinds of row the rent-indexation sweep writes to rentIndexationLog:
//   prenotice  — advance heads-up pushed to both parties before a step
//   applied    — an increase was actually applied (rent bumped)
//   cpi_manual — a CPI step is due but there's no CPI feed; owner flagged to
//                set the new rent by hand (no automatic bump)
export type RentIndexationLogKind = "prenotice" | "applied" | "cpi_manual";

// One row per indexation event, written by functions/src/rentIndexation.ts as
// an idempotency guard so a cron retry / cold-start replay can't double-apply
// or double-notify. Doc id = `${agreementId}_${effectiveOn}_${kind}`.
export interface RentIndexationLog {
  id: string;
  agreementId: string;
  ownerId: string;
  tenantId: string;
  kind: RentIndexationLogKind;
  // The indexation step's effective date (YYYY-MM-DD) this row guards.
  effectiveOn: string;
  // The date the sweep wrote this row (YYYY-MM-DD).
  recordedOn: string;
  // Present on kind === "applied": the rent transition that was applied.
  previousRent?: number;
  newRent?: number;
  indexationType?: CpiIndexationType;
  rate?: number;
}

export interface Agreement {
  id: string;
  tenantId: string;
  unitId: string;
  propertyId: string;
  ownerId: string;
  // Stable portfolio this lease belongs to (Portfolio.id — survives an owner
  // transfer, unlike ownerId). Stamped on creation; legacy rows backfilled by
  // script/stampPortfolioIds.ts.
  portfolioId?: string;
  // Reserved / not yet enforced: no route currently writes or reads this, and
  // the "active" transition does NOT gate on it. Kept as a placeholder for a
  // future payment-method precondition.
  paymentMethodId?: string;
  agreementValue: number;
  startDate: string;
  endDate: string;
  status: AgreementStatus;
  // Legacy / superseded: a one-shot URL field nothing currently writes. The
  // canonical signed-lease attachment is `signedLeaseDocument` below, which
  // stores only the storage path so every read mints a fresh, expiring v4
  // signed URL (M-23: never persist a permanent capability URL). Reads fall
  // back to this field only if it was ever set.
  documentUrl?: string;
  // The actual signed/physical lease PDF the owner uploads for this lease.
  // Stored in Cloud Storage under documents/{ownerId}/{propertyId}/agreements/
  // {agreementId}/…; only the storagePath is durable. Both the owner and the
  // lease's tenant can view + download it (the agreement read endpoints mint a
  // fresh signed URL from storagePath). Uploaded/replaced/removed by the owner
  // via /api/owner/agreements/:id/document/*. Retained when the tenancy ends —
  // it's each party's own legal record. `null` once the owner removes it.
  signedLeaseDocument?: {
    storagePath: string;
    name: string; // original filename, for display + download
    contentType: string; // always "application/pdf" today
    size: number; // bytes
    uploadedAt: string; // ISO 8601
    uploadedBy: string; // owner User.id who uploaded it
  } | null;
  createdAt: string;
  // Set when the tenant responds to a "pending_tenant" lease via
  // POST /api/tenant/agreements/:id/respond — one or the other, never both.
  acceptedAt?: string;
  declinedAt?: string;
  // Set by the server when the agreement is terminated (status → "terminated"):
  // the end-tenancy handler in portfolio.ts and the plan-downgrade reconcile in
  // planReconcile.ts both stamp this. ISO 8601.
  terminatedAt?: string;
  // Set by the lease-expiry sweep when a lease reaches its endDate with no
  // auto-renewal (status → "expired"). ISO 8601. Distinct from terminatedAt:
  // "expired" = natural end of term, "terminated" = ended early by the owner.
  expiredAt?: string;
  // Unpaid rent owed when the lease closed (see AgreementClosingBalance).
  // `null`/absent once settled or when the lease closed fully paid-up.
  closingBalance?: AgreementClosingBalance | null;
  // Set when the agreement is paused (status → "suspended") by the plan-downgrade
  // soft-deactivation. Cleared on restore. nextPaymentDate is preserved across
  // suspension. ISO 8601.
  suspendedAt?: string;
  // Why the lease was suspended — drives the owner/tenant notification copy and
  // the 30-day audit. Cleared on restore.
  suspendedReason?: "planDowngrade" | "rentCollectLost";

  // Optional lease descriptors surfaced on the tenant Agreements page.
  leaseType?: LeaseType;
  monthlyRent?: number;
  deposit?: number;
  noticePeriodMonths?: number;
  paymentDayOfMonth?: number;
  signedAt?: string;

  // Owner-collected terms from AddTenantDrawer. All optional so legacy
  // agreement docs (which never collected these) continue to read cleanly.
  signatureDate?: string;
  // Cleared to `null` by the end-tenancy handler (portfolio.ts) when the
  // agreement is terminated; otherwise an ISO date string.
  nextPaymentDate?: string | null;
  prepaidRents?: number; // months pre-paid up front
  // Total prepaid amount (rent × prepaidRents) FROZEN at creation. The synthetic
  // prepaid-rent activity row reads this so the historical figure doesn't shift
  // when monthlyRent is later indexed/edited (services/prepaidActivity.ts). Older
  // leases predating this field fall back to live monthlyRent × prepaidRents.
  prepaidRentAmount?: number;
  rentFreePeriodMonths?: number;
  paymentFrequency?: PaymentFrequency;
  rentalDurationMonths?: number;
  autoRenewal?: AutoRenewalMode;
  // For autoRenewal === "fixed": the term (in months) each renewal extends the
  // lease by. Absent ⇒ the lease's rentalDurationMonths is used (legacy / "auto"
  // leases). Set from the owner's "renew for N months" pick in AddTenantDrawer.
  fixedRenewalMonths?: number;
  indexation?: AgreementIndexation;

  // Free-text clauses / special conditions the owner types in AddTenantDrawer.
  // Shown verbatim on the tenant's agreement view + downloadable PDF. Optional
  // so legacy agreement docs (which never collected this) read cleanly.
  termsAndConditions?: string;
}

// Owner-side saved card/payment instrument, mirrored from Stripe.
// VESTIGIAL: nothing writes this collection today — the only accessor is the
// account-deletion cascade (userDelete.ts), which queries by `userId`. The
// field is named to match that reality (it was previously declared `ownerId`,
// disagreeing with the code). These are PERSONAL payment instruments — they
// belong to the user, never to a portfolio, and must not move on transfer.
export interface PaymentMethod {
  id: string;
  userId: string; // User.id
  stripePaymentMethodId: string;
  brand: string; // "visa" | "mastercard" | "amex" | ...
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
  createdAt: string;
}

// Portfolio access — owners can grant a trusted person view (or view+edit)
// access to their portfolio data. Three fixed roles: legacy (inheritance
// contact, view), legal (lawyer, view+edit), financial (accountant, view).
// One contact per type per owner. Doc id == `${ownerId}_${type}`.
export type AccessContactType = "legacy" | "legal" | "financial";
export type AccessPermission = "view" | "edit";
// NOTE: the current access flow (server/routes/access.ts) only ever produces
// "pending" → "active" (accept) / "declined" (decline). Removing a contact is a
// hard DELETE of the doc, not a status flip — so "revoked" is currently NEVER
// written by any route. Kept in the union for forward-compat / legacy docs.
export type AccessContactStatus = "pending" | "active" | "declined" | "revoked";

export interface PortfolioAccessContact {
  id: string;
  ownerId: string;
  // Stable portfolio this grant attaches to (Portfolio.id). Stamped on
  // creation; legacy rows backfilled by script/stampPortfolioIds.ts. Note the
  // doc id embeds ownerId for legacy rows — queries must use this FIELD.
  portfolioId?: string;
  type: AccessContactType;
  name: string;
  email: string;
  permissions: AccessPermission[];
  status: AccessContactStatus;
  // Set when the email matches an existing user — access binds to their UID
  // immediately and they can see the portfolio next time they sign in.
  contactUserId?: string;
  // Currently UNUSED. The access route (server/routes/access.ts) now REQUIRES
  // the invitee to already have an Olio account (returns 404 otherwise) and
  // never auto-provisions one, so no inviteLink is generated or persisted.
  // Kept for legacy docs created before the require-existing-account change.
  inviteLink?: string;
  invitedAt: string;
  acceptedAt?: string;
  declinedAt?: string;
}

// Complimentary plan grant — admins can comp a user onto Advance or PRO for a
// fixed duration. The grant is tracked here for audit/revoke; the live plan is
// applied by setting the `stripeRole` custom claim on the Firebase Auth user
// (the same claim the Stripe Payments extension writes for paid subscribers).
// Doc id == userId so each user has at most one active grant at a time.
// "business" is sales-led only — there is no Stripe product for it; admins
// grant it via the comp-plan flow. "advance" and "pro" can also be granted
// as comp plans on top of (or instead of) a Stripe subscription.
export type ComplimentaryPlanType = "advance" | "pro" | "business";
// "superseded" = the gifted owner bought a real paid Stripe subscription, so
// the gift no longer governs their plan (the Payments extension owns the claim
// now). The expiry cron filters status=="active", so a superseded gift is
// ignored — no phantom "active gift" surfaces on a paying owner.
export type ComplimentaryPlanStatus = "active" | "revoked" | "expired" | "superseded";

export interface ComplimentaryPlan {
  id: string;
  userId: string;
  plan: ComplimentaryPlanType;
  grantedAt: string;
  expiresAt: string;
  grantedByUid: string;
  grantedByName: string;
  status: ComplimentaryPlanStatus;
  revokedAt?: string;
  // Set when status flips to "superseded" (gifted → paid upgrade).
  supersededAt?: string;
}

export type InviteRole = Extract<Role, "admin" | "superadmin">;
export type InviteStatus = "pending" | "accepted" | "expired" | "revoked";

// Admin-panel invite. Only superadmins can create these; accepting one grants the named role.
export interface Invite {
  id: string;
  email: string;
  role: InviteRole;
  invitedBy: string; // User.id of the inviting superadmin
  expiresAt: string; // ISO 8601
  status: InviteStatus;
  acceptedBy?: string; // User.id of acceptor, set on accept
  acceptedAt?: string;
  createdAt: string;
}

export type TransactionType = "income" | "expense" | "neutral";
export type TransactionCategory = "rent" | "maintenance" | "tax" | "fee" | "other";
// How a Transaction was paid. Distinct from the PaymentMethod (saved card) entity above.
export type TxPaymentMethod =
  | "card" // Stripe Connect — auto-confirmed when checkout.session.completed fires
  | "bank_transfer"
  | "cash"
  | "check"
  | "other";

// How a Transaction came into being. "manual" rows are owner-recorded ledger
// entries (RecordActivityDialog); "rent" + the absent/legacy case are system-
// generated by a payment flow (Stripe webhook, offline-rent log/verify).
// "prepaid" is special: a SYNTHETIC, read-only row the activity feeds derive on
// the fly from Agreement.prepaidRents — it is NEVER written to Firestore (see
// server/services/prepaidActivity.ts). Only "manual" rows are user-editable —
// see the append-only note below. Absent on legacy rows (treated as non-manual,
// i.e. immutable).
export type TransactionSource = "manual" | "rent" | "prepaid";

// Mostly append-only ledger. System-generated rows (rent payments, anything
// not source:"manual") must never be mutated — their amounts, commission
// breakdown and rentPeriod feed cycle-advancement idempotency and historical
// accounting. The ONE allowed exception: an owner correcting a manual entry
// they recorded themselves within the last 24h (PATCH /api/owner/transactions/:id,
// gated on source==="manual" + ownerId===caller + createdAt within window).
// Status transitions (owner verification, Stripe webhook) remain the only
// other permitted mutation.
export interface Transaction {
  id: string;
  propertyId?: string;
  unitId?: string;
  tenantId?: string;
  // The lease this payment belongs to (Agreement.id). Stamped on every rent /
  // income row tied to a live lease at write time and on the synthetic prepaid
  // row; left UNSET on manual owner expenses and maintenance not bound to a
  // lease. WRITE-ONCE — it must survive the lease expiring/terminating so the
  // payment stays attributable to its agreement forever (the row itself is NOT
  // nested under the lease; it lives in the top-level transactions ledger).
  // Legacy rows backfilled by script/backfillAgreementIds.ts.
  agreementId?: string;
  ownerId?: string;
  // Stable portfolio this row belongs to (Portfolio.id — survives an owner
  // transfer, unlike ownerId). Stamped on creation for owner-keyed rows;
  // legacy rows backfilled by script/stampPortfolioIds.ts.
  //
  // DATA GUARANTEE (verified 2026-06-15 backfill): 0 transactions are missing
  // this — every existing row carries it, and every NEW write path stamps it
  // (the owner-direct paths unconditionally; the Stripe path from checkout
  // metadata). It is therefore effectively-always-present.
  //
  // KEPT STRUCTURALLY OPTIONAL ON PURPOSE — do NOT flip to required. The Stripe
  // rent recorder (server/services/rentTransaction.ts) deliberately OMITS the
  // stamp if a portfolio lookup throws, so a paid-rent webhook never 500s and
  // gets replayed. A required type would force `portfolioId: ""` there — a
  // sticky bad row the backfill then skips. A new write path should stamp it
  // unconditionally like finance.ts / tenant.ts / tickets.ts do.
  portfolioId?: string;
  name: string;
  amount: number;
  currency: string; // ISO 4217, e.g. "EUR"
  type: TransactionType;
  category: TransactionCategory;
  // pending = awaiting owner verification (offline rent) or — for a tenant-
  //   reported maintenance issue mirrored into the ledger — awaiting the owner
  //   marking it fixed.
  // completed = card-paid (auto) or owner-verified (manual).
  // failed = payment didn't go through.
  // resolved = a tenant-reported maintenance issue the owner has marked fixed.
  //   Only ever set on neutral/maintenance rows; see
  //   POST /api/owner/maintenance/resolve/:id.
  status: "completed" | "pending" | "failed" | "resolved";
  // The activity date — what the entry is *about*. Owner-recorded entries can
  // back-date this. NOT the row's creation time; see `createdAt` for the
  // wall-clock moment the row was written (used for the 24h edit window).
  timestamp: string;
  paymentMethod?: TxPaymentMethod;
  // Optional URL to a receipt/proof image uploaded by the tenant for offline payments.
  proofUrl?: string;
  // For Stripe-paid rent: the Checkout Session id, used to finalize on redirect.
  stripeSessionId?: string;
  // For Stripe-paid rent: the Checkout Session's PaymentIntent id. Stored so a
  // later charge.refunded webhook — which carries the PaymentIntent, not our
  // session id — can locate THIS row and stamp the refund onto it. Absent on
  // offline payments and on Stripe rows written before this field shipped.
  stripePaymentIntentId?: string;
  // Refund visibility, stamped by the charge.refunded webhook (onChargeRefunded).
  // Cumulative cents refunded to the cardholder, and cumulative platform
  // application-fee refunded. Absent until a refund actually occurs; a partial
  // refund sets the partial cumulative totals. Display-only — the original
  // `amount`/`applicationFeeCents` stay as booked so historical accounting holds.
  refundedAmountCents?: number;
  feeRefundedCents?: number;
  verifiedAt?: string;
  verifiedBy?: string; // owner User.id
  // For tenant-reported maintenance issues (neutral/maintenance rows): when the
  // owner marked the report fixed, and which owner did it. Absent until the
  // status moves to "resolved".
  resolvedAt?: string;
  resolvedBy?: string; // owner User.id
  // The billing cycle this rent payment covers — the agreement's
  // nextPaymentDate (YYYY-MM-DD) at the moment of payment. Used to keep
  // cycle advancement idempotent: a second payment for an already-advanced
  // cycle (split offline transfers, or card + offline for the same period)
  // must not skip a month. Absent on legacy rows and non-rent transactions.
  rentPeriod?: string;
  notes?: string;
  // Platform commission breakdown for Stripe-paid rent. Stored at finalize
  // time so the historical numbers stick even if admin later changes the
  // rate. Absent on offline payments and on Stripe payments created before
  // this feature shipped — UI falls back to the single `amount` display.
  applicationFeeCents?: number;
  ownerNetCents?: number;
  ownerPlanAtSend?: OwnerPlanKey;
  // Discriminates owner-recorded entries from system-generated ones. Only set
  // on rows written by POST /api/owner/transactions ("manual"); gates the
  // owner's 24h edit window. Absent rows are treated as non-manual/immutable.
  source?: TransactionSource;
  // Wall-clock moment the row was written, independent of the (back-datable)
  // activity `timestamp`. Drives the 24h manual-edit window. Absent on legacy
  // rows and system rows that predate this field.
  createdAt?: string;
}

export type PartnerType = "broker" | "contractor" | "legal" | "cleaning" | "insurance" | "other";

export type PartnerDurationMonths = 1 | 2 | 3 | 6 | 12;

export interface Partner {
  id: string;
  name: string;
  type: PartnerType;
  contactName?: string;
  email?: string;
  phone?: string;
  rating?: number;
  status: "active" | "inactive";
  // ISO timestamp at which the partner auto-inactivates.
  activeUntil?: string;
  location?: string;
  image?: string;
  createdAt: string;
}

export type TicketStatus = "open" | "in_progress" | "resolved" | "closed";
export type TicketPriority = "low" | "medium" | "high" | "urgent";

export interface Ticket {
  id: string;
  subject: string;
  userId: string;
  userEmail: string;
  category: "billing" | "technical" | "account" | "general" | "property";
  priority: TicketPriority;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  // First-message body for property-issue reports from the dashboard. Longer
  // back-and-forth lives in the messages subcollection: tickets/{id}/messages/{msgId}
  description?: string;
  // For property-category tickets: where the issue was reported from.
  propertyId?: string;
  unitId?: string;
}

export interface Broadcast {
  id: string;
  audience: "owners" | "tenants" | "all";
  subject: string;
  body: string;
  sentAt?: string;
  status: "draft" | "sent";
  createdAt: string;
}

// Email-marketing campaigns sent via Resend. Authored under
// /admin/email-marketing by users with the `comm.email` privilege; dispatched
// in batches by the scheduled `dispatchEmailCampaigns` Cloud Function.
export type EmailCampaignAudience = "all" | "owners" | "tenants";

// Inclusive [min, max] range for marketing audience filters. Either bound may
// be omitted (no constraint on that side).
export interface MarketingNumericRange {
  min?: number;
  max?: number;
}

// Rich audience filter shared between push and email marketing surfaces.
// Owner-only filters (plans, ranges) auto-exclude tenants — none of those
// dimensions apply to tenant accounts.
export interface MarketingAudienceFilter {
  role: "all" | "owners" | "tenants";
  status: "any" | UserStatus;
  emailContains?: string;
  plans?: OwnerPlanKey[];
  portfolioAccessRange?: MarketingNumericRange;
  propertiesRange?: MarketingNumericRange;
  rentedRange?: MarketingNumericRange;
  peopleAssignedRange?: MarketingNumericRange;
}

export type EmailCampaignStatus =
  | "draft" // editable, never queued
  | "scheduled" // queued for a future scheduledAt
  | "sending" // dispatch worker is fanning out
  | "sent" // every recipient processed (delivered or failed)
  | "failed" // catastrophic failure — no recipients sent
  | "cancelled"; // admin cancelled mid-flight

// Optional call-to-action button rendered in a campaign email between the
// body and the signature. Both fields are required together; `url` must be an
// http(s) URL (validated server-side + guarded again at render time so a
// javascript:/data: URL can never reach the button href).
export interface EmailCta {
  label: string;
  url: string;
}

export interface EmailCampaign {
  id: string;
  subject: string;
  // Canonical authoring form (plain text with {{merge}} vars). Rendered to
  // HTML at send time; we keep the source so drafts round-trip cleanly.
  bodyText: string;
  // Legacy simple selector (owners + tenants only). New campaigns set
  // `filter` or `targetUserId` instead; this stays optional so existing
  // drafts and sent campaigns keep resolving via the legacy path.
  audience?: EmailCampaignAudience;
  // Rich audience filter — same shape as the push-notification surface.
  filter?: MarketingAudienceFilter;
  // Single-user campaign. Set when admin picks "Specific user" in the editor.
  targetUserId?: string;
  // Optional call-to-action button (label + link) rendered after the body.
  cta?: EmailCta;
  // Optional sign-off appended after the body/CTA. Plain text; supports the
  // same {{merge}} vars as the body.
  signature?: string;
  // Optional custom footer text rendered ABOVE the mandatory copyright +
  // unsubscribe + sender-address block. Never replaces the unsubscribe link
  // (legal requirement); it's additive.
  footerText?: string;
  status: EmailCampaignStatus;
  scheduledAt?: string;
  sentAt?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  sentBy?: string;
  // Aggregates kept in sync by the dispatch worker + webhook handler so the
  // campaign list can render counts without a subcollection scan.
  recipientCount?: number;
  acceptedCount?: number;
  deliveredCount?: number;
  failedCount?: number;
  openedCount?: number;
  clickedCount?: number;
  unsubscribedCount?: number;
}

export type EmailRecipientStatus =
  | "queued" // written by /send, not yet picked up
  | "sending" // claimed by a dispatcher tick; transient — flips to
  // accepted or failed once the Resend call completes.
  // A row stuck here means the tick crashed mid-send.
  | "accepted" // Resend returned 200 with a message id
  | "sent" // Resend's email.sent event fired (handed off upstream)
  | "delivered" // landed in the inbox
  | "opened"
  | "clicked"
  | "failed"
  | "unsubscribed"
  | "skipped"; // suppressed by provider (bounced/complained previously)

export interface EmailRecipient {
  userId: string;
  email: string;
  status: EmailRecipientStatus;
  // Provider-side message id (currently Resend). Stored so webhook events
  // can be matched back to the recipient doc via collectionGroup query.
  providerMessageId?: string;
  // ISO timestamp the dispatcher CLAIMED this recipient (status flipped
  // from queued → sending). Used by the dispatcher's concurrent-tick
  // de-duplication: once a row is claimed, other ticks see status !==
  // "queued" and skip it instead of double-sending.
  claimedAt?: string;
  attemptedAt?: string;
  deliveredAt?: string;
  openedAt?: string;
  clickedAt?: string;
  error?: string;
}

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export type PortfolioSize = "1-2" | "3-5" | "5-10" | "10+";
export type ExpertApplicationStatus = "new" | "contacted" | "closed";

export interface ExpertApplication {
  id: string;
  userId: string; // User.id
  email: string;
  message: string;
  portfolioSize: PortfolioSize;
  services: string[];
  status: ExpertApplicationStatus;
  createdAt: string;
}

// Investment-suggestion leads submitted from the "Find me a property" flow
// in AddPropertyDrawer. Captured for the platform team to follow up on with
// curated listings.
export const SUGGESTION_PROPERTY_TYPES = [
  "Apartment",
  "House",
  "Building",
  "Commercial",
  "Plot",
] as const;
export type SuggestionPropertyType = (typeof SUGGESTION_PROPERTY_TYPES)[number];
export type SuggestionRequestStatus = "new" | "contacted" | "closed";

export interface SuggestionRequest {
  id: string;
  userId: string;
  userEmail: string;
  userName: string;
  location: string;
  budget: number | null; // EUR, major units; null when the user left it blank
  propertyType: SuggestionPropertyType;
  status: SuggestionRequestStatus;
  createdAt: string;
}

// Per-listing buyer interest. An owner clicks "I'm interested" on a marketplace
// listing detail page; the platform team picks it up from the leads queue.
// Listing fields are snapshotted at submission time so the queue row remains
// readable if the source listing is later edited or removed.
export type MarketplaceLeadStatus = "new" | "contacted" | "closed";

export interface MarketplaceLead {
  id: string;
  listingId: string;
  listingTitle: string;
  listingPrice: number;
  listingLocation: string;
  userId: string;
  userEmail: string;
  userName: string;
  message?: string;
  status: MarketplaceLeadStatus;
  createdAt: string;
}

// Marketplace properties for sale, surfaced to owners as buying opportunities.
// Created and curated by platform admins; read by all authenticated users.
export type MarketplaceListingStatus = "active" | "draft" | "sold" | "withdrawn";
export type MarketplaceListingTag = "Hot Deal" | "New" | "Featured" | "Off-market";

export interface MarketplaceListing {
  id: string;
  title: string;
  location: string; // free-form display, e.g. "Limassol, Cyprus"
  price: number; // in major units (e.g. 850000 = €850,000)
  // Estimated annual return on investment as a percentage (e.g. 6.2 = 6.2%).
  // Optional — admins may not have a yield estimate for every listing.
  roi?: number;
  beds?: number;
  baths?: number;
  sqm?: number;
  image?: string; // public URL or path under /assets
  tag?: MarketplaceListingTag;
  status: MarketplaceListingStatus;
  // Optional outbound link, e.g. to a broker's listing or property docs.
  externalUrl?: string;
  createdAt: string;
  updatedAt?: string;
}
