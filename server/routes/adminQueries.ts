// Admin read-only queries: dashboard, audit-log, lists (users, units,
// portfolios, agreements, transactions, partners, tickets,
// suggestion-requests), and the combined activity feed.
//
// All gated to admin + superadmin; finer-grained privileges check
// matrix entries inline. The `?financial=1` opt-in pattern repeats
// across several endpoints: without the flag, monetary fields are
// zeroed before send so a DevTools peek can't read platform
// financials. With the flag, the caller must hold finance.viewAll
// (403 otherwise). The UI only ships the flag when the user actually
// has the privilege.

import type { Express, RequestHandler } from "express";
import { auth, db } from "../firebase";
import { requireAuth } from "../auth";
import { isStripeConfigured, stripe } from "../stripe";
import { errMsg } from "../services/errMsg";
import { logWarn } from "../services/log";
import { hasPlatformPrivilege } from "../services/platformPrivilege";
import { signReadUrl } from "../services/signedReadUrl";
import {
  COL,
  CONFIG_DOC_PLAN_LABELS,
  DEFAULT_PLAN_LABELS,
  withFixedPlanPrices,
  type Agreement,
  type ImpersonationLog,
  type MarketplaceLead,
  type OwnerPlanKey,
  type Partner,
  type PlanLabelsConfig,
  type PlatformPrivilegeKey,
  type PortfolioAccessContact,
  type Property,
  type Role,
  type SuggestionRequest,
  type Tenant,
  type Ticket,
  type Transaction,
  type Unit,
  type User,
  type UserAuditEntry,
} from "../../shared/firestore-schema";
import { isRealizedRent, netRealizedRentAmount } from "../../shared/realizedRent";
import { derivePaymentStatus } from "../../shared/paymentStatus";

// ── Local helpers ────────────────────────────────────────────────────

function parseCity(address: string | undefined): string | null {
  if (!address) return null;
  const parts = address
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.length >= 2 ? parts[parts.length - 2] : parts[parts.length - 1];
}

function parseCountry(address: string | undefined): string | null {
  if (!address) return null;
  const parts = address
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length - 1];
}

function relativeTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function formatDate(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IE", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function topByCount(map: Map<string, number>, limit = 5) {
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ── QA-03 scalability helpers ────────────────────────────────────────
// The list endpoints below used to read ENTIRE collections with
// `.collection(X).get()` then sort/slice in JS. As transactions /
// agreements / activity grow that overruns the function's memory + time
// budget. We now push ordering + a row cap into Firestore and resolve
// the JOINed referenced docs by id (getAll / chunked `in`) instead of
// scanning the whole referenced collection.

// Default cap for endpoints that previously returned EVERY row with no
// JS slice. Generous enough to cover today's data while bounding the
// worst case; the admin tables paginate/sort client-side. Raise this
// (or add cursor pagination) before any single collection is expected
// to exceed it.
const LIST_CAP = 500;

// Firestore allows at most 30 values in an `in`/`array-contains-any`
// filter. Split larger id sets and union the results.
const IN_CHUNK = 30;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Fetch only the docs referenced by `ids` from `col`, keyed by doc id.
// Uses getAll (a single batched read) instead of reading the whole
// collection. Empty input short-circuits (getAll throws on no refs).
async function fetchByIds<T>(col: string, ids: Iterable<string>): Promise<Map<string, T>> {
  const unique = Array.from(new Set(Array.from(ids).filter(Boolean)));
  const map = new Map<string, T>();
  if (unique.length === 0) return map;
  const refs = unique.map((id) => db().collection(col).doc(id));
  const snaps = await db().getAll(...refs);
  for (const s of snaps) if (s.exists) map.set(s.id, s.data() as T);
  return map;
}

// Fetch all docs in `col` whose `field` equals one of `values`, via
// chunked `in` queries (30 per query). Used for JOINs where the join
// key is NOT the doc id (e.g. properties/tenants keyed by ownerId /
// propertyId).
async function fetchWhereIn<T>(
  col: string,
  field: string,
  values: Iterable<string>,
): Promise<Array<{ id: string; data: T }>> {
  const unique = Array.from(new Set(Array.from(values).filter(Boolean)));
  if (unique.length === 0) return [];
  const snaps = await Promise.all(
    chunk(unique, IN_CHUNK).map((c) => db().collection(col).where(field, "in", c).get()),
  );
  const out: Array<{ id: string; data: T }> = [];
  for (const snap of snaps) {
    for (const d of snap.docs) out.push({ id: d.id, data: d.data() as T });
  }
  return out;
}

// ── Range filter ─────────────────────────────────────────────────────
// The SuperAdminDashboard time-range pill (1d / 1w / 1m / 1q / 1y /
// Lifetime) drives *every* widget on the page. Records are scoped by
// their primary timestamp:
//   - users → joinedAt
//   - properties / units / agreements / tenants → createdAt
//   - transactions → timestamp
// The prior equivalent window (rangeStart - ms .. rangeStart) feeds
// the "vs prior period" deltas on the stat cards.

export type DashboardRange = "1d" | "1w" | "1m" | "1q" | "1y" | "all";

const RANGE_MS: Record<Exclude<DashboardRange, "all">, number> = {
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
  "1q": 90 * 24 * 60 * 60 * 1000,
  "1y": 365 * 24 * 60 * 60 * 1000,
};

function parseRange(raw: unknown): DashboardRange {
  if (
    raw === "1d" ||
    raw === "1w" ||
    raw === "1m" ||
    raw === "1q" ||
    raw === "1y" ||
    raw === "all"
  ) {
    return raw;
  }
  return "all";
}

// Bucket definitions for the three time-series charts. Each range
// picks a bucket size that keeps the chart legible: hourly for one
// day, daily for one week / one month, weekly for one quarter,
// monthly for a year or lifetime.
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Bucket {
  startMs: number;
  endMs: number;
  label: string;
}

function buildBuckets(range: DashboardRange, now: Date): Bucket[] {
  const buckets: Bucket[] = [];
  if (range === "1d") {
    // 24 hourly buckets ending at the next hour boundary.
    const end = new Date(now);
    end.setMinutes(0, 0, 0);
    end.setHours(end.getHours() + 1);
    for (let i = 23; i >= 0; i--) {
      const e = new Date(end);
      e.setHours(e.getHours() - i);
      const s = new Date(e);
      s.setHours(s.getHours() - 1);
      buckets.push({
        startMs: s.getTime(),
        endMs: e.getTime(),
        label: `${String(s.getHours()).padStart(2, "0")}:00`,
      });
    }
    return buckets;
  }
  if (range === "1w") {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    for (let i = 6; i >= 0; i--) {
      const s = new Date(end);
      s.setDate(s.getDate() - i - 1);
      const e = new Date(s);
      e.setDate(e.getDate() + 1);
      buckets.push({
        startMs: s.getTime(),
        endMs: e.getTime(),
        label: DAY_LABELS[s.getDay()],
      });
    }
    return buckets;
  }
  if (range === "1m") {
    // 30 daily buckets.
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    for (let i = 29; i >= 0; i--) {
      const s = new Date(end);
      s.setDate(s.getDate() - i - 1);
      const e = new Date(s);
      e.setDate(e.getDate() + 1);
      buckets.push({
        startMs: s.getTime(),
        endMs: e.getTime(),
        label: `${s.getMonth() + 1}/${s.getDate()}`,
      });
    }
    return buckets;
  }
  if (range === "1q") {
    // 13 weekly buckets.
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    for (let i = 12; i >= 0; i--) {
      const s = new Date(end);
      s.setDate(s.getDate() - (i + 1) * 7);
      const e = new Date(s);
      e.setDate(e.getDate() + 7);
      buckets.push({
        startMs: s.getTime(),
        endMs: e.getTime(),
        label: `${s.getMonth() + 1}/${s.getDate()}`,
      });
    }
    return buckets;
  }
  // 1y / all → 12 monthly buckets ending with the current month.
  for (let i = 11; i >= 0; i--) {
    const s = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const e = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    buckets.push({
      startMs: s.getTime(),
      endMs: e.getTime(),
      label: MONTH_LABELS[s.getMonth()],
    });
  }
  return buckets;
}

export interface AdminQueriesDeps {
  requireRole: (...roles: Role[]) => RequestHandler;
  requirePlatformPrivilege: (p: PlatformPrivilegeKey) => RequestHandler;
}

export function registerAdminQueriesRoutes(
  app: Express,
  { requireRole, requirePlatformPrivilege }: AdminQueriesDeps,
): void {
  // GET /api/admin/dashboard — aggregate stats for the
  // SuperAdminDashboard. Pass ?financial=1 for monetary fields
  // (gated by finance.viewAll).
  app.get(
    "/api/admin/dashboard",
    requireAuth,
    requireRole("admin", "superadmin"),
    // Consistent with the sibling list endpoints (GET /api/admin/users,
    // /units, /portfolios all require *.viewAll): the dashboard exposes
    // platform-wide user/owner/tenant/property aggregates + geo distribution,
    // which sub-roles like marketing/sales (users.viewAll = false) are meant to
    // be withheld from. The inline finance.viewAll check below still gates the
    // monetary fields separately.
    requirePlatformPrivilege("users.viewAll"),
    async (req, res) => {
      try {
        // QA-03: these six reads are deliberately LEFT unbounded. Every
        // dashboard figure is a row-level synthesis over the full data
        // set, NOT something Firestore aggregation can reproduce:
        //   - MRR/ARR sum monthlyRent over agreements filtered by BOTH
        //     status === "active" AND createdAt >= rangeStart — two
        //     predicates, one an equality and one an inequality. A
        //     correct .sum() needs status indexed for equality; the
        //     "active users" headline likewise needs status !== suspended
        //     AND joinedAt >= start (two inequalities — illegal in one
        //     query). Neither can be bounded without new indexed fields /
        //     maintained counters.
        //   - occupancy (propertiesRented/Available) is synthesized per
        //     property by joining units + tenants row-by-row.
        //   - the three time-series charts + the prior-window trend
        //     deltas re-scan the whole collections by bucket.
        // Bounding any of these by a limit would silently drop rows from
        // a SUM/COUNT and ship a wrong number — worse than the perf cost.
        // Revisit with maintained aggregate counters (a schema change),
        // not a query tweak.
        const [usersSnap, propsSnap, unitsSnap, agreementsSnap, tenantsSnap, txSnap] =
          await Promise.all([
            db().collection(COL.users).get(),
            db().collection(COL.properties).get(),
            db().collection(COL.units).get(),
            db().collection(COL.agreements).get(),
            db().collection(COL.tenants).get(),
            // `transactions` is the only unbounded-growth collection here (one
            // row per payment, forever). The read count still can't be windowed
            // without a maintained counter (the map paid-status index needs
            // all-time realized rent per tenant — see QA-03 above), but we
            // field-mask to ONLY the columns the dashboard actually reads so we
            // don't deserialize whole rows (proofUrl, names, metadata, …) into
            // memory. If a new consumer needs another tx field, add it here or
            // the figure silently reads as undefined.
            db()
              .collection(COL.transactions)
              .select(
                "type",
                "status",
                "tenantId",
                "rentPeriod",
                "timestamp",
                "amount",
                "applicationFeeCents",
                "feeRefundedCents",
              )
              .get(),
          ]);

        const range = parseRange(req.query.range);

        const allUsers = usersSnap.docs.map((d) => d.data() as User);
        const allProperties = propsSnap.docs.map((d) => d.data() as Property);
        const allUnits = unitsSnap.docs.map((d) => d.data() as Unit);
        // "draft" is a reserved, never-surfaced state (owner + tenant reads
        // already exclude it) — keep it out of admin dashboard counts/activity
        // too, per the rule that ALL agreement reads filter out draft.
        const allAgreements = agreementsSnap.docs
          .map((d) => d.data() as Agreement)
          .filter((a) => a.status !== "draft");
        const allTenants = tenantsSnap.docs.map((d) => d.data() as Tenant);
        const allTransactions = txSnap.docs.map((d) => d.data() as Transaction);

        // Subscription counts come from the Stripe Payments extension
        // — every active subscriber has a `stripeRole` custom claim
        // (advance | pro).
        const paidUids = new Set<string>();
        // The plan each subscriber is on (from their stripeRole claim), so
        // platform MRR/ARR can value each subscription at its plan price.
        const planByPaidUid = new Map<string, OwnerPlanKey>();
        let pageToken: string | undefined;
        do {
          const page = await auth().listUsers(1000, pageToken);
          for (const u of page.users) {
            const claim = (u.customClaims as { stripeRole?: unknown } | undefined)?.stripeRole;
            if (typeof claim === "string" && claim !== "" && claim !== "basic") {
              paidUids.add(u.uid);
              planByPaidUid.set(u.uid, claim as OwnerPlanKey);
            }
          }
          pageToken = page.pageToken;
        } while (pageToken);

        // Plan prices (FIXED in code) → platform subscription revenue.
        // `yearlyAmount` is the annual EUR price; "basic" is 0 and "business"
        // is a custom quote (null → counted as 0, since its real revenue isn't
        // known here). Overlay the canonical prices so a stale stored override
        // can't skew revenue.
        const planLabelsSnap = await db().collection(COL.config).doc(CONFIG_DOC_PLAN_LABELS).get();
        const planPrices = withFixedPlanPrices({
          plans: {
            ...DEFAULT_PLAN_LABELS.plans,
            ...((planLabelsSnap.data() as Partial<PlanLabelsConfig> | undefined)?.plans ?? {}),
          },
          proUpgradeFirstCycleAmount: DEFAULT_PLAN_LABELS.proUpgradeFirstCycleAmount,
        }).plans;
        // Annual revenue contributed by one subscriber's plan.
        const planYearly = (plan?: OwnerPlanKey): number =>
          plan ? (planPrices[plan]?.yearlyAmount ?? 0) : 0;
        const subscriptionArr = (uids: string[]): number =>
          uids.reduce((sum, uid) => sum + planYearly(planByPaidUid.get(uid)), 0);

        const now = new Date();
        // Range boundaries — null for "all". `priorStart..rangeStart`
        // is the prior equivalent window that feeds the "+X%" trend
        // bubbles on the stat cards.
        const ms = range === "all" ? null : RANGE_MS[range];
        const rangeStartIso = ms === null ? null : new Date(now.getTime() - ms).toISOString();
        const priorStartIso = ms === null ? null : new Date(now.getTime() - 2 * ms).toISOString();
        // For range === 'all' we fall back to the legacy MoM/YoY
        // comparison so the Lifetime view keeps showing meaningful
        // deltas instead of "no prior period".
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
        const startOfYear = new Date(now.getFullYear(), 0, 1).toISOString();
        const startOfPrevYear = new Date(now.getFullYear() - 1, 0, 1).toISOString();

        const inRange = (iso: string | null | undefined): boolean =>
          !!iso && (rangeStartIso === null || iso >= rangeStartIso);
        const inPriorRange = (iso: string | null | undefined): boolean =>
          !!iso &&
          rangeStartIso !== null &&
          priorStartIso !== null &&
          iso >= priorStartIso &&
          iso < rangeStartIso;

        // Active filter (current state): suspended users are always
        // excluded from headline counts even at Lifetime. Range
        // filter (joinedAt) applies only when range !== 'all'.
        const activeUsers = allUsers
          .filter((u) => u.status !== "suspended")
          .filter((u) => inRange(u.joinedAt));
        const properties = allProperties.filter((p) => inRange(p.createdAt));
        const agreements = allAgreements.filter((a) => inRange(a.createdAt));
        const units = allUnits.filter((u) => inRange(u.createdAt));
        const tenants = allTenants.filter((t) => inRange(t.createdAt));
        const transactions = allTransactions.filter((t) => inRange(t.timestamp));

        const totalOwners = activeUsers.filter((u) => u.roles?.includes("owner")).length;
        const totalTenants = activeUsers.filter((u) => u.roles?.includes("tenant")).length;
        const dualRoleUsers = activeUsers.filter(
          (u) => u.roles?.includes("owner") && u.roles?.includes("tenant"),
        ).length;
        // Subscriptions: at Lifetime, total active subscribers. With
        // a range, paid users who joined in that window (joinedAt is
        // the closest proxy we have to "subscription started").
        const activeSubscriptions =
          range === "all" ? paidUids.size : activeUsers.filter((u) => paidUids.has(u.id)).length;

        // Platform MRR/ARR = OWNER SUBSCRIPTION revenue paid to Olio, NOT the
        // sum of contracted tenant rent. Tenant rent is GMV that flows to
        // owners — it is not platform revenue. Value each active subscriber at
        // their plan's price (range === "all" → all subscribers; a windowed
        // range → subscribers who joined in-window, the same joinedAt proxy the
        // activeSubscriptions headline uses).
        const subscriberUids =
          range === "all"
            ? Array.from(paidUids)
            : activeUsers.filter((u) => paidUids.has(u.id)).map((u) => u.id);
        const arr = Math.round(subscriptionArr(subscriberUids));
        const mrr = Math.round(arr / 12);
        const totalRealEstateValue = properties.reduce((acc, p) => acc + (p.propertyValue ?? 0), 0);
        // Match /api/admin/units: iterate properties (source of truth)
        // and synthesize a row when no Unit doc exists. We rebuild
        // unit/tenant indices from the range-filtered arrays so
        // rented counts reflect what was added in the window.
        const unitsByProperty = new Map<string, Unit[]>();
        for (const u of units) {
          const list = unitsByProperty.get(u.propertyId) ?? [];
          list.push(u);
          unitsByProperty.set(u.propertyId, list);
        }
        const tenantsByProperty = new Map<string, Tenant[]>();
        for (const t of tenants) {
          const list = tenantsByProperty.get(t.propertyId) ?? [];
          list.push(t);
          tenantsByProperty.set(t.propertyId, list);
        }
        // Occupancy derives from ACTIVE tenancies, never Unit.currentTenantId
        // (never written; owner-created properties have no Unit doc). Active-
        // only matches /api/owner/summary and the PDF briefing — a pending
        // invite generates no revenue and is NOT occupied. For multi-unit
        // (admin) properties a unit is occupied iff an active tenancy points at
        // its id. See services/occupancy.ts.
        let totalUnitRows = 0;
        let propertiesRented = 0;
        for (const prop of properties) {
          const propUnits = unitsByProperty.get(prop.id) ?? [];
          const propTenants = tenantsByProperty.get(prop.id) ?? [];
          if (propUnits.length === 0) {
            totalUnitRows += 1;
            if (propTenants.some((t) => t.status === "active")) {
              propertiesRented += 1;
            }
          } else {
            totalUnitRows += propUnits.length;
            const occupiedUnitIds = new Set(
              propTenants.filter((t) => t.status === "active").map((t) => t.unitId),
            );
            propertiesRented += propUnits.filter((u) => occupiedUnitIds.has(u.id)).length;
          }
        }
        const propertiesAvailable = totalUnitRows - propertiesRented;

        // Trend bubbles. For range === 'all' keep the legacy MoM /
        // YoY semantic (this-month deltas, year-over-year %). For any
        // range, compare the current window to the prior equivalent
        // window directly.
        let usersThisMonth: number;
        let propertiesThisMonth: number;
        let agreementsThisMonth: number;
        let subscriptionsThisMonth: number;
        let arrYoY: number;
        let mrrMoM: number;
        let aumYoY: number;

        if (range === "all") {
          usersThisMonth = allUsers.filter(
            (u) => u.status !== "suspended" && u.joinedAt && u.joinedAt >= startOfMonth,
          ).length;
          propertiesThisMonth = allProperties.filter(
            (p) => p.createdAt && p.createdAt >= startOfMonth,
          ).length;
          agreementsThisMonth = allAgreements.filter(
            (a) => a.createdAt && a.createdAt >= startOfMonth,
          ).length;
          subscriptionsThisMonth = allUsers.filter(
            (u) =>
              u.status !== "suspended" &&
              paidUids.has(u.id) &&
              u.joinedAt &&
              u.joinedAt >= startOfMonth,
          ).length;

          // Subscription revenue (not tenant rent) for the prior windows, using
          // the same joinedAt proxy for "subscription started" as the headline.
          const paidJoinedIn = (lo: string, hi: string): string[] =>
            allUsers
              .filter(
                (u) =>
                  u.status !== "suspended" &&
                  paidUids.has(u.id) &&
                  u.joinedAt &&
                  u.joinedAt >= lo &&
                  u.joinedAt < hi,
              )
              .map((u) => u.id);
          const arrPrevYear = Math.round(
            subscriptionArr(paidJoinedIn(startOfPrevYear, startOfYear)),
          );
          const mrrPrevMonth = Math.round(
            subscriptionArr(paidJoinedIn(startOfPrevMonth, startOfMonth)) / 12,
          );
          const aumPrevYear = allProperties
            .filter(
              (p) => p.createdAt && p.createdAt >= startOfPrevYear && p.createdAt < startOfYear,
            )
            .reduce((acc, p) => acc + (p.propertyValue ?? 0), 0);

          arrYoY = arrPrevYear > 0 ? ((arr - arrPrevYear) / arrPrevYear) * 100 : 0;
          mrrMoM = mrrPrevMonth > 0 ? ((mrr - mrrPrevMonth) / mrrPrevMonth) * 100 : 0;
          aumYoY = aumPrevYear > 0 ? ((totalRealEstateValue - aumPrevYear) / aumPrevYear) * 100 : 0;
        } else {
          // Counts and totals from the prior equivalent window.
          const priorUsers = allUsers.filter(
            (u) => u.status !== "suspended" && inPriorRange(u.joinedAt),
          );
          const priorProperties = allProperties.filter((p) => inPriorRange(p.createdAt));
          const priorAgreements = allAgreements.filter((a) => inPriorRange(a.createdAt));

          // % change from prior window. The "this month" fields are
          // repurposed to be percent change (so the client renders
          // a single label "vs prior 1 day" / "vs prior 1 week" etc).
          const pctChange = (cur: number, prev: number): number =>
            prev > 0 ? ((cur - prev) / prev) * 100 : 0;

          usersThisMonth = Number(pctChange(activeUsers.length, priorUsers.length).toFixed(1));
          propertiesThisMonth = Number(
            pctChange(properties.length, priorProperties.length).toFixed(1),
          );
          agreementsThisMonth = Number(
            pctChange(agreements.length, priorAgreements.length).toFixed(1),
          );
          subscriptionsThisMonth = Number(
            pctChange(
              activeSubscriptions,
              priorUsers.filter((u) => paidUids.has(u.id)).length,
            ).toFixed(1),
          );

          const priorArr = Math.round(
            subscriptionArr(priorUsers.filter((u) => paidUids.has(u.id)).map((u) => u.id)),
          );
          const priorMrr = Math.round(priorArr / 12);
          const priorAum = priorProperties.reduce((acc, p) => acc + (p.propertyValue ?? 0), 0);

          arrYoY = pctChange(arr, priorArr);
          mrrMoM = pctChange(mrr, priorMrr);
          aumYoY = pctChange(totalRealEstateValue, priorAum);
        }

        // Location aggregations — driven by range-filtered properties
        // so "Top properties · cities" reflects what was added in the
        // selected window.
        const propsByCity = new Map<string, number>();
        const propsByCountry = new Map<string, number>();
        const rentSumByCity = new Map<string, { sum: number; n: number }>();
        const rentSumByCountry = new Map<string, { sum: number; n: number }>();
        const usersByCity = new Map<string, Set<string>>();
        const usersByCountry = new Map<string, Set<string>>();

        const propIndex = new Map(properties.map((p) => [p.id, p]));
        for (const p of properties) {
          const city = p.city ?? parseCity(p.address);
          const country = p.country ?? parseCountry(p.address);
          if (city) propsByCity.set(city, (propsByCity.get(city) ?? 0) + 1);
          if (country) propsByCountry.set(country, (propsByCountry.get(country) ?? 0) + 1);
          if (city) {
            if (!usersByCity.has(city)) usersByCity.set(city, new Set());
            usersByCity.get(city)!.add(p.ownerId);
          }
          if (country) {
            if (!usersByCountry.has(country)) usersByCountry.set(country, new Set());
            usersByCountry.get(country)!.add(p.ownerId);
          }
        }
        for (const u of units) {
          if (!u.rentAmount) continue;
          const p = propIndex.get(u.propertyId);
          if (!p) continue;
          const city = p.city ?? parseCity(p.address);
          const country = p.country ?? parseCountry(p.address);
          if (city) {
            const cur = rentSumByCity.get(city) ?? { sum: 0, n: 0 };
            cur.sum += u.rentAmount;
            cur.n += 1;
            rentSumByCity.set(city, cur);
          }
          if (country) {
            const cur = rentSumByCountry.get(country) ?? { sum: 0, n: 0 };
            cur.sum += u.rentAmount;
            cur.n += 1;
            rentSumByCountry.set(country, cur);
          }
        }
        // Owner-created properties have no Unit rows, so the loop above never
        // counts their rent into city/country averages. Add each unit-less
        // property's ACTIVE-tenancy rent so "average rental by city/country"
        // isn't silently missing every owner property.
        for (const t of tenants) {
          if (t.status !== "active" || !t.rentAmount) continue;
          if ((unitsByProperty.get(t.propertyId) ?? []).length > 0) continue;
          const p = propIndex.get(t.propertyId);
          if (!p) continue;
          const city = p.city ?? parseCity(p.address);
          const country = p.country ?? parseCountry(p.address);
          if (city) {
            const cur = rentSumByCity.get(city) ?? { sum: 0, n: 0 };
            cur.sum += t.rentAmount;
            cur.n += 1;
            rentSumByCity.set(city, cur);
          }
          if (country) {
            const cur = rentSumByCountry.get(country) ?? { sum: 0, n: 0 };
            cur.sum += t.rentAmount;
            cur.n += 1;
            rentSumByCountry.set(country, cur);
          }
        }

        const usersByCityCount = new Map<string, number>();
        usersByCity.forEach((v, k) => usersByCityCount.set(k, v.size));
        const usersByCountryCount = new Map<string, number>();
        usersByCountry.forEach((v, k) => usersByCountryCount.set(k, v.size));

        // Per-tenancy realized-rent index for the map pills, so a marker's
        // status is DERIVED from the ledger like every other surface rather
        // than read from the never-updated Unit.paymentStatus (which defaulted
        // to a misleading green "paid" — the least-safe default — for any unit
        // with no value, so the same tenancy could read PAID on the map but
        // OVERDUE on the owner dashboard).
        const mapToday = new Date().toISOString().slice(0, 10);
        const mapPaidTenancies = new Set<string>();
        const mapPaidPeriods = new Map<string, Set<string>>();
        for (const tx of allTransactions) {
          if (!isRealizedRent(tx) || !tx.tenantId) continue;
          mapPaidTenancies.add(tx.tenantId);
          if (tx.rentPeriod) {
            const set = mapPaidPeriods.get(tx.tenantId) ?? new Set<string>();
            set.add(tx.rentPeriod.slice(0, 10));
            mapPaidPeriods.set(tx.tenantId, set);
          }
        }
        const mapMarkers = properties
          .filter((p) => typeof p.lat === "number" && typeof p.lng === "number")
          .map((p) => {
            const propUnits = unitsByProperty.get(p.id) ?? [];
            const firstUnit = propUnits[0];
            // Tenant + rent from the ACTIVE tenancy, not Unit.currentTenantId
            // (never written; owner-created properties have no Unit doc, so
            // every owner property used to render "Vacant / €0" on the map).
            const activeTenant = (tenantsByProperty.get(p.id) ?? []).find(
              (t) => t.status === "active",
            );
            const due = (activeTenant?.nextPayment ?? firstUnit?.nextPaymentDate ?? "").slice(
              0,
              10,
            );
            return {
              id: p.id,
              lat: p.lat!,
              lng: p.lng!,
              address: p.address,
              tenantName: activeTenant?.name ?? "Vacant",
              rentAmount: activeTenant?.rentAmount ?? firstUnit?.rentAmount ?? 0,
              paymentStatus: activeTenant
                ? derivePaymentStatus({
                    nextDue: due,
                    today: mapToday,
                    currentCyclePaid:
                      !!due && (mapPaidPeriods.get(activeTenant.id)?.has(due) ?? false),
                    hasSettledHistory: mapPaidTenancies.has(activeTenant.id),
                  })
                : ("pending" as const),
              image: p.image ?? null,
              // Property valuation surfaced in the map-pin popup (alongside
              // rent). Financial detail → zeroed below for non-finance admins.
              value: p.propertyValue ?? 0,
            };
          });

        // ── Time-series charts ──
        // Bucket size adapts to the selected range so a 1-day view
        // shows hourly granularity, a quarter shows weekly, a year /
        // lifetime shows monthly. Each chart pulls from the full
        // collection (not the range-filtered copy) and lets the
        // bucket boundaries do the windowing — that way the lifetime
        // view still shows the most recent 12 months instead of all
        // history collapsed onto one bar.
        const buckets = buildBuckets(range, now);

        const monthlySeriesBuckets = buckets.map((b) => ({
          ...b,
          revenue: 0,
          volume: 0,
        }));
        for (const t of allTransactions) {
          // Realized income only — excludes unverified pending offline rent
          // (shared predicate; also keeps legacy no-status income counted).
          if (!isRealizedRent(t)) continue;
          const ts = new Date(t.timestamp).getTime();
          if (Number.isNaN(ts)) continue;
          const bucket = monthlySeriesBuckets.find((b) => ts >= b.startMs && ts < b.endMs);
          if (!bucket) continue;
          // Net of any cardholder refund (refundedAmountCents) stamped on the
          // row by charge.refunded — so volume (GMV) doesn't keep counting
          // money that was returned.
          bucket.volume += netRealizedRentAmount(t);
          if (typeof t.applicationFeeCents === "number") {
            // Platform commission, NET of any application-fee refunded back to
            // the owner (feeRefundedCents). Without this subtraction the
            // platform-revenue series stays overstated after every refund.
            const feeRefunded = Math.max(0, Number(t.feeRefundedCents) || 0);
            bucket.revenue += Math.max(0, t.applicationFeeCents - feeRefunded) / 100;
          }
        }
        const monthlySeriesOut = monthlySeriesBuckets.map((b) => ({
          month: b.label,
          revenue: Math.round(b.revenue),
          volume: Math.round(b.volume),
        }));

        // Activity: new transactions + new properties + new
        // agreements per bucket.
        const activityBuckets = buckets.map((b) => ({ ...b, value: 0 }));
        const bumpActivity = (iso: string | undefined | null) => {
          if (!iso) return;
          const ts = new Date(iso).getTime();
          if (Number.isNaN(ts)) return;
          const bucket = activityBuckets.find((b) => ts >= b.startMs && ts < b.endMs);
          if (bucket) bucket.value += 1;
        };
        for (const t of allTransactions) bumpActivity(t.timestamp);
        for (const p of allProperties) bumpActivity(p.createdAt);
        for (const a of allAgreements) bumpActivity(a.createdAt);
        const weeklyActivityOut = activityBuckets.map(({ label, value }) => ({
          day: label,
          value,
        }));

        // Unit growth: cumulative unit-row count at the end of each
        // bucket. One row per Unit when present, else one row for
        // the bare Property — same shape as /admin/units.
        const unitsByPropertyId = new Map<string, Unit[]>();
        for (const u of allUnits) {
          const list = unitsByPropertyId.get(u.propertyId) ?? [];
          list.push(u);
          unitsByPropertyId.set(u.propertyId, list);
        }
        const unitRowCreatedAtsMs: number[] = [];
        for (const p of allProperties) {
          const propUnits = unitsByPropertyId.get(p.id) ?? [];
          if (propUnits.length === 0) {
            if (p.createdAt) {
              const t = new Date(p.createdAt).getTime();
              if (!Number.isNaN(t)) unitRowCreatedAtsMs.push(t);
            }
          } else {
            for (const u of propUnits) {
              if (u.createdAt) {
                const t = new Date(u.createdAt).getTime();
                if (!Number.isNaN(t)) unitRowCreatedAtsMs.push(t);
              }
            }
          }
        }
        unitRowCreatedAtsMs.sort((a, b) => a - b);
        const unitGrowthOut = buckets.map((b) => ({
          month: b.label,
          units: unitRowCreatedAtsMs.filter((t) => t < b.endMs).length,
        }));

        // Explicit opt-in for financial fields via ?financial=1.
        // Without the flag, every monetary/growth number is zeroed
        // before send — even a DevTools peek can't read platform
        // financials. With the flag, the caller must hold
        // finance.viewAll (403 otherwise). UI passes the flag only
        // when canPlatform('finance.viewAll') is true.
        const wantsFin = req.query.financial === "1";
        const canFin = await hasPlatformPrivilege(req.user?.profile, "finance.viewAll");
        if (wantsFin && !canFin) {
          return res.status(403).json({
            error: "Requesting financial fields requires the finance.viewAll privilege.",
          });
        }
        const includeFin = wantsFin && canFin;

        const avgRentalCities = Array.from(rentSumByCity.entries())
          .map(([name, { sum, n }]) => ({ name, price: Math.round(sum / n) }))
          .sort((a, b) => b.price - a.price)
          .slice(0, 5);
        const avgRentalCountries = Array.from(rentSumByCountry.entries())
          .map(([name, { sum, n }]) => ({ name, price: Math.round(sum / n) }))
          .sort((a, b) => b.price - a.price)
          .slice(0, 5);

        res.json({
          range,
          stats: {
            arr: includeFin ? arr : 0,
            mrr: includeFin ? mrr : 0,
            totalRealEstateValue: includeFin ? totalRealEstateValue : 0,
            activeSubscriptions,
            totalProperties: totalUnitRows,
            totalUsers: activeUsers.length,
            totalAgreements: agreements.length,
            totalOwners,
            totalTenants,
            dualRoleUsers,
            propertiesRented,
            propertiesAvailable,
          },
          trends: {
            arrYoY: includeFin ? Number(arrYoY.toFixed(1)) : 0,
            mrrMoM: includeFin ? Number(mrrMoM.toFixed(1)) : 0,
            aumYoY: includeFin ? Number(aumYoY.toFixed(1)) : 0,
            subscriptionsThisMonth,
            propertiesThisMonth,
            usersThisMonth,
            agreementsThisMonth,
          },
          monthlySeries: includeFin ? monthlySeriesOut : [],
          weeklyActivity: weeklyActivityOut,
          unitGrowth: unitGrowthOut,
          topProperties: {
            cities: topByCount(propsByCity),
            countries: topByCount(propsByCountry),
          },
          topUsers: {
            cities: topByCount(usersByCityCount),
            countries: topByCount(usersByCountryCount),
          },
          avgRental: {
            cities: includeFin ? avgRentalCities : avgRentalCities.map((c) => ({ ...c, price: 0 })),
            countries: includeFin
              ? avgRentalCountries
              : avgRentalCountries.map((c) => ({ ...c, price: 0 })),
          },
          mapMarkers: includeFin
            ? mapMarkers
            : mapMarkers.map((m) => ({ ...m, rentAmount: 0, value: 0 })),
        });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load dashboard") });
      }
    },
  );

  // GET /api/admin/audit-log — combined feed of admin actions.
  // Two source collections, surfaced as one stream so superadmins can
  // see "what staff did over the last N days" without bouncing
  // between pages: impersonations/{id} and userAudit/{id}. Cursor-
  // based pagination via `?before=<ISO>`. Filters: ?actorUid,
  // ?targetUid, ?type=impersonation|user-audit. Gated on
  // users.viewAll — audit-trail access is naturally part of "see
  // who/what is on the platform".
  // Self-initiated end-user account events (userAudit rows where the
  // actor is also the target) are excluded — this feed is admin
  // activity only, not users managing their own login.
  app.get(
    "/api/admin/audit-log",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("users.viewAll"),
    async (req, res) => {
      try {
        const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
        const before = typeof req.query.before === "string" ? req.query.before : null;
        const actorUid = typeof req.query.actorUid === "string" ? req.query.actorUid : null;
        const targetUid = typeof req.query.targetUid === "string" ? req.query.targetUid : null;
        const typeFilter =
          req.query.type === "impersonation" || req.query.type === "user-audit"
            ? req.query.type
            : null;

        // Fetch up to `limit` from each collection (so the merged
        // page can render `limit` after sort+dedup). Filters applied
        // server-side. Order desc by createdAt.
        const buildQuery = (col: string): FirebaseFirestore.Query => {
          let q: FirebaseFirestore.Query = db()
            .collection(col)
            .orderBy("createdAt", "desc")
            .limit(limit);
          if (before) q = q.startAfter(before);
          if (actorUid) q = q.where("actorUid", "==", actorUid);
          if (targetUid) q = q.where("targetUid", "==", targetUid);
          return q;
        };

        const shouldFetchImpersonations = !typeFilter || typeFilter === "impersonation";
        const shouldFetchUserAudit = !typeFilter || typeFilter === "user-audit";

        const [imperSnap, auditSnap] = await Promise.all([
          shouldFetchImpersonations ? buildQuery(COL.impersonations).get() : Promise.resolve(null),
          shouldFetchUserAudit ? buildQuery(COL.userAudit).get() : Promise.resolve(null),
        ]);

        interface AuditEntry {
          id: string;
          type: "impersonation" | "user-audit";
          actorUid: string;
          actorEmail: string;
          targetUid: string;
          targetEmail: string;
          createdAt: string;
          beforeRoles?: string[];
          afterRoles?: string[];
          beforePlatformRole?: string | null;
          afterPlatformRole?: string | null;
          beforeStatus?: string;
          afterStatus?: string;
          action?: string;
        }

        const merged: AuditEntry[] = [];
        if (imperSnap) {
          for (const d of imperSnap.docs) {
            const data = d.data() as ImpersonationLog;
            merged.push({
              id: d.id,
              type: "impersonation",
              actorUid: data.actorUid,
              actorEmail: data.actorEmail,
              targetUid: data.targetUid,
              targetEmail: data.targetEmail,
              createdAt: data.createdAt,
            });
          }
        }
        if (auditSnap) {
          for (const d of auditSnap.docs) {
            const data = d.data() as UserAuditEntry;
            // Admin-activity feed only. userAudit ALSO records self-initiated
            // end-user account events (add/remove password, connect/disconnect
            // Google, request email change, self-delete) — the writers tag
            // those by naming the same uid as actor + target (see profile.ts).
            // Those aren't staff actions, so drop them: the log should read as
            // "what admins did", matching this endpoint's stated purpose.
            if (data.actorUid === data.targetUid) continue;
            merged.push({
              id: d.id,
              type: "user-audit",
              actorUid: data.actorUid,
              actorEmail: data.actorEmail,
              targetUid: data.targetUid,
              targetEmail: data.targetEmail,
              createdAt: data.createdAt,
              beforeRoles: data.beforeRoles,
              afterRoles: data.afterRoles,
              beforePlatformRole: data.beforePlatformRole,
              afterPlatformRole: data.afterPlatformRole,
              beforeStatus: data.beforeStatus,
              afterStatus: data.afterStatus,
              action: data.action,
            });
          }
        }
        merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        // The page boundary must not split a group of entries that share the
        // same createdAt. The next page uses an EXCLUSIVE createdAt cursor
        // (startAfter below), so any same-timestamp sibling left just past a
        // naive slice(0, limit) — especially one from the OTHER collection —
        // would be skipped forever: a silent audit gap that could hide an
        // actor's action from an investigator. Extend the cut to include the
        // whole boundary-timestamp group, then advance the cursor past it.
        let cut = Math.min(limit, merged.length);
        if (cut > 0 && cut < merged.length) {
          const boundaryTs = merged[cut - 1].createdAt;
          while (cut < merged.length && merged[cut].createdAt === boundaryTs) {
            cut++;
          }
        }
        const page = merged.slice(0, cut);
        // Keep paginating while there's more in the merged buffer OR a source
        // collection was capped at `limit` (older rows may be unfetched).
        // startAfter(nextCursor) then skips the fully-returned boundary group.
        const hitCap = (imperSnap?.size ?? 0) >= limit || (auditSnap?.size ?? 0) >= limit;
        const nextCursor =
          page.length > 0 && (cut < merged.length || hitCap)
            ? page[page.length - 1].createdAt
            : null;

        res.json({ items: page, nextCursor });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load audit log") });
      }
    },
  );

  // GET /api/admin/users — list of all users with derived counts.
  app.get(
    "/api/admin/users",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("users.viewAll"),
    async (req, res) => {
      try {
        // Contact PII (phone + home address) is more sensitive than the
        // name/email/status the user table needs. Gate it behind
        // users.manage so the support/sales sub-roles — which hold
        // users.viewAll but NOT users.manage — can't bulk-harvest every
        // owner/tenant's phone number and home address in one request.
        const canSeeContactPII = await hasPlatformPrivilege(req.user?.profile, "users.manage");
        // QA-03: bound the primary read — newest LIST_CAP users, ordered
        // server-side (was: read the entire users collection plus the
        // whole properties + tenants collections). The admin table
        // sorts/filters client-side.
        const usersSnap = await db()
          .collection(COL.users)
          .orderBy("joinedAt", "desc")
          .limit(LIST_CAP)
          .get();
        const users = usersSnap.docs.map((d) => d.data() as User);
        const userIds = users.map((u) => u.id);

        // QA-03: properties + tenants are joined only for the bounded
        // users' derived counts, so fetch just the rows that reference
        // them (chunked `in`) instead of scanning both collections.
        // A tenant row attaches to a bounded user either as its owner
        // (ownerId) or as the renter (userId); union both, de-duped.
        const [propRows, tenantOwnerRows, tenantUserRows] = await Promise.all([
          fetchWhereIn<Property>(COL.properties, "ownerId", userIds),
          fetchWhereIn<Tenant>(COL.tenants, "ownerId", userIds),
          fetchWhereIn<Tenant>(COL.tenants, "userId", userIds),
        ]);
        const properties = propRows.map((r) => r.data);
        const tenantMap = new Map<string, Tenant>();
        for (const r of tenantOwnerRows) tenantMap.set(r.id, r.data);
        for (const r of tenantUserRows) tenantMap.set(r.id, r.data);
        const tenants = Array.from(tenantMap.values());

        // Plan is owned by the Stripe Payments extension, which
        // writes a `stripeRole` custom claim on the Firebase Auth
        // user. Pull every user's claims in one paged scan so the
        // admin table reflects the billing system (not a stale
        // Firestore cache).
        const stripeRoleByUid = new Map<string, string>();
        let pageToken: string | undefined;
        do {
          const page = await auth().listUsers(1000, pageToken);
          for (const u of page.users) {
            const claim = (u.customClaims as { stripeRole?: unknown } | undefined)?.stripeRole;
            if (typeof claim === "string") stripeRoleByUid.set(u.uid, claim);
          }
          pageToken = page.pageToken;
        } while (pageToken);

        // Properties are units in this app — owner-created properties
        // don't create a separate Unit row, so counts must come from
        // properties + tenants directly.
        const propByOwner = new Map<string, string[]>();
        for (const p of properties) {
          const list = propByOwner.get(p.ownerId) ?? [];
          list.push(p.id);
          propByOwner.set(p.ownerId, list);
        }
        // "Rented" = an ACTIVE tenancy only (a pending/invited/expired row is
        // not currently rented), matching the unified occupancy definition
        // used everywhere else (occupancy.ts, dashboard, owner summary).
        const rentedOutByOwner = new Map<string, Set<string>>();
        for (const t of tenants) {
          if (!t.ownerId || !t.propertyId) continue;
          if (t.status !== "active") continue;
          const set = rentedOutByOwner.get(t.ownerId) ?? new Set<string>();
          set.add(t.propertyId);
          rentedOutByOwner.set(t.ownerId, set);
        }
        const rentedInByTenantUid = new Map<string, Set<string>>();
        for (const t of tenants) {
          if (!t.userId || !t.propertyId) continue;
          if (t.status !== "active") continue;
          const set = rentedInByTenantUid.get(t.userId) ?? new Set<string>();
          set.add(t.propertyId);
          rentedInByTenantUid.set(t.userId, set);
        }

        const cap = (s: string) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1));
        // Map the stripeRole claim to a display label. Mirrors OwnerPlanKey
        // (basic|advance|pro|business). A `business` claim (e.g. a comped
        // Business owner) previously fell through to "Free" here even though
        // the dashboard subscriber metric counts it as paid (L-11); give it
        // its own branch so it reads "Business".
        const planLabel = (uid: string): "Free" | "Advance" | "Pro" | "Business" => {
          const role = stripeRoleByUid.get(uid);
          if (role === "advance") return "Advance";
          if (role === "pro") return "Pro";
          if (role === "business") return "Business";
          return "Free";
        };

        const rows = users.map((u) => {
          const ownedIds = propByOwner.get(u.id) ?? [];
          const unitsOwned = ownedIds.length;
          const unitsRentedOut = rentedOutByOwner.get(u.id)?.size ?? 0;
          const unitsRentedIn = rentedInByTenantUid.get(u.id)?.size ?? 0;
          return {
            id: u.id,
            email: u.email,
            firstName: u.firstName ?? "",
            lastName: u.lastName ?? "",
            name: `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email,
            phone: canSeeContactPII ? (u.phone ?? "") : "",
            address: canSeeContactPII ? (u.address ?? "") : "",
            photoURL: u.photoURL ?? null,
            roles: (u.roles ?? []).map((r) => cap(r)),
            rawRoles: u.roles ?? [],
            platformRole: u.platformRole ?? null,
            status: cap(u.status ?? "active"),
            rawStatus: u.status,
            plan: planLabel(u.id),
            joinDate: (u.joinedAt ?? "").slice(0, 10),
            joinedAt: u.joinedAt ?? "",
            lastLogin: relativeTime(u.lastLoginAt),
            lastLoginAt: u.lastLoginAt ?? null,
            lastSeen: relativeTime(u.lastSeenAt),
            lastSeenAt: u.lastSeenAt ?? null,
            unitsAssociated: unitsOwned + unitsRentedIn,
            unitsOwned,
            unitsRentedOut,
            unitsRentedIn,
          };
        });

        res.json(rows);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load users") });
      }
    },
  );

  // GET /api/admin/units — units with denormalized property + tenant
  // info. Pass ?financial=1 to include monetary fields (gated by
  // finance.viewAll).
  app.get(
    "/api/admin/units",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("properties.viewAll"),
    async (req, res) => {
      try {
        // QA-03: bound the primary read — newest LIST_CAP properties,
        // ordered server-side (properties are the source of truth here;
        // each emits one or more unit rows). Was: read the entire
        // properties collection + four more whole collections.
        const propsSnap = await db()
          .collection(COL.properties)
          .orderBy("createdAt", "desc")
          .limit(LIST_CAP)
          .get();
        const properties = propsSnap.docs.map((d) => d.data() as Property);
        const propertyIds = properties.map((p) => p.id);

        // QA-03: units + tenants joined by propertyId (chunked `in`),
        // owners by id (getAll), and transactions scoped to the
        // referenced property/unit ids — instead of reading those whole
        // collections.
        const [unitRows, tenantRows] = await Promise.all([
          fetchWhereIn<Unit>(COL.units, "propertyId", propertyIds),
          fetchWhereIn<Tenant>(COL.tenants, "propertyId", propertyIds),
        ]);
        const units = unitRows.map((r) => r.data);
        const tenants = tenantRows.map((r) => r.data);
        const unitIds = units.map((u) => u.id);

        const [userIndex, txByProperty, txByUnit] = await Promise.all([
          fetchByIds<User>(
            COL.users,
            properties.map((p) => p.ownerId),
          ),
          fetchWhereIn<Transaction>(COL.transactions, "propertyId", propertyIds),
          fetchWhereIn<Transaction>(COL.transactions, "unitId", unitIds),
        ]);
        // Union the two tx fetches, de-duped by id, so a tx that carries
        // both propertyId AND unitId is counted once into each bucket
        // exactly as the original single-pass loop did.
        const txMap = new Map<string, Transaction>();
        for (const r of txByProperty) txMap.set(r.id, r.data);
        for (const r of txByUnit) txMap.set(r.id, r.data);
        const txs = Array.from(txMap.values());

        // Owner-created properties don't always generate a Unit row,
        // so we iterate properties (the source of truth) and merge
        // unit data when it exists. Group units/tenants by propertyId
        // for the lookup.
        const unitsByProperty = new Map<string, Unit[]>();
        for (const u of units) {
          const list = unitsByProperty.get(u.propertyId) ?? [];
          list.push(u);
          unitsByProperty.set(u.propertyId, list);
        }
        const tenantsByProperty = new Map<string, Tenant[]>();
        for (const t of tenants) {
          const list = tenantsByProperty.get(t.propertyId) ?? [];
          list.push(t);
          tenantsByProperty.set(t.propertyId, list);
        }
        const collectedByUnit = new Map<string, number>();
        const collectedByProperty = new Map<string, number>();
        // Per-tenancy realized-rent index so the admin Paid/Pending/Overdue
        // pill is DERIVED from the rent ledger (same shared predicate as the
        // owner + tenant surfaces) instead of the raw Unit.paymentStatus field,
        // which no rent payment ever updates (it was permanently "pending" for
        // admin units and the "Overdue" filter could never surface real
        // overdue tenancies).
        const tenanciesWithPaidRent = new Set<string>();
        const paidPeriodsByTenancy = new Map<string, Set<string>>();
        for (const tx of txs) {
          // Collected total = realized income only (excludes pending offline
          // rent; shared predicate keeps legacy no-status income counted).
          if (!isRealizedRent(tx)) continue;
          if (tx.unitId) {
            collectedByUnit.set(tx.unitId, (collectedByUnit.get(tx.unitId) ?? 0) + tx.amount);
          }
          if (tx.propertyId) {
            collectedByProperty.set(
              tx.propertyId,
              (collectedByProperty.get(tx.propertyId) ?? 0) + tx.amount,
            );
          }
          if (tx.tenantId) {
            tenanciesWithPaidRent.add(tx.tenantId);
            if (tx.rentPeriod) {
              const set = paidPeriodsByTenancy.get(tx.tenantId) ?? new Set<string>();
              set.add(tx.rentPeriod.slice(0, 10));
              paidPeriodsByTenancy.set(tx.tenantId, set);
            }
          }
        }
        const adminToday = new Date().toISOString().slice(0, 10);
        // Pill for an admin row: derive from the ledger when there's an active
        // tenancy, else "pending" (vacant/awaiting). `due` prefers the tenancy's
        // advanced date over the never-advanced Unit.nextPaymentDate.
        const adminPaymentStatus = (
          tenant: Tenant | undefined,
          unitNextPaymentDate?: string | null,
        ): "paid" | "pending" | "overdue" => {
          if (!tenant || tenant.status !== "active") return "pending";
          const due = (tenant.nextPayment ?? unitNextPaymentDate ?? "").slice(0, 10);
          return derivePaymentStatus({
            nextDue: due,
            today: adminToday,
            currentCyclePaid: !!due && (paidPeriodsByTenancy.get(tenant.id)?.has(due) ?? false),
            hasSettledHistory: tenanciesWithPaidRent.has(tenant.id),
          });
        };

        // Full property-level descriptors used by the admin edit
        // drawer to hydrate without a second fetch. Kept as a helper
        // so the no-unit and with-units row builders below don't
        // drift.
        const propertyDescriptors = (prop: Property) => ({
          propertyType: prop.propertyType ?? null,
          buildingName: prop.buildingName ?? null,
          floor: prop.floor ?? null,
          sqm: prop.sqm ?? null,
          builtYear: prop.builtYear ?? null,
          energyClass: prop.energyClass ?? null,
          parking: prop.parking ?? null,
          elevator: prop.elevator ?? null,
          heating: prop.heating ?? null,
          cooling: prop.cooling ?? null,
          solarPanels: prop.solarPanels ?? null,
          storageUnit: prop.storageUnit ?? null,
          ownershipType: prop.ownershipType ?? null,
          companyName: prop.companyName ?? null,
          titleDeedsStatus: prop.titleDeedsStatus ?? null,
          developmentStatus: prop.developmentStatus ?? null,
          propertyUse: prop.propertyUse ?? null,
          acquisitionYear: prop.acquisitionYear ?? null,
          developmentYear: prop.developmentYear ?? null,
          rentPrice: prop.rentPrice ?? null,
        });

        const rows = properties.flatMap((prop) => {
          const owner = userIndex.get(prop.ownerId);
          const ownerName = owner
            ? `${owner.firstName ?? ""} ${owner.lastName ?? ""}`.trim() || owner.email
            : "—";
          const ownerEmail = owner?.email ?? null;
          const propUnits = unitsByProperty.get(prop.id) ?? [];
          const propTenants = tenantsByProperty.get(prop.id) ?? [];
          const descriptors = propertyDescriptors(prop);

          // No unit row yet (owner-created property): emit a single
          // row using property + tenant data so the property still
          // appears in the table.
          if (propUnits.length === 0) {
            const tenant = propTenants.find((t) => t.status === "active" || t.status === "pending");
            return [
              {
                id: prop.id,
                propertyId: prop.id,
                ownerId: prop.ownerId,
                ownerName,
                ownerEmail,
                address: prop.address ?? "",
                unitLabel: null,
                tenantName: tenant?.name ?? "Vacant",
                tenantId: tenant?.id ?? null,
                rentAmount: tenant?.rentAmount ?? 0,
                paymentStatus: adminPaymentStatus(tenant),
                image: prop.image ?? null,
                nextPaymentDate: tenant?.nextPayment ?? null,
                leaseEnd: null,
                propertyValue: prop.propertyValue ?? 0,
                acquisitionPrice: prop.acquisitionPrice ?? 0,
                totalCollected: collectedByProperty.get(prop.id) ?? 0,
                lat: prop.lat ?? null,
                lng: prop.lng ?? null,
                city: prop.city ?? parseCity(prop.address),
                country: prop.country ?? parseCountry(prop.address),
                postalCode: prop.postalCode ?? null,
                ...descriptors,
              },
            ];
          }

          return propUnits.map((u) => {
            // Tenant from the ACTIVE tenancy pointing at this unit, not
            // Unit.currentTenantId (never written). See services/occupancy.ts.
            const tenant = propTenants.find((t) => t.unitId === u.id && t.status === "active");
            return {
              id: u.id,
              propertyId: prop.id,
              ownerId: prop.ownerId,
              ownerName,
              ownerEmail,
              address: prop.address ?? "",
              unitLabel: u.label ?? null,
              tenantName: tenant?.name ?? "Vacant",
              tenantId: tenant?.id ?? null,
              rentAmount: u.rentAmount ?? 0,
              paymentStatus: adminPaymentStatus(tenant, u.nextPaymentDate),
              image: prop.image ?? null,
              nextPaymentDate: tenant?.nextPayment ?? u.nextPaymentDate ?? null,
              leaseEnd: u.leaseEnd ?? null,
              propertyValue: prop.propertyValue ?? 0,
              acquisitionPrice: prop.acquisitionPrice ?? 0,
              totalCollected: collectedByUnit.get(u.id) ?? 0,
              lat: prop.lat ?? null,
              lng: prop.lng ?? null,
              city: prop.city ?? parseCity(prop.address),
              country: prop.country ?? parseCountry(prop.address),
              postalCode: prop.postalCode ?? null,
              ...descriptors,
            };
          });
        });

        const wantsFin = req.query.financial === "1";
        const canFin = await hasPlatformPrivilege(req.user?.profile, "finance.viewAll");
        if (wantsFin && !canFin) {
          return res.status(403).json({
            error: "Requesting financial fields requires the finance.viewAll privilege.",
          });
        }
        const includeFin = wantsFin && canFin;
        const out = includeFin
          ? rows
          : rows.map((r) => ({
              ...r,
              rentAmount: 0,
              propertyValue: 0,
              acquisitionPrice: 0,
              totalCollected: 0,
              rentPrice: null,
            }));
        res.json(out);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load units") });
      }
    },
  );

  // GET /api/admin/portfolios — one row per owner: unit count, role
  // contacts, rented-out count, total portfolio value.
  app.get(
    "/api/admin/portfolios",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("properties.viewAll"),
    async (req, res) => {
      try {
        // QA-03: LEFT unbounded. The output is one row per OWNER sorted
        // by unitsCount (a derived aggregate), not a time-ordered list —
        // there is no timestamp field to order+limit on that matches the
        // rendered ordering. Capping users by joinedAt would drop the
        // oldest owners from a unit-count-sorted table, changing which
        // portfolios appear (a wrong result set, not just a slow one).
        // Each row's unitsCount/totalValue also sums every property the
        // owner holds, so the properties read can't be bounded either.
        // Needs maintained per-owner counters to bound safely.
        const [usersSnap, propsSnap, tenantsSnap, contactsSnap] = await Promise.all([
          db().collection(COL.users).get(),
          db().collection(COL.properties).get(),
          db().collection(COL.tenants).get(),
          db().collection(COL.portfolioAccessContacts).get(),
        ]);

        const users = usersSnap.docs.map((d) => d.data() as User);
        const properties = propsSnap.docs.map((d) => d.data() as Property);
        const tenants = tenantsSnap.docs.map((d) => d.data() as Tenant);
        const contacts = contactsSnap.docs.map((d) => d.data() as PortfolioAccessContact);

        const propsByOwner = new Map<string, Property[]>();
        for (const p of properties) {
          const list = propsByOwner.get(p.ownerId) ?? [];
          list.push(p);
          propsByOwner.set(p.ownerId, list);
        }
        const rentedPropsByOwner = new Map<string, Set<string>>();
        for (const t of tenants) {
          if (!t.ownerId || !t.propertyId) continue;
          // Active only — a pending invite generates no revenue and is NOT
          // rented, matching the unified occupancy definition (occupancy.ts,
          // the dashboard, owner summary, askOlio, audiences). Counting pending
          // here made this column disagree with every other surface.
          if (t.status !== "active") continue;
          const set = rentedPropsByOwner.get(t.ownerId) ?? new Set<string>();
          set.add(t.propertyId);
          rentedPropsByOwner.set(t.ownerId, set);
        }
        const contactsByOwner = new Map<string, PortfolioAccessContact[]>();
        for (const c of contacts) {
          const list = contactsByOwner.get(c.ownerId) ?? [];
          list.push(c);
          contactsByOwner.set(c.ownerId, list);
        }

        const rows = users
          .filter((u) => (u.roles ?? []).includes("owner"))
          .map((u) => {
            const ownedProps = propsByOwner.get(u.id) ?? [];
            const ownerName = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email;
            const portfolioName = `${ownerName}'s Portfolio`;
            const ownerContacts = contactsByOwner.get(u.id) ?? [];
            // Roles on the portfolio: owner is implicit; access
            // contacts add legacy / legal / financial slots when
            // active.
            const roleLabelByType: Record<string, string> = {
              legacy: "Legacy Owner",
              legal: "Legal",
              financial: "Financial",
            };
            const roles = [
              "Owner",
              ...ownerContacts
                .filter((c) => c.status === "active")
                .map((c) => roleLabelByType[c.type] ?? c.type),
            ];
            const totalValue = ownedProps.reduce((acc, p) => acc + (p.propertyValue ?? 0), 0);
            const rentedOut = rentedPropsByOwner.get(u.id)?.size ?? 0;
            return {
              id: u.id,
              portfolioId: u.portfolioId ?? null,
              ownerId: u.id,
              ownerName,
              ownerEmail: u.email,
              portfolioName,
              unitsCount: ownedProps.length,
              roles,
              rentedOut,
              totalValue,
            };
          })
          .sort((a, b) => b.unitsCount - a.unitsCount);

        const wantsFin = req.query.financial === "1";
        const canFin = await hasPlatformPrivilege(req.user?.profile, "finance.viewAll");
        if (wantsFin && !canFin) {
          return res.status(403).json({
            error: "Requesting financial fields requires the finance.viewAll privilege.",
          });
        }
        const includeFin = wantsFin && canFin;
        const out = includeFin ? rows : rows.map((r) => ({ ...r, totalValue: 0 }));
        res.json(out);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load portfolios") });
      }
    },
  );

  // GET /api/admin/agreements — agreements with denormalized info.
  // Pass ?financial=1 for rentAmount + agreementValue (gated by
  // finance.viewAll).
  app.get(
    "/api/admin/agreements",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("legal.viewAll"),
    async (req, res) => {
      try {
        // QA-03: bound the primary read — newest LIST_CAP agreements,
        // ordered server-side (was: read the entire agreements
        // collection unbounded).
        const agreementsSnap = await db()
          .collection(COL.agreements)
          .orderBy("createdAt", "desc")
          .limit(LIST_CAP)
          .get();
        // Exclude "draft" — a reserved, never-surfaced state owner + tenant
        // reads already filter out; the admin list must match (Rule 3).
        const agreements = agreementsSnap.docs
          .map((d) => d.data() as Agreement)
          .filter((a) => a.status !== "draft");

        // QA-03: resolve only the referenced tenant/property/unit/owner
        // docs by id (getAll) instead of reading those whole
        // collections. tenant.userId users are pulled in a second pass
        // once tenants are known (for tenantImage).
        const [tenantIndex, propIndex, unitIndex] = await Promise.all([
          fetchByIds<Tenant>(
            COL.tenants,
            agreements.map((a) => a.tenantId),
          ),
          fetchByIds<Property>(
            COL.properties,
            agreements.map((a) => a.propertyId),
          ),
          fetchByIds<Unit>(
            COL.units,
            agreements.map((a) => a.unitId),
          ),
        ]);
        const tenantUserIds = Array.from(tenantIndex.values())
          .map((t) => t.userId ?? "")
          .filter(Boolean);
        const userIndex = await fetchByIds<User>(COL.users, [
          ...agreements.map((a) => a.ownerId),
          ...tenantUserIds,
        ]);

        const rows = agreements.map((a) => {
          const tenant = tenantIndex.get(a.tenantId);
          const owner = userIndex.get(a.ownerId);
          const prop = propIndex.get(a.propertyId);
          const unit = unitIndex.get(a.unitId);
          const tenantUser = tenant?.userId ? userIndex.get(tenant.userId) : null;
          return {
            id: a.id,
            tenantId: a.tenantId,
            tenantName: tenant?.name ?? "—",
            tenantEmail: tenant?.email ?? "—",
            tenantImage: tenantUser?.photoURL ?? null,
            tenantStatus: tenant?.status ?? "pending",
            unitId: a.unitId,
            propertyId: a.propertyId,
            propertyAddress: prop?.address ?? "—",
            ownerId: a.ownerId,
            ownerName: owner
              ? `${owner.firstName ?? ""} ${owner.lastName ?? ""}`.trim() || owner.email
              : "—",
            rentAmount: a.monthlyRent ?? unit?.rentAmount ?? 0,
            agreementValue: a.agreementValue,
            status: a.status,
            startDate: a.startDate,
            endDate: a.endDate,
            expiration: formatDate(a.endDate),
            // Read the authoritative Agreement.nextPaymentDate (the cron's
            // source of truth, on the very row being rendered) — not
            // Unit.nextPaymentDate, which is null for owner props and never
            // advanced for admin units, so this column was reliably wrong.
            nextPayment: formatDate(
              a.nextPaymentDate ?? tenant?.nextPayment ?? unit?.nextPaymentDate,
            ),
            documentUrl: a.documentUrl ?? null,
            signedAt: a.signedAt ?? null,
          };
        });

        const wantsFin = req.query.financial === "1";
        const canFin = await hasPlatformPrivilege(req.user?.profile, "finance.viewAll");
        if (wantsFin && !canFin) {
          return res.status(403).json({
            error: "Requesting financial fields requires the finance.viewAll privilege.",
          });
        }
        const includeFin = wantsFin && canFin;
        const out = includeFin
          ? rows
          : rows.map((r) => ({ ...r, rentAmount: 0, agreementValue: 0 }));

        // Mint a fresh, short-lived signed read URL for each lease that has an
        // uploaded signed-lease PDF (M-23: storagePath is the durable truth, the
        // URL is signed per-read and never persisted). Only the agreements that
        // actually carry an attachment incur a signing round-trip.
        const docPathById = new Map<string, string>();
        agreements.forEach((a) => {
          if (a.signedLeaseDocument?.storagePath)
            docPathById.set(a.id, a.signedLeaseDocument.storagePath);
        });
        const signedOut = docPathById.size
          ? await Promise.all(
              out.map(async (r) => {
                const sp = docPathById.get(r.id);
                if (!sp) return r;
                const url = await signReadUrl(sp);
                return url ? { ...r, documentUrl: url } : r;
              }),
            )
          : out;

        res.json(signedOut);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load agreements") });
      }
    },
  );

  // GET /api/admin/transactions — the platform's REAL money movements:
  // only payments that actually ran through Stripe. Offline/manual ledger
  // rows (cash, bank transfer, owner-recorded entries) are the owners'
  // private bookkeeping, not platform transaction history, so they're
  // deliberately excluded. Two sources, merged newest-first:
  //   1. Stripe Connect rent payments — Transaction rows written by
  //      recordRentTransactionFromSession (stripeSessionId always set,
  //      paymentMethod "card"), each carrying the platform's cut in
  //      applicationFeeCents.
  //   2. Owner subscription payments — paid invoices fetched live from
  //      Stripe Billing. The Stripe Payments extension mirrors
  //      subscription STATE into customers/{uid}/subscriptions but not
  //      per-payment invoices, so the Stripe API is the only source of
  //      payment history. Best-effort: a Stripe hiccup degrades to
  //      rent-only rows instead of 500ing the whole table.
  app.get(
    "/api/admin/transactions",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("finance.viewAll"),
    async (_req, res) => {
      try {
        // QA-03: bound the primary read — newest LIST_CAP transactions,
        // ordered server-side. The Stripe-only scope is pushed INTO the
        // query (composite index: paymentMethod ASC + timestamp DESC in
        // firestore.indexes.json) so the row cap applies to in-scope rows
        // — a post-fetch filter would let offline/manual bookkeeping
        // silently eat the window. paymentMethod "card" is written ONLY
        // by recordRentTransactionFromSession, always together with
        // stripeSessionId, so it's a complete proxy for "real Stripe row".
        const txSnap = await db()
          .collection(COL.transactions)
          .where("paymentMethod", "==", "card")
          .orderBy("timestamp", "desc")
          .limit(LIST_CAP)
          .get();
        // Defense in depth on the "card == real Stripe" invariant. The query
        // above scopes to paymentMethod "card", which today only
        // recordRentTransactionFromSession writes — and it ALWAYS co-sets
        // stripeSessionId (rentTransaction.ts). So a card row WITHOUT a session
        // id cannot be a genuine Stripe payment: it's a seed/import/legacy
        // impostor (e.g. demo-seed rows). Require the session id so non-Stripe
        // money can never be presented here as a Stripe transaction. Genuine
        // rows always carry it, so this never hides a real payment. (Can't be a
        // Firestore field-exists query, hence a post-fetch filter.)
        const txs = txSnap.docs
          .map((d) => d.data() as Transaction)
          .filter((t) => typeof t.stripeSessionId === "string" && t.stripeSessionId.length > 0);
        // The query hit LIST_CAP → older real Stripe rent rows exist beyond this
        // window. Surfaced so the UI can disclose the truncation instead of it
        // reading as missing data. Measured on the raw snapshot (the cap applies
        // to the query, before the session-id guard trims any impostors).
        const rentCapped = txSnap.docs.length >= LIST_CAP;

        // QA-03: resolve only the referenced property/tenant docs by id
        // (getAll) instead of reading those whole collections.
        const [propIndex, tenantIndex] = await Promise.all([
          fetchByIds<Property>(COL.properties, txs.map((t) => t.propertyId ?? "").filter(Boolean)),
          fetchByIds<Tenant>(COL.tenants, txs.map((t) => t.tenantId ?? "").filter(Boolean)),
        ]);
        // Tenant.name is the invite email frozen at invite time — the real
        // display name lives on the linked User, so join through
        // Tenant.userId (same shape as /api/admin/agreements).
        const userIndex = await fetchByIds<User>(COL.users, [
          ...txs.map((t) => t.ownerId ?? ""),
          ...Array.from(tenantIndex.values()).map((t) => t.userId ?? ""),
        ]);

        const fullName = (u: User | null | undefined): string | null =>
          u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email : null;

        interface PlatformTxRow {
          id: string;
          kind: "rent" | "subscription";
          name: string;
          amount: number;
          currency: string;
          type: Transaction["type"];
          category: Transaction["category"];
          status: Transaction["status"];
          timestamp: string;
          date: string;
          propertyAddress: string | null;
          ownerName: string | null;
          tenantName: string | null;
          // The platform's revenue from this row, in cents: the Connect
          // application fee for rent (null when no fee was captured),
          // the full amount for a subscription payment.
          platformFeeCents: number | null;
          // Refund visibility for rent rows (null when none / not applicable):
          // cents returned to the cardholder, and the platform application-fee
          // refunded. Stamped by the charge.refunded webhook.
          refundedAmountCents: number | null;
          feeRefundedCents: number | null;
        }

        const rentRows: PlatformTxRow[] = txs.map((tx) => {
          const prop = tx.propertyId ? propIndex.get(tx.propertyId) : null;
          const tenant = tx.tenantId ? tenantIndex.get(tx.tenantId) : null;
          const tenantUser = tenant?.userId ? userIndex.get(tenant.userId) : null;
          const owner = tx.ownerId ? userIndex.get(tx.ownerId) : null;
          return {
            id: tx.id,
            kind: "rent",
            name: tx.name,
            amount: tx.amount,
            currency: tx.currency,
            type: tx.type,
            category: tx.category,
            status: tx.status,
            timestamp: tx.timestamp,
            date: formatDate(tx.timestamp),
            propertyAddress: prop?.address ?? null,
            ownerName: fullName(owner),
            tenantName: fullName(tenantUser) ?? tenant?.name ?? null,
            platformFeeCents:
              typeof tx.applicationFeeCents === "number" ? tx.applicationFeeCents : null,
            refundedAmountCents:
              typeof tx.refundedAmountCents === "number" ? tx.refundedAmountCents : null,
            feeRefundedCents: typeof tx.feeRefundedCents === "number" ? tx.feeRefundedCents : null,
          };
        });

        const subscriptionRows: PlatformTxRow[] = [];
        // True when paid subscription invoices exist beyond the page bound below
        // (so the UI can disclose the truncation). Owners-only billing means the
        // bound is far above any near-term invoice count — effectively never set.
        let subscriptionsCapped = false;
        if (isStripeConfigured()) {
          try {
            // Structural type for the invoice fields we read — same
            // moduleResolution portability reason as rentTransaction.ts.
            interface PaidInvoice {
              id: string;
              customer: string | { id: string } | null;
              amount_paid: number | null;
              currency: string | null;
              created: number;
              billing_reason?: string | null;
              // Post-"basil" invoice model: the subscription link lives on
              // `parent`, not a top-level `subscription` field.
              parent?: { subscription_details?: object | null } | null;
              status_transitions?: { paid_at?: number | null } | null;
              lines?: { data?: Array<{ description?: string | null }> } | null;
              // Populated only when we successfully expand `data.charge` (best-
              // effort — a pinned API version may not permit the expand, in which
              // case this stays a string id / null and the row shows no refund).
              // `amount_refunded` is the cents returned to the owner; since a
              // subscription payment is entirely platform revenue, a refund
              // reduces our revenue by the same amount.
              charge?: { amount_refunded?: number | null } | string | null;
            }
            // Page through paid invoices with starting_after rather than a single
            // limit:100 call, so the 101st+ subscription payment isn't silently
            // dropped. Bounded to MAX_INVOICE_PAGES × 100 = 1000 invoices — orders
            // of magnitude above the owner count for the foreseeable future; if we
            // ever exceed it, subscriptionsCapped lets the UI say so rather than
            // hide rows. 10s timeout per page (SDK default is 80s): a hung Stripe
            // must degrade this table to rent-only, not pin the function until the
            // platform's 60s request deadline 504s the whole page.
            const MAX_INVOICE_PAGES = 10;
            const allInvoices: PaidInvoice[] = [];
            let startingAfter: string | undefined;
            // Expand the charge so we can reflect subscription refunds (an owner
            // refund would otherwise show full revenue). Guarded: if the pinned
            // API version rejects the expand, we drop it and keep returning rows
            // (sans refund annotation) rather than degrading the table to
            // rent-only. Detected once, then remembered for the rest of the pages.
            let expandCharge = true;
            for (let page = 0; page < MAX_INVOICE_PAGES; page++) {
              const params = {
                status: "paid" as const,
                limit: 100,
                ...(startingAfter ? { starting_after: startingAfter } : {}),
              };
              let invoiceList: { data?: PaidInvoice[]; has_more?: boolean };
              try {
                invoiceList = (await stripe().invoices.list(
                  { ...params, ...(expandCharge ? { expand: ["data.charge"] } : {}) },
                  { timeout: 10_000 },
                )) as unknown as { data?: PaidInvoice[]; has_more?: boolean };
              } catch (listErr: unknown) {
                if (!expandCharge) throw listErr;
                expandCharge = false;
                logWarn("admin_tx.invoice-charge-expand-unsupported", {
                  err: String(listErr).slice(0, 120),
                });
                invoiceList = (await stripe().invoices.list(params, {
                  timeout: 10_000,
                })) as unknown as { data?: PaidInvoice[]; has_more?: boolean };
              }
              const data = invoiceList.data ?? [];
              allInvoices.push(...data);
              if (!invoiceList.has_more || data.length === 0) break;
              if (page === MAX_INVOICE_PAGES - 1) {
                subscriptionsCapped = true;
                break;
              }
              startingAfter = data[data.length - 1].id;
            }
            // Keep only subscription-originated invoices that moved money:
            // zero-amount rows (trials, 100% discounts) are skipped, and so
            // is any one-off invoice an admin might raise from the Stripe
            // Dashboard — presenting those as "Owner subscription" would
            // book arbitrary amounts as subscription revenue.
            const paid = allInvoices.filter(
              (inv) =>
                (inv.amount_paid ?? 0) > 0 &&
                (!!inv.parent?.subscription_details ||
                  (inv.billing_reason ?? "").startsWith("subscription")),
            );

            // Stripe customer id → Firebase uid via the extension's
            // customers/{uid} mirror (doc id IS the uid; stripeId field
            // holds the Stripe customer id), then uid → user doc.
            const customerIds = paid
              .map((inv) => (typeof inv.customer === "string" ? inv.customer : inv.customer?.id))
              .filter((id): id is string => !!id);
            const uidByStripeId = new Map<string, string>(
              (await fetchWhereIn<{ stripeId?: string }>("customers", "stripeId", customerIds))
                .filter((c) => !!c.data.stripeId)
                .map((c) => [c.data.stripeId!, c.id]),
            );
            const subscriberIndex = await fetchByIds<User>(COL.users, uidByStripeId.values());

            for (const inv of paid) {
              const custId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
              const uid = custId ? uidByStripeId.get(custId) : undefined;
              const paidAtSec = inv.status_transitions?.paid_at ?? inv.created;
              const ts = new Date(paidAtSec * 1000).toISOString();
              // Stripe's auto-generated line description reads
              // "1 × Growth (at €499.00 / year)" — drop the quantity
              // prefix for display.
              const line = (inv.lines?.data?.[0]?.description ?? "").replace(/^\d+\s*×\s*/, "");
              const amountCents = inv.amount_paid ?? 0;
              // Refund total from the expanded charge (0 when not expanded / no
              // charge object / never refunded). A subscription payment is wholly
              // platform revenue, so the same cents are both "returned to the
              // owner" (refundedAmountCents) and "platform revenue reversed"
              // (feeRefundedCents) — mirroring keeps the net consistent with the
              // rent rows' refund convention the UI already renders.
              const subRefundCents =
                inv.charge && typeof inv.charge === "object"
                  ? (inv.charge.amount_refunded ?? 0)
                  : 0;
              subscriptionRows.push({
                id: inv.id,
                kind: "subscription",
                name: line.trim() || "Owner subscription",
                amount: amountCents / 100,
                currency: (inv.currency ?? "eur").toUpperCase(),
                type: "income",
                category: "other",
                status: "completed",
                timestamp: ts,
                date: formatDate(ts),
                propertyAddress: null,
                ownerName: fullName(uid ? subscriberIndex.get(uid) : null),
                tenantName: null,
                platformFeeCents: amountCents,
                refundedAmountCents: subRefundCents > 0 ? subRefundCents : null,
                feeRefundedCents: subRefundCents > 0 ? subRefundCents : null,
              });
            }
          } catch (err: unknown) {
            logWarn("admin_tx.subscription-invoices-failed", {
              err: String(err).slice(0, 200),
            });
          }
        }

        const rows = [...rentRows, ...subscriptionRows].sort((a, b) =>
          a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
        );

        // Wrapped in an object (was a bare array) so the truncation flags ride
        // alongside the rows — the UI discloses "newest N" instead of silently
        // dropping older real Stripe payments past the caps.
        res.json({ rows, rentCapped, subscriptionsCapped });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load transactions") });
      }
    },
  );

  // GET /api/admin/partners — list of partners. Status is derived
  // from activeUntil so the list always reflects auto-inactivation
  // without a cron.
  app.get(
    "/api/admin/partners",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.partners"),
    async (_req, res) => {
      try {
        const snap = await db().collection(COL.partners).get();
        const now = Date.now();
        const partners = snap.docs.map((d) => {
          const p = d.data() as Partner;
          const expired = !!p.activeUntil && new Date(p.activeUntil).getTime() <= now;
          return {
            ...p,
            status: expired ? "inactive" : p.status,
          } as Partner;
        });
        partners.sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1));
        res.json(partners);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load partners") });
      }
    },
  );

  // GET /api/admin/tickets — support tickets with reporter info
  // denormalized.
  app.get(
    "/api/admin/tickets",
    requireAuth,
    requireRole("admin", "superadmin"),
    // Exposes cross-user contact PII (reporter email + free-text). Gate on
    // comm.activityLog so the sales/marketing deny in the matrix — already
    // enforced on /api/admin/activity — is honored here too.
    requirePlatformPrivilege("comm.activityLog"),
    async (_req, res) => {
      try {
        const [ticketsSnap, usersSnap] = await Promise.all([
          db().collection(COL.tickets).get(),
          db().collection(COL.users).get(),
        ]);
        const tickets = ticketsSnap.docs.map((d) => d.data() as Ticket);
        const userIndex = new Map(usersSnap.docs.map((d) => [d.id, d.data() as User]));

        const rows = tickets
          .sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1))
          .map((t) => {
            const u = userIndex.get(t.userId);
            return {
              id: t.id,
              subject: t.subject,
              description: t.description ?? "",
              userId: t.userId,
              userName: u
                ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email
                : t.userEmail,
              userEmail: t.userEmail,
              userImage: u?.photoURL ?? null,
              category: t.category,
              priority: t.priority,
              status: t.status,
              createdAt: t.createdAt,
              updatedAt: t.updatedAt,
              propertyId: t.propertyId ?? null,
              unitId: t.unitId ?? null,
            };
          });

        res.json(rows);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load tickets") });
      }
    },
  );

  // GET /api/admin/suggestion-requests — investment-suggestion leads
  // from the owner-side "Find me a property" flow. Joins each lead's
  // user so the table can show the current display name + avatar even
  // after the user edits their profile.
  app.get(
    "/api/admin/suggestion-requests",
    requireAuth,
    requireRole("admin", "superadmin"),
    // Cross-user lead PII (email, name, free-text). Same gate as the
    // activity feed so sales/marketing sub-roles can't pull it directly.
    requirePlatformPrivilege("comm.activityLog"),
    async (_req, res) => {
      try {
        const [leadsSnap, usersSnap] = await Promise.all([
          db().collection(COL.suggestionRequests).get(),
          db().collection(COL.users).get(),
        ]);
        const leads = leadsSnap.docs.map((d) => d.data() as SuggestionRequest);
        const userIndex = new Map(usersSnap.docs.map((d) => [d.id, d.data() as User]));

        const rows = leads
          .sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1))
          .map((l) => {
            const u = userIndex.get(l.userId);
            return {
              ...l,
              userName: u
                ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email || l.userName
                : l.userName,
              userEmail: u?.email ?? l.userEmail,
              userImage: u?.photoURL ?? null,
            };
          });

        res.json(rows);
      } catch (err: unknown) {
        res.status(500).json({
          error: errMsg(err, "Failed to load suggestion requests"),
        });
      }
    },
  );

  // GET /api/admin/marketplace-leads — per-listing buyer interest from
  // owners clicking "I'm interested" on a marketplace listing. Joins each
  // lead's user so the table shows the current display name + avatar even
  // after the user edits their profile.
  app.get(
    "/api/admin/marketplace-leads",
    requireAuth,
    requireRole("admin", "superadmin"),
    // Cross-user lead PII (email, name, budget, free-text message). Same
    // gate as the activity feed so sales/marketing can't pull it directly.
    requirePlatformPrivilege("comm.activityLog"),
    async (_req, res) => {
      try {
        const [leadsSnap, usersSnap] = await Promise.all([
          db().collection(COL.marketplaceLeads).get(),
          db().collection(COL.users).get(),
        ]);
        const leads = leadsSnap.docs.map((d) => d.data() as MarketplaceLead);
        const userIndex = new Map(usersSnap.docs.map((d) => [d.id, d.data() as User]));

        const rows = leads
          .sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1))
          .map((l) => {
            const u = userIndex.get(l.userId);
            return {
              ...l,
              userName: u
                ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email || l.userName
                : l.userName,
              userEmail: u?.email ?? l.userEmail,
              userImage: u?.photoURL ?? null,
            };
          });

        res.json(rows);
      } catch (err: unknown) {
        res.status(500).json({
          error: errMsg(err, "Failed to load marketplace leads"),
        });
      }
    },
  );

  // GET /api/admin/activity — combined feed of recent system events.
  // Description strings include € amounts for agreement + transaction
  // events; those are stripped for callers without finance.viewAll so
  // the activity feed doesn't become a financial side-channel for
  // legal / support roles.
  app.get(
    "/api/admin/activity",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.activityLog"),
    async (req, res) => {
      try {
        const canFin = await hasPlatformPrivilege(req.user?.profile, "finance.viewAll");
        // QA-03: the feed only ever renders the newest 200 rows (slice
        // below), so each source can be capped at its newest 200 by its
        // primary timestamp — the merged top-200 is unchanged. Was: read
        // SIX whole collections then merge+slice in JS.
        //
        // Single-timestamp sources (users/properties/transactions/
        // tickets) are exact. Agreements + portfolio-access emit a
        // secondary row keyed off a LATER timestamp (signedAt /
        // acceptedAt / declinedAt); we order by the primary creation
        // timestamp (createdAt / invitedAt), so in the rare case where a
        // long-created row is acted on very recently its secondary row
        // may fall outside the cap. Acceptable for an informational
        // timeline; raise the cap or add a per-event log to make it
        // exact.
        const FEED_CAP = 200;
        const [usersSnap, propsSnap, agreementsSnap, txSnap, ticketsSnap, accessSnap] =
          await Promise.all([
            db().collection(COL.users).orderBy("joinedAt", "desc").limit(FEED_CAP).get(),
            db().collection(COL.properties).orderBy("createdAt", "desc").limit(FEED_CAP).get(),
            db().collection(COL.agreements).orderBy("createdAt", "desc").limit(FEED_CAP).get(),
            db().collection(COL.transactions).orderBy("timestamp", "desc").limit(FEED_CAP).get(),
            db().collection(COL.tickets).orderBy("createdAt", "desc").limit(FEED_CAP).get(),
            db()
              .collection(COL.portfolioAccessContacts)
              .orderBy("invitedAt", "desc")
              .limit(FEED_CAP)
              .get(),
          ]);
        const users = usersSnap.docs.map((d) => d.data() as User);

        // QA-03: user labels are needed for actors referenced across all
        // sources, not just the bounded users page. Collect every
        // referenced uid and resolve them by id (getAll) instead of
        // reading the whole users collection.
        const referencedUids = new Set<string>();
        for (const u of users) referencedUids.add(u.id);
        for (const d of propsSnap.docs) {
          const v = d.data() as Property;
          if (v.ownerId) referencedUids.add(v.ownerId);
        }
        for (const d of agreementsSnap.docs) {
          const v = d.data() as Agreement;
          if (v.ownerId) referencedUids.add(v.ownerId);
          if (v.tenantId) referencedUids.add(v.tenantId);
        }
        for (const d of txSnap.docs) {
          const v = d.data() as Transaction;
          const uid = v.tenantId ?? v.ownerId;
          if (uid) referencedUids.add(uid);
        }
        for (const d of ticketsSnap.docs) {
          const v = d.data() as Ticket;
          if (v.userId) referencedUids.add(v.userId);
        }
        for (const d of accessSnap.docs) {
          const v = d.data() as PortfolioAccessContact;
          if (v.ownerId) referencedUids.add(v.ownerId);
        }
        const userIndex = await fetchByIds<User>(COL.users, referencedUids);
        const userLabel = (uid: string | undefined) => {
          if (!uid) return null;
          const u = userIndex.get(uid);
          return u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email : null;
        };
        const userEmail = (uid: string | undefined) =>
          uid ? (userIndex.get(uid)?.email ?? null) : null;

        type Row = {
          id: string;
          kind: string;
          entity: string;
          title: string;
          description: string;
          timestamp: string;
          actorName: string | null;
          actorEmail: string | null;
        };
        const rows: Row[] = [];

        for (const u of users) {
          rows.push({
            id: `user-${u.id}`,
            kind: "user.created",
            entity: "user",
            title: "New User Registered",
            description: `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email,
            timestamp: u.joinedAt ?? "",
            actorName: userLabel(u.id),
            actorEmail: u.email,
          });
        }
        for (const d of propsSnap.docs) {
          const v = d.data() as Property;
          rows.push({
            id: `prop-${v.id}`,
            kind: "property.created",
            entity: "property",
            title: "Property Added",
            description: v.address ?? "New property listed",
            timestamp: v.createdAt ?? "",
            actorName: userLabel(v.ownerId),
            actorEmail: userEmail(v.ownerId),
          });
        }
        // Two rows per agreement: the request (owner → tenant ask) and,
        // once accepted, the activation. Tracking them separately lets
        // the timeline show both the ask and the response rather than
        // collapsing them into a single status-dependent row.
        for (const d of agreementsSnap.docs) {
          const v = d.data() as Agreement;
          // Skip "draft" — never-surfaced reserved state (Rule 3).
          if (v.status === "draft") continue;
          const valueLine = canFin ? ` — €${(v.agreementValue ?? 0).toLocaleString()}` : "";
          rows.push({
            id: `agr-req-${v.id}`,
            kind: "agreement.requested",
            entity: "agreement",
            title: "Agreement Request Sent",
            description: `Owner requested an agreement with tenant${valueLine}`,
            timestamp: v.createdAt ?? "",
            actorName: userLabel(v.ownerId),
            actorEmail: userEmail(v.ownerId),
          });
          if (v.status === "active") {
            rows.push({
              id: `agr-acc-${v.id}`,
              kind: "agreement.accepted",
              entity: "agreement",
              title: "Agreement Accepted",
              description: `Tenant accepted the agreement${valueLine}`,
              timestamp: v.signedAt ?? v.createdAt ?? "",
              actorName: userLabel(v.tenantId),
              actorEmail: userEmail(v.tenantId),
            });
          }
        }
        // Portfolio access invites + their responses — emitted from the
        // same contact doc since invite/accept/decline are all states
        // of one record.
        for (const d of accessSnap.docs) {
          const v = d.data() as PortfolioAccessContact;
          const typeLabel = v.type ? v.type.charAt(0).toUpperCase() + v.type.slice(1) : "Portfolio";
          rows.push({
            id: `acc-inv-${v.id}`,
            kind: "access.invited",
            entity: "access",
            title: "Portfolio Access Invited",
            description: `${typeLabel} access invitation sent to ${v.name || v.email}`,
            timestamp: v.invitedAt ?? "",
            actorName: userLabel(v.ownerId),
            actorEmail: userEmail(v.ownerId),
          });
          if (v.status === "active" && v.acceptedAt) {
            rows.push({
              id: `acc-acc-${v.id}`,
              kind: "access.accepted",
              entity: "access",
              title: "Portfolio Access Accepted",
              description: `${v.name || v.email} accepted ${typeLabel.toLowerCase()} access`,
              timestamp: v.acceptedAt,
              actorName: v.name || null,
              actorEmail: v.email ?? null,
            });
          }
          if (v.status === "declined" && v.declinedAt) {
            rows.push({
              id: `acc-dec-${v.id}`,
              kind: "access.declined",
              entity: "access",
              title: "Portfolio Access Declined",
              description: `${v.name || v.email} declined ${typeLabel.toLowerCase()} access`,
              timestamp: v.declinedAt,
              actorName: v.name || null,
              actorEmail: v.email ?? null,
            });
          }
        }
        for (const d of txSnap.docs) {
          const v = d.data() as Transaction;
          rows.push({
            id: `tx-${v.id}`,
            kind: v.status === "completed" ? "transaction.completed" : "transaction.pending",
            entity: "transaction",
            title: v.status === "completed" ? "Payment Received" : "Payment Pending",
            description: canFin ? `${v.name} — €${(v.amount ?? 0).toLocaleString()}` : v.name,
            timestamp: v.timestamp ?? "",
            actorName: userLabel(v.tenantId ?? v.ownerId),
            actorEmail: userEmail(v.tenantId ?? v.ownerId),
          });
        }
        for (const d of ticketsSnap.docs) {
          const v = d.data() as Ticket;
          rows.push({
            id: `tkt-${v.id}`,
            kind: v.status === "resolved" ? "ticket.resolved" : "ticket.created",
            entity: "ticket",
            title: v.status === "resolved" ? "Ticket Resolved" : "Ticket Opened",
            description: v.subject,
            timestamp: v.createdAt ?? "",
            actorName: userLabel(v.userId),
            actorEmail: v.userEmail,
          });
        }

        rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
        res.json(rows.slice(0, 200));
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load activity") });
      }
    },
  );
}
