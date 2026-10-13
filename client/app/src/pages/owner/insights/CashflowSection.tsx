import {
  ComposedChart,
  Bar,
  Line,
  ReferenceLine,
  AreaChart,
  Area,
  PieChart as RePieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { TrendingDown, Banknote } from "lucide-react";
import { formatCurrencyShort, formatCurrencyCompact } from "@ui/lib/format";
import type { InsightsBundle } from "@/lib/portfolioInsights";
import {
  SectionHeader,
  EmptyState,
  LazyChart,
  CHART_TOOLTIP_STYLE,
  CATEGORY_COLORS,
  SOURCE_LABELS,
} from "./ui";

const SOURCE_COLORS = ["var(--brand-accent)", "#a78bfa", "#f59e0b", "#94a3b8"];

export function CashflowSection({ b, windowLabel }: { b: InsightsBundle; windowLabel: string }) {
  const expenseDonut = b.expenseBreakdown;
  const incomeMix = b.incomeMix;
  const trendHasData = b.expenseTrend.some((m) => m.maintenance + m.tax + m.fee + m.other > 0);

  return (
    <section>
      <SectionHeader
        id="cashflow"
        title="Cash flow & costs"
        subtitle="12-month flows, where money goes, and how it comes in"
      />

      {/* Cash flow analysis — income/expense bars + net line */}
      <div className="bg-card p-6 rounded-2xl border border-border shadow-sm mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h3 className="font-bold text-foreground">Cash flow analysis · 12 months</h3>
          <div className="flex gap-2">
            <Legend color="var(--brand-accent)" label="Income" />
            <Legend color="var(--border)" label="Expense" />
            <Legend color="var(--foreground)" label="Net" line />
          </div>
        </div>
        <LazyChart
          minHeight={256}
          label="Bar and line chart: monthly income, expense, and net cash flow over the last 12 months"
        >
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={b.monthly}
                margin={{ top: 5, right: 10, left: -20, bottom: 0 }}
                barGap={8}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <ReferenceLine y={0} stroke="var(--border)" />
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
                  cursor={{ fill: "var(--secondary)" }}
                  formatter={(v) => formatCurrencyCompact(Number(v))}
                  contentStyle={CHART_TOOLTIP_STYLE}
                />
                <Bar
                  dataKey="income"
                  fill="var(--brand-accent)"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={40}
                />
                <Bar
                  dataKey="expense"
                  fill="var(--muted-foreground)"
                  opacity={0.3}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={40}
                />
                <Line
                  type="monotone"
                  dataKey="net"
                  stroke="var(--foreground)"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </LazyChart>
        <p className="text-xs text-muted-foreground/70 mt-2">
          The latest month is still in progress; prepaid rent lands entirely in its signing month.
        </p>
      </div>

      {/* Expense donut + income mix */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="bg-card p-6 rounded-2xl border border-border shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-foreground">Where your costs go</h3>
            <span className="text-xs font-medium text-muted-foreground">{windowLabel}</span>
          </div>
          {expenseDonut.total === 0 ? (
            <EmptyState
              icon={TrendingDown}
              title="No expenses recorded"
              hint="Nothing logged in this period."
              height={200}
            />
          ) : (
            <div className="flex flex-col sm:flex-row items-center gap-4">
              <div className="relative w-44 h-52 shrink-0">
                <LazyChart minHeight={208} label="Donut chart: breakdown of expenses by category">
                  <ResponsiveContainer width="100%" height="100%">
                    <RePieChart>
                      <Pie
                        data={expenseDonut.data}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={52}
                        outerRadius={78}
                        paddingAngle={2}
                        stroke="none"
                      >
                        {expenseDonut.data.map((d) => (
                          <Cell key={d.name} fill={CATEGORY_COLORS[d.name]} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(v) => formatCurrencyCompact(Number(v))}
                        contentStyle={{ ...CHART_TOOLTIP_STYLE, textTransform: "capitalize" }}
                      />
                    </RePieChart>
                  </ResponsiveContainer>
                </LazyChart>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-lg font-bold text-foreground">
                    {formatCurrencyShort(expenseDonut.total)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">total</span>
                </div>
              </div>
              <div className="flex-1 w-full space-y-2">
                {expenseDonut.data.map((d) => (
                  <div key={d.name} className="flex items-center gap-2 text-sm">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: CATEGORY_COLORS[d.name] }}
                    />
                    <span className="capitalize text-foreground flex-1">{d.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {((d.value / expenseDonut.total) * 100).toFixed(0)}%
                    </span>
                    <span className="font-medium text-foreground tabular-nums w-16 text-right">
                      {formatCurrencyCompact(d.value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="bg-card p-6 rounded-2xl border border-border shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-foreground">How rent comes in</h3>
            <span className="text-xs font-medium text-muted-foreground">{windowLabel}</span>
          </div>
          {incomeMix.bySource.length === 0 ? (
            <EmptyState
              icon={Banknote}
              title="No rent collected yet"
              hint="Income mix appears once rent is recorded."
              height={200}
            />
          ) : (
            <div className="flex flex-col sm:flex-row items-center gap-4">
              <div className="relative w-44 h-52 shrink-0">
                <LazyChart minHeight={208} label="Donut chart: rent income mix by payment source">
                  <ResponsiveContainer width="100%" height="100%">
                    <RePieChart>
                      <Pie
                        data={incomeMix.bySource}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={52}
                        outerRadius={78}
                        paddingAngle={2}
                        stroke="none"
                      >
                        {incomeMix.bySource.map((d, i) => (
                          <Cell key={d.name} fill={SOURCE_COLORS[i % SOURCE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(v) => formatCurrencyCompact(Number(v))}
                        contentStyle={CHART_TOOLTIP_STYLE}
                      />
                    </RePieChart>
                  </ResponsiveContainer>
                </LazyChart>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-lg font-bold text-foreground">
                    {incomeMix.cardPct == null ? "—" : `${Math.round(incomeMix.cardPct)}%`}
                  </span>
                  <span className="text-[10px] text-muted-foreground">card/online</span>
                </div>
              </div>
              <div className="flex-1 w-full space-y-2">
                {incomeMix.bySource.map((d, i) => (
                  <div key={d.name} className="flex items-center gap-2 text-sm">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: SOURCE_COLORS[i % SOURCE_COLORS.length] }}
                    />
                    <span className="text-foreground flex-1">
                      {SOURCE_LABELS[d.name] ?? d.name}
                    </span>
                    <span className="font-medium text-foreground tabular-nums w-16 text-right">
                      {formatCurrencyCompact(d.value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Expense trend over 12 months */}
      <div className="bg-card p-6 rounded-2xl border border-border shadow-sm">
        <h3 className="font-bold text-foreground mb-4">Cost trend by category · 12 months</h3>
        {trendHasData ? (
          <LazyChart
            minHeight={240}
            label="Stacked area chart: expense trend by category over the last 12 months"
          >
            <div className="h-60 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={b.expenseTrend}
                  margin={{ top: 5, right: 10, left: -20, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
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
                    contentStyle={{ ...CHART_TOOLTIP_STYLE, textTransform: "capitalize" }}
                  />
                  {(["maintenance", "tax", "fee", "other"] as const).map((c) => (
                    <Area
                      key={c}
                      type="monotone"
                      dataKey={c}
                      stackId="1"
                      stroke={CATEGORY_COLORS[c]}
                      fill={CATEGORY_COLORS[c]}
                      fillOpacity={0.5}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </LazyChart>
        ) : (
          <EmptyState
            icon={TrendingDown}
            title="No expenses recorded"
            hint="Cost trends appear once you log expenses."
            height={200}
          />
        )}
      </div>
    </section>
  );
}

function Legend({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return (
    <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <span
        className={line ? "w-3 h-0.5 rounded-full" : "w-2 h-2 rounded-full"}
        style={{ backgroundColor: color }}
      />{" "}
      {label}
    </span>
  );
}
