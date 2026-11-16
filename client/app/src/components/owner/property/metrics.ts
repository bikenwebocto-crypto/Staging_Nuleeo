// Property-level figures for the Property page (KPI bar, Financial summary,
// Financials tab, notifications). Pure functions so they can be unit-tested
// and later moved behind GET /api/properties/:id/financials unchanged.
import type { Transaction } from "@shared/firestore-schema";
import { isRealizedRent } from "@shared/realizedRent";
import { resolveRentalUse, type PropertyProfile } from "@shared/propertyProfile";

const DAY = 86_400_000;

export type FinancialRange = "12m" | "ytd";

export function rangeStart(range: FinancialRange, now = new Date()): Date {
  return range === "ytd"
    ? new Date(now.getFullYear(), 0, 1)
    : new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
}

export interface FinancialSummary {
  rentalIncome: number;
  operatingExpenses: number;
  netIncome: number;
  grossYield: number | null; // %
  annualRent: number;
}

// Operating expenses = recorded expense transactions in the window. When the
// owner has recorded none yet, fall back to the configured running costs
// (property tax + municipal + common charges ×12 + insurance premium) so the
// summary isn't blank on a fresh property.
export function configuredYearlyCosts(profile: PropertyProfile | undefined): number {
  const c = profile?.costs;
  if (!c) return 0;
  return (
    (c.propertyTaxYearly ?? 0) +
    (c.municipalYearly ?? 0) +
    (c.commonMonthly ?? 0) * 12 +
    (c.insurance?.premiumYearly ?? 0)
  );
}

export function financialSummary(
  transactions: Transaction[],
  opts: {
    range: FinancialRange;
    value: number;
    monthlyRent: number;
    profile?: PropertyProfile;
    now?: Date;
  },
): FinancialSummary {
  const now = opts.now ?? new Date();
  const from = rangeStart(opts.range, now).getTime();
  const inRange = transactions.filter((t) => new Date(t.timestamp).getTime() >= from);
  const rentalIncome = inRange
    .filter((t) => isRealizedRent(t))
    .reduce((s, t) => s + (t.amount ?? 0), 0);
  const recordedExpenses = inRange
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + (t.amount ?? 0), 0);
  const configured = configuredYearlyCosts(opts.profile);
  const operatingExpenses =
    recordedExpenses > 0
      ? recordedExpenses
      : opts.range === "ytd"
        ? (configured * (now.getMonth() + 1)) / 12
        : configured;
  const annualRent = opts.monthlyRent * 12;
  return {
    rentalIncome,
    operatingExpenses,
    netIncome: rentalIncome - operatingExpenses,
    grossYield: opts.value > 0 && annualRent > 0 ? (annualRent / opts.value) * 100 : null,
    annualRent,
  };
}

export function loanMetrics(
  value: number,
  profile: PropertyProfile | undefined,
  netIncomeYearly: number,
) {
  const f = profile?.financing;
  if (!f?.hasLoan || !f.balance) return null;
  return {
    ltv: value > 0 ? (f.balance / value) * 100 : null,
    equity: value - f.balance,
    // DSCR = net operating income ÷ annual debt service.
    dscr:
      f.monthlyPayment && f.monthlyPayment > 0 ? netIncomeYearly / (f.monthlyPayment * 12) : null,
  };
}

// Short-term lets have no lease rent: monthly rent = avg realized rent over
// the last 12 months.
export function shortTermMonthlyRent(transactions: Transaction[], now = new Date()): number {
  const from = rangeStart("12m", now).getTime();
  const total = transactions
    .filter((t) => isRealizedRent(t) && new Date(t.timestamp).getTime() >= from)
    .reduce((s, t) => s + (t.amount ?? 0), 0);
  return total / 12;
}

export function daysUntil(iso: string | undefined | null, now = new Date()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((t - today) / DAY);
}

// "16 days" under three weeks, "about 5 weeks" after.
export function humanizeDays(days: number): string {
  if (days < 21) return `${days} ${days === 1 ? "day" : "days"}`;
  const weeks = Math.round(days / 7);
  return `${weeks} weeks`;
}

export { resolveRentalUse };
