// Pure, framework-agnostic analytics for the owner "Olio Insights" page.
//
// NO react / firebase / recharts imports — same discipline as
// shared/realizedRent.ts — so every function here is unit-testable in
// isolation (see portfolioInsights.test.ts) and the ~render-only page stays
// thin. The page passes the already-fetched query results in; these functions
// derive every projection, ranking, score and trend from them.
//
// Cross-cutting rules baked in here (do NOT special-case at call sites):
//   • Realized income routes through isRealizedRent (pending offline rent is
//     never "collected"). Expenses = type "expense" && status !== "failed".
//   • Prepaid rent is a SINGLE synthetic "completed" row already in the feed
//     (source "prepaid", amount = monthlyRent×months, NO rentPeriod). Never
//     re-derive it from Agreement.prepaidRents (double count); it is excluded
//     from punctuality scoring by both source and missing-rentPeriod.
//   • autoRenewal ∈ {"none","auto","fixed"} | null. A lease CONTINUES past its
//     endDate iff auto|fixed; it LAPSES iff none|null. ("off"/"on" do NOT
//     exist — guarding against the enum mistake the design surfaced.)
//   • Date-only values (rentPeriod, lease start/end) are parsed to LOCAL
//     midnight via ymdToLocalMidnightMs — never new Date(s).toISOString()
//     (shifts the calendar day in UTC+3 Cyprus) and never dateInputToIso
//     (anchors to the current time-of-day, corrupting a lateness diff).
//   • Every ratio guards divide-by-zero and returns null (the page renders
//     "—"), never NaN/Infinity.

import { isRealizedRent, netRealizedRentAmount } from "@shared/realizedRent";
import type {
  OwnerAgreement,
  OwnerProperty,
  OwnerSummary,
  OwnerTenant,
  OwnerTransaction,
} from "./ownerQueries";

const DAY_MS = 86_400_000;
const AVG_MONTH_MS = 2_629_800_000; // 30.44 days — for tenure/age in months
const FEED_DAYS = 370; // useOwnerInsightsTransactions fetches sinceDays=370

// ── Date helpers ──────────────────────────────────────────────────────

// Well-formed calendar date "YYYY-MM-DD" (rejects ISO datetime strings).
export function isValidYmd(s: string | null | undefined): boolean {
  if (typeof s !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  // Round-trip guard rejects impossible days (e.g. 2026-02-30).
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

// Parse a date-only "YYYY-MM-DD" to LOCAL-midnight epoch ms. null on malformed.
export function ymdToLocalMidnightMs(ymd: string | null | undefined): number | null {
  if (!isValidYmd(ymd)) return null;
  const [y, mo, d] = (ymd as string).split("-").map(Number);
  return new Date(y, mo - 1, d).getTime();
}

// Floor any full ISO instant to its LOCAL calendar-day midnight ms.
export function dateOnlyMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Accept either a date-only string or a full ISO and resolve to local midnight.
function anyDateToLocalMidnightMs(s: string | null | undefined): number | null {
  if (!s) return null;
  return s.includes("T") ? dateOnlyMs(s) : ymdToLocalMidnightMs(s.slice(0, 10));
}

function monthsBetween(fromMs: number, toMs: number): number {
  const a = new Date(fromMs);
  const b = new Date(toMs);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

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

// ── Shared low-level money walks ──────────────────────────────────────

function expenses(txns: OwnerTransaction[], fromMs: number, toMs: number): number {
  let sum = 0;
  for (const t of txns) {
    const ms = new Date(t.timestamp).getTime();
    if (ms < fromMs || ms > toMs) continue;
    if (t.type === "expense" && t.status !== "failed") sum += Math.abs(Number(t.amount) || 0);
  }
  return sum;
}

// ── Period-over-period deltas (headline KPIs) ─────────────────────────

export interface MetricDelta {
  value: number | null;
  prior: number | null;
  deltaPct: number | null;
}
export interface PeriodDeltas {
  netIncome: MetricDelta;
  collectionRate: MetricDelta;
  expenseRatio: MetricDelta;
  priorAvailable: boolean;
}

function windowMetrics(txns: OwnerTransaction[], fromMs: number, toMs: number) {
  let income = 0;
  let expense = 0;
  let rentCollected = 0;
  let rentPending = 0;
  for (const t of txns) {
    const ms = new Date(t.timestamp).getTime();
    if (ms < fromMs || ms > toMs) continue;
    const amt = Math.abs(Number(t.amount) || 0);
    if (isRealizedRent(t)) {
      // Net of any refund stamped on the row (charge.refunded) — realized
      // income/rent collected must not count money that was refunded.
      const net = netRealizedRentAmount(t);
      income += net;
      if (t.category === "rent") rentCollected += net;
    } else if (t.type === "income" && t.status === "pending" && t.category === "rent") {
      rentPending += amt;
    } else if (t.type === "expense" && t.status !== "failed") {
      expense += amt;
    }
  }
  const rentDue = rentCollected + rentPending;
  return {
    netIncome: income - expense,
    collectionRate: rentDue > 0 ? (rentCollected / rentDue) * 100 : null,
    expenseRatio: income > 0 ? (expense / income) * 100 : null,
  };
}

function pctDelta(value: number | null, prior: number | null): number | null {
  if (value == null || prior == null || prior === 0) return null;
  return ((value - prior) / Math.abs(prior)) * 100;
}

export function computePeriodDeltas(
  txns: OwnerTransaction[],
  windowDays: number,
  nowMs: number,
): PeriodDeltas {
  const curFrom = nowMs - windowDays * DAY_MS;
  const cur = windowMetrics(txns, curFrom, nowMs);
  // The prior equal-length window must fit inside the 370-day feed.
  const priorAvailable = windowDays * 2 <= FEED_DAYS;
  const prior = priorAvailable
    ? windowMetrics(txns, nowMs - 2 * windowDays * DAY_MS, curFrom)
    : { netIncome: null as number | null, collectionRate: null, expenseRatio: null };
  const mk = (v: number | null, p: number | null): MetricDelta => ({
    value: v,
    prior: priorAvailable ? p : null,
    deltaPct: priorAvailable ? pctDelta(v, p) : null,
  });
  return {
    netIncome: mk(cur.netIncome, prior.netIncome),
    collectionRate: mk(cur.collectionRate, prior.collectionRate),
    expenseRatio: mk(cur.expenseRatio, prior.expenseRatio),
    priorAvailable,
  };
}

// ── Rent-roll → collected reconciliation (current calendar month) ─────

export interface RentReconciliation {
  expected: number;
  collected: number;
  shortfall: number;
  pct: number | null;
}
export function computeRentReconciliation(
  summary: OwnerSummary | undefined,
  txns: OwnerTransaction[],
  nowMs: number,
): RentReconciliation {
  const expected = summary?.monthlyRevenue ?? 0;
  const now = new Date(nowMs);
  const y = now.getFullYear();
  const mo = now.getMonth();
  let collected = 0;
  for (const t of txns) {
    if (!isRealizedRent(t) || t.category !== "rent") continue;
    // Exclude the prepaid lump so a lease signed THIS month doesn't inflate
    // current-month collected (it has no rentPeriod and covers future cycles).
    if (t.source === "prepaid") continue;
    // Attribute by the cycle the rent covers (rentPeriod) when present, else by
    // when it was recorded (timestamp).
    const refMs = isValidYmd(t.rentPeriod)
      ? ymdToLocalMidnightMs(t.rentPeriod)
      : dateOnlyMs(t.timestamp);
    if (refMs == null) continue;
    const d = new Date(refMs);
    if (d.getFullYear() === y && d.getMonth() === mo) collected += Math.abs(Number(t.amount) || 0);
  }
  return {
    expected,
    collected,
    shortfall: Math.max(0, expected - collected),
    pct: expected > 0 ? (collected / expected) * 100 : null,
  };
}

// ── Projections ───────────────────────────────────────────────────────

export interface RunRate {
  annualRunRate: number;
  trailingRent: number;
  delta: number;
}
export function computeRunRate(
  summary: OwnerSummary | undefined,
  txns: OwnerTransaction[],
  nowMs: number,
): RunRate {
  const annualRunRate = (summary?.monthlyRevenue ?? 0) * 12;
  let trailingRent = 0;
  const from = nowMs - 365 * DAY_MS;
  for (const t of txns) {
    const ms = new Date(t.timestamp).getTime();
    if (ms < from || ms > nowMs) continue;
    if (isRealizedRent(t) && t.category === "rent") trailingRent += netRealizedRentAmount(t);
  }
  return { annualRunRate, trailingRent, delta: annualRunRate - trailingRent };
}

function leaseContinues(a: OwnerAgreement): boolean {
  return a.autoRenewal === "auto" || a.autoRenewal === "fixed";
}

export interface ForwardIncome {
  months: { label: string; projected: number; causedDropBy?: string }[];
  runRatePerMonth: number;
}
export function buildForwardIncome(
  agreements: OwnerAgreement[],
  summary: OwnerSummary | undefined,
  nowMs: number,
): ForwardIncome {
  const now = new Date(nowMs);
  const active = agreements.filter((a) => a.status === "active");
  const months: ForwardIncome["months"] = [];
  for (let m = 0; m < 12; m++) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() + m, 1);
    const monthMs = monthStart.getTime();
    let projected = 0;
    let causedDropBy: string | undefined;
    for (const a of active) {
      const rent = a.monthlyRent || 0;
      if (rent <= 0) continue;
      const startMs = anyDateToLocalMidnightMs(a.startDate);
      // Not started by this month yet.
      if (startMs != null && startMs > monthMs) continue;
      // Leading rent-free + prepaid cycles produce no NEW cash this month.
      const lead = (a.rentFreePeriodMonths || 0) + (a.prepaidRents || 0);
      if (startMs != null && lead > 0 && monthsBetween(startMs, monthMs) < lead) continue;
      // Lapses at endDate (unless it auto/fixed-renews).
      if (!leaseContinues(a) && a.endDate) {
        const endMs = anyDateToLocalMidnightMs(a.endDate);
        if (endMs != null && endMs < monthMs) {
          if (!causedDropBy) causedDropBy = a.address;
          continue;
        }
      }
      projected += rent;
    }
    months.push({
      label: MONTH_LABELS[monthStart.getMonth()],
      projected,
      ...(causedDropBy ? { causedDropBy } : {}),
    });
  }
  return { months, runRatePerMonth: summary?.monthlyRevenue ?? 0 };
}

export interface ExpiringLease {
  id: string;
  address: string;
  tenantName: string;
  tenantId: string;
  endDate: string;
  daysToExpiry: number;
  monthlyRent: number;
  grade?: string | null;
  holdover: boolean;
}
export interface ExpiringLeases {
  leases: ExpiringLease[];
  within90: number;
  within180: number;
  within365: number;
}
export function buildExpiringLeases(
  agreements: OwnerAgreement[],
  nowMs: number,
  tenantScores?: TenantScore[],
): ExpiringLeases {
  const todayMs = dateOnlyMs(new Date(nowMs).toISOString()) ?? nowMs;
  const gradeByTenant = new Map<string, string | null>();
  (tenantScores ?? []).forEach((s) => gradeByTenant.set(s.tenantId, s.grade));
  const leases: ExpiringLease[] = [];
  let within90 = 0;
  let within180 = 0;
  let within365 = 0;
  for (const a of agreements) {
    if (a.status !== "active" || !a.endDate || leaseContinues(a)) continue;
    const endMs = anyDateToLocalMidnightMs(a.endDate);
    if (endMs == null) continue;
    const daysToExpiry = Math.floor((endMs - todayMs) / DAY_MS);
    // Within the next year (or already past = holdover).
    if (daysToExpiry > 365) continue;
    const rent = a.monthlyRent || 0;
    leases.push({
      id: a.id,
      address: a.address,
      tenantName: a.tenantName,
      tenantId: a.tenantId,
      endDate: a.endDate,
      daysToExpiry,
      monthlyRent: rent,
      grade: gradeByTenant.get(a.tenantId) ?? null,
      holdover: daysToExpiry < 0,
    });
    if (daysToExpiry <= 90) within90 += rent;
    if (daysToExpiry <= 180) within180 += rent;
    if (daysToExpiry <= 365) within365 += rent;
  }
  leases.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
  return { leases, within90, within180, within365 };
}

export interface ProjectedNet {
  projectedAnnualNet: number;
  trailingMonthlyExpense: number;
  monthsOfHistory: number;
}
export function computeProjectedNet(
  agreements: OwnerAgreement[],
  summary: OwnerSummary | undefined,
  txns: OwnerTransaction[],
  nowMs: number,
): ProjectedNet {
  const from = nowMs - 365 * DAY_MS;
  let totalExpense = 0;
  let oldest = nowMs;
  for (const t of txns) {
    const ms = new Date(t.timestamp).getTime();
    if (ms < from || ms > nowMs) continue;
    if (t.type === "expense" && t.status !== "failed") {
      totalExpense += Math.abs(Number(t.amount) || 0);
      if (ms < oldest) oldest = ms;
    }
  }
  const monthsOfHistory = Math.max(1, Math.round((nowMs - oldest) / AVG_MONTH_MS));
  const trailingMonthlyExpense = totalExpense / monthsOfHistory;
  const fwd = buildForwardIncome(agreements, summary, nowMs);
  const annualIncome = fwd.months.reduce((s, m) => s + m.projected, 0);
  return {
    projectedAnnualNet: annualIncome - trailingMonthlyExpense * 12,
    trailingMonthlyExpense,
    monthsOfHistory,
  };
}

export interface NOI {
  noi: number;
  capRate: number | null;
}
export function computeNOI(
  summary: OwnerSummary | undefined,
  txns: OwnerTransaction[],
  nowMs: number,
): NOI {
  const opEx = expenses(txns, nowMs - 365 * DAY_MS, nowMs);
  const noi = (summary?.monthlyRevenue ?? 0) * 12 - opEx;
  const value = summary?.portfolioValue ?? 0;
  return { noi, capRate: value > 0 ? (noi / value) * 100 : null };
}

export interface TotalReturn {
  grossYield: number | null;
  appreciationRunRate: number | null;
  avgHoldingYears: number;
}
export function computeTotalReturn(
  summary: OwnerSummary | undefined,
  properties: OwnerProperty[],
  nowMs: number,
): TotalReturn {
  const value = summary?.portfolioValue ?? 0;
  const equity = summary?.equityInvested ?? 0;
  const grossYield = value > 0 ? (((summary?.monthlyRevenue ?? 0) * 12) / value) * 100 : null;
  const currentYear = new Date(nowMs).getFullYear();
  const holdings: number[] = [];
  for (const p of properties) {
    let year = parseInt(p.acquisitionYear ?? "", 10);
    if (!Number.isFinite(year)) year = new Date(p.createdAt).getFullYear();
    if (Number.isFinite(year)) holdings.push(Math.max(1, currentYear - year));
  }
  const avgHoldingYears = holdings.length
    ? holdings.reduce((a, b) => a + b, 0) / holdings.length
    : 1;
  const totalGainPct = equity > 0 ? ((value - equity) / equity) * 100 : null;
  return {
    grossYield,
    appreciationRunRate: totalGainPct == null ? null : totalGainPct / avgHoldingYears,
    avgHoldingYears,
  };
}

export interface DepositLiability {
  depositLiability: number;
  contributingLeases: number;
  depositMonths: number | null;
}
export function computeDepositLiability(
  agreements: OwnerAgreement[],
  summary: OwnerSummary | undefined,
): DepositLiability {
  let total = 0;
  let contributing = 0;
  for (const a of agreements) {
    if (a.status !== "active") continue;
    const dep = a.deposit || 0;
    total += dep;
    if (dep > 0) contributing++;
  }
  const monthly = summary?.monthlyRevenue ?? 0;
  return {
    depositLiability: total,
    contributingLeases: contributing,
    depositMonths: monthly > 0 ? total / monthly : null,
  };
}

export interface Stress {
  contractedAnnual: number;
  vacancyAdjusted: number;
  oneVacancyStress: number;
  largestLeaseAnnual: number;
}
export function computeStress(
  summary: OwnerSummary | undefined,
  agreements: OwnerAgreement[],
): Stress {
  const contractedAnnual = (summary?.monthlyRevenue ?? 0) * 12;
  const occ = (summary?.occupancyRate ?? 0) / 100;
  let largest = 0;
  for (const a of agreements) {
    if (a.status !== "active") continue;
    if ((a.monthlyRent || 0) > largest) largest = a.monthlyRent || 0;
  }
  const largestLeaseAnnual = largest * 12;
  return {
    contractedAnnual,
    vacancyAdjusted: contractedAnnual * occ,
    oneVacancyStress: Math.max(0, contractedAnnual - largestLeaseAnnual),
    largestLeaseAnnual,
  };
}

// ── Property leaderboard ──────────────────────────────────────────────

export interface LeaderboardRow {
  id: string;
  address: string;
  image?: string;
  revenue: number;
  expenses: number;
  profit: number;
  netMargin: number | null;
  expenseRatio: number | null;
  grossYield: number | null;
  cashROI: number | null;
  eurPerSqm: number | null;
  appreciation: number | null;
  occupancy: "occupied" | "pending" | "vacant";
  costBasis: number;
  usedFallback: boolean;
  hasActivity: boolean;
}
export function buildPropertyLeaderboard(
  properties: OwnerProperty[],
  txns: OwnerTransaction[],
  windowDays: number,
  nowMs: number,
): LeaderboardRow[] {
  const cutoff = nowMs - windowDays * DAY_MS;
  const rev = new Map<string, number>();
  const exp = new Map<string, number>();
  for (const t of txns) {
    if (!t.propertyId) continue;
    const ms = new Date(t.timestamp).getTime();
    if (ms < cutoff || ms > nowMs) continue;
    const amt = Math.abs(Number(t.amount) || 0);
    if (isRealizedRent(t))
      rev.set(t.propertyId, (rev.get(t.propertyId) || 0) + netRealizedRentAmount(t));
    else if (t.type === "expense" && t.status !== "failed")
      exp.set(t.propertyId, (exp.get(t.propertyId) || 0) + amt);
  }
  return properties.map((p) => {
    const revenue = rev.get(p.id) || 0;
    const expense = exp.get(p.id) || 0;
    const profit = revenue - expense;
    const usedFallback = !(p.acquisitionPrice > 0);
    const costBasis = p.acquisitionPrice > 0 ? p.acquisitionPrice : (p.propertyValue || 0) * 0.8;
    const sqmNum = parseFloat(p.sqm ?? "");
    const sqmValid = Number.isFinite(sqmNum) && sqmNum > 0;
    const annualizedNet = windowDays > 0 ? profit * (365 / windowDays) : profit;
    return {
      id: p.id,
      address: p.address,
      image: p.image,
      revenue,
      expenses: expense,
      profit,
      netMargin: revenue > 0 ? (profit / revenue) * 100 : null,
      expenseRatio: revenue > 0 ? (expense / revenue) * 100 : null,
      grossYield:
        p.propertyValue > 0 && p.rentAmount > 0
          ? ((p.rentAmount * 12) / p.propertyValue) * 100
          : null,
      cashROI: costBasis > 0 ? (annualizedNet / costBasis) * 100 : null,
      eurPerSqm: sqmValid && p.propertyValue > 0 ? p.propertyValue / sqmNum : null,
      appreciation: costBasis > 0 ? ((p.propertyValue - costBasis) / costBasis) * 100 : null,
      occupancy: p.tenancyState,
      costBasis,
      usedFallback,
      hasActivity: revenue > 0 || expense > 0,
    };
  });
}

// ── Concentration / composition analytics ────────────────────────────

export interface HHI {
  assetHHI: number | null;
  cityHHI: number | null;
  topAssetPct: number | null;
  label: string;
}
function hhiOf(values: number[]): number | null {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return values.reduce((s, v) => s + Math.pow(v / total, 2), 0) * 10000;
}
export function computeHHI(properties: OwnerProperty[]): HHI {
  const values = properties.map((p) => p.propertyValue || 0).filter((v) => v > 0);
  const assetHHI = values.length ? hhiOf(values) : null;
  const byCity = new Map<string, number>();
  for (const p of properties) {
    const k = p.city || "Unknown";
    byCity.set(k, (byCity.get(k) || 0) + (p.propertyValue || 0));
  }
  const total = values.reduce((a, b) => a + b, 0);
  const topAssetPct = total > 0 ? (Math.max(...values) / total) * 100 : null;
  let label = "—";
  if (assetHHI != null) {
    if (values.length === 1) label = "Single asset";
    else if (assetHHI < 1500) label = "Well diversified";
    else if (assetHHI <= 2500) label = "Moderate concentration";
    else label = "Highly concentrated";
  }
  return { assetHHI, cityHHI: hhiOf(Array.from(byCity.values())), topAssetPct, label };
}

export interface SqmBenchmarkType {
  type: string;
  meanValuePerSqm: number;
  meanRentPerSqm: number | null;
  rows: { address: string; valuePerSqm: number; rentPerSqm: number | null; underRented: boolean }[];
}
export function computeSqmBenchmark(properties: OwnerProperty[]): SqmBenchmarkType[] {
  const byType = new Map<
    string,
    { address: string; valuePerSqm: number; rentPerSqm: number | null }[]
  >();
  for (const p of properties) {
    const sqm = parseFloat(p.sqm ?? "");
    if (!Number.isFinite(sqm) || sqm <= 0 || !(p.propertyValue > 0)) continue;
    const type = p.propertyType || "Unknown";
    const rentPerSqm = p.occupied && p.rentAmount > 0 ? p.rentAmount / sqm : null;
    const arr = byType.get(type) ?? [];
    arr.push({ address: p.address, valuePerSqm: p.propertyValue / sqm, rentPerSqm });
    byType.set(type, arr);
  }
  const out: SqmBenchmarkType[] = [];
  for (const [type, rows] of Array.from(byType.entries())) {
    const meanValuePerSqm = rows.reduce((s, r) => s + r.valuePerSqm, 0) / rows.length;
    const rentRows = rows.filter((r) => r.rentPerSqm != null) as { rentPerSqm: number }[];
    const meanRentPerSqm = rentRows.length
      ? rentRows.reduce((s, r) => s + r.rentPerSqm, 0) / rentRows.length
      : null;
    const canFlag = rows.length >= 2 && meanRentPerSqm != null;
    out.push({
      type,
      meanValuePerSqm,
      meanRentPerSqm,
      rows: rows.map((r) => ({
        address: r.address,
        valuePerSqm: r.valuePerSqm,
        rentPerSqm: r.rentPerSqm,
        underRented: !!(canFlag && r.rentPerSqm != null && r.rentPerSqm < 0.85 * meanRentPerSqm!),
      })),
    });
  }
  return out;
}

// ── Tenant payment-reliability scoring ────────────────────────────────

const GRACE_DAYS = 3;

export interface TenantScore {
  tenantId: string;
  name: string;
  propertyAddress: string | null;
  state: "rated" | "provisional" | "unrated";
  score: number | null;
  grade: "A" | "B" | "C" | "D" | "F" | null;
  onTimePct: number | null;
  avgDaysLateOverall: number;
  maxDaysLate: number;
  lateEvents: number;
  paymentCount: number;
  unscorablePayments: number;
  totalPaid: number;
  confidence: number;
  lowConfidence: boolean;
  chronicLate: boolean;
  last6: number[];
}

function gradeOf(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export function scoreTenantPayments(
  txns: OwnerTransaction[],
  tenants: OwnerTenant[],
  nowMs: number,
  opts?: { graceDays?: number },
): TenantScore[] {
  const grace = opts?.graceDays ?? GRACE_DAYS;
  void nowMs; // reserved (recency weighting) — kept in signature for stability
  interface Acc {
    events: { lateness: number; card: boolean; ts: number; amount: number }[];
    unscorable: number;
  }
  const acc = new Map<string, Acc>();
  const ensure = (id: string): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = { events: [], unscorable: 0 };
      acc.set(id, a);
    }
    return a;
  };
  for (const t of txns) {
    if (t.category !== "rent" || !isRealizedRent(t) || t.source === "prepaid" || !t.tenantId)
      continue;
    const a = ensure(t.tenantId);
    const dueMs = ymdToLocalMidnightMs(t.rentPeriod);
    const paidMs = dateOnlyMs(t.timestamp);
    if (dueMs == null || paidMs == null) {
      a.unscorable++;
      continue;
    }
    a.events.push({
      lateness: Math.round((paidMs - dueMs) / DAY_MS),
      card: t.paymentMethod === "card",
      ts: new Date(t.timestamp).getTime(),
      amount: Math.abs(Number(t.amount) || 0),
    });
  }
  const byId = new Map(tenants.map((t) => [t.id, t]));
  const out: TenantScore[] = [];
  // Tenants who have any scorable/unscorable activity OR are active/pending.
  const ids = new Set<string>();
  acc.forEach((_v, k) => ids.add(k));
  for (const t of tenants) {
    if (t.status === "active" || t.status === "pending") ids.add(t.id);
  }
  for (const id of Array.from(ids)) {
    const t = byId.get(id);
    // Omit invited/declined tenants with no payment history at all.
    if (t && (t.status === "invited" || t.status === "declined") && !acc.get(id)?.events.length) {
      continue;
    }
    const a = acc.get(id) ?? { events: [], unscorable: 0 };
    const events = a.events.sort((x, y) => x.ts - y.ts);
    const paymentCount = events.length;
    const name = t?.name ?? "Tenant";
    const propertyAddress = t?.propertyAddress ?? null;
    const base = {
      tenantId: id,
      name,
      propertyAddress,
      paymentCount,
      unscorablePayments: a.unscorable,
      totalPaid: events.reduce((s, e) => s + e.amount, 0),
      last6: events.slice(-6).map((e) => e.lateness),
    };
    if (paymentCount === 0) {
      out.push({
        ...base,
        state: "unrated",
        score: null,
        grade: null,
        onTimePct: null,
        avgDaysLateOverall: 0,
        maxDaysLate: 0,
        lateEvents: 0,
        confidence: 0,
        lowConfidence: true,
        chronicLate: false,
      });
      continue;
    }
    const onTimeCount = events.filter((e) => e.lateness <= grace).length;
    const onTimePct = (onTimeCount / paymentCount) * 100;
    const lateEvents = events.filter((e) => e.lateness > grace).length;
    const avgDaysLateOverall =
      events.reduce((s, e) => s + Math.max(0, e.lateness), 0) / paymentCount;
    const maxDaysLate = events.reduce((m, e) => Math.max(m, e.lateness), 0);
    const cardEvents = events.filter((e) => e.card).length;
    const confidence = cardEvents / paymentCount;
    const lateRatePenalty = (1 - onTimePct / 100) * 40;
    const latenessSeverity = Math.min(40, 2 * avgDaysLateOverall);
    const score = Math.round(Math.max(0, 100 - lateRatePenalty - latenessSeverity));
    out.push({
      ...base,
      state: paymentCount >= 3 ? "rated" : "provisional",
      score,
      grade: gradeOf(score),
      onTimePct,
      avgDaysLateOverall,
      maxDaysLate,
      lateEvents,
      confidence,
      lowConfidence: confidence < 0.5,
      chronicLate: lateEvents >= 3 || (paymentCount >= 4 && onTimePct < 60),
    });
  }
  return out;
}

export interface RankedTenants {
  scores: TenantScore[];
  avgPortfolioScore: number | null;
  chronicLateCount: number;
}
export function rankTenantScores(scores: TenantScore[]): RankedTenants {
  const order = { rated: 0, provisional: 1, unrated: 2 };
  const sorted = [...scores].sort((a, b) => {
    if (order[a.state] !== order[b.state]) return order[a.state] - order[b.state];
    if (a.score != null && b.score != null && a.score !== b.score) return b.score - a.score;
    if ((b.onTimePct ?? -1) !== (a.onTimePct ?? -1))
      return (b.onTimePct ?? -1) - (a.onTimePct ?? -1);
    return a.avgDaysLateOverall - b.avgDaysLateOverall;
  });
  const rated = sorted.filter((s) => s.state === "rated" && s.score != null);
  const avgPortfolioScore = rated.length
    ? rated.reduce((s, t) => s + (t.score as number), 0) / rated.length
    : null;
  return {
    scores: sorted,
    avgPortfolioScore,
    chronicLateCount: sorted.filter((s) => s.chronicLate).length,
  };
}

// ── Deposit coverage / tenure / lease hygiene / vacancy risk ──────────

export interface DepositCoverage {
  rows: {
    tenantName: string;
    address: string;
    coverage: number | null;
    deposit: number;
    band: "strong" | "ok" | "weak" | "none";
    grade?: string | null;
  }[];
  weightedCoverage: number | null;
  underSecuredCount: number;
  totalDepositHeld: number;
}
export function computeDepositCoverage(
  agreements: OwnerAgreement[],
  scores: TenantScore[],
): DepositCoverage {
  const gradeByTenant = new Map(scores.map((s) => [s.tenantId, s.grade]));
  const rows: DepositCoverage["rows"] = [];
  let sumDep = 0;
  let sumRent = 0;
  let underSecured = 0;
  for (const a of agreements) {
    if (a.status !== "active") continue;
    const deposit = a.deposit || 0;
    const rent = a.monthlyRent || 0;
    const coverage = rent > 0 ? deposit / rent : null;
    sumDep += deposit;
    sumRent += rent;
    let band: "strong" | "ok" | "weak" | "none" = "none";
    if (deposit <= 0) band = "none";
    else if (coverage == null) band = "none";
    else if (coverage >= 2) band = "strong";
    else if (coverage >= 1) band = "ok";
    else {
      band = "weak";
      underSecured++;
    }
    rows.push({
      tenantName: a.tenantName,
      address: a.address,
      coverage,
      deposit,
      band,
      grade: gradeByTenant.get(a.tenantId) ?? null,
    });
  }
  return {
    rows,
    weightedCoverage: sumRent > 0 ? sumDep / sumRent : null,
    underSecuredCount: underSecured,
    totalDepositHeld: sumDep,
  };
}

export interface Tenure {
  rows: {
    tenantId: string;
    name: string;
    tenureMonths: number;
    bucket: "New" | "Established" | "Long-term";
    grade?: string | null;
  }[];
  avgTenureMonths: number | null;
}
export function computeTenure(
  agreements: OwnerAgreement[],
  tenants: OwnerTenant[],
  nowMs: number,
  scores?: TenantScore[],
): Tenure {
  const gradeByTenant = new Map((scores ?? []).map((s) => [s.tenantId, s.grade]));
  // Earliest active-lease start per tenant (renewals must not reset tenure).
  const earliestStart = new Map<string, number>();
  for (const a of agreements) {
    if (a.status !== "active") continue;
    const ms = anyDateToLocalMidnightMs(a.startDate);
    if (ms == null) continue;
    const cur = earliestStart.get(a.tenantId);
    if (cur == null || ms < cur) earliestStart.set(a.tenantId, ms);
  }
  const rows: Tenure["rows"] = [];
  for (const t of tenants) {
    if (t.status !== "active") continue;
    const startMs = earliestStart.get(t.id) ?? anyDateToLocalMidnightMs(t.createdAt);
    if (startMs == null) continue;
    const tenureMonths = Math.max(0, Math.floor((nowMs - startMs) / AVG_MONTH_MS));
    const bucket = tenureMonths < 6 ? "New" : tenureMonths <= 24 ? "Established" : "Long-term";
    rows.push({
      tenantId: t.id,
      name: t.name,
      tenureMonths,
      bucket,
      grade: gradeByTenant.get(t.id) ?? null,
    });
  }
  const avgTenureMonths = rows.length
    ? rows.reduce((s, r) => s + r.tenureMonths, 0) / rows.length
    : null;
  return { rows, avgTenureMonths };
}

export interface VacancyRisk {
  atRiskMonthly: number;
  annualizedExposure: number;
  exposurePct: number | null;
  top3: { address: string; atRisk: number }[];
}
export function computeVacancyRisk(
  agreements: OwnerAgreement[],
  summary: OwnerSummary | undefined,
  windowDays: number,
  nowMs: number,
): VacancyRisk {
  const todayMs = dateOnlyMs(new Date(nowMs).toISOString()) ?? nowMs;
  const horizon = todayMs + windowDays * DAY_MS;
  const perProp: { address: string; atRisk: number }[] = [];
  let atRiskMonthly = 0;
  for (const a of agreements) {
    if (a.status !== "active" || !a.endDate || leaseContinues(a)) continue;
    const endMs = anyDateToLocalMidnightMs(a.endDate);
    if (endMs == null || endMs > horizon) continue;
    const startMs = anyDateToLocalMidnightMs(a.startDate);
    const tenureMonths = startMs != null ? (todayMs - startMs) / AVG_MONTH_MS : 99;
    const tenureMult = tenureMonths < 12 ? 1.15 : 1;
    const risk = (a.monthlyRent || 0) * 1.0 * tenureMult;
    atRiskMonthly += risk;
    perProp.push({ address: a.address, atRisk: risk });
  }
  const monthly = summary?.monthlyRevenue ?? 0;
  perProp.sort((x, y) => y.atRisk - x.atRisk);
  return {
    atRiskMonthly,
    annualizedExposure: atRiskMonthly * 12,
    exposurePct: monthly > 0 ? (atRiskMonthly / monthly) * 100 : null,
    top3: perProp.slice(0, 3),
  };
}

export interface LeaseHygiene {
  autoRenewPct: number | null;
  definedDayPct: number | null;
  nullDayCount: number;
  distinctDays: number;
}
export function computeLeaseHygiene(agreements: OwnerAgreement[]): LeaseHygiene {
  let rentTotal = 0;
  let rentAutoRenew = 0;
  let activeCount = 0;
  let definedDay = 0;
  let nullDay = 0;
  const days = new Set<number>();
  for (const a of agreements) {
    if (a.status !== "active") continue;
    activeCount++;
    const rent = a.monthlyRent || 0;
    rentTotal += rent;
    if (leaseContinues(a)) rentAutoRenew += rent;
    if (a.paymentDayOfMonth != null) {
      definedDay++;
      days.add(a.paymentDayOfMonth);
    } else {
      nullDay++;
    }
  }
  return {
    autoRenewPct: rentTotal > 0 ? (rentAutoRenew / rentTotal) * 100 : null,
    definedDayPct: activeCount > 0 ? (definedDay / activeCount) * 100 : null,
    nullDayCount: nullDay,
    distinctDays: days.size,
  };
}

export interface ProjectedCollection {
  months: {
    label: string;
    scheduled: number;
    projected: number;
    bandLow: number;
    bandHigh: number;
  }[];
  projectedCollected90: number;
  projectedShortfall: number;
}
export function computeProjectedCollection(
  agreements: OwnerAgreement[],
  scores: TenantScore[],
  summary: OwnerSummary | undefined,
  nowMs: number,
): ProjectedCollection {
  const scoreByTenant = new Map(scores.map((s) => [s.tenantId, s]));
  const rated = scores.filter((s) => s.onTimePct != null);
  const portfolioAvg = rated.length
    ? rated.reduce((s, t) => s + (t.onTimePct as number), 0) / rated.length
    : 85;
  const active = agreements.filter((a) => a.status === "active");
  const now = new Date(nowMs);
  const months: ProjectedCollection["months"] = [];
  let projectedCollected90 = 0;
  let scheduledTotal = 0;
  for (let m = 0; m < 3; m++) {
    const label = MONTH_LABELS[new Date(now.getFullYear(), now.getMonth() + m, 1).getMonth()];
    let scheduled = 0;
    let projected = 0;
    let lowConf = false;
    for (const a of active) {
      const rent = a.monthlyRent || 0;
      scheduled += rent;
      const sc = scoreByTenant.get(a.tenantId);
      const onTime = sc?.onTimePct ?? portfolioAvg;
      if (sc?.lowConfidence || sc?.onTimePct == null) lowConf = true;
      projected += rent * (onTime / 100);
    }
    const bandWidth = lowConf ? 0.25 : 0.15;
    months.push({
      label,
      scheduled,
      projected,
      bandLow: projected * (1 - bandWidth),
      bandHigh: Math.min(scheduled, projected * (1 + bandWidth)),
    });
    projectedCollected90 += projected;
    scheduledTotal += scheduled;
  }
  void summary;
  return {
    months,
    projectedCollected90,
    projectedShortfall: Math.max(0, scheduledTotal - projectedCollected90),
  };
}

// ── Cash-flow & cost time series ──────────────────────────────────────

export interface MonthBucket {
  label: string;
  income: number;
  expense: number;
  net: number;
}
function twelveMonthScaffold(nowMs: number) {
  const now = new Date(nowMs);
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1);
    return { year: d.getFullYear(), month: d.getMonth(), label: MONTH_LABELS[d.getMonth()] };
  });
}
export function buildMonthlyCashflow(txns: OwnerTransaction[], nowMs: number): MonthBucket[] {
  const buckets = twelveMonthScaffold(nowMs).map((b) => ({ ...b, income: 0, expense: 0 }));
  for (const t of txns) {
    const ts = new Date(t.timestamp);
    const b = buckets.find((x) => x.year === ts.getFullYear() && x.month === ts.getMonth());
    if (!b) continue;
    const amt = Math.abs(Number(t.amount) || 0);
    if (isRealizedRent(t)) b.income += netRealizedRentAmount(t);
    else if (t.type === "expense" && t.status !== "failed") b.expense += amt;
  }
  return buckets.map((b) => ({
    label: b.label,
    income: b.income,
    expense: b.expense,
    net: b.income - b.expense,
  }));
}

export interface ExpenseTrendMonth {
  label: string;
  maintenance: number;
  tax: number;
  fee: number;
  other: number;
}
export function buildExpenseTrend(txns: OwnerTransaction[], nowMs: number): ExpenseTrendMonth[] {
  const buckets = twelveMonthScaffold(nowMs).map((b) => ({
    ...b,
    maintenance: 0,
    tax: 0,
    fee: 0,
    other: 0,
  }));
  for (const t of txns) {
    if (t.type !== "expense" || t.status === "failed") continue;
    const ts = new Date(t.timestamp);
    const b = buckets.find((x) => x.year === ts.getFullYear() && x.month === ts.getMonth());
    if (!b) continue;
    const cat =
      t.category === "maintenance" || t.category === "tax" || t.category === "fee"
        ? t.category
        : "other";
    b[cat] += Math.abs(Number(t.amount) || 0);
  }
  return buckets.map((b) => ({
    label: b.label,
    maintenance: b.maintenance,
    tax: b.tax,
    fee: b.fee,
    other: b.other,
  }));
}

export interface IncomeMix {
  bySource: { name: string; value: number }[];
  byMethod: { name: string; value: number }[];
  cardPct: number | null;
}
export function computeIncomeMix(
  txns: OwnerTransaction[],
  windowDays: number,
  nowMs: number,
): IncomeMix {
  const from = nowMs - windowDays * DAY_MS;
  const bySource = new Map<string, number>();
  const byMethod = new Map<string, number>();
  let total = 0;
  let card = 0;
  for (const t of txns) {
    const ms = new Date(t.timestamp).getTime();
    if (ms < from || ms > nowMs) continue;
    if (!isRealizedRent(t) || t.category !== "rent") continue;
    const amt = Math.abs(Number(t.amount) || 0);
    const src = t.source ?? "system";
    bySource.set(src, (bySource.get(src) || 0) + amt);
    const method = t.paymentMethod ?? "other";
    byMethod.set(method, (byMethod.get(method) || 0) + amt);
    total += amt;
    if (t.source === "rent") card += amt;
  }
  const toArr = (m: Map<string, number>) =>
    Array.from(m.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  return {
    bySource: toArr(bySource),
    byMethod: toArr(byMethod),
    cardPct: total > 0 ? (card / total) * 100 : null,
  };
}

export interface ExpenseBreakdown {
  data: { name: string; value: number }[];
  total: number;
}
export function computeExpenseBreakdown(
  txns: OwnerTransaction[],
  windowDays: number,
  nowMs: number,
): ExpenseBreakdown {
  const from = nowMs - windowDays * DAY_MS;
  const cats: Record<"maintenance" | "tax" | "fee" | "other", number> = {
    maintenance: 0,
    tax: 0,
    fee: 0,
    other: 0,
  };
  for (const t of txns) {
    const ms = new Date(t.timestamp).getTime();
    if (ms < from || ms > nowMs) continue;
    if (t.type !== "expense" || t.status === "failed") continue;
    const c =
      t.category === "maintenance" || t.category === "tax" || t.category === "fee"
        ? t.category
        : "other";
    cats[c] += Math.abs(Number(t.amount) || 0);
  }
  const data = (["maintenance", "tax", "fee", "other"] as const)
    .map((name) => ({ name, value: cats[name] }))
    .filter((d) => d.value > 0);
  return { data, total: data.reduce((s, d) => s + d.value, 0) };
}

export interface EquityTimeline {
  steps: { label: string; cumulativeCost: number }[];
  todayValue: number;
  unrealizedGain: number;
}
export function buildEquityTimeline(
  properties: OwnerProperty[],
  summary: OwnerSummary | undefined,
): EquityTimeline {
  const items = properties
    .map((p) => {
      let year = parseInt(p.acquisitionYear ?? "", 10);
      if (!Number.isFinite(year)) year = new Date(p.createdAt).getFullYear();
      const cost = p.acquisitionPrice > 0 ? p.acquisitionPrice : (p.propertyValue || 0) * 0.8;
      return { year: Number.isFinite(year) ? year : 0, cost };
    })
    .filter((x) => x.cost > 0)
    .sort((a, b) => a.year - b.year);
  let cum = 0;
  const steps = items.map((it) => {
    cum += it.cost;
    return { label: it.year ? String(it.year) : "—", cumulativeCost: cum };
  });
  const todayValue = summary?.portfolioValue ?? 0;
  return { steps, todayValue, unrealizedGain: todayValue - (summary?.equityInvested ?? 0) };
}

// ── One-shot aggregator ───────────────────────────────────────────────
// The page calls this once (memoized) and hands the bundle to each section, so
// shared derivations (tenant scores, expiring leases) are computed ONCE and the
// Projections + Tenants sections can't drift apart.

export interface InsightsInput {
  summary: OwnerSummary | undefined;
  properties: OwnerProperty[];
  transactions: OwnerTransaction[];
  tenants: OwnerTenant[];
  agreements: OwnerAgreement[];
  windowDays: number;
  nowMs: number;
}

export interface InsightsBundle {
  deltas: PeriodDeltas;
  reconciliation: RentReconciliation;
  runRate: RunRate;
  forward: ForwardIncome;
  expiring: ExpiringLeases;
  projectedNet: ProjectedNet;
  noi: NOI;
  totalReturn: TotalReturn;
  depositLiability: DepositLiability;
  stress: Stress;
  leaderboard: LeaderboardRow[];
  hhi: HHI;
  sqm: SqmBenchmarkType[];
  ranked: RankedTenants;
  depositCoverage: DepositCoverage;
  tenure: Tenure;
  vacancyRisk: VacancyRisk;
  hygiene: LeaseHygiene;
  projectedCollection: ProjectedCollection;
  monthly: MonthBucket[];
  expenseTrend: ExpenseTrendMonth[];
  expenseBreakdown: ExpenseBreakdown;
  incomeMix: IncomeMix;
  equityTimeline: EquityTimeline;
}

export function computeInsights(input: InsightsInput): InsightsBundle {
  const { summary, properties, transactions, tenants, agreements, windowDays, nowMs } = input;
  const scores = scoreTenantPayments(transactions, tenants, nowMs);
  return {
    deltas: computePeriodDeltas(transactions, windowDays, nowMs),
    reconciliation: computeRentReconciliation(summary, transactions, nowMs),
    runRate: computeRunRate(summary, transactions, nowMs),
    forward: buildForwardIncome(agreements, summary, nowMs),
    expiring: buildExpiringLeases(agreements, nowMs, scores),
    projectedNet: computeProjectedNet(agreements, summary, transactions, nowMs),
    noi: computeNOI(summary, transactions, nowMs),
    totalReturn: computeTotalReturn(summary, properties, nowMs),
    depositLiability: computeDepositLiability(agreements, summary),
    stress: computeStress(summary, agreements),
    leaderboard: buildPropertyLeaderboard(properties, transactions, windowDays, nowMs),
    hhi: computeHHI(properties),
    sqm: computeSqmBenchmark(properties),
    ranked: rankTenantScores(scores),
    depositCoverage: computeDepositCoverage(agreements, scores),
    tenure: computeTenure(agreements, tenants, nowMs, scores),
    vacancyRisk: computeVacancyRisk(agreements, summary, windowDays, nowMs),
    hygiene: computeLeaseHygiene(agreements),
    projectedCollection: computeProjectedCollection(agreements, scores, summary, nowMs),
    monthly: buildMonthlyCashflow(transactions, nowMs),
    expenseTrend: buildExpenseTrend(transactions, nowMs),
    expenseBreakdown: computeExpenseBreakdown(transactions, windowDays, nowMs),
    incomeMix: computeIncomeMix(transactions, windowDays, nowMs),
    equityTimeline: buildEquityTimeline(properties, summary),
  };
}
