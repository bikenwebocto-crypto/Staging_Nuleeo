// Resolve an email-campaign audience selector to a list of recipients.
//
// Filters applied (in addition to the audience-specific role match):
// - status === "active"
// - email present and non-empty
// - notificationPrefs.marketingEmails !== false (default-opt-in)

import { auth, db } from "../firebase";
import {
  COL,
  type EmailCampaign,
  type EmailCampaignAudience,
  type MarketingAudienceFilter,
  type MarketingNumericRange,
  type OwnerPlanKey,
  type PortfolioAccessContact,
  type Property,
  type Tenant,
  type User,
  type UserStatus,
} from "../../shared/firestore-schema";
import { occupiedPropertyIds } from "./occupancy";

export interface AudienceRecipient {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
}

// Re-exports kept for older internal callers (notifications.ts). Canonical
// types live in shared/firestore-schema.ts so the editor UI and server agree
// on the payload shape stored on EmailCampaign.filter.
export type NumericRange = MarketingNumericRange;
export type PushAudienceFilter = MarketingAudienceFilter;

// Which delivery channel a filter resolution is for. Decides which opt-out
// flag blocks delivery: pushEnabled (push) vs marketingEmails (email).
export type MarketingChannel = "push" | "email";

const KNOWN_PLANS: readonly OwnerPlanKey[] = ["basic", "advance", "pro", "business"];

function inRange(n: number, range: MarketingNumericRange | undefined): boolean {
  if (!range) return true;
  if (typeof range.min === "number" && n < range.min) return false;
  if (typeof range.max === "number" && n > range.max) return false;
  return true;
}

function isOwnerOnlyFilter(filter: MarketingAudienceFilter): boolean {
  return (
    (filter.plans?.length ?? 0) > 0 ||
    !!filter.portfolioAccessRange ||
    !!filter.propertiesRange ||
    !!filter.rentedRange ||
    !!filter.peopleAssignedRange
  );
}

// Pull every Auth user's `stripeRole` custom claim in one batch (1000 at a
// time). Returns a map keyed by uid. Falls back to "basic" for owners with
// no claim — same default as resolveOwnerPlan().
async function loadAllOwnerPlans(): Promise<Map<string, OwnerPlanKey>> {
  const out = new Map<string, OwnerPlanKey>();
  let pageToken: string | undefined = undefined;
  do {
    const page = await auth().listUsers(1000, pageToken);
    for (const u of page.users) {
      const claim = (u.customClaims as { stripeRole?: unknown } | undefined)?.stripeRole;
      if (typeof claim === "string" && (KNOWN_PLANS as readonly string[]).includes(claim)) {
        out.set(u.uid, claim as OwnerPlanKey);
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return out;
}

interface OwnerStats {
  plan: OwnerPlanKey;
  // Number of portfolios this owner can see (own + any they were granted
  // access to as a portfolioAccessContact). Owners always count themselves.
  portfolioAccessCount: number;
  // Properties they own.
  propertiesCount: number;
  // Unique properties with at least one rented unit.
  rentedCount: number;
  // People they assigned to their own portfolio (excludes revoked rows).
  peopleAssignedCount: number;
}

async function loadOwnerStats(ownerIds: Set<string>): Promise<Map<string, OwnerStats>> {
  if (ownerIds.size === 0) return new Map();

  const [propsSnap, tenantsSnap, contactsSnap, planByUid] = await Promise.all([
    db().collection(COL.properties).get(),
    db().collection(COL.tenants).get(),
    db().collection(COL.portfolioAccessContacts).get(),
    loadAllOwnerPlans(),
  ]);

  const propertiesByOwner = new Map<string, Property[]>();
  for (const d of propsSnap.docs) {
    const p = d.data() as Property;
    if (!p.ownerId) continue;
    const arr = propertiesByOwner.get(p.ownerId) ?? [];
    arr.push(p);
    propertiesByOwner.set(p.ownerId, arr);
  }

  // Properties that are actually rented = those with ≥1 ACTIVE tenancy.
  // Derived from tenancies, NOT Unit.currentTenantId (never written; owner-
  // created properties have no Unit doc, so the old unit-based map was always
  // empty and a "rented ≥ 1" segment matched zero owners). See
  // services/occupancy.ts.
  const occupiedProps = occupiedPropertyIds(tenantsSnap.docs.map((d) => d.data() as Tenant));

  // Active or pending PortfolioAccessContacts. "revoked" rows shouldn't
  // count against either side (assigned-to or assigned-by) — the link is
  // gone. Doc id format is `${ownerId}_${type}` but we use the row's own
  // ownerId / contactUserId fields rather than parsing the id.
  const peopleByOwner = new Map<string, number>();
  const accessByContact = new Map<string, Set<string>>();
  for (const d of contactsSnap.docs) {
    const c = d.data() as PortfolioAccessContact;
    if (c.status === "revoked") continue;
    if (c.ownerId) {
      peopleByOwner.set(c.ownerId, (peopleByOwner.get(c.ownerId) ?? 0) + 1);
    }
    if (c.contactUserId) {
      const set = accessByContact.get(c.contactUserId) ?? new Set<string>();
      set.add(c.ownerId);
      accessByContact.set(c.contactUserId, set);
    }
  }

  const result = new Map<string, OwnerStats>();
  for (const uid of Array.from(ownerIds)) {
    const props = propertiesByOwner.get(uid) ?? [];
    const propertiesCount = props.length;
    let rentedCount = 0;
    for (const p of props) {
      if (occupiedProps.has(p.id)) rentedCount += 1;
    }
    const peopleAssignedCount = peopleByOwner.get(uid) ?? 0;
    // Own portfolio (+1) plus any others they were given access to.
    const portfolioAccessCount = 1 + (accessByContact.get(uid)?.size ?? 0);
    const plan = planByUid.get(uid) ?? "basic";
    result.set(uid, {
      plan,
      portfolioAccessCount,
      propertiesCount,
      rentedCount,
      peopleAssignedCount,
    });
  }
  return result;
}

export async function resolveMarketingAudience(
  filter: MarketingAudienceFilter,
  channel: MarketingChannel = "push",
): Promise<AudienceRecipient[]> {
  const ownerOnly = isOwnerOnlyFilter(filter);

  const snap = await db().collection(COL.users).get();
  const needle = (filter.emailContains ?? "").trim().toLowerCase();

  // First pass: apply cheap filters and collect candidate owners. We defer
  // owner-stats lookups (which touch Auth + 3 collections) until we know we
  // need them.
  interface Candidate {
    u: User;
    isOwner: boolean;
  }
  const candidates: Candidate[] = [];
  for (const doc of snap.docs) {
    const u = doc.data() as User;
    if (!u.email) continue;
    const isOwner = u.roles?.includes("owner") ?? false;
    const isTenant = u.roles?.includes("tenant") ?? false;
    if (!isOwner && !isTenant) continue;

    // Owner-only filters drop every tenant, regardless of the role pick.
    if (ownerOnly && !isOwner) continue;

    if (filter.role === "owners" && !isOwner) continue;
    if (filter.role === "tenants" && !isTenant) continue;

    if (filter.status !== "any" && u.status !== filter.status) continue;
    if (needle && !u.email.toLowerCase().includes(needle)) continue;
    // Push marketing honors BOTH the master push switch AND the marketing-
    // specific opt-out, so a user can keep transactional push while declining
    // promotional broadcasts (mirrors the email marketingEmails opt-out).
    if (
      channel === "push" &&
      (u.notificationPrefs?.pushEnabled === false || u.notificationPrefs?.marketingPush === false)
    )
      continue;
    if (channel === "email" && u.notificationPrefs?.marketingEmails === false) continue;

    candidates.push({ u, isOwner });
  }

  const ownerStats = ownerOnly
    ? await loadOwnerStats(new Set(candidates.filter((c) => c.isOwner).map((c) => c.u.id)))
    : null;

  const out: AudienceRecipient[] = [];
  const seen = new Set<string>();
  const planSet = new Set(filter.plans ?? []);
  for (const { u, isOwner } of candidates) {
    if (ownerOnly) {
      if (!isOwner) continue;
      const s = ownerStats!.get(u.id);
      if (!s) continue;
      if (planSet.size > 0 && !planSet.has(s.plan)) continue;
      if (!inRange(s.portfolioAccessCount, filter.portfolioAccessRange)) continue;
      if (!inRange(s.propertiesCount, filter.propertiesRange)) continue;
      if (!inRange(s.rentedCount, filter.rentedRange)) continue;
      if (!inRange(s.peopleAssignedCount, filter.peopleAssignedRange)) continue;
    }
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    out.push({
      userId: u.id,
      email: u.email,
      firstName: u.firstName ?? "",
      lastName: u.lastName ?? "",
    });
  }
  return out;
}

// Back-compat alias for the push-notification surface. New callers should
// prefer `resolveMarketingAudience` directly.
export function resolvePushAudience(filter: MarketingAudienceFilter): Promise<AudienceRecipient[]> {
  return resolveMarketingAudience(filter, "push");
}

// Resolve the recipient list for an email campaign. Order of precedence:
// (1) targetUserId — single-user send;
// (2) filter — rich audience filter;
// (3) legacy `audience` field — kept so existing drafts and sent campaigns
//     keep resolving without a Firestore migration.
export async function resolveEmailAudienceByCampaign(
  campaign: EmailCampaign,
): Promise<AudienceRecipient[]> {
  if (campaign.targetUserId) return resolveEmailAudienceForUser(campaign.targetUserId);
  if (campaign.filter) return resolveMarketingAudience(campaign.filter, "email");
  if (campaign.audience) return resolveAudience(campaign.audience);
  return [];
}

// Single-user resolution for "Specific user" mode. The user must be an
// owner or tenant, have an email, be active, and not have opted out of
// marketing emails. Returns [] (caller surfaces a clear error) otherwise.
async function resolveEmailAudienceForUser(userId: string): Promise<AudienceRecipient[]> {
  const snap = await db().collection(COL.users).doc(userId).get();
  if (!snap.exists) return [];
  const u = snap.data() as User;
  if (!u.email || u.status !== "active") return [];
  if (u.notificationPrefs?.marketingEmails === false) return [];
  const isOwner = u.roles?.includes("owner") ?? false;
  const isTenant = u.roles?.includes("tenant") ?? false;
  if (!isOwner && !isTenant) return [];
  return [
    {
      userId: u.id,
      email: u.email,
      firstName: u.firstName ?? "",
      lastName: u.lastName ?? "",
    },
  ];
}

export async function resolveAudience(
  audience: EmailCampaignAudience,
): Promise<AudienceRecipient[]> {
  const snap = await db().collection(COL.users).get();
  const out: AudienceRecipient[] = [];
  const seen = new Set<string>();

  for (const doc of snap.docs) {
    const u = doc.data() as User;
    if (!u.email || u.status !== "active") continue;
    if (u.notificationPrefs?.marketingEmails === false) continue;

    const isOwner = u.roles?.includes("owner") ?? false;
    const isTenant = u.roles?.includes("tenant") ?? false;

    // "all" deliberately means owners + tenants only — staff (admin-only
    // accounts) are excluded from marketing audiences because campaigns are
    // user-facing. The UI label in client/platform/.../audience.ts reflects
    // this so the dropdown reads "Owners + Tenants", not "All Users".
    let matches = false;
    if (audience === "all") matches = isOwner || isTenant;
    else if (audience === "owners") matches = isOwner;
    else if (audience === "tenants") matches = isTenant;

    if (!matches || seen.has(u.id)) continue;
    seen.add(u.id);
    out.push({
      userId: u.id,
      email: u.email,
      firstName: u.firstName ?? "",
      lastName: u.lastName ?? "",
    });
  }
  return out;
}

// ── Marketing-filter input parsing ───────────────────────────────────────────
// Validates an untrusted `MarketingAudienceFilter` payload. Shared by BOTH the
// push (notifications.ts) and email (emailMarketing.ts) marketing surfaces so
// the two channels validate audiences identically and can't drift.

const FILTER_ROLES = ["all", "owners", "tenants"] as const;
const FILTER_STATUSES: readonly (UserStatus | "any")[] = [
  "any",
  "active",
  "suspended",
  "invited",
  "pending",
];
const FILTER_PLAN_KEYS: readonly OwnerPlanKey[] = ["basic", "advance", "pro", "business"];

function parseRange(raw: unknown): MarketingNumericRange | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") return { error: "range must be an object" };
  const r = raw as Record<string, unknown>;
  const out: MarketingNumericRange = {};
  const minRaw = r.min;
  const maxRaw = r.max;
  if (minRaw !== undefined && minRaw !== null && minRaw !== "") {
    const n = typeof minRaw === "number" ? minRaw : Number(minRaw);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return { error: "range.min must be a non-negative integer" };
    }
    out.min = n;
  }
  if (maxRaw !== undefined && maxRaw !== null && maxRaw !== "") {
    const n = typeof maxRaw === "number" ? maxRaw : Number(maxRaw);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return { error: "range.max must be a non-negative integer" };
    }
    out.max = n;
  }
  if (out.min === undefined && out.max === undefined) return undefined;
  if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
    return { error: "range.min cannot exceed range.max" };
  }
  return out;
}

function parsePlans(raw: unknown): OwnerPlanKey[] | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return { error: "plans must be an array" };
  if (raw.length === 0) return undefined;
  const out: OwnerPlanKey[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !(FILTER_PLAN_KEYS as readonly string[]).includes(v)) {
      return { error: `plans entries must be one of ${FILTER_PLAN_KEYS.join(", ")}` };
    }
    if (!out.includes(v as OwnerPlanKey)) out.push(v as OwnerPlanKey);
  }
  return out;
}

function parseOwnerFilters(
  raw: Record<string, unknown>,
): Partial<MarketingAudienceFilter> | { error: string } {
  const plans = parsePlans(raw.plans);
  if (plans && typeof plans === "object" && "error" in plans) return plans;
  const ranges: Array<[keyof MarketingAudienceFilter, unknown]> = [
    ["portfolioAccessRange", raw.portfolioAccessRange],
    ["propertiesRange", raw.propertiesRange],
    ["rentedRange", raw.rentedRange],
    ["peopleAssignedRange", raw.peopleAssignedRange],
  ];
  const out: Partial<MarketingAudienceFilter> = {};
  if (plans) out.plans = plans as OwnerPlanKey[];
  for (const [key, value] of ranges) {
    const parsed = parseRange(value);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      return { error: `${String(key)}: ${parsed.error}` };
    }
    if (parsed) (out as Record<string, unknown>)[key as string] = parsed;
  }
  return out;
}

// Parse + validate a raw `MarketingAudienceFilter` object (role/status/
// emailContains + the owner-stats ranges/plans). Returns the clean filter or
// an `{ error }` string. Channel-agnostic — the caller decides push vs email.
export function parseMarketingFilter(raw: unknown): MarketingAudienceFilter | { error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const role = b.role as MarketingAudienceFilter["role"];
  const status = b.status as MarketingAudienceFilter["status"];
  if (!FILTER_ROLES.includes(role))
    return { error: `role must be one of ${FILTER_ROLES.join(", ")}` };
  if (!FILTER_STATUSES.includes(status))
    return { error: `status must be one of ${FILTER_STATUSES.join(", ")}` };
  const emailContains =
    typeof b.emailContains === "string" && b.emailContains.trim()
      ? b.emailContains.trim()
      : undefined;
  const owner = parseOwnerFilters(b);
  if ("error" in owner) return { error: owner.error };
  return { role, status, emailContains, ...owner };
}
