import { useState, type ComponentType, type ReactNode } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  DoorOpen,
  Home,
  Info,
  Landmark,
  Pencil,
  Plus,
  Store,
  User,
  Building,
} from "lucide-react";
import type { StructureOwner, StructureProperty } from "@shared/structure";
import { useOwnerStructure } from "@/lib/structure";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { CreateEntityDialog } from "@/components/owner/entity/CreateEntityDialog";
import { PALETTE } from "@/components/owner/dashboard/tokens";
import { CardHeader, DARK_CARD, money, pct } from "@/components/owner/property/ui";
import { cn } from "@ui/lib/utils";

type Icon = ComponentType<{ className?: string }>;

const CHIP =
  "shrink-0 rounded-full bg-[#1C2325] px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-[#C9CBCC]";
const PROJECT_CHIP =
  "shrink-0 rounded-full bg-[#14B8A6]/15 px-2.5 py-0.5 text-[11px] font-medium text-[#5EEAD4]";

function NodeIcon({ icon: I, solid }: { icon: Icon; solid?: boolean }) {
  return (
    <span
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
        solid ? "bg-[#F4F4F2] text-[#111618]" : "bg-[#1C2325] text-[#C9CBCC]",
      )}
    >
      <I className="h-4 w-4" />
    </span>
  );
}

function Row({
  depth,
  icon,
  solid,
  title,
  subtitle,
  trailing,
  href,
}: {
  depth: number;
  icon: Icon;
  solid?: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  href?: string;
}) {
  const body = (
    <div className="flex min-w-0 items-center gap-3">
      {depth > 0 ? <span aria-hidden className="h-px w-4 shrink-0 bg-[#2A3134]" /> : null}
      <NodeIcon icon={icon} solid={solid} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{title}</p>
        {subtitle ? (
          <p className="truncate text-xs" style={{ color: PALETTE.muted }}>
            {subtitle}
          </p>
        ) : null}
      </div>
    </div>
  );
  return (
    <li
      className="flex items-center justify-between gap-3 py-2.5"
      style={{ paddingLeft: depth ? `${(depth - 1) * 28}px` : 0 }}
    >
      {href ? (
        <Link
          href={href}
          className="min-w-0 rounded-lg focus-visible:outline-2 focus-visible:outline-[#A78C68] hover:opacity-80"
        >
          {body}
        </Link>
      ) : (
        body
      )}
      {trailing}
    </li>
  );
}

function propertyIcon(p: StructureProperty): Icon {
  if (p.kind === "building" || p.kind === "apartment") return Building;
  if (p.kind === "commercial") return Store;
  return Home;
}

function ownerSubtitle(o: StructureOwner): string {
  const n = o.properties.length;
  const props = `${n} propert${n === 1 ? "y" : "ies"}`;
  if (o.entityType === "COMPANY") return `Company · ${props}`;
  if (o.entityType === "PERSONAL") return `Personally owned · ${props}`;
  return `Not linked to an owner yet · ${props}`;
}

function StatRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3 text-sm">
      <span style={{ color: PALETTE.muted }}>{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

export default function StructurePage() {
  const { data, isLoading, error } = useOwnerStructure();
  const { isSelf } = useActivePortfolio();
  const [addOpen, setAddOpen] = useState(false);
  const qc = useQueryClient();

  const s = data?.summary;

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mx-auto w-full max-w-[1440px] space-y-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Structure</h1>
          {isSelf ? (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#F4F4F2] px-4 py-2 text-sm font-medium text-[#111618] transition hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]"
            >
              <Plus className="h-4 w-4" /> Add entity
            </button>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <section className={cn(DARK_CARD, "pb-4")}>
            <CardHeader
              title="Ownership hierarchy"
              action={
                isSelf ? (
                  <Link
                    href="/portfolios"
                    className="inline-flex items-center gap-1.5 text-xs font-medium hover:opacity-80"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit structure
                  </Link>
                ) : undefined
              }
            />
            <div className="px-5 pt-4">
              {isLoading ? (
                <div className="space-y-3 py-2">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-10 animate-pulse rounded-lg bg-[#1C2325]" />
                  ))}
                </div>
              ) : error ? (
                <p className="py-6 text-sm" style={{ color: PALETTE.muted }}>
                  Couldn't load the structure. Please try again.
                </p>
              ) : !data || data.owners.length === 0 ? (
                <p className="py-6 text-sm" style={{ color: PALETTE.muted }}>
                  No properties yet. Add an entity and a property to build your structure.
                </p>
              ) : (
                <ul>
                  <Row
                    depth={0}
                    icon={Landmark}
                    solid
                    title="Real estate portfolio"
                    subtitle={`${s!.owners} owner${s!.owners === 1 ? "" : "s"} · ${s!.properties} properties · ${s!.units} units`}
                    trailing={<span className={CHIP}>{money(data.totalValue)}</span>}
                  />
                  {data.owners.map((o) => (
                    <OwnerBranch key={o.id} owner={o} />
                  ))}
                </ul>
              )}
            </div>
          </section>

          <div className="space-y-6">
            <section className={cn(DARK_CARD, "pb-3")}>
              <CardHeader title="Summary" />
              <div className="px-5 pt-3">
                <StatRow label="Owners" value={s?.owners ?? "—"} />
                <StatRow label="Companies" value={s?.companies ?? "—"} />
                <StatRow label="Properties" value={s?.properties ?? "—"} />
                <StatRow label="Units" value={s?.units ?? "—"} />
                <StatRow label="Active tenancies" value={s?.activeTenancies ?? "—"} />
                <StatRow label="Occupancy" value={s ? `${s.occupancyPct}%` : "—"} />
              </div>
            </section>
            <section className={cn(DARK_CARD, "pb-3")}>
              <CardHeader title="By owner" />
              <div className="px-5 pt-3">
                <StatRow label="Company-owned" value={money(s?.companyOwnedValue)} />
                <StatRow label="Personally owned" value={money(s?.personallyOwnedValue)} />
                <StatRow label="Average yield" value={s ? pct(s.averageYieldPct) : "—"} />
              </div>
            </section>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-[24px] bg-[#111618] px-5 py-4 text-xs text-[#C9CBCC]">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1C2325]">
            <Info className="h-4 w-4" />
          </span>
          Properties sit under their owner: Owner → Property → Unit → Tenant. Every transaction,
          report and access rule reads from this structure.
        </div>
      </div>

      <CreateEntityDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={() =>
          qc.invalidateQueries({
            predicate: (q) =>
              typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/owner/structure"),
          })
        }
      />
    </div>
  );
}

function OwnerBranch({ owner }: { owner: StructureOwner }) {
  const icon: Icon =
    owner.entityType === "COMPANY" ? Building2 : owner.entityType === "PERSONAL" ? User : Info;
  return (
    <>
      <Row
        depth={1}
        icon={icon}
        title={owner.name}
        subtitle={ownerSubtitle(owner)}
        trailing={<span className={CHIP}>{money(owner.value)}</span>}
      />
      {owner.properties.map((p) => (
        <PropertyBranch key={p.id} property={p} />
      ))}
    </>
  );
}

function PropertyBranch({ property: p }: { property: StructureProperty }) {
  const letUnits = p.units.filter((u) => u.tenantName);
  return (
    <>
      <Row
        depth={2}
        icon={propertyIcon(p)}
        title={p.name}
        subtitle={p.subtitle}
        href={`/properties/${p.id}`}
        trailing={p.projectName ? <span className={PROJECT_CHIP}>{p.projectName}</span> : undefined}
      />
      {letUnits.length > 0 ? (
        <Row
          depth={3}
          icon={DoorOpen}
          title={letUnits.map((u) => `${u.label} → ${u.tenantName}`).join(" · ")}
        />
      ) : null}
    </>
  );
}
