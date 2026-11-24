import { Link } from "wouter";
import {
  ArrowLeftRight,
  ArrowRight,
  Building2,
  ChevronRight,
  Plus,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { PALETTE } from "@/components/owner/dashboard/tokens";
import { DashSkeleton } from "@/components/owner/dashboard/ui";
import { DARK_CARD, money } from "@/components/owner/property/ui";
import type { OwnerProperty } from "@/lib/ownerQueries";
import { cn } from "@ui/lib/utils";

// Real-estate portfolio overview: KPI strip + company / personal groups.
// Every figure is derived from the owner's property docs — no invented deltas.

export interface OverviewAsset {
  property: OwnerProperty;
  name: string;
  type: string;
  value: number;
  monthly: number;
  totalUnits: number;
  letUnits: number;
}

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className={cn(DARK_CARD, "flex min-w-0 items-center gap-3 px-4 py-5")}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#1C2325]">
        <Icon size={18} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs" style={{ color: PALETTE.muted }}>
          {label}
        </p>
        <p className="truncate text-xl font-semibold tabular-nums tracking-[-0.02em]">{value}</p>
        <p className="truncate text-[11px]" style={{ color: PALETTE.muted }}>
          {sub}
        </p>
      </div>
    </div>
  );
}

const PREVIEW_LIMIT = 4;

function Group({ title, assets, href }: { title: string; assets: OverviewAsset[]; href: string }) {
  const total = assets.reduce((sum, a) => sum + a.value, 0);
  const shown = [...assets].sort((a, b) => b.value - a.value).slice(0, PREVIEW_LIMIT);
  const n = assets.length;
  return (
    <section className={cn(DARK_CARD, "flex flex-col gap-2 p-5")} aria-label={title}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <p className="text-xs" style={{ color: PALETTE.muted }}>
            {money(total)} · {n} {n === 1 ? "property" : "properties"}
          </p>
        </div>
        {n > 0 ? (
          <Link
            href={href}
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-[#A78C68]"
          >
            View all {n} <ArrowRight size={12} aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      {n === 0 ? (
        <p className="py-6 text-center text-sm" style={{ color: PALETTE.muted }}>
          No properties yet
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {shown.map((a) => (
            <li key={a.property.id}>
              <Link
                href={`/properties/${a.property.id}`}
                className="flex items-center gap-4 rounded-2xl px-0 py-2 transition-colors hover:bg-white/[0.03] focus-visible:outline-2 focus-visible:outline-[#A78C68]"
              >
                <span className="flex h-10 w-14 shrink-0 items-center justify-center rounded-xl bg-[#1C2325]">
                  <Building2 size={16} style={{ color: PALETTE.muted }} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{a.name}</span>
                  <span className="block truncate text-xs" style={{ color: PALETTE.muted }}>
                    {a.type}
                    {a.property.city ? ` · ${a.property.city}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {money(a.property.propertyValue)}
                </span>
                <ChevronRight
                  size={16}
                  className="shrink-0"
                  style={{ color: PALETTE.muted }}
                  aria-hidden="true"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PortfolioOverview({
  assets,
  loading,
  canAdd,
  onAdd,
}: {
  assets: OverviewAsset[];
  loading: boolean;
  canAdd: boolean;
  onAdd: () => void;
}) {
  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <DashSkeleton key={i} className="h-[94px] rounded-[24px]" />
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <DashSkeleton key={i} className="h-[260px] rounded-[24px]" />
          ))}
        </div>
      </div>
    );
  }

  if (assets.length === 0) {
    return (
      <div className={cn(DARK_CARD, "flex flex-col items-center px-6 py-14 text-center")}>
        <Building2 size={32} className="mb-3 opacity-40" style={{ color: PALETTE.muted }} />
        <p className="text-sm font-medium">No assets yet</p>
        {canAdd ? (
          <button
            type="button"
            onClick={onAdd}
            className="mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
            style={{ backgroundColor: PALETTE.lime, color: PALETTE.bg }}
          >
            <Plus size={16} aria-hidden="true" /> Add your first asset
          </button>
        ) : null}
      </div>
    );
  }

  const totalValue = assets.reduce((s, a) => s + a.value, 0);
  const totalUnits = assets.reduce((s, a) => s + a.totalUnits, 0);
  const letUnits = assets.reduce((s, a) => s + a.letUnits, 0);
  const monthly = assets.reduce((s, a) => s + a.monthly, 0);
  const vacant = totalUnits - letUnits;
  const occupancy = totalUnits > 0 ? Math.round((letUnits / totalUnits) * 100) : null;
  const company = assets.filter((a) => a.property.ownershipType === "company");
  const personal = assets.filter((a) => a.property.ownershipType !== "company");

  return (
    <div className="space-y-6">
      <section aria-label="Portfolio summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          icon={Wallet}
          label="Portfolio value"
          value={money(totalValue)}
          sub={`${assets.length} ${assets.length === 1 ? "asset" : "assets"}`}
        />
        <Kpi
          icon={Building2}
          label="Properties"
          value={String(assets.length)}
          sub={`${totalUnits} ${totalUnits === 1 ? "unit" : "units"}`}
        />
        <Kpi
          icon={ArrowLeftRight}
          label="Monthly rent"
          value={money(monthly)}
          sub={`${letUnits} active ${letUnits === 1 ? "tenancy" : "tenancies"}`}
        />
        <Kpi
          icon={Users}
          label="Occupancy"
          value={occupancy == null ? "—" : `${occupancy}%`}
          sub={vacant === 0 ? "Fully let" : `${vacant} ${vacant === 1 ? "unit" : "units"} vacant`}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Group title="Company-owned" assets={company} href="/portfolios?ownership=company" />
        <Group title="Personally owned" assets={personal} href="/portfolios?ownership=personal" />
      </div>
    </div>
  );
}
