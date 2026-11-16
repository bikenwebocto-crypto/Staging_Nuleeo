// Tenants & leases — /owner/tenants_leases.
// One roster of every live tenancy in the active portfolio: KPI cards, search,
// owner + property filters, status pills, a paged table with a per-row "next
// action" (send reminder / renew lease / invite / resend invite), CSV export,
// and a full-page "Filter by property" picker (projects, then by asset type).
import { useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  Plus,
  RefreshCw,
  Search,
  Users,
  X,
  Check,
} from "lucide-react";

import { HeaderActions, PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { ListErrorState } from "@/components/common/ListErrorState";
import { TenantDetailsDrawer } from "@/components/tenant/TenantDetailsDrawer";
import {
  DARK_CARD,
  PILL_SOLID,
  StatusChip,
  moneyFull,
  formatMonth,
} from "@/components/owner/property/ui";
import { PALETTE } from "@/components/owner/dashboard/tokens";
import { useActivePortfolio } from "@/lib/activePortfolio";
import {
  useInviteTenant,
  useOwnerProperties,
  useOwnerTenants,
  useRemindTenant,
  type OwnerProperty,
  type OwnerTenant,
} from "@/lib/ownerQueries";
import { useProjects } from "@/lib/projects";
import { useToast } from "@ui/hooks/use-toast";
import { parseApiError } from "@ui/lib/queryClient";
import { cn } from "@ui/lib/utils";
import {
  EXPIRING_WINDOW_DAYS,
  TYPE_GROUPS,
  isOnRoster,
  leaseState,
  matchesFilter,
  ownerKey,
  propertyLabel,
  relativeLogin,
  rootPropertyId,
  typeGroupOf,
  type LeaseState,
  type PropertyFilter,
} from "./tenants/model";

export const TENANTS_LEASES_PATH = "/owner/tenants_leases";
const PAGE_SIZE = 8;
type Pill = "all" | "paid" | "overdue" | "expiring";
const PILLS: { id: Pill; label: string }[] = [
  { id: "all", label: "All" },
  { id: "paid", label: "Paid" },
  { id: "overdue", label: "Overdue" },
  { id: "expiring", label: "Expiring" },
];

export default function TenantsLeasesPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { isSelf } = useActivePortfolio();
  const { data: tenants = [], isLoading, isError, refetch } = useOwnerTenants();
  const { data: properties = [] } = useOwnerProperties();
  const { data: projectData } = useProjects(isSelf);
  const projects = projectData?.projects ?? [];
  const remind = useRemindTenant();
  const invite = useInviteTenant();

  const [search, setSearch] = useState("");
  const [pill, setPill] = useState<Pill>("all");
  const [owner, setOwner] = useState("all");
  const [propFilter, setPropFilter] = useState<PropertyFilter>({ kind: "all" });
  const [picking, setPicking] = useState(false);
  const [page, setPage] = useState(0);
  const [openTenant, setOpenTenant] = useState<OwnerTenant | null>(null);

  const today = useMemo(() => new Date(), []);
  const byId = useMemo(() => new Map(properties.map((p) => [p.id, p])), [properties]);
  const roster = useMemo(() => tenants.filter(isOnRoster), [tenants]);

  const ownerOptions = useMemo(() => {
    const companies = new Set<string>();
    roster.forEach(
      (t) => t.ownershipType === "company" && t.companyName && companies.add(t.companyName),
    );
    return [
      { value: "all", label: "All owners" },
      { value: "personal", label: "Personal" },
      ...Array.from(companies)
        .sort()
        .map((c) => ({ value: `co:${c}`, label: c })),
    ];
  }, [roster]);

  // Owner + property scope → drives both the KPI cards and the table.
  const scoped = useMemo(
    () =>
      roster.filter(
        (t) => (owner === "all" || ownerKey(t) === owner) && matchesFilter(t, propFilter, byId),
      ),
    [roster, owner, propFilter, byId],
  );
  const states = useMemo(
    () => new Map(scoped.map((t) => [t.id, leaseState(t, today)] as const)),
    [scoped, today],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scoped.filter((t) => {
      if (pill !== "all" && states.get(t.id) !== pill) return false;
      if (!q) return true;
      return [t.name, t.email, propertyLabel(t, byId), t.propertyAddress ?? ""].some((s) =>
        s.toLowerCase().includes(q),
      );
    });
  }, [scoped, states, search, pill, byId]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const overdue = scoped.filter((t) => states.get(t.id) === "overdue");
  const kpis = {
    total: scoped.length,
    paid: scoped.filter((t) => t.paymentStatus === "paid").length,
    expiring: scoped.filter((t) => states.get(t.id) === "expiring").length,
    overdue: overdue.length,
    outstanding: overdue.reduce((s, t) => s + t.rentAmount + (t.outstandingBalance || 0), 0),
  };

  const resetPage =
    <T,>(fn: (v: T) => void) =>
    (v: T) => {
      fn(v);
      setPage(0);
    };

  const onAddTenant = () => {
    navigate(`${TENANTS_LEASES_PATH}/new`);
  };

  const run = (kind: "remind" | "invite", t: OwnerTenant) => {
    const m = kind === "remind" ? remind : invite;
    m.mutate(t.id, {
      onSuccess: (res) =>
        toast({
          title: kind === "remind" ? "Reminder sent" : "Invite sent",
          description:
            kind === "remind"
              ? `${t.name} was reminded ${"channel" in res && res.channel === "in_app" ? "in the app" : "by email"}.`
              : `We emailed ${t.email} an invite to the tenant portal.`,
        }),
      onError: (err) =>
        toast({
          title: kind === "remind" ? "Couldn't send reminder" : "Couldn't send invite",
          description: parseApiError(err, "Please try again."),
          variant: "destructive",
        }),
    });
  };

  const exportCsv = () => {
    const cell = (v: string | number) => {
      let s = String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // block spreadsheet formula injection
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = [
      "Tenant",
      "Email",
      "Phone",
      "Property",
      "Monthly rent",
      "Lease start",
      "Lease end",
      "Status",
      "Portal",
    ];
    const lines = rows.map((t) =>
      [
        t.name,
        t.email,
        t.phone ?? "",
        propertyLabel(t, byId),
        t.rentAmount,
        t.leaseStart ?? "",
        t.leaseEnd ?? "",
        STATE_LABEL[states.get(t.id) ?? "pending"],
        t.portalStatus ?? "",
      ]
        .map(cell)
        .join(","),
    );
    const blob = new Blob([[header.map(cell).join(","), ...lines].join("\n")], {
      type: "text/csv",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tenants-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (picking) {
    return (
      <PropertyFilterView
        value={propFilter}
        roster={roster}
        properties={properties}
        projects={projects}
        byId={byId}
        onClose={() => setPicking(false)}
        onPick={(f) => {
          setPropFilter(f);
          setPage(0);
          setPicking(false);
        }}
      />
    );
  }

  const propLabel = propFilter.kind === "all" ? "All properties" : propFilter.label;

  return (
    <>
      <HeaderActions>
        <div className="flex items-center gap-2">
          <button type="button" onClick={exportCsv} disabled={!rows.length} className={PILL_SOLID}>
            <Download size={16} /> Export
          </button>
          {isSelf ? (
            <button type="button" onClick={onAddTenant} className={PILL_SOLID}>
              <Plus size={16} /> Add tenant
            </button>
          ) : null}
        </div>
      </HeaderActions>
      <TenantDetailsDrawer
        open={!!openTenant}
        onOpenChange={(o) => !o && setOpenTenant(null)}
        tenant={openTenant}
      />

      <div className={PAGE_CONTAINER_CLASSNAME}>
        <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
          {/* KPI cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi icon={<Users size={18} />} label="Total tenants" value={kpis.total} />
            <Kpi icon={<CheckCircle2 size={18} />} label="Paid this month" value={kpis.paid} />
            <Kpi
              icon={<Clock size={18} />}
              label="Expiring"
              value={kpis.expiring}
              sub={
                kpis.expiring
                  ? `within ${EXPIRING_WINDOW_DAYS} days`
                  : `none within ${EXPIRING_WINDOW_DAYS} days`
              }
              subColor={kpis.expiring ? PALETTE.amber : PALETTE.muted}
            />
            <Kpi
              icon={<AlertTriangle size={18} />}
              label="Overdue"
              value={kpis.overdue}
              sub={
                kpis.overdue ? `${moneyFull(kpis.outstanding)} outstanding` : "nothing outstanding"
              }
              subColor={kpis.overdue ? PALETTE.coral : PALETTE.muted}
            />
          </div>

          {/* Filters */}
          <section className={cn(DARK_CARD, "flex flex-col gap-4 p-4")}>
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <label className="flex h-10 min-w-0 flex-1 items-center gap-3 rounded-full bg-[#1C2325] px-4 text-sm focus-within:ring-2 focus-within:ring-[#A78C68]">
                <Search size={16} className="shrink-0 text-[#A3A7AB]" />
                <input
                  value={search}
                  onChange={(e) => resetPage(setSearch)(e.target.value)}
                  placeholder="Search by tenant, property or email…"
                  aria-label="Search tenants"
                  className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-[#7D8287]"
                />
              </label>
              <div className="flex gap-2">
                <span className="relative flex h-10 items-center rounded-full bg-[#1C2325] pl-4 pr-8 text-sm">
                  <select
                    value={owner}
                    onChange={(e) => resetPage(setOwner)(e.target.value)}
                    aria-label="Filter by owner"
                    className="h-full appearance-none bg-transparent outline-none [color-scheme:dark]"
                  >
                    {ownerOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={12} className="pointer-events-none absolute right-3" />
                </span>
                <span className="flex h-10 items-center rounded-full bg-[#1C2325] text-sm">
                  <button
                    type="button"
                    onClick={() => setPicking(true)}
                    className="flex h-full max-w-[220px] items-center gap-2 pl-4 pr-3"
                  >
                    <span className="truncate">{propLabel}</span>
                    <ChevronDown size={12} className="shrink-0" />
                  </button>
                  {propFilter.kind !== "all" ? (
                    <button
                      type="button"
                      aria-label="Clear property filter"
                      onClick={() => resetPage(setPropFilter)({ kind: "all" })}
                      className="pr-3 text-[#A3A7AB] hover:text-[#F4F4F2]"
                    >
                      <X size={14} />
                    </button>
                  ) : null}
                </span>
              </div>
            </div>
            <div role="tablist" className="flex flex-wrap gap-2">
              {PILLS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={pill === p.id}
                  onClick={() => resetPage(setPill)(p.id)}
                  className={cn(
                    "rounded-full px-5 py-2 text-sm transition",
                    pill === p.id
                      ? "bg-[#F4F4F2] text-[#111618]"
                      : "bg-[#1C2325] text-[#C9CCCE] hover:bg-[#2A3134]",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </section>

          {/* Table */}
          {isError ? (
            <ListErrorState title="We couldn't load your tenants." onRetry={() => refetch()} />
          ) : (
            <section className={cn(DARK_CARD, "overflow-hidden")}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[960px] text-sm">
                  <thead className="bg-[#1C2325] text-left text-xs text-[#C9CCCE]">
                    <tr>
                      <th className="px-5 py-3 font-medium">Tenant</th>
                      <th className="px-5 py-3 font-medium">Property</th>
                      <th className="px-5 py-3 text-right font-medium">Monthly rent</th>
                      <th className="px-5 py-3 font-medium">Lease period</th>
                      <th className="px-5 py-3 font-medium">Status</th>
                      <th className="px-5 py-3 font-medium">Next action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {isLoading ? (
                      Array.from({ length: 5 }).map((_, i) => (
                        <tr key={i}>
                          <td colSpan={6} className="px-5 py-5">
                            <div className="h-6 animate-pulse rounded-full bg-[#1C2325]" />
                          </td>
                        </tr>
                      ))
                    ) : pageRows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-5 py-16 text-center text-[#A3A7AB]">
                          {roster.length === 0
                            ? "No tenants yet. Add your first tenant to start tracking rent and leases."
                            : "No tenants match your filters."}
                        </td>
                      </tr>
                    ) : (
                      pageRows.map((t) => (
                        <tr
                          key={t.id}
                          onClick={() => setOpenTenant(t)}
                          className="cursor-pointer transition hover:bg-[#1C2325]/60"
                        >
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-3">
                              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#1C2325] text-sm font-medium">
                                {(t.name?.[0] ?? "?").toUpperCase()}
                              </span>
                              <div className="min-w-0">
                                <p className="truncate font-medium">{t.name}</p>
                                <PortalLine t={t} today={today} />
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-4">{propertyLabel(t, byId)}</td>
                          <td className="px-5 py-4 text-right font-medium tabular-nums">
                            {moneyFull(t.rentAmount)}
                          </td>
                          <td className="px-5 py-4 whitespace-nowrap">
                            {t.leaseStart
                              ? `${formatMonth(t.leaseStart)} – ${formatMonth(t.leaseEnd)}`
                              : "—"}
                          </td>
                          <td className="px-5 py-4">
                            <StateChip state={states.get(t.id) ?? "pending"} />
                          </td>
                          <td className="px-5 py-4" onClick={(e) => e.stopPropagation()}>
                            <NextAction
                              t={t}
                              state={states.get(t.id) ?? "pending"}
                              canAct={isSelf}
                              busy={
                                (remind.isPending && remind.variables === t.id) ||
                                (invite.isPending && invite.variables === t.id)
                              }
                              onRemind={() => run("remind", t)}
                              onInvite={() => run("invite", t)}
                              onRenew={() =>
                                navigate(
                                  t.agreementId
                                    ? `/owner/agreements/${t.agreementId}`
                                    : "/owner/agreements",
                                )
                              }
                            />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-col gap-2 px-5 py-4 text-xs text-[#A3A7AB] sm:flex-row sm:items-center sm:justify-between">
                <p>
                  {rows.length
                    ? `${safePage * PAGE_SIZE + 1}–${safePage * PAGE_SIZE + pageRows.length} of ${rows.length} tenants`
                    : "0 tenants"}{" "}
                  · Reminders go in-app to tenants who have logged in, by email to those who
                  haven't.
                </p>
                <div className="flex gap-3 text-[#F4F4F2]">
                  <button
                    type="button"
                    disabled={safePage === 0}
                    onClick={() => setPage(safePage - 1)}
                    className="disabled:opacity-40"
                  >
                    ‹ Previous
                  </button>
                  <button
                    type="button"
                    disabled={safePage >= pageCount - 1}
                    onClick={() => setPage(safePage + 1)}
                    className="disabled:opacity-40"
                  >
                    Next ›
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────

const STATE_LABEL: Record<LeaseState, string> = {
  overdue: "Overdue",
  expiring: "Expiring",
  paid: "Paid",
  pending: "Due",
  awaiting: "Awaiting signature",
  ended: "Ended",
};

function StateChip({ state }: { state: LeaseState }) {
  const tone =
    state === "paid"
      ? "green"
      : state === "overdue"
        ? "coral"
        : state === "expiring"
          ? "amber"
          : "muted";
  return <StatusChip tone={tone}>{STATE_LABEL[state]}</StatusChip>;
}

function Kpi({
  icon,
  label,
  value,
  sub,
  subColor,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  sub?: string;
  subColor?: string;
}) {
  return (
    <div className={cn(DARK_CARD, "flex items-center gap-4 px-5 py-5")}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#1C2325]">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs text-[#C9CCCE]">{label}</p>
        <p className="text-xl font-semibold tabular-nums">{value}</p>
        {sub ? (
          <p className="truncate text-xs" style={{ color: subColor }}>
            {sub}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PortalLine({ t, today }: { t: OwnerTenant; today: Date }) {
  if (t.portalStatus === "active" || (!t.portalStatus && t.userId)) {
    return (
      <p className="truncate text-[11px]" style={{ color: PALETTE.green }}>
        ● Active · last login {relativeLogin(t.lastLoginAt, today)}
      </p>
    );
  }
  return (
    <p className="truncate text-[11px]" style={{ color: PALETTE.amber }}>
      ○ {t.portalStatus === "not_invited" ? "Not invited yet" : "Invited · hasn't logged in yet"}
    </p>
  );
}

function NextAction({
  t,
  state,
  canAct,
  busy,
  onRemind,
  onInvite,
  onRenew,
}: {
  t: OwnerTenant;
  state: LeaseState;
  canAct: boolean;
  busy: boolean;
  onRemind: () => void;
  onInvite: () => void;
  onRenew: () => void;
}) {
  const btn =
    "inline-flex items-center gap-1.5 rounded-full bg-[#1C2325] px-3 py-1.5 text-xs font-medium text-[#F4F4F2] transition hover:bg-[#2A3134] disabled:opacity-50";
  if (!canAct) return <span className="text-[#7D8287]">—</span>;
  if (state === "overdue")
    return (
      <button type="button" className={btn} disabled={busy} onClick={onRemind}>
        <Bell size={13} /> {busy ? "Sending…" : "Send reminder"}
      </button>
    );
  if (state === "expiring")
    return (
      <button type="button" className={btn} onClick={onRenew}>
        <RefreshCw size={13} /> Renew lease
      </button>
    );
  if (t.portalStatus === "not_invited")
    return (
      <button type="button" className={btn} disabled={busy} onClick={onInvite}>
        {busy ? "Sending…" : "Invite"}
      </button>
    );
  if (t.portalStatus === "invited")
    return (
      <button type="button" className={btn} disabled={busy} onClick={onInvite}>
        {busy ? "Sending…" : "Resend invite"}
      </button>
    );
  return <span className="text-[#7D8287]">—</span>;
}

// ── Filter by property (full-page picker) ─────────────────────────────

function PropertyFilterView({
  value,
  roster,
  properties,
  projects,
  byId,
  onPick,
  onClose,
}: {
  value: PropertyFilter;
  roster: OwnerTenant[];
  properties: OwnerProperty[];
  projects: { id: string; name: string }[];
  byId: Map<string, OwnerProperty>;
  onPick: (f: PropertyFilter) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const hit = (s: string) => !query || s.toLowerCase().includes(query);

  // Top-level assets only — units roll up into their building.
  const roots = properties.filter((p) => !p.parentPropertyId);
  const unitCount = (id: string) => properties.filter((p) => p.parentPropertyId === id).length;
  const countFor = (f: PropertyFilter) => roster.filter((t) => matchesFilter(t, f, byId)).length;
  const rootTenants = (id: string) => roster.filter((t) => rootPropertyId(t) === id).length;
  const isOn = (f: PropertyFilter) => JSON.stringify(f) === JSON.stringify(value);
  const nameOf = (p: OwnerProperty) => p.name || p.address;

  const projectRows = projects
    .map((pr) => ({ pr, members: roots.filter((p) => p.projectId === pr.id) }))
    .filter(({ pr, members }) => hit(pr.name) || members.some((m) => hit(nameOf(m))));

  const groups = TYPE_GROUPS.map((g) => ({
    g,
    members: roots.filter((p) => typeGroupOf(p) === g.id && hit(nameOf(p))),
  })).filter(({ g, members }) => members.length > 0 && (hit(g.label) || members.length > 0));

  const Row = ({
    f,
    title,
    sub,
    count,
    indent,
  }: {
    f: PropertyFilter;
    title: string;
    sub?: string;
    count: string;
    indent?: boolean;
  }) => (
    <button
      type="button"
      onClick={() => onPick(f)}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-[#1C2325]",
        indent && "pl-7",
        isOn(f) && "bg-[#2A3134]",
      )}
    >
      <span className="min-w-0">
        <span className={cn("block truncate text-sm", !indent && "font-medium")}>{title}</span>
        {sub ? <span className="block truncate text-[11px] text-[#A3A7AB]">{sub}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-[#A3A7AB]">
        {count}
        {isOn(f) ? <Check size={14} className="text-[#F4F4F2]" /> : null}
      </span>
    </button>
  );

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mx-auto w-full max-w-[1440px]">
        <div className="flex items-center justify-between">
          <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
            <button type="button" onClick={onClose} className="hover:text-foreground">
              Tenants &amp; leases
            </button>{" "}
            › <span className="text-foreground/40">Filter by property</span>
          </nav>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#111618] text-[#F4F4F2] hover:bg-[#1C2325]"
          >
            <X size={18} />
          </button>
        </div>

        <div className={cn(DARK_CARD, "mx-auto mt-16 w-full max-w-[608px] p-3")}>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects or properties…"
            aria-label="Search projects or properties"
            className="h-10 w-full rounded-full bg-[#1C2325] px-3 text-sm outline-none placeholder:text-[#7D8287] focus:ring-2 focus:ring-[#A78C68]"
          />
          <div className="mt-2 max-h-[65vh] overflow-y-auto">
            <Row f={{ kind: "all" }} title="All properties" count="" />

            {projectRows.length ? (
              <>
                <p className="px-3 pb-1 pt-3 text-xs text-[#A3A7AB]">Projects</p>
                {projectRows.map(({ pr, members }) => {
                  const f: PropertyFilter = { kind: "project", id: pr.id, label: pr.name };
                  const n = countFor(f);
                  return (
                    <Row
                      key={pr.id}
                      f={f}
                      title={pr.name}
                      sub={members.map(nameOf).join(" · ") || "No properties yet"}
                      count={`${n} tenant${n === 1 ? "" : "s"}`}
                    />
                  );
                })}
              </>
            ) : null}

            {groups.length ? (
              <p className="px-3 pb-1 pt-3 text-xs text-[#A3A7AB]">By type</p>
            ) : null}
            {groups.map(({ g, members }) => {
              const gf: PropertyFilter = { kind: "type", type: g.id, label: g.label };
              const gn = countFor(gf);
              return (
                <div key={g.id}>
                  <Row f={gf} title={g.label} count={gn ? String(gn) : "—"} />
                  {members.map((p) => {
                    const units = unitCount(p.id);
                    const owner = p.propertyUse === "owner_occupied";
                    const n = rootTenants(p.id);
                    return (
                      <Row
                        key={p.id}
                        indent
                        f={{ kind: "property", id: p.id, label: nameOf(p) }}
                        title={nameOf(p)}
                        sub={units ? `${units} units` : owner ? "Owner-occupied" : undefined}
                        count={n ? String(n) : "—"}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
