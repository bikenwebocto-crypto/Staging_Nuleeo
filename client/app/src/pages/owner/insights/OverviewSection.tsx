import {
  Building,
  Wallet,
  Users,
  TrendingUp,
  PieChart,
  Activity,
  TrendingDown,
  AlertCircle,
} from "lucide-react";
import { formatCurrencyShort, formatCurrencyCompact, formatDate } from "@ui/lib/format";
import type { OwnerSummary, OwnerProperty, OwnerTenant } from "@/lib/ownerQueries";
import type { InsightsBundle } from "@/lib/portfolioInsights";
import { StatCard, DeltaChip, SectionHeader, fmtPct } from "./ui";

export function OverviewSection({
  b,
  summary,
  properties,
  tenants,
  windowLabel,
}: {
  b: InsightsBundle;
  summary: OwnerSummary | undefined;
  properties: OwnerProperty[];
  tenants: OwnerTenant[];
  windowLabel: string;
}) {
  const totalValue = summary?.portfolioValue ?? 0;
  const totalRent = summary?.monthlyRevenue ?? 0;
  const equity = summary?.equityInvested ?? 0;
  const capitalGain = totalValue - equity;
  const capitalGainPct = equity > 0 ? (capitalGain / equity) * 100 : null;
  const occupancyRate = summary?.occupancyRate ?? 0;
  const vacant = properties.filter((p) => !p.occupied).length;
  const avgGrossYield = totalValue > 0 ? ((totalRent * 12) / totalValue) * 100 : null;

  const recon = b.reconciliation;
  const collectedPct = recon.pct == null ? 0 : Math.min(100, recon.pct);

  // Live arrears chase-list: overdue active cycles + any preserved closing
  // balance (which a Settle action clears).
  const atRisk = tenants.filter(
    (t) => t.paymentStatus === "overdue" || (t.outstandingBalance ?? 0) > 0,
  );
  const totalArrears = atRisk.reduce((s, t) => s + (t.outstandingBalance ?? 0), 0);
  const overdueCount = tenants.filter((t) => t.paymentStatus === "overdue").length;

  return (
    <section>
      <SectionHeader
        id="overview"
        title="Overview & health"
        subtitle="Headline position, this-period KPIs, and what needs attention"
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <StatCard
          icon={Building}
          label="Total Portfolio Value"
          value={formatCurrencyShort(totalValue)}
          accent="bg-blue-500/10"
        />
        <StatCard
          icon={Wallet}
          label="Expected Monthly Rent"
          value={formatCurrencyCompact(totalRent)}
          accent="bg-emerald-500/10"
          caption="Contracted across active leases (expected, not yet collected)"
        />
        <StatCard
          icon={Users}
          label="Occupancy Rate"
          value={`${occupancyRate}%`}
          accent="bg-sky-500/10"
          caption={`${vacant} vacant ${vacant === 1 ? "property" : "properties"}`}
        />
        <StatCard
          icon={TrendingUp}
          label="Value Growth on Cost"
          value={formatCurrencyShort(capitalGain)}
          accent="bg-violet-500/10"
          caption={
            capitalGainPct == null ? (
              "Unrealized vs acquisition cost"
            ) : (
              <span
                className={
                  capitalGain >= 0
                    ? "text-emerald-600 dark:text-emerald-400 font-medium"
                    : "text-red-600 dark:text-red-400 font-medium"
                }
              >
                {capitalGain >= 0 ? "+" : ""}
                {capitalGainPct.toFixed(1)}% on cost (unrealized)
              </span>
            )
          }
        />
      </div>

      {/* This-period KPIs with period-over-period deltas */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <KpiCard icon={PieChart} label="Avg. Gross Yield" value={fmtPct(avgGrossYield)} />
        <KpiCard
          icon={Activity}
          label={`Collection Rate · ${windowLabel}`}
          value={
            b.deltas.collectionRate.value == null
              ? "—"
              : `${Math.round(b.deltas.collectionRate.value)}%`
          }
          delta={<DeltaChip deltaPct={b.deltas.collectionRate.deltaPct} />}
        />
        <KpiCard
          icon={TrendingDown}
          label={`Expense Ratio · ${windowLabel}`}
          value={
            b.deltas.expenseRatio.value == null
              ? "—"
              : `${Math.round(b.deltas.expenseRatio.value)}%`
          }
          delta={<DeltaChip deltaPct={b.deltas.expenseRatio.deltaPct} invert />}
        />
        <KpiCard
          icon={Wallet}
          label={`Net Income · ${windowLabel}`}
          value={formatCurrencyShort(b.deltas.netIncome.value ?? 0)}
          delta={<DeltaChip deltaPct={b.deltas.netIncome.deltaPct} />}
        />
      </div>

      {/* Rent-roll → collected reconciliation (current month) */}
      <div className="bg-card p-6 rounded-2xl border border-border shadow-sm mb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
          <h3 className="font-bold text-foreground">This month's rent — expected vs collected</h3>
          <span className="text-sm text-muted-foreground">
            {recon.expected > 0 ? `${fmtPct(recon.pct, 0)} collected` : "No contracted rent yet"}
          </span>
        </div>
        {recon.expected > 0 ? (
          <>
            <div className="flex w-full h-3 rounded-full overflow-hidden bg-secondary mb-3">
              <div className="bg-emerald-500" style={{ width: `${collectedPct}%` }} />
              <div className="bg-red-500/60" style={{ width: `${100 - collectedPct}%` }} />
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span className="text-muted-foreground">
                Expected{" "}
                <span className="font-semibold text-foreground">
                  {formatCurrencyCompact(recon.expected)}
                </span>
              </span>
              <span className="text-muted-foreground">
                Collected{" "}
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  {formatCurrencyCompact(recon.collected)}
                </span>
              </span>
              {recon.shortfall > 0 && (
                <span className="text-muted-foreground">
                  Outstanding{" "}
                  <span className="font-semibold text-red-600 dark:text-red-400">
                    {formatCurrencyCompact(recon.shortfall)}
                  </span>
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground/70 mt-2">
              Rent attributed to the cycle it covers; excludes prepaid advances and pending
              (unverified) offline rent.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Collection tracking begins once a lease is active.
          </p>
        )}
      </div>

      {/* Arrears / at-risk rent */}
      {(atRisk.length > 0 || tenants.length > 0) &&
        (atRisk.length > 0 ? (
          <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 p-6 pb-4">
              <div className="flex items-center gap-2">
                <AlertCircle size={18} className="text-red-500" />
                <h3 className="font-bold text-foreground">Rent at risk</h3>
              </div>
              <div className="text-right">
                <span className="block text-lg font-bold text-foreground">
                  {formatCurrencyShort(totalArrears)}
                </span>
                <span className="text-xs text-muted-foreground">
                  outstanding (incl. closed leases)
                  {overdueCount > 0 ? ` · ${overdueCount} overdue` : ""}
                </span>
              </div>
            </div>
            <div className="divide-y divide-border">
              {atRisk.map((t) => (
                <div key={t.id} className="flex items-center gap-3 px-6 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{t.name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {t.propertyAddress ?? "—"}
                    </p>
                  </div>
                  {t.paymentStatus === "overdue" && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-600 dark:text-red-400 shrink-0">
                      Overdue
                    </span>
                  )}
                  <div className="text-right shrink-0">
                    {(t.outstandingBalance ?? 0) > 0 && (
                      <span className="block text-sm font-bold text-foreground">
                        {formatCurrencyCompact(t.outstandingBalance)}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      Due {formatDate(t.nextPayment)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl px-4 py-3">
            <Wallet size={16} /> All rent collected — no arrears.
          </div>
        ))}
    </section>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  delta,
}: {
  icon: typeof PieChart;
  label: string;
  value: string;
  delta?: React.ReactNode;
}) {
  return (
    <div className="bg-card p-5 rounded-2xl border border-border shadow-sm flex flex-col gap-1.5 h-32 justify-center">
      <Icon size={20} className="text-muted-foreground" />
      <div className="text-2xl font-extrabold text-foreground leading-none">{value}</div>
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs text-muted-foreground font-medium truncate">{label}</span>
        {delta}
      </div>
    </div>
  );
}
