import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  AlertCircle,
  Banknote,
  Building2,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock,
  CreditCard,
  Landmark,
  ReceiptText,
  Repeat,
  Users,
  Wallet,
  Wrench,
} from "lucide-react";
import {
  formatCurrencyCompact,
  formatCurrencyTrim,
  formatDate,
  formatDateTime,
} from "@ui/lib/format";
import { isRepairReport } from "@/lib/activityVisual";
import type { OwnerTransaction } from "@/lib/ownerQueries";
import type { AttentionItem, DashboardModel, UpcomingPayment } from "@/lib/dashboardModel";
import type { MonthBucket } from "@/lib/portfolioInsights";
import {
  CardLink,
  DashSkeleton,
  DeltaChip,
  Panel,
  PriorityDot,
  SectionLabel,
  Sparkline,
  StatusBadge,
} from "./ui";
import { PALETTE } from "./tokens";

// ── helpers ────────────────────────────────────────────────────────────

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

function syncLabel(iso: string | null): string {
  if (!iso) return "Not synced yet";
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "Not synced yet";
  const age = Date.now() - ms;
  if (age < 86_400_000) return "Synced today";
  if (age < 2 * 86_400_000) return "Synced yesterday";
  return `Synced ${formatDate(iso)}`;
}

function monthShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IE", { month: "short", day: "numeric" });
}

// ── KPI cards ──────────────────────────────────────────────────────────

export function SummaryCards({
  model,
  loading,
  onViewAttention,
}: {
  model: DashboardModel;
  loading: boolean;
  onViewAttention: () => void;
}) {
  const { monthlyIncome, cash, attention } = model;
  const tone =
    attention.urgent > 0 ? PALETTE.coral : attention.total > 0 ? PALETTE.amber : PALETTE.green;
  const statusLabel = attention.urgent > 0 ? "Urgent" : attention.total > 0 ? "Review" : "Clear";

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <KpiCard
        icon={Wallet}
        tone={PALETTE.green}
        label="Monthly Income"
        value={formatCurrencyCompact(monthlyIncome.value)}
        caption={`${formatCurrencyCompact(monthlyIncome.contracted)} contracted · ${monthlyIncome.activeTenancies} active ${plural(monthlyIncome.activeTenancies, "tenancy", "tenancies")}`}
        delta={<DeltaChip value={monthlyIncome.deltaPct} suffix="vs last month" />}
        spark={<Sparkline values={monthlyIncome.series} color={PALETTE.green} />}
        loading={loading}
      />

      <KpiCard
        icon={Landmark}
        tone={PALETTE.cyan}
        label="Cash in Bank"
        value={formatCurrencyCompact(cash.value)}
        caption={`${cash.accounts} connected ${plural(cash.accounts, "account")} · ${syncLabel(cash.lastSync)}`}
        delta={<DeltaChip value={cash.deltaPct} suffix="vs prior 30d" />}
        spark={<Sparkline values={cash.series} color={PALETTE.cyan} />}
        loading={loading}
      />

      <Panel className="flex min-h-[168px] flex-col justify-between">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-xl"
              style={{ backgroundColor: `${tone}1A`, color: tone }}
            >
              <AlertCircle size={17} strokeWidth={1.9} />
            </span>
            <span
              className="text-[11px] font-semibold uppercase tracking-[0.16em]"
              style={{ color: PALETTE.muted }}
            >
              Needs Attention
            </span>
          </div>
          <StatusBadge
            tone={attention.urgent > 0 ? "critical" : attention.total > 0 ? "warning" : "positive"}
          >
            {statusLabel}
          </StatusBadge>
        </div>

        {loading ? (
          <DashSkeleton className="mt-5 h-9 w-16" />
        ) : (
          <p
            className="mt-5 text-[30px] font-semibold leading-none tracking-tight tabular-nums"
            style={{ color: PALETTE.text }}
          >
            {attention.total}
          </p>
        )}

        <div className="mt-3">
          <div className="mb-2 flex h-1.5 w-full overflow-hidden rounded-full bg-[#060A0B]">
            <span
              className="h-full rounded-full transition-all"
              style={{
                width: `${attention.total > 0 ? (attention.urgent / attention.total) * 100 : 0}%`,
                backgroundColor: PALETTE.coral,
              }}
            />
            <span
              className="h-full rounded-full transition-all"
              style={{
                width: `${attention.total > 0 ? ((attention.total - attention.urgent) / attention.total) * 100 : 100}%`,
                backgroundColor: attention.total > 0 ? PALETTE.amber : PALETTE.green,
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="truncate text-[11px]" style={{ color: PALETTE.muted }}>
              {attention.urgent} urgent · {attention.total} open
            </p>
            <CardLink onClick={onViewAttention} className="shrink-0 hover:text-[#F4F4F2]">
              View items <ChevronRight size={12} />
            </CardLink>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function KpiCard({
  icon: Icon,
  tone,
  label,
  value,
  caption,
  delta,
  spark,
  loading,
}: {
  icon: typeof Wallet;
  tone: string;
  label: string;
  value: string;
  caption: string;
  delta: React.ReactNode;
  spark: React.ReactNode;
  loading: boolean;
}) {
  return (
    <Panel className="flex min-h-[168px] flex-col justify-between">
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-9 w-9 items-center justify-center rounded-xl"
          style={{ backgroundColor: `${tone}1A`, color: tone }}
        >
          <Icon size={17} strokeWidth={1.9} />
        </span>
        <span
          className="text-[11px] font-semibold uppercase tracking-[0.16em]"
          style={{ color: PALETTE.muted }}
        >
          {label}
        </span>
      </div>

      {loading ? (
        <DashSkeleton className="mt-5 h-9 w-32" />
      ) : (
        <p
          className="mt-5 text-[30px] font-semibold leading-none tracking-tight tabular-nums"
          style={{ color: PALETTE.text }}
          title={value}
        >
          {value}
        </p>
      )}

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          {delta}
          <p className="mt-1 truncate text-[11px]" style={{ color: PALETTE.muted }}>
            {caption}
          </p>
        </div>
        {spark}
      </div>
    </Panel>
  );
}

// ── Real estate portfolio ─────────────────────────────────────────────

export type WindowKey = "6M" | "12M" | "All";

export function PortfolioCard({
  model,
  loading,
  ownerOptions,
  ownerId,
  onOwnerChange,
}: {
  model: DashboardModel;
  loading: boolean;
  ownerOptions: { value: string; label: string }[];
  ownerId: string;
  onOwnerChange: (value: string) => void;
}) {
  const [windowKey, setWindowKey] = useState<WindowKey>("6M");
  const months = useMemo(() => {
    const all = model.portfolio.monthly;
    if (windowKey === "6M") return all.slice(-6);
    if (windowKey === "12M") return all.slice(-12);
    return all;
  }, [model.portfolio.monthly, windowKey]);

  return (
    <Panel className="xl:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <SectionLabel
            icon={Building2}
            title="Real Estate Portfolio"
            subtitle="Value & monthly performance"
            tone={PALETTE.cyan}
          />
          <div className="mt-4 flex flex-wrap items-end gap-3">
            {loading ? (
              <DashSkeleton className="h-10 w-40" />
            ) : (
              <p
                className="text-[34px] font-semibold leading-none tracking-tight tabular-nums"
                style={{ color: PALETTE.text }}
              >
                {formatCurrencyCompact(model.portfolio.value)}
              </p>
            )}
            <DeltaChip value={model.portfolio.monthlyGrowthPct} suffix="est. monthly" />
          </div>
          <p className="mt-1.5 text-[11px]" style={{ color: PALETTE.muted }}>
            {model.portfolio.monthlyGrowthPct != null && model.portfolio.value > 0
              ? `≈ ${formatCurrencyCompact(model.portfolio.monthlyGrowth)} ${
                  model.portfolio.monthlyGrowthPct < 0 ? "depreciation" : "appreciation"
                } / month · `
              : ""}
            {formatCurrencyCompact(model.portfolio.unrealizedGain)} unrealized gain
          </p>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-1 rounded-full border border-transparent bg-[#1C2325] p-1">
            {(["6M", "12M", "All"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setWindowKey(key)}
                aria-pressed={windowKey === key}
                className="rounded-full px-3 py-1 text-[11px] font-semibold transition-colors"
                style={
                  windowKey === key
                    ? { backgroundColor: PALETTE.lime, color: PALETTE.bg }
                    : { color: PALETTE.muted }
                }
              >
                {key}
              </button>
            ))}
          </div>

          {ownerOptions.length > 0 && (
            <label className="flex items-center gap-2 text-[11px]" style={{ color: PALETTE.muted }}>
              <span className="sr-only">Filter by owner</span>
              <select
                value={ownerId}
                onChange={(e) => onOwnerChange(e.target.value)}
                className="h-8 max-w-[180px] rounded-xl border border-transparent bg-[#1C2325] px-2.5 text-[11px] font-medium outline-none transition-colors focus:border-transparent"
                style={{ color: PALETTE.text }}
              >
                {ownerOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <div className="mt-6">
        {loading ? <DashSkeleton className="h-44 w-full" /> : <PortfolioBars months={months} />}
      </div>
    </Panel>
  );
}

function PortfolioBars({ months }: { months: MonthBucket[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(
    1,
    ...months.flatMap((m) => [Number(m.income) || 0, Number(m.expense) || 0]),
  );
  const hasData = months.some((m) => (Number(m.income) || 0) > 0 || (Number(m.expense) || 0) > 0);
  const active = hover == null ? months.length - 1 : hover;
  const activeMonth = months[active];

  if (!hasData) {
    return (
      <div className="flex h-44 items-center justify-center rounded-xl border border-dashed border-transparent text-xs text-[#A3A7AB]">
        No transactions in this period yet.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-4">
          <span className="inline-flex items-center gap-1.5" style={{ color: PALETTE.muted }}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PALETTE.cyan }} />
            Income
          </span>
          <span className="inline-flex items-center gap-1.5" style={{ color: PALETTE.muted }}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PALETTE.coral }} />
            Expenses
          </span>
          <span
            className="hidden items-center gap-1.5 sm:inline-flex"
            style={{ color: PALETTE.muted }}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: PALETTE.lime, boxShadow: `0 0 0 2px ${PALETTE.lime}33` }}
            />
            Current
          </span>
        </div>
        {activeMonth ? (
          <span className="tabular-nums" style={{ color: PALETTE.muted }}>
            <span style={{ color: PALETTE.text }}>{activeMonth.label}</span>
            {" · net "}
            <span
              style={{ color: activeMonth.net >= 0 ? PALETTE.green : PALETTE.coral }}
              className="font-semibold"
            >
              {formatCurrencyCompact(activeMonth.net)}
            </span>
          </span>
        ) : null}
      </div>

      <div className="flex h-44 items-end gap-1.5 pb-5 sm:gap-2">
        {months.map((m, i) => {
          const current = i === months.length - 1;
          const isHover = hover === i;
          const dim = hover != null && !isHover;
          return (
            <div
              key={`${m.label}-${i}`}
              className="group relative flex h-full flex-1 items-end justify-center gap-[3px]"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <div
                className="w-2 rounded-t-full transition-all duration-300 sm:w-2.5"
                style={{
                  height: `${Math.max(2, ((Number(m.income) || 0) / max) * 100)}%`,
                  backgroundColor: PALETTE.cyan,
                  opacity: dim ? 0.35 : current ? 1 : 0.72,
                }}
              />
              <div
                className="w-2 rounded-t-full transition-all duration-300 sm:w-2.5"
                style={{
                  height: `${Math.max(2, ((Number(m.expense) || 0) / max) * 100)}%`,
                  backgroundColor: PALETTE.coral,
                  opacity: dim ? 0.22 : isHover ? 0.95 : 0.55,
                }}
              />
              <span
                className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[10px]"
                style={{ color: current ? PALETTE.text : PALETTE.muted }}
              >
                {m.label}
              </span>

              {isHover && (
                <div className="pointer-events-none absolute bottom-full z-20 mb-2 w-max min-w-[132px] rounded-xl border border-transparent bg-[#060A0B] p-2.5 shadow-xl">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-[#A3A7AB]">
                    {m.label}
                  </p>
                  <p className="mt-1 flex items-center justify-between gap-3 text-[11px] text-[#A3A7AB]">
                    Income
                    <span className="tabular-nums text-[#7BD88F]">
                      {formatCurrencyCompact(m.income)}
                    </span>
                  </p>
                  <p className="flex items-center justify-between gap-3 text-[11px] text-[#A3A7AB]">
                    Expenses
                    <span className="tabular-nums text-[#FF7A7A]">
                      {formatCurrencyCompact(m.expense)}
                    </span>
                  </p>
                  <p className="mt-1 flex items-center justify-between gap-3 border-t border-transparent pt-1 text-[11px] text-[#A3A7AB]">
                    Net
                    <span
                      className="tabular-nums font-semibold"
                      style={{ color: m.net >= 0 ? PALETTE.green : PALETTE.coral }}
                    >
                      {formatCurrencyCompact(m.net)}
                    </span>
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── By owner ──────────────────────────────────────────────────────────

export function ByOwnerCard({ model, loading }: { model: DashboardModel; loading: boolean }) {
  const { companyValue, individualValue, total, companies } = model.byOwner;
  const companyPct = total > 0 ? (companyValue / total) * 100 : 0;
  const individualPct = total > 0 ? (individualValue / total) * 100 : 0;

  return (
    <Panel className="xl:col-span-1">
      <div className="flex items-start justify-between gap-3">
        <SectionLabel
          icon={Users}
          title="By Owner"
          subtitle="Ownership distribution"
          tone={PALETTE.lime}
        />
        <Link href="/properties">
          <span
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-[11px] font-semibold transition-colors hover:text-[#F4F4F2]"
            style={{ color: PALETTE.muted }}
          >
            View structure <ChevronRight size={12} />
          </span>
        </Link>
      </div>

      {loading ? (
        <div className="mt-5 space-y-3">
          <DashSkeleton className="h-8 w-32" />
          <DashSkeleton className="h-2.5 w-full" />
          <DashSkeleton className="h-12 w-full" />
        </div>
      ) : total <= 0 ? (
        <div className="mt-6 flex flex-col items-center justify-center rounded-xl border border-dashed border-transparent py-8 text-center">
          <Building2 size={22} className="mb-2 opacity-40" />
          <p className="text-xs text-[#A3A7AB]">Add a property to see your ownership split.</p>
        </div>
      ) : (
        <>
          <p
            className="mt-5 text-[26px] font-semibold leading-none tracking-tight tabular-nums"
            style={{ color: PALETTE.text }}
          >
            {formatCurrencyCompact(total)}
          </p>
          <p className="mt-1 text-[11px]" style={{ color: PALETTE.muted }}>
            {companies.length + (individualValue > 0 ? 1 : 0)} ownership{" "}
            {plural(companies.length + (individualValue > 0 ? 1 : 0), "entity", "entities")}
          </p>

          <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-[#060A0B]">
            <span
              className="h-full transition-all"
              style={{ width: `${companyPct}%`, backgroundColor: PALETTE.cyan }}
            />
            <span
              className="h-full transition-all"
              style={{ width: `${individualPct}%`, backgroundColor: PALETTE.lime }}
            />
          </div>

          <div className="mt-4 space-y-3">
            <OwnerRow
              color={PALETTE.cyan}
              label="Company-owned"
              value={companyValue}
              pct={companyPct}
            />
            <OwnerRow
              color={PALETTE.lime}
              label="Personally owned"
              value={individualValue}
              pct={individualPct}
            />
          </div>

          {companies.length > 0 && (
            <div className="mt-4 border-t border-transparent pt-3">
              <p
                className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{ color: PALETTE.muted }}
              >
                SPV breakdown
              </p>
              <div className="space-y-2">
                {companies.slice(0, 4).map((c) => (
                  <div key={c.name} className="flex items-center justify-between gap-3">
                    <span className="truncate text-xs" style={{ color: PALETTE.muted }}>
                      {c.name}
                    </span>
                    <span
                      className="shrink-0 text-xs font-medium tabular-nums"
                      style={{ color: PALETTE.text }}
                    >
                      {formatCurrencyCompact(c.value)}{" "}
                      <span style={{ color: PALETTE.muted }}>{c.pct.toFixed(0)}%</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function OwnerRow({
  color,
  label,
  value,
  pct,
}: {
  color: string;
  label: string;
  value: number;
  pct: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="truncate text-xs" style={{ color: PALETTE.muted }}>
          {label}
        </span>
      </span>
      <span className="shrink-0 text-xs font-semibold tabular-nums" style={{ color: PALETTE.text }}>
        {formatCurrencyCompact(value)}{" "}
        <span className="font-normal" style={{ color: PALETTE.muted }}>
          {pct.toFixed(1)}%
        </span>
      </span>
    </div>
  );
}

// ── Transactions ──────────────────────────────────────────────────────

export function TransactionsCard({
  model,
  loading,
  isSelf,
  isResolving,
  onResolve,
}: {
  model: DashboardModel;
  loading: boolean;
  isSelf: boolean;
  isResolving: boolean;
  onResolve: (id: string) => void;
}) {
  const [tab, setTab] = useState<"upcoming" | "recent">("recent");
  const rows = tab === "upcoming" ? model.upcoming : model.recent;

  return (
    <Panel className="xl:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionLabel
          icon={ReceiptText}
          title="Transactions"
          subtitle="Income, expenses & approvals"
          tone={PALETTE.cyan}
        />
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-full border border-transparent bg-[#1C2325] p-1">
            {(["upcoming", "recent"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                aria-pressed={tab === key}
                className="rounded-full px-3 py-1 text-[11px] font-semibold capitalize transition-colors"
                style={
                  tab === key
                    ? { backgroundColor: PALETTE.lime, color: PALETTE.bg }
                    : { color: PALETTE.muted }
                }
              >
                {key}
              </button>
            ))}
          </div>
          <Link href="/owner/activity">
            <span
              className="inline-flex cursor-pointer items-center gap-1 text-[11px] font-semibold transition-colors hover:text-[#F4F4F2]"
              style={{ color: PALETTE.muted }}
            >
              View all <ChevronRight size={12} />
            </span>
          </Link>
        </div>
      </div>

      <div className="mt-4 divide-y divide-transparent">
        {loading ? (
          <div className="space-y-3 py-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <DashSkeleton className="h-9 w-9 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <DashSkeleton className="h-3 w-1/2" />
                  <DashSkeleton className="h-2.5 w-1/3" />
                </div>
                <DashSkeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Clock size={24} className="mb-2 opacity-40" />
            <p className="text-xs" style={{ color: PALETTE.muted }}>
              {tab === "upcoming" ? "No upcoming rent scheduled." : "No transactions recorded yet."}
            </p>
          </div>
        ) : tab === "recent" ? (
          model.recent.map((tx) => (
            <RecentRow
              key={tx.id}
              tx={tx}
              isSelf={isSelf}
              isResolving={isResolving}
              onResolve={onResolve}
            />
          ))
        ) : (
          model.upcoming.map((p) => <UpcomingRow key={p.id} payment={p} />)
        )}
      </div>
    </Panel>
  );
}

function categoryVisual(category: OwnerTransaction["category"]): {
  Icon: typeof Banknote;
} {
  switch (category) {
    case "rent":
      return { Icon: Banknote };
    case "maintenance":
      return { Icon: Wrench };
    case "tax":
      return { Icon: Landmark };
    case "fee":
      return { Icon: CreditCard };
    default:
      return { Icon: ReceiptText };
  }
}

function RecentRow({
  tx,
  isSelf,
  isResolving,
  onResolve,
}: {
  tx: OwnerTransaction;
  isSelf: boolean;
  isResolving: boolean;
  onResolve: (id: string) => void;
}) {
  const { Icon } = categoryVisual(tx.category);
  const color =
    tx.type === "income" ? PALETTE.green : tx.type === "expense" ? PALETTE.coral : PALETTE.amber;
  const repair = isRepairReport(tx);
  const canResolve = repair && isSelf && tx.status === "pending";
  const amount = Math.abs(Number(tx.amount) || 0);
  const prefix = tx.type === "income" ? "+" : tx.type === "expense" ? "−" : "";

  return (
    <div className="flex items-center gap-3 py-3 transition-colors hover:bg-[#1C2325]/60">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
        style={{ backgroundColor: `${color}1A`, color }}
      >
        <Icon size={16} strokeWidth={1.9} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-[13px] font-medium" style={{ color: PALETTE.text }}>
            {tx.name}
          </p>
          {tx.category === "rent" && (
            <span
              className="inline-flex shrink-0 items-center gap-1 text-[10px]"
              style={{ color: PALETTE.muted }}
            >
              <Repeat size={10} /> Recurring
            </span>
          )}
        </div>
        <p className="truncate text-[11px]" style={{ color: PALETTE.muted }}>
          {tx.propertyAddress ? `${tx.propertyAddress} · ` : ""}
          {formatDateTime(tx.timestamp)}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <span
          className="text-[13px] font-semibold tabular-nums"
          style={{ color: tx.type === "neutral" ? PALETTE.muted : color }}
        >
          {prefix}
          {formatCurrencyTrim(amount)}
        </span>
        <div className="flex items-center gap-1.5">
          {tx.status === "pending" && <StatusBadge tone="warning">Pending</StatusBadge>}
          {tx.status === "failed" && <StatusBadge tone="critical">Failed</StatusBadge>}
          {tx.status === "resolved" && <StatusBadge tone="positive">Resolved</StatusBadge>}
          {tx.status === "completed" && tx.source === "rent" && (
            <StatusBadge tone="info">Auto</StatusBadge>
          )}
          {tx.status === "completed" && tx.source === "manual" && (
            <StatusBadge tone="neutral">Recorded</StatusBadge>
          )}
          {canResolve && (
            <button
              type="button"
              onClick={() => onResolve(tx.id)}
              disabled={isResolving}
              className="rounded-lg px-2 py-0.5 text-[10px] font-semibold transition-opacity disabled:opacity-50"
              style={{ backgroundColor: PALETTE.lime, color: PALETTE.bg }}
            >
              Resolve
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function UpcomingRow({ payment }: { payment: UpcomingPayment }) {
  return (
    <div className="flex items-center gap-3 py-3 transition-colors hover:bg-[#1C2325]/60">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
        style={{ backgroundColor: `${PALETTE.cyan}1A`, color: PALETTE.cyan }}
      >
        <CalendarClock size={16} strokeWidth={1.9} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium" style={{ color: PALETTE.text }}>
          Rent due · {payment.tenantName}
        </p>
        <p className="truncate text-[11px]" style={{ color: PALETTE.muted }}>
          {payment.propertyAddress ? `${payment.propertyAddress} · ` : ""}
          {monthShort(payment.date)}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-[13px] font-semibold tabular-nums" style={{ color: PALETTE.green }}>
          +{formatCurrencyTrim(payment.amount)}
        </span>
        <div className="flex items-center gap-1.5">
          <StatusBadge tone="info">Scheduled</StatusBadge>
          <span
            className="inline-flex items-center gap-1 text-[10px]"
            style={{ color: PALETTE.muted }}
          >
            <Repeat size={10} /> Recurring
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Needs attention ───────────────────────────────────────────────────

export function AttentionCard({ model, loading }: { model: DashboardModel; loading: boolean }) {
  const items = model.attention.items.slice(0, 6);

  return (
    <Panel id="needs-attention" className="xl:col-span-1">
      <div className="flex items-start justify-between gap-3">
        <SectionLabel
          icon={AlertCircle}
          title="Needs Attention"
          subtitle="Priority items that need action"
          tone={PALETTE.amber}
        />
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums"
          style={{ backgroundColor: `${PALETTE.amber}1F`, color: PALETTE.amber }}
        >
          {model.attention.total}
        </span>
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-start gap-2.5">
                <DashSkeleton className="mt-1 h-2 w-2 rounded-full" />
                <div className="flex-1 space-y-2">
                  <DashSkeleton className="h-3 w-2/3" />
                  <DashSkeleton className="h-2.5 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-transparent py-10 text-center">
            <CheckCircle2 size={24} style={{ color: PALETTE.green }} className="mb-2" />
            <p className="text-xs font-medium" style={{ color: PALETTE.text }}>
              You're all caught up
            </p>
            <p className="mt-1 text-[11px]" style={{ color: PALETTE.muted }}>
              No overdue rent, expiring leases or pending approvals.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-transparent">
            {items.map((item) => (
              <AttentionRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>

      {model.attention.total > items.length && (
        <div className="mt-3 border-t border-transparent pt-3">
          <Link href="/owner/activity">
            <span
              className="inline-flex cursor-pointer items-center gap-1 text-[11px] font-semibold transition-colors hover:text-[#F4F4F2]"
              style={{ color: PALETTE.muted }}
            >
              View all {model.attention.total} items <ChevronRight size={12} />
            </span>
          </Link>
        </div>
      )}
    </Panel>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  return (
    <div className="flex items-start gap-2.5 py-3">
      <PriorityDot priority={item.priority} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-[12px] font-medium" style={{ color: PALETTE.text }}>
            {item.title}
          </p>
          {item.priority !== "info" && (
            <StatusBadge tone={item.priority === "critical" ? "critical" : "warning"}>
              {item.priority === "critical" ? "Urgent" : "Soon"}
            </StatusBadge>
          )}
        </div>
        <p className="truncate text-[11px]" style={{ color: PALETTE.muted }}>
          {item.subject}
        </p>
        <p className="mt-0.5 text-[10px]" style={{ color: PALETTE.muted }}>
          {item.dueLabel}
        </p>
      </div>
      <Link href={item.href}>
        <span
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-transparent bg-[#1C2325] px-2 py-1 text-[10px] font-semibold transition-colors hover:border-transparent hover:text-[#F4F4F2]"
          style={{ color: PALETTE.muted }}
        >
          {item.actionLabel}
          <ChevronRight size={10} />
        </span>
      </Link>
    </div>
  );
}
