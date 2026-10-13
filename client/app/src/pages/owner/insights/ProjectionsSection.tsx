import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { TrendingUp, Wallet, Gauge, PiggyBank, CalendarClock, AlertTriangle } from "lucide-react";
import { formatCurrencyShort, formatCurrencyCompact, formatDate } from "@ui/lib/format";
import type { InsightsBundle, ExpiringLeases } from "@/lib/portfolioInsights";
import { StatCard, SectionHeader, EmptyState, LazyChart, CHART_TOOLTIP_STYLE, fmtPct } from "./ui";

export function ProjectionsSection({ b }: { b: InsightsBundle }) {
  const { runRate, forward, projectedNet, noi, totalReturn, depositLiability, stress } = b;
  const totalReturnPct =
    totalReturn.grossYield == null && totalReturn.appreciationRunRate == null
      ? null
      : (totalReturn.grossYield ?? 0) + (totalReturn.appreciationRunRate ?? 0);
  const hasForward = forward.months.some((m) => m.projected > 0);

  return (
    <section>
      <SectionHeader
        id="projections"
        title="Projections & forecasting"
        subtitle="Forward-looking estimates from signed lease terms and trailing costs — not guarantees"
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
        <StatCard
          icon={TrendingUp}
          label="Contracted annual run-rate"
          value={formatCurrencyShort(runRate.annualRunRate)}
          accent="bg-emerald-500/10"
          caption="Estimate — assumes active leases hold at current rent for 12 months; excludes vacancies, renewals & indexation."
        />
        <StatCard
          icon={Wallet}
          label="Projected net cash flow · 12mo"
          value={formatCurrencyShort(projectedNet.projectedAnnualNet)}
          accent="bg-teal-500/10"
          caption={`Estimate — future costs at trailing avg (${formatCurrencyCompact(projectedNet.trailingMonthlyExpense)}/mo over ${projectedNet.monthsOfHistory}mo); one-offs may not repeat.`}
        />
        <StatCard
          icon={Gauge}
          label="Projected NOI & forward cap rate"
          value={formatCurrencyShort(noi.noi)}
          accent="bg-blue-500/10"
          caption={
            <>
              Cap rate <span className="font-semibold text-foreground">{fmtPct(noi.capRate)}</span>{" "}
              — contracted rent less trailing-12mo operating costs; excludes financing & capex.
            </>
          }
        />
        <StatCard
          icon={TrendingUp}
          label="Annualized total return"
          value={fmtPct(totalReturnPct)}
          accent="bg-violet-500/10"
          caption={
            <>
              Yield {fmtPct(totalReturn.grossYield)} + appreciation{" "}
              {fmtPct(totalReturn.appreciationRunRate)}/yr (over ~
              {totalReturn.avgHoldingYears.toFixed(0)}y hold; some cost bases estimated).
            </>
          }
        />
        <StatCard
          icon={PiggyBank}
          label="Deposit liability held"
          value={formatCurrencyShort(depositLiability.depositLiability)}
          accent="bg-amber-500/10"
          caption={
            depositLiability.depositMonths == null
              ? "Funds held for tenants — not income; returnable at lease end."
              : `${depositLiability.depositMonths.toFixed(1)}× monthly rent held across ${depositLiability.contributingLeases} lease(s) — not income.`
          }
        />
        <StatCard
          icon={AlertTriangle}
          label="If your biggest tenant leaves"
          value={formatCurrencyShort(stress.oneVacancyStress)}
          accent="bg-rose-500/10"
          caption={`Remaining annual rent vs ${formatCurrencyShort(stress.contractedAnnual)} contracted — single-vacancy stress estimate.`}
        />
      </div>

      {/* Forward 12-month income projection */}
      <div className="bg-card p-6 rounded-2xl border border-border shadow-sm mb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
          <h3 className="font-bold text-foreground">Forward income · next 12 months</h3>
          <span className="text-xs text-muted-foreground">dashed = current run-rate</span>
        </div>
        <p className="text-xs text-muted-foreground/70 mb-3">
          Estimate based on signed lease terms; lease end-dates (without auto-renewal) show as
          upcoming drops. Excludes new lettings & indexation.
        </p>
        {hasForward ? (
          <LazyChart
            minHeight={240}
            label="Area chart: projected forward rental income over the next 12 months based on signed lease terms"
          >
            <div className="h-60 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={forward.months}
                  margin={{ top: 5, right: 10, left: -20, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="fwdFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--brand-accent)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--brand-accent)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="label"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                    dy={10}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                  />
                  <Tooltip
                    formatter={(v) => formatCurrencyCompact(Number(v))}
                    contentStyle={CHART_TOOLTIP_STYLE}
                  />
                  <ReferenceLine
                    y={forward.runRatePerMonth}
                    stroke="var(--muted-foreground)"
                    strokeDasharray="4 4"
                  />
                  <Area
                    type="monotone"
                    dataKey="projected"
                    stroke="var(--brand-accent)"
                    strokeWidth={2}
                    fill="url(#fwdFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </LazyChart>
        ) : (
          <EmptyState
            icon={TrendingUp}
            title="No forward income to project"
            hint="Add active leases. Leases nearing their end date will show as upcoming drops here."
          />
        )}
      </div>

      <ExpiringLeasesCard expiring={b.expiring} />
    </section>
  );
}

// Shared lease-expiry / income-at-risk timeline. Rendered in BOTH Projections and
// Tenants from the one buildExpiringLeases result so the two never drift.
export function ExpiringLeasesCard({ expiring }: { expiring: ExpiringLeases }) {
  return (
    <div className="bg-card p-6 rounded-2xl border border-border shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="font-bold text-foreground flex items-center gap-2">
          <CalendarClock size={18} className="text-muted-foreground" /> Lease expiry & income at
          risk
        </h3>
        {expiring.leases.length > 0 && (
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span>
              90d{" "}
              <span className="font-semibold text-foreground">
                {formatCurrencyShort(expiring.within90)}
              </span>
            </span>
            <span>
              180d{" "}
              <span className="font-semibold text-foreground">
                {formatCurrencyShort(expiring.within180)}
              </span>
            </span>
            <span>
              1y{" "}
              <span className="font-semibold text-foreground">
                {formatCurrencyShort(expiring.within365)}
              </span>
            </span>
          </div>
        )}
      </div>
      {expiring.leases.length === 0 ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          No fixed-term leases expiring within 12 months — contracted income looks stable.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {expiring.leases.map((l) => {
            const pill = l.holdover
              ? "bg-red-500/10 text-red-600 dark:text-red-400"
              : l.daysToExpiry <= 60
                ? "bg-red-500/10 text-red-600 dark:text-red-400"
                : l.daysToExpiry <= 180
                  ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  : "bg-secondary text-muted-foreground";
            return (
              <div key={l.id} className="flex items-center gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{l.address}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {l.tenantName} · ends {formatDate(l.endDate)}
                  </p>
                </div>
                <span className="text-sm font-semibold text-foreground shrink-0">
                  {formatCurrencyCompact(l.monthlyRent)}/mo
                </span>
                <span
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${pill}`}
                >
                  {l.holdover ? "Holdover" : l.daysToExpiry <= 0 ? "Due" : `${l.daysToExpiry}d`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
