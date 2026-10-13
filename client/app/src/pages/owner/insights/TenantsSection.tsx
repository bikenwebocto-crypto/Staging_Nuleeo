import { Users, ShieldCheck, PiggyBank, Clock, AlertTriangle } from "lucide-react";
import { formatCurrencyShort, formatCurrencyCompact } from "@ui/lib/format";
import type { InsightsBundle } from "@/lib/portfolioInsights";
import { SectionHeader, EmptyState, ScoreBadge, LatenessSparkline, StatCard, fmtPct } from "./ui";
import { ExpiringLeasesCard } from "./ProjectionsSection";

export function TenantsSection({ b }: { b: InsightsBundle }) {
  const { ranked, depositCoverage, tenure, vacancyRisk, hygiene, projectedCollection } = b;
  const scores = ranked.scores;
  const anyScorable = scores.some((s) => s.state !== "unrated");

  return (
    <section>
      <SectionHeader
        id="tenants"
        title="Tenants & lease analytics"
        subtitle="Payment reliability, deposit cover, tenure and renewal risk"
      />

      {/* Headline stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
        <StatCard
          icon={ShieldCheck}
          label="Avg. tenant reliability"
          value={
            ranked.avgPortfolioScore == null ? "—" : `${Math.round(ranked.avgPortfolioScore)}/100`
          }
          accent="bg-emerald-500/10"
          caption={
            ranked.chronicLateCount > 0
              ? `${ranked.chronicLateCount} chronic-late tenant(s) to watch`
              : "Across rated tenants with payment history"
          }
        />
        <StatCard
          icon={AlertTriangle}
          label="Rent at risk from expiries"
          value={formatCurrencyShort(vacancyRisk.annualizedExposure)}
          accent="bg-rose-500/10"
          caption={
            vacancyRisk.exposurePct == null
              ? "No fixed-term leases lapsing in this window."
              : `${fmtPct(vacancyRisk.exposurePct, 0)} of monthly rent — estimate, assumes no renewal.`
          }
        />
        <StatCard
          icon={PiggyBank}
          label="Projected collection · 90d"
          value={formatCurrencyShort(projectedCollection.projectedCollected90)}
          accent="bg-teal-500/10"
          caption={
            projectedCollection.projectedShortfall > 0
              ? `Estimate — ~${formatCurrencyCompact(projectedCollection.projectedShortfall)} potential shortfall vs scheduled, from on-time history.`
              : "Estimate — based on past on-time rate × contracted rent."
          }
        />
      </div>

      {/* Reliability leaderboard */}
      <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden mb-4">
        <div className="flex items-center justify-between gap-3 p-6 pb-4">
          <h3 className="font-bold text-foreground flex items-center gap-2">
            <Users size={18} className="text-muted-foreground" /> Payment reliability
          </h3>
          {ranked.avgPortfolioScore != null && (
            <span className="text-xs text-muted-foreground">
              Portfolio avg{" "}
              <span className="font-semibold text-foreground">
                {Math.round(ranked.avgPortfolioScore)}
              </span>
            </span>
          )}
        </div>
        {scores.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No tenants yet"
            hint="Reliability scores appear once rent payments are recorded."
            height={160}
          />
        ) : !anyScorable ? (
          <EmptyState
            icon={ShieldCheck}
            title="No payment history yet"
            hint="Scores grade tenants A–F once on-platform rent payments are recorded with a due date."
            height={160}
          />
        ) : (
          <div className="divide-y divide-border">
            {scores.map((s) => (
              <div key={s.tenantId} className="flex items-center gap-3 px-6 py-3">
                <ScoreBadge
                  grade={s.grade}
                  score={s.score}
                  state={s.state}
                  lowConfidence={s.lowConfidence}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground truncate">{s.name}</p>
                    {s.chronicLate && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-600 dark:text-red-400">
                        Chronic late
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {s.state === "unrated"
                      ? "New — not enough payment history"
                      : `${s.onTimePct != null ? `${Math.round(s.onTimePct)}% on time` : ""}${s.avgDaysLateOverall > 0 ? ` · avg ${s.avgDaysLateOverall.toFixed(1)}d late` : ""}${s.state === "provisional" ? " · limited history" : ""}${s.unscorablePayments > 0 ? ` · ${s.unscorablePayments} unscorable` : ""}`}
                  </p>
                </div>
                <div className="hidden sm:block shrink-0">
                  <LatenessSparkline values={s.last6} />
                </div>
                <div className="text-right shrink-0 w-20">
                  <span className="block text-sm font-semibold text-foreground tabular-nums">
                    {formatCurrencyShort(s.totalPaid)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {s.paymentCount} pmt{s.paymentCount === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Deposit coverage + lease hygiene */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="bg-card p-6 rounded-2xl border border-border shadow-sm">
          <div className="flex items-baseline justify-between mb-4">
            <h3 className="font-bold text-foreground">Deposit coverage</h3>
            {depositCoverage.weightedCoverage != null && (
              <span className="text-xs text-muted-foreground">
                {depositCoverage.weightedCoverage.toFixed(1)}× rent held
              </span>
            )}
          </div>
          {depositCoverage.rows.length === 0 ? (
            <EmptyState
              icon={PiggyBank}
              title="No active leases"
              hint="Deposit coverage appears with an active lease that has rent and a deposit."
              height={140}
            />
          ) : (
            <div className="space-y-3">
              {depositCoverage.rows.map((r, i) => {
                const bar =
                  r.band === "strong"
                    ? "bg-emerald-500"
                    : r.band === "ok"
                      ? "bg-amber-500"
                      : r.band === "weak"
                        ? "bg-red-500"
                        : "bg-border";
                const w = r.coverage == null ? 0 : Math.min(100, (r.coverage / 2) * 100);
                return (
                  <div key={i}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-foreground truncate flex-1 min-w-0">
                        {r.tenantName}
                      </span>
                      <span className="text-muted-foreground tabular-nums ml-2">
                        {r.coverage == null ? "— no deposit" : `${r.coverage.toFixed(1)}×`}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-secondary overflow-hidden">
                      <div className={bar} style={{ width: `${w}%`, height: "100%" }} />
                    </div>
                  </div>
                );
              })}
              {depositCoverage.underSecuredCount > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                  {depositCoverage.underSecuredCount} lease(s) under 1× rent — under-secured.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="bg-card p-6 rounded-2xl border border-border shadow-sm">
          <h3 className="font-bold text-foreground mb-4">Lease hygiene</h3>
          <div className="space-y-4">
            <Gauge
              label="Auto-renew coverage"
              pct={hygiene.autoRenewPct}
              hint="of rent on auto/fixed-renewing leases"
            />
            <Gauge
              label="Payment day on file"
              pct={hygiene.definedDayPct}
              hint={
                hygiene.nullDayCount > 0
                  ? `${hygiene.nullDayCount} lease(s) with no due day set`
                  : "all active leases have a due day"
              }
            />
          </div>
          {/* Tenure summary */}
          {tenure.avgTenureMonths != null && (
            <div className="mt-4 pt-4 border-t border-border flex items-center gap-2 text-sm text-muted-foreground">
              <Clock size={15} /> Avg. tenant tenure{" "}
              <span className="font-semibold text-foreground">
                {Math.round(tenure.avgTenureMonths)} mo
              </span>
              {tenure.rows.length > 0 &&
                ` · ${tenure.rows.filter((r) => r.bucket === "Long-term").length} long-term`}
            </div>
          )}
        </div>
      </div>

      {/* Renewal calendar (shared with Projections) */}
      <div id="renewals">
        <ExpiringLeasesCard expiring={b.expiring} />
      </div>
    </section>
  );
}

function Gauge({ label, pct, hint }: { label: string; pct: number | null; hint: string }) {
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const color =
    pct == null
      ? "bg-border"
      : pct >= 80
        ? "bg-emerald-500"
        : pct >= 50
          ? "bg-amber-500"
          : "bg-red-500";
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-1">
        <span className="text-foreground">{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {pct == null ? "—" : `${Math.round(pct)}%`}
        </span>
      </div>
      <div className="h-2 rounded-full bg-secondary overflow-hidden">
        <div className={color} style={{ width: `${v}%`, height: "100%" }} />
      </div>
      <p className="text-xs text-muted-foreground/70 mt-1">{hint}</p>
    </div>
  );
}
