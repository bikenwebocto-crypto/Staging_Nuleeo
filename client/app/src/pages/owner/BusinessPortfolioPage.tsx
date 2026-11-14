import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Building2, ChevronRight, Plus, RefreshCw, Search, SearchX } from "lucide-react";
import { cn } from "@ui/lib/utils";
import { ENTITY_STATUS_LABEL } from "@shared/entities";
import {
  OWNERSHIP_FILTER_LABEL,
  type BusinessListItem,
  type BusinessPortfolioSummary,
  type OwnershipFilter,
  type PortfolioView,
} from "@shared/businesses";
import { useBusinessPortfolio } from "@/lib/businesses";
import { CARD } from "@/components/owner/dashboard/tokens";

// Business Portfolio (business workspace): consolidated summary + list of the
// owner's businesses (Entities of type COMPANY). Financial cards show "—"
// until ledger / banking / VAT data exists — never invented figures.

const STATUS_TONE = { SETTING_UP: "#F5B65C", ACTIVE: "#7BD88F", INACTIVE: "#7D8287" } as const;
const DASH = "—";

function SummaryCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className={`${CARD} flex min-w-0 flex-col gap-2 p-6`}>
      <p className="text-sm text-[#A3A7AB]">{label}</p>
      <p className="truncate text-3xl font-semibold tabular-nums tracking-[-0.02em] text-[#F4F4F2]">
        {value}
      </p>
      <p className="truncate text-xs text-[#7D8287]">{sub}</p>
    </div>
  );
}

function Summary({ s, loading }: { s?: BusinessPortfolioSummary; loading: boolean }) {
  if (loading && !s) {
    return (
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[132px] animate-pulse rounded-[24px] bg-[#111618]" />
        ))}
      </div>
    );
  }
  const money = (v: number | null | undefined) =>
    v == null
      ? DASH
      : new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: "EUR",
          maximumFractionDigits: 0,
        }).format(v);
  const split = s?.byType.length
    ? s.byType.map((t) => `${t.count} ${t.label.toLowerCase()}`).join(" · ")
    : "No businesses yet";
  return (
    <section aria-label="Portfolio summary" className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
      <SummaryCard label="Total companies" value={String(s?.totalCompanies ?? 0)} sub={split} />
      <SummaryCard
        label="Revenue year to date"
        value={money(s?.revenueYtd)}
        sub={
          s?.revenueYtd == null
            ? "Available once books are connected"
            : `Last year ${money(s.revenueLastYearSamePeriod)}`
        }
      />
      <SummaryCard
        label="Cash in bank"
        value={money(s?.cashInBank)}
        sub={s?.bankAccounts == null ? "No bank accounts connected" : `${s.bankAccounts} accounts`}
      />
      <SummaryCard
        label="VAT this quarter"
        value={money(s?.vatThisQuarter)}
        sub={s?.vatNextDueDate ? `Next due ${s.vatNextDueDate}` : "No VAT returns tracked yet"}
      />
    </section>
  );
}

function Row({ b }: { b: BusinessListItem }) {
  const tone = STATUS_TONE[b.status];
  return (
    <li>
      <Link
        href={`/business/${encodeURIComponent(b.id)}`}
        className="flex items-center gap-3 rounded-2xl bg-[#1C2325] px-4 py-3 transition-colors hover:bg-[#2A3134] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[#F4F4F2]">
          <Building2 size={18} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-[#F4F4F2]">{b.name}</span>
          <span className="block truncate text-xs text-[#A3A7AB]">
            {b.typeLabel} · {b.ownerLabel}
          </span>
        </span>
        <span
          className="hidden shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold sm:inline"
          style={{ color: tone, backgroundColor: `${tone}1F` }}
        >
          {b.archived ? "Archived" : ENTITY_STATUS_LABEL[b.status]}
        </span>
        <ChevronRight size={16} className="shrink-0 text-[#7D8287]" aria-hidden="true" />
      </Link>
    </li>
  );
}

const AddButton = ({ subtle }: { subtle?: boolean }) => (
  <Link
    href="/business/new"
    className={cn(
      "flex h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]",
      subtle
        ? "bg-[#1C2325] text-[#F4F4F2] hover:bg-[#2A3134]"
        : "bg-white text-[#060A0B] hover:brightness-95",
    )}
  >
    <Plus size={16} aria-hidden="true" /> Add business
  </Link>
);

export default function BusinessPortfolioPage() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [ownership, setOwnership] = useState<OwnershipFilter>("all");
  const [view, setView] = useState<PortfolioView>("active");

  // Debounce search so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQ(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isError, isFetching, refetch } = useBusinessPortfolio({
    q,
    ownership,
    view,
  });
  const filtered = q.trim() !== "" || ownership !== "all";

  return (
    <main className="min-h-full w-full px-5 py-5 pb-[var(--mobile-nav-clearance)] sm:px-6 sm:py-6 md:pb-8 lg:px-8 lg:py-7">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-[-0.02em] text-[#F4F4F2]">Portfolio</h1>
            <p className="mt-1 text-sm text-[#A3A7AB]">All your businesses in one place.</p>
          </div>
          <AddButton />
        </header>

        <Summary s={data?.summary} loading={isLoading} />

        <section aria-label="Businesses" className={`${CARD} flex flex-col gap-4 p-6`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-[#F4F4F2]">Businesses</h2>
            <AddButton subtle />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[200px] flex-1">
              <span className="sr-only">Search businesses</span>
              <Search
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#7D8287]"
                aria-hidden="true"
              />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search businesses"
                className="h-11 w-full rounded-full bg-[#1C2325] pl-10 pr-4 text-sm text-[#F4F4F2] placeholder:text-[#7D8287] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]"
              />
            </label>
            <label>
              <span className="sr-only">Filter by owner</span>
              <select
                value={ownership}
                onChange={(e) => setOwnership(e.target.value as OwnershipFilter)}
                className="h-11 rounded-full bg-[#1C2325] px-4 text-sm text-[#F4F4F2] [color-scheme:dark] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]"
              >
                {(Object.keys(OWNERSHIP_FILTER_LABEL) as OwnershipFilter[]).map((o) => (
                  <option key={o} value={o}>
                    {OWNERSHIP_FILTER_LABEL[o]}
                  </option>
                ))}
              </select>
            </label>
            <div role="tablist" aria-label="Status" className="flex rounded-full bg-[#1C2325] p-1">
              {(["active", "archived"] as PortfolioView[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={cn(
                    "h-9 rounded-full px-4 text-sm font-semibold transition-colors",
                    view === v
                      ? "bg-[#2A3134] text-[#F4F4F2]"
                      : "text-[#A3A7AB] hover:text-[#F4F4F2]",
                  )}
                >
                  {v === "active" ? "Active" : "Archived"}
                  <span className="ml-1.5 tabular-nums text-[#7D8287]">
                    {data?.counts[v] ?? "·"}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {isLoading ? (
            <ul className="flex flex-col gap-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <li key={i} className="h-[64px] animate-pulse rounded-2xl bg-[#1C2325]" />
              ))}
            </ul>
          ) : isError ? (
            <div className="flex flex-col items-start gap-3 py-6">
              <p className="text-sm font-semibold text-[#F4F4F2]">Couldn't load your businesses</p>
              <button
                type="button"
                onClick={() => refetch()}
                className="flex items-center gap-2 rounded-full bg-[#1C2325] px-4 py-2 text-sm font-semibold text-[#F4F4F2] hover:bg-[#2A3134]"
              >
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </button>
            </div>
          ) : data && data.total === 0 ? (
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <Building2 size={28} className="text-[#73C2CD]" aria-hidden="true" />
              <h3 className="mt-4 text-[15px] font-semibold text-[#F4F4F2]">No businesses yet</h3>
              <p className="mt-2 max-w-[420px] text-sm text-[#A3A7AB]">
                Add your first business to track its banking, VAT and reports here.
              </p>
              <div className="mt-5">
                <AddButton subtle />
              </div>
            </div>
          ) : data && data.businesses.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-10 text-center">
              <SearchX size={24} className="text-[#7D8287]" aria-hidden="true" />
              <p className="mt-3 text-sm font-semibold text-[#F4F4F2]">
                {filtered
                  ? "No businesses match your filters"
                  : view === "archived"
                    ? "No archived businesses"
                    : "No active businesses"}
              </p>
              {filtered && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch("");
                    setOwnership("all");
                  }}
                  className="mt-3 text-sm font-semibold text-[#73C2CD] hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <ul
              className={cn("flex flex-col gap-2 transition-opacity", isFetching && "opacity-70")}
            >
              {data?.businesses.map((b) => (
                <Row key={b.id} b={b} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
