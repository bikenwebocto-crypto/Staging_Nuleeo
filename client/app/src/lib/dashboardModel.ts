// Dashboard view-model for the owner home page.
//
// Pure derivation layer: the page passes the query results it already fetched
// (summary, properties, transactions, tenants, agreements) and this module
// turns them into the card-ready shapes. No hardcoded demo values, no extra
// API calls, and no React/recharts imports so it stays unit-testable.
//
// Money rules are inherited from `portfolioInsights` (the single source of
// truth for realized income) — pending offline rent is never counted as cash.

import { isRealizedRent, netRealizedRentAmount } from "@shared/realizedRent";
import { formatDate } from "@ui/lib/format";
import type {
  OwnerAgreement,
  OwnerProperty,
  OwnerSummary,
  OwnerTenant,
  OwnerTransaction,
} from "./ownerQueries";
import {
  buildExpiringLeases,
  buildMonthlyCashflow,
  computeTotalReturn,
  type MonthBucket,
} from "./portfolioInsights";

const DAY_MS = 86_400_000;

export type AttentionPriority = "critical" | "warning" | "info";
export type AttentionKind = "rent" | "lease" | "approval" | "document" | "profile" | "deed";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  subject: string;
  dueLabel: string;
  dueIso: string | null;
  priority: AttentionPriority;
  actionLabel: string;
  href: string;
}

export interface UpcomingPayment {
  id: string;
  tenantName: string;
  propertyAddress: string | null;
  date: string;
  amount: number;
}

export interface OwnerBreakdownRow {
  name: string;
  value: number;
  pct: number;
}

export interface DashboardModel {
  propertyCount: number;
  unitCount: number;
  portfolioGrowth?: number | null;
  monthlyIncome: {
    value: number;
    contracted: number;
    activeTenancies: number;
    deltaPct: number | null;
    series: number[];
  };
  cash: {
    value: number;
    accounts: number;
    lastSync: string | null;
    deltaPct: number | null;
    series: number[];
  };
  attention: {
    total: number;
    urgent: number;
    items: AttentionItem[];
  };
  portfolio: {
    value: number;
    unrealizedGain: number;
    monthlyGrowth: number;
    monthlyGrowthPct: number | null;
    monthly: MonthBucket[];
  };
  byOwner: {
    companyValue: number;
    individualValue: number;
    total: number;
    companies: OwnerBreakdownRow[];
  };
  recent: OwnerTransaction[];
  upcoming: UpcomingPayment[];
}

export interface DashboardInput {
  summary?: OwnerSummary;
  properties: OwnerProperty[];
  transactions: OwnerTransaction[];
  tenants: OwnerTenant[];
  agreements: OwnerAgreement[];
  nowMs: number;
}

function money(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function timestampMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function windowTotals(txns: OwnerTransaction[], fromMs: number, toMs: number) {
  let income = 0;
  let expense = 0;
  for (const t of txns) {
    const ms = timestampMs(t.timestamp);
    if (ms < fromMs || ms > toMs) continue;
    if (isRealizedRent(t)) {
      income += netRealizedRentAmount(t);
    } else if (t.type === "expense" && t.status !== "failed") {
      expense += Math.abs(money(t.amount));
    }
  }
  return { income, expense, net: income - expense };
}

const PRIORITY_RANK: Record<AttentionPriority, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function buildAttentionItems(input: DashboardInput): AttentionItem[] {
  const { properties, transactions, tenants, agreements, nowMs } = input;
  const items: AttentionItem[] = [];

  // Overdue rent / outstanding balances. A closed tenancy can still carry a
  // preserved closing balance, so `outstandingBalance` is checked too.
  for (const t of tenants) {
    const overdue = t.paymentStatus === "overdue";
    const balance = money(t.outstandingBalance);
    if (!overdue && balance <= 0) continue;
    items.push({
      id: `rent-${t.id}`,
      kind: "rent",
      title: overdue ? "Rent overdue" : "Balance outstanding",
      subject: [t.name, t.propertyAddress].filter(Boolean).join(" · "),
      dueLabel: t.nextPayment ? `Due ${formatDate(t.nextPayment)}` : "Awaiting payment",
      dueIso: t.nextPayment,
      priority: overdue ? "critical" : "warning",
      actionLabel: "Review",
      href: "/tenants",
    });
  }

  // Leases expiring inside the next 90 days (or already in holdover).
  for (const lease of buildExpiringLeases(agreements, nowMs).leases) {
    if (lease.daysToExpiry > 90) continue;
    items.push({
      id: `lease-${lease.id}`,
      kind: "lease",
      title: lease.holdover ? "Lease in holdover" : "Lease expiring",
      subject: `${lease.tenantName} · ${lease.address}`,
      dueLabel: lease.holdover
        ? `Expired ${Math.abs(lease.daysToExpiry)}d ago`
        : `${lease.daysToExpiry}d left`,
      dueIso: lease.endDate,
      priority: lease.daysToExpiry <= 30 ? "critical" : "warning",
      actionLabel: "Renew",
      href: "/owner/agreements",
    });
  }

  // Transactions awaiting the owner's verification / review.
  for (const t of transactions) {
    if (t.status !== "pending") continue;
    const title =
      t.category === "maintenance"
        ? "Maintenance needs review"
        : t.category === "rent"
          ? "Rent awaiting verification"
          : "Payment pending";
    items.push({
      id: `tx-${t.id}`,
      kind: "approval",
      title,
      subject: [t.name, t.propertyAddress].filter(Boolean).join(" · "),
      dueLabel: `Since ${formatDate(t.timestamp)}`,
      dueIso: t.timestamp,
      priority: "warning",
      actionLabel: "Review",
      href: "/owner/activity",
    });
  }

  // Active leases without a signed copy on file.
  for (const a of agreements) {
    if (a.status !== "active" || a.documentUrl) continue;
    items.push({
      id: `doc-${a.id}`,
      kind: "document",
      title: "Lease document missing",
      subject: `${a.tenantName} · ${a.address}`,
      dueLabel: "No signed copy",
      dueIso: null,
      priority: "info",
      actionLabel: "Upload",
      href: "/owner/agreements",
    });
  }

  // Property profile / title-deed gaps.
  for (const p of properties) {
    if (p.titleDeedsStatus === "pending") {
      items.push({
        id: `deed-${p.id}`,
        kind: "deed",
        title: "Title deeds pending",
        subject: p.address,
        dueLabel: "Awaiting issuance",
        dueIso: null,
        priority: "info",
        actionLabel: "Review",
        href: `/properties/${p.id}`,
      });
    } else if (!p.image) {
      items.push({
        id: `profile-${p.id}`,
        kind: "profile",
        title: "Property photo missing",
        subject: p.address,
        dueLabel: "Profile incomplete",
        dueIso: null,
        priority: "info",
        actionLabel: "Complete",
        href: `/properties/${p.id}`,
      });
    }
  }

  // Tenant profiles missing a contact number.
  for (const t of tenants) {
    if (t.status !== "active" || t.phone) continue;
    items.push({
      id: `tenant-${t.id}`,
      kind: "profile",
      title: "Tenant contact missing",
      subject: [t.name, t.propertyAddress].filter(Boolean).join(" · "),
      dueLabel: "Profile incomplete",
      dueIso: null,
      priority: "info",
      actionLabel: "Update",
      href: "/tenants",
    });
  }

  return items.sort((a, b) => {
    const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (byPriority !== 0) return byPriority;
    const aMs = timestampMs(a.dueIso);
    const bMs = timestampMs(b.dueIso);
    if (aMs && bMs && aMs !== bMs) return aMs - bMs;
    if (aMs && !bMs) return -1;
    if (!aMs && bMs) return 1;
    return a.title.localeCompare(b.title);
  });
}

export function buildDashboardModel(input: DashboardInput): DashboardModel {
  const { summary, properties, transactions, tenants, nowMs } = input;

  // ── Monthly income ────────────────────────────────────────────────
  const monthly = buildMonthlyCashflow(transactions, nowMs);
  const thisMonth = monthly[monthly.length - 1];
  const priorMonth = monthly[monthly.length - 2];
  const activeTenancies = tenants.filter((t) => t.status === "active").length;

  // ── Cash ──────────────────────────────────────────────────────────
  // There is no live bank-balance feed, so this is the realized net cash
  // position over the last 30 days (collected rent minus recorded expenses).
  const last30 = windowTotals(transactions, nowMs - 30 * DAY_MS, nowMs);
  const prior30 = windowTotals(transactions, nowMs - 60 * DAY_MS, nowMs - 30 * DAY_MS);
  const latestSync = transactions.reduce<string | null>((latest, t) => {
    if (!t.timestamp) return latest;
    if (!latest) return t.timestamp;
    return timestampMs(t.timestamp) > timestampMs(latest) ? t.timestamp : latest;
  }, null);
  const spvNames = new Set<string>();
  for (const p of properties) {
    spvNames.add(
      p.ownershipType === "company" ? p.companyName?.trim() || "Company SPV" : "Personal",
    );
  }

  // ── Attention ─────────────────────────────────────────────────────
  const allAttention = buildAttentionItems(input);

  // ── Portfolio ─────────────────────────────────────────────────────
  const totalReturn = computeTotalReturn(summary, properties, nowMs);
  const monthlyGrowthPct =
    totalReturn.appreciationRunRate == null ? null : totalReturn.appreciationRunRate / 12;
  const portfolioValue = money(summary?.portfolioValue);
  const monthlyGrowth =
    monthlyGrowthPct == null ? 0 : (portfolioValue * Math.abs(monthlyGrowthPct)) / 100;

  // ── By owner ──────────────────────────────────────────────────────
  let companyValue = 0;
  let individualValue = 0;
  const companyMap = new Map<string, number>();
  for (const p of properties) {
    const value = money(p.propertyValue);
    if (p.ownershipType === "company") {
      companyValue += value;
      const name = p.companyName?.trim() || "Company SPV";
      companyMap.set(name, (companyMap.get(name) || 0) + value);
    } else {
      individualValue += value;
    }
  }
  if (companyValue + individualValue <= 0 && portfolioValue > 0) {
    // Legacy properties without per-property valuations: fall back to the
    // authoritative portfolio total rather than showing an empty card.
    individualValue = portfolioValue;
  }
  const ownerTotal = companyValue + individualValue;
  const companies: OwnerBreakdownRow[] = Array.from(companyMap.entries())
    .map(([name, value]) => ({
      name,
      value,
      pct: ownerTotal > 0 ? (value / ownerTotal) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);

  // ── Transactions ──────────────────────────────────────────────────
  const recent = [...transactions]
    .sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp))
    .slice(0, 6);

  const upcoming: UpcomingPayment[] = tenants
    .filter(
      (t) =>
        t.status === "active" && !!t.nextPayment && timestampMs(t.nextPayment) >= nowMs - DAY_MS,
    )
    .map((t) => ({
      id: t.id,
      tenantName: t.name,
      propertyAddress: t.propertyAddress,
      date: t.nextPayment as string,
      amount: money(t.rentAmount),
    }))
    .sort((a, b) => timestampMs(a.date) - timestampMs(b.date))
    .slice(0, 6);

  const propertyCount = properties.length;
  const unitCount =
    money(summary?.unitCount) ||
    properties.reduce((total, property) => total + money(property.unitCount), 0);

  return {
    propertyCount,
    unitCount,
    portfolioGrowth: summary?.portfolioGrowth ?? null,
    monthlyIncome: {
      value: thisMonth?.income ?? 0,
      contracted: money(summary?.monthlyRevenue),
      activeTenancies,
      deltaPct: priorMonth ? pctChange(thisMonth?.income ?? 0, priorMonth.income) : null,
      series: monthly.map((m) => m.income),
    },
    cash: {
      value: last30.net,
      accounts: spvNames.size,
      lastSync: latestSync,
      deltaPct: pctChange(last30.net, prior30.net),
      series: monthly.map((m) => m.net),
    },
    attention: {
      total: allAttention.length,
      urgent: allAttention.filter((i) => i.priority === "critical").length,
      items: allAttention.slice(0, 12),
    },
    portfolio: {
      value: portfolioValue,
      unrealizedGain: portfolioValue - money(summary?.equityInvested),
      monthlyGrowth,
      monthlyGrowthPct,
      monthly,
    },
    byOwner: {
      companyValue,
      individualValue,
      total: ownerTotal,
      companies,
    },
    recent,
    upcoming,
  };
}
