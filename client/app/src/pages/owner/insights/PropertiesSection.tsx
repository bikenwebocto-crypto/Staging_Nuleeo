import { useState } from "react";
import { Building, Trophy, AlertTriangle, ArrowUpDown } from "lucide-react";
import { formatCurrencyShort, formatCurrencyCompact } from "@ui/lib/format";
import { PropertyImage } from "@ui/components/common/PropertyImage";
import type { OwnerSummary, OwnerProperty } from "@/lib/ownerQueries";
import type { InsightsBundle, LeaderboardRow } from "@/lib/portfolioInsights";
import { SectionHeader, EmptyState, TYPE_COLORS, fmtPct } from "./ui";

type SortKey = "revenue" | "expenses" | "profit" | "netMargin" | "grossYield";

export function PropertiesSection({
  b,
  summary,
  properties,
  windowLabel,
}: {
  b: InsightsBundle;
  summary: OwnerSummary | undefined;
  properties: OwnerProperty[];
  windowLabel: string;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("profit");
  const rows = b.leaderboard;
  const active = rows.filter((r) => r.hasActivity);

  // Active rows first, then by the chosen metric desc (nulls last).
  const sorted = [...rows].sort((a, x) => {
    if (a.hasActivity !== x.hasActivity) return a.hasActivity ? -1 : 1;
    const av = a[sortKey];
    const xv = x[sortKey];
    if (av == null && xv == null) return 0;
    if (av == null) return 1;
    if (xv == null) return -1;
    return xv - av;
  });

  const best = active.length >= 2 ? active.reduce((m, r) => (r.profit > m.profit ? r : m)) : null;
  const worst = active.length >= 2 ? active.reduce((m, r) => (r.profit < m.profit ? r : m)) : null;

  // Profit-contribution: only net-positive properties form the 100% bar.
  const positives = active.filter((r) => r.profit > 0).sort((a, x) => x.profit - a.profit);
  const totalProfit = positives.reduce((s, r) => s + r.profit, 0);

  // Value composition by type (concentration the count view hides).
  const byType = new Map<string, number>();
  for (const p of properties)
    byType.set(
      p.propertyType || "Other",
      (byType.get(p.propertyType || "Other") || 0) + (p.propertyValue || 0),
    );
  const compTotal = Array.from(byType.values()).reduce((a, x) => a + x, 0);
  const segments =
    compTotal > 0
      ? Array.from(byType.entries())
          .map(([type, val]) => ({ type, val, pct: (val / compTotal) * 100 }))
          .sort((a, x) => x.val - a.val)
      : [];

  // Existing yield ranking (kept) — flag occupied props below the portfolio yield.
  const totalValue = summary?.portfolioValue ?? 0;
  const avgGrossYield =
    totalValue > 0 ? (((summary?.monthlyRevenue ?? 0) * 12) / totalValue) * 100 : null;
  const byYield = [...properties].sort((a, x) => {
    const ya = a.rentAmount && a.propertyValue ? (a.rentAmount * 12) / a.propertyValue : -1;
    const yx = x.rentAmount && x.propertyValue ? (x.rentAmount * 12) / x.propertyValue : -1;
    return yx - ya;
  });

  return (
    <section>
      <SectionHeader
        id="properties"
        title="Property leaderboard"
        subtitle={`Revenue, costs and profit per property over the last ${windowLabel}, plus composition & yield`}
      />

      {/* Best / worst callouts */}
      {best && worst && best.id !== worst.id && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <Callout row={best} kind="best" />
          <Callout row={worst} kind="worst" />
        </div>
      )}

      {/* Sortable leaderboard table */}
      <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden mb-4">
        {properties.length === 0 ? (
          <EmptyState
            icon={Building}
            title="No properties yet"
            hint="Add a property to see the leaderboard."
          />
        ) : (
          <>
            {active.length === 0 && (
              <p className="text-xs text-muted-foreground px-6 pt-4">
                No income or expenses in the last {windowLabel} — totals populate as you log rent
                and costs.
              </p>
            )}

            {/* Desktop: sortable table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="font-medium px-6 py-3">Property</th>
                    <Th label="Revenue" k="revenue" sortKey={sortKey} setSortKey={setSortKey} />
                    <Th label="Expenses" k="expenses" sortKey={sortKey} setSortKey={setSortKey} />
                    <Th label="Profit" k="profit" sortKey={sortKey} setSortKey={setSortKey} />
                    <Th label="Margin" k="netMargin" sortKey={sortKey} setSortKey={setSortKey} />
                    <Th label="Yield" k="grossYield" sortKey={sortKey} setSortKey={setSortKey} />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-border/60 last:border-0 hover:bg-background/60"
                    >
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-8 h-8 rounded-lg bg-secondary overflow-hidden shrink-0">
                            <PropertyImage src={r.image} alt={r.address} iconSize={14} />
                          </div>
                          <span className="truncate text-foreground font-medium">
                            {r.address.split(",")[0]}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-foreground">
                        {formatCurrencyCompact(r.revenue)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                        {formatCurrencyCompact(r.expenses)}
                      </td>
                      <td
                        className={`px-3 py-3 text-right tabular-nums font-semibold ${r.profit < 0 ? "text-destructive" : "text-foreground"}`}
                      >
                        {formatCurrencyCompact(r.profit)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                        {fmtPct(r.netMargin, 0)}
                      </td>
                      <td className="px-6 py-3 text-right tabular-nums text-muted-foreground">
                        {fmtPct(r.grossYield)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile: stacked cards (active rows first, then by profit) */}
            <div className="md:hidden divide-y divide-border/60">
              {sorted.map((r) => (
                <div key={r.id} className="px-4 py-3.5">
                  <div className="flex items-center gap-3 min-w-0 mb-3">
                    <div className="w-9 h-9 rounded-lg bg-secondary overflow-hidden shrink-0">
                      <PropertyImage src={r.image} alt={r.address} iconSize={15} />
                    </div>
                    <span className="truncate text-foreground font-medium text-sm">
                      {r.address.split(",")[0]}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Revenue</span>
                      <span className="tabular-nums text-foreground">
                        {formatCurrencyCompact(r.revenue)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Expenses</span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatCurrencyCompact(r.expenses)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Profit</span>
                      <span
                        className={`tabular-nums font-semibold ${r.profit < 0 ? "text-destructive" : "text-foreground"}`}
                      >
                        {formatCurrencyCompact(r.profit)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Margin</span>
                      <span className="tabular-nums text-muted-foreground">
                        {fmtPct(r.netMargin, 0)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Yield</span>
                      <span className="tabular-nums text-muted-foreground">
                        {fmtPct(r.grossYield)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Profit contribution + composition side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="bg-card p-6 rounded-2xl border border-border shadow-sm">
          <h3 className="font-bold text-foreground mb-4">Profit contribution</h3>
          {totalProfit > 0 ? (
            <>
              <div className="flex w-full h-4 rounded-full overflow-hidden mb-4">
                {positives.map((r, i) => (
                  <div
                    key={r.id}
                    style={{
                      width: `${(r.profit / totalProfit) * 100}%`,
                      backgroundColor: Object.values(TYPE_COLORS)[i % 6],
                    }}
                    title={`${r.address.split(",")[0]} · ${formatCurrencyCompact(r.profit)}`}
                  />
                ))}
              </div>
              <div className="space-y-2">
                {positives.map((r, i) => (
                  <div key={r.id} className="flex items-center gap-2 text-sm">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: Object.values(TYPE_COLORS)[i % 6] }}
                    />
                    <span className="text-foreground flex-1 truncate">
                      {r.address.split(",")[0]}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {((r.profit / totalProfit) * 100).toFixed(0)}%
                    </span>
                    <span className="font-medium text-foreground tabular-nums w-16 text-right">
                      {formatCurrencyShort(r.profit)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <EmptyState
              icon={Trophy}
              title="No net profit yet"
              hint={`No property turned a net profit in the last ${windowLabel}.`}
              height={140}
            />
          )}
        </div>

        <div className="bg-card p-6 rounded-2xl border border-border shadow-sm">
          <div className="flex items-baseline justify-between mb-4">
            <h3 className="font-bold text-foreground">Portfolio by value</h3>
            <span className="text-xs font-medium text-muted-foreground">{b.hhi.label}</span>
          </div>
          {segments.length === 0 ? (
            <EmptyState
              icon={Building}
              title="No valuations yet"
              hint="Add property values to see composition."
              height={140}
            />
          ) : (
            <>
              <div className="flex w-full h-4 rounded-full overflow-hidden mb-4">
                {segments.map((s) => (
                  <div
                    key={s.type}
                    style={{
                      width: `${s.pct}%`,
                      backgroundColor: TYPE_COLORS[s.type] ?? TYPE_COLORS.Other,
                    }}
                    title={`${s.type} · ${s.pct.toFixed(0)}%`}
                  />
                ))}
              </div>
              <div className="space-y-2">
                {segments.map((s) => (
                  <div key={s.type} className="flex items-center gap-2 text-sm">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: TYPE_COLORS[s.type] ?? TYPE_COLORS.Other }}
                    />
                    <span className="text-foreground flex-1">{s.type}</span>
                    <span className="text-muted-foreground tabular-nums">{s.pct.toFixed(0)}%</span>
                    <span className="font-medium text-foreground tabular-nums w-16 text-right">
                      {formatCurrencyShort(s.val)}
                    </span>
                  </div>
                ))}
              </div>
              {b.hhi.topAssetPct != null && (
                <p className="text-xs text-muted-foreground/70 mt-3">
                  Top asset is {b.hhi.topAssetPct.toFixed(0)}% of portfolio value.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Yield ranking (kept) */}
      <div className="bg-card p-6 rounded-2xl border border-border shadow-sm">
        <h3 className="font-bold text-foreground mb-4">Yield ranking</h3>
        {properties.length === 0 ? (
          <EmptyState
            icon={Building}
            title="No properties yet"
            hint="Performance metrics appear once you add a property."
            height={140}
          />
        ) : (
          <div className="space-y-3 max-h-[360px] overflow-y-auto pr-2 custom-scrollbar">
            {byYield.map((p) => {
              const y =
                p.rentAmount && p.propertyValue
                  ? ((p.rentAmount * 12) / p.propertyValue) * 100
                  : null;
              const below = p.occupied && y != null && avgGrossYield != null && y < avgGrossYield;
              return (
                <div key={p.id} className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-secondary overflow-hidden shrink-0">
                    <PropertyImage src={p.image} alt={p.address} iconSize={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-bold text-foreground truncate">
                      {p.address.split(",")[0]}
                    </h4>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">
                        {y != null ? `Yield: ${y.toFixed(1)}%` : "Yield: —"}
                      </span>
                      {below && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-warning/10 text-warning">
                          Below avg
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${p.occupied ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}
                  >
                    {p.occupied ? "Occupied" : "Vacant"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function Th({
  label,
  k,
  sortKey,
  setSortKey,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  setSortKey: (k: SortKey) => void;
}) {
  const activeCol = sortKey === k;
  return (
    <th className="font-medium px-3 py-3 text-right">
      <button
        onClick={() => setSortKey(k)}
        className={`inline-flex items-center gap-1 hover:text-foreground transition ${activeCol ? "text-foreground" : ""}`}
      >
        {label}
        <ArrowUpDown size={11} className={activeCol ? "opacity-100" : "opacity-40"} />
      </button>
    </th>
  );
}

function Callout({ row, kind }: { row: LeaderboardRow; kind: "best" | "worst" }) {
  const isBest = kind === "best";
  const label = isBest ? "Top performer" : row.profit >= 0 ? "Lowest margin" : "Biggest loss";
  return (
    <div className="bg-card p-5 rounded-2xl border border-border shadow-sm flex items-center gap-3">
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isBest ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}
      >
        {isBest ? <Trophy size={18} /> : <AlertTriangle size={18} />}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-bold text-foreground truncate">{row.address.split(",")[0]}</p>
        <p
          className={`text-sm font-semibold ${row.profit < 0 ? "text-destructive" : "text-foreground"}`}
        >
          {formatCurrencyShort(row.profit)}{" "}
          <span className="text-xs font-normal text-muted-foreground">
            net · margin {fmtPct(row.netMargin, 0)}
          </span>
        </p>
      </div>
    </div>
  );
}
