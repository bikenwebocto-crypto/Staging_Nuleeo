import { useState, type ReactNode } from "react";
import { Link, useParams } from "wouter";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Building2,
  ChevronLeft,
  ChevronRight,
  FileBarChart,
  FileText,
  Info,
  Landmark,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Users,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@ui/components/ui/dropdown-menu";
import { cn } from "@ui/lib/utils";
import { useAuth } from "@ui/lib/useAuth";
import { parseApiError } from "@ui/lib/queryClient";
import { useToast } from "@ui/hooks/use-toast";
import { ENTITY_STATUS_LABEL } from "@shared/entities";
import {
  BANKING_PREFERENCE_LABEL,
  BANKING_STATUS_LABEL,
  BUSINESS_COUNTRIES,
  BUSINESS_ROLE_LABEL,
  BUSINESS_TYPE_LABEL,
  VAT_FILING_PERIOD_LABEL,
} from "@shared/businesses";
import type { BusinessDetailResponse, BusinessNotification } from "@shared/shareholdings";
import { useArchiveBusiness, useBusinessDetail } from "@/lib/businesses";
import { CARD } from "@/components/owner/dashboard/tokens";
import { EditBusinessDialog } from "@/components/owner/business/EditBusinessDialog";
import { ShareholdersDialog } from "@/components/owner/business/ShareholdersDialog";

// Business Detail: header, KPIs, and Overview / Financials / Documents /
// Activity / Invoices tabs. Modules that don't exist yet (ledger, documents
// per business, invoicing) render their structure with "—" and an honest
// empty state — no fabricated numbers.

const DASH = "—";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STATUS_TONE = { SETTING_UP: "#F5B65C", ACTIVE: "#7BD88F", INACTIVE: "#7D8287" } as const;
const TABS = ["Overview", "Financials", "Documents", "Activity", "Invoices"] as const;
type Tab = (typeof TABS)[number];

const money = (v: number | null | undefined) =>
  v == null
    ? DASH
    : new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
const date = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : DASH;

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className={`${CARD} flex min-w-0 flex-col gap-2 p-6`}>
      <p className="text-sm text-[#A3A7AB]">{label}</p>
      <p className="truncate text-3xl font-semibold tabular-nums tracking-[-0.02em]" style={{ color: tone ?? "#F4F4F2" }}>
        {value}
      </p>
      <p className="truncate text-xs text-[#7D8287]">{sub}</p>
    </div>
  );
}

function Card({ title, action, children, id }: { title: string; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} aria-label={title} className={`${CARD} flex flex-col gap-4 p-6`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-[#F4F4F2]">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function SmallButton({ onClick, children, disabled }: { onClick?: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 items-center gap-1.5 rounded-full bg-[#1C2325] px-4 text-xs font-semibold text-[#F4F4F2] hover:bg-[#2A3134] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]"
    >
      {children}
    </button>
  );
}

function Empty({ icon: Icon, title, body }: { icon: typeof Info; title: string; body: string }) {
  return (
    <div className={`${CARD} flex flex-col items-center px-6 py-14 text-center`}>
      <Icon size={26} className="text-[#73C2CD]" aria-hidden="true" />
      <h2 className="mt-4 text-[15px] font-semibold text-[#F4F4F2]">{title}</h2>
      <p className="mt-2 max-w-[460px] text-sm text-[#A3A7AB]">{body}</p>
    </div>
  );
}

function Detail({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[#7D8287]">{label}</dt>
      <dd className="mt-1 truncate text-sm text-[#F4F4F2]">{value || DASH}</dd>
    </div>
  );
}

function Overview({
  d,
  readOnly,
  onAction,
}: {
  d: BusinessDetailResponse;
  readOnly: boolean;
  onAction: (t: BusinessNotification["action"]["target"]) => void;
}) {
  const b = d.business;
  const yearEnd = b.financialYearEnd
    ? `${Number(b.financialYearEnd.slice(3))} ${MONTHS[Number(b.financialYearEnd.slice(0, 2)) - 1]}`
    : null;
  const pref = b.bankingPreference;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="lg:col-span-2">
        <Card title="Notifications">
          {d.notifications.length === 0 ? (
            <p className="text-sm text-[#A3A7AB]">You're all caught up.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {d.notifications.map((n) => (
                <li key={n.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-[#1C2325] px-4 py-3">
                  {n.tone === "warning" ? (
                    <AlertTriangle size={16} className="shrink-0 text-[#F5B65C]" aria-hidden="true" />
                  ) : (
                    <Info size={16} className="shrink-0 text-[#73C2CD]" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-[#F4F4F2]">{n.title}</span>
                    <span className="block text-xs text-[#A3A7AB]">{n.body}</span>
                  </span>
                  {!(readOnly && n.action.target !== "banking") && (
                    <button type="button" onClick={() => onAction(n.action.target)} className="text-xs font-semibold text-[#73C2CD] hover:underline">
                      {n.action.label}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title="Business details"
        action={
          !readOnly && (
            <SmallButton onClick={() => onAction("edit")}>
              <Pencil size={12} aria-hidden="true" /> Edit
            </SmallButton>
          )
        }
      >
        <dl className="grid grid-cols-2 gap-4">
          <Detail label="Legal name" value={b.legalName} />
          <Detail label="Trading name" value={b.tradingName} />
          <Detail label="Type" value={b.businessType ? BUSINESS_TYPE_LABEL[b.businessType] : null} />
          <Detail label="Country" value={BUSINESS_COUNTRIES.find((c) => c.code === b.country)?.name ?? b.country} />
          <Detail label="Registration no." value={b.registrationNumber} />
          <Detail label="Sector" value={b.sector} />
          <Detail
            label="VAT"
            value={b.vatRegistered == null ? null : b.vatRegistered ? `${b.vatNumber ?? DASH} · ${b.vatFilingPeriod ? VAT_FILING_PERIOD_LABEL[b.vatFilingPeriod] : DASH}` : "Not registered"}
          />
          <Detail label="Year end" value={yearEnd} />
          <Detail label="Accountant" value={b.accountantEmail} />
        </dl>
      </Card>

      <Card
        title="Ownership"
        action={
          !readOnly && (
            <SmallButton onClick={() => onAction("shareholders")}>
              <Users size={12} aria-hidden="true" /> Manage
            </SmallButton>
          )
        }
      >
        <div>
          <div className="h-2 overflow-hidden rounded-full bg-[#1C2325]" aria-hidden="true">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.min(d.allocation.total, 100)}%`, backgroundColor: d.allocation.complete ? "#7BD88F" : "#F5B65C" }}
            />
          </div>
          <p className="mt-2 text-xs text-[#A3A7AB]">
            {d.allocation.total}% allocated · {d.allocation.complete ? "Confirmed" : "Not confirmed"}
          </p>
        </div>
        {d.shareholders.length === 0 ? (
          <p className="text-sm text-[#A3A7AB]">No shareholders recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {d.shareholders.map((s) => (
              <li key={s.id} className="flex items-center gap-3 rounded-2xl bg-[#1C2325] px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[#F4F4F2]">{s.label}</span>
                  <span className="block truncate text-xs text-[#A3A7AB]">
                    {s.holderType === "ENTITY" ? "Company" : s.role ? BUSINESS_ROLE_LABEL[s.role] : "Individual"}
                  </span>
                </span>
                <span className="text-sm font-semibold tabular-nums text-[#F4F4F2]">{s.percent}%</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="lg:col-span-2">
        <Card id="business-banking" title="Bank account">
          <div className="flex items-center gap-3 rounded-2xl bg-[#1C2325] px-4 py-3">
            <Landmark size={18} className="shrink-0 text-[#A3A7AB]" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-[#F4F4F2]">
                {pref && pref !== "NONE" ? BANKING_PREFERENCE_LABEL[pref] : "No banking selected"}
              </span>
              <span className="block text-xs text-[#A3A7AB]">
                {pref && pref !== "NONE"
                  ? BANKING_STATUS_LABEL[b.bankingStatus ?? "NOT_STARTED"]
                  : "Choose a banking option once business banking is available."}
              </span>
            </span>
          </div>
          <p className="text-xs text-[#7D8287]">
            No application or bank connection has been started. Nothing is sent to a provider until
            business banking is switched on and you confirm.
          </p>
        </Card>
      </div>
    </div>
  );
}

function Invoices() {
  const [filter, setFilter] = useState<"All" | "Unpaid" | "Overdue" | "Paid">("All");
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 sm:grid-cols-3">
        <Kpi label="Unpaid" value={DASH} sub="— invoices" />
        <Kpi label="Overdue" value={DASH} sub="— invoices" />
        <Kpi label="Paid this month" value={DASH} sub="Transfers between your companies aren't counted" />
      </div>
      <section aria-label="Invoices" className={`${CARD} flex flex-col gap-4 p-6`}>
        <div role="tablist" aria-label="Invoice status" className="flex w-fit rounded-full bg-[#1C2325] p-1">
          {(["All", "Unpaid", "Overdue", "Paid"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "h-9 rounded-full px-4 text-sm font-semibold",
                filter === f ? "bg-[#2A3134] text-[#F4F4F2]" : "text-[#A3A7AB] hover:text-[#F4F4F2]",
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-xs text-[#7D8287]">
              <tr>
                <th className="py-2 pr-4 font-medium">Invoice</th>
                <th className="py-2 pr-4 font-medium">Customer</th>
                <th className="py-2 pr-4 font-medium">Due</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={5} className="py-10 text-center text-sm text-[#A3A7AB]">
                  Invoicing isn't available yet. Sales invoices will appear here once it is.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <nav aria-label="Invoice pages" className="flex items-center justify-end gap-2 text-xs text-[#7D8287]">
          <button type="button" disabled aria-label="Previous page" className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1C2325] opacity-50">
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <span>Page 1 of 1</span>
          <button type="button" disabled aria-label="Next page" className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1C2325] opacity-50">
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </nav>
      </section>
    </div>
  );
}

function Activity({ d }: { d: BusinessDetailResponse }) {
  const b = d.business;
  const events = [
    { at: b.createdAt, label: b.source === "MIGRATED" ? "Imported from your property records" : "Business added" },
    ...(b.archivedAt ? [{ at: b.archivedAt, label: "Archived" }] : []),
    ...(b.updatedAt && b.updatedAt !== b.createdAt ? [{ at: b.updatedAt, label: "Last updated" }] : []),
  ].sort((x, y) => y.at.localeCompare(x.at));
  return (
    <Card title="Activity">
      <ul className="flex flex-col gap-3">
        {events.map((e) => (
          <li key={e.label} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-[#F4F4F2]">{e.label}</span>
            <span className="text-xs text-[#7D8287]">{date(e.at)}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-[#7D8287]">A full activity history is coming with the business ledger.</p>
    </Card>
  );
}

export default function BusinessDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { firebaseUser } = useAuth();
  const { toast } = useToast();
  const { data: d, isLoading, isError, error, refetch } = useBusinessDetail(id);
  const archive = useArchiveBusiness(id ?? "");
  const [tab, setTab] = useState<Tab>("Overview");
  const [editOpen, setEditOpen] = useState(false);
  const [sharesOpen, setSharesOpen] = useState(false);

  const goBanking = () => {
    setTab("Overview");
    requestAnimationFrame(() => document.getElementById("business-banking")?.scrollIntoView({ behavior: "smooth" }));
  };
  const onAction = (t: BusinessNotification["action"]["target"]) =>
    t === "edit" ? setEditOpen(true) : t === "shareholders" ? setSharesOpen(true) : goBanking();

  const toggleArchive = () => {
    if (!d) return;
    const archiving = !d.business.archivedAt;
    if (
      archiving &&
      !window.confirm(
        `Archive ${d.business.name}? It moves to Archived in your portfolio. Nothing is deleted and you can restore it any time.`,
      )
    )
      return;
    archive.mutate(
      { archive: archiving },
      {
        onSuccess: () => toast({ title: archiving ? "Business archived" : "Business restored" }),
        onError: (err) => toast({ title: parseApiError(err, "Couldn't update the business"), variant: "destructive" }),
      },
    );
  };

  const notFound = isError && String(error?.message).startsWith("404");

  return (
    <main className="min-h-full w-full px-5 py-5 pb-[var(--mobile-nav-clearance)] sm:px-6 sm:py-6 md:pb-8 lg:px-8 lg:py-7">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm text-[#A3A7AB]">
          <Link href="/owner" className="hover:text-[#F4F4F2]">Portfolio</Link>
          <span aria-hidden="true">/</span>
          <Link href="/business" className="hover:text-[#F4F4F2]">Companies</Link>
          <span aria-hidden="true">/</span>
          <span className="truncate text-[#F4F4F2]" aria-current="page">{d?.business.name ?? "…"}</span>
        </nav>

        {isLoading ? (
          <div className="flex flex-col gap-5" aria-busy="true">
            <div className="h-16 animate-pulse rounded-[24px] bg-[#111618]" />
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-[132px] animate-pulse rounded-[24px] bg-[#111618]" />
              ))}
            </div>
          </div>
        ) : !d ? (
          <div className={`${CARD} flex flex-col items-start gap-3 p-7`}>
            <p className="font-semibold text-[#F4F4F2]">{notFound ? "Business not found" : "Couldn't load this business"}</p>
            {notFound ? (
              <Link href="/business" className="text-sm font-semibold text-[#73C2CD] hover:underline">Back to companies</Link>
            ) : (
              <button type="button" onClick={() => refetch()} className="flex items-center gap-2 rounded-full bg-[#1C2325] px-4 py-2 text-sm font-semibold text-[#F4F4F2] hover:bg-[#2A3134]">
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </button>
            )}
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-center gap-4">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#1C2325] text-[#73C2CD]">
                <Building2 size={22} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-2xl font-semibold tracking-[-0.02em] text-[#F4F4F2]">{d.business.name}</h1>
                  {(() => {
                    const tone = d.business.archivedAt ? "#7D8287" : STATUS_TONE[d.business.status];
                    return (
                      <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ color: tone, backgroundColor: `${tone}1F` }}>
                        {d.business.archivedAt ? "Archived" : ENTITY_STATUS_LABEL[d.business.status]}
                      </span>
                    );
                  })()}
                </div>
                <p className="mt-1 truncate text-sm text-[#A3A7AB]">
                  {[
                    d.business.sector,
                    d.business.businessType ? BUSINESS_TYPE_LABEL[d.business.businessType] : "Company",
                    `${d.allocation.total}% allocated${d.allocation.complete ? "" : " (unconfirmed)"}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <SmallButton onClick={goBanking}>
                  <Landmark size={12} aria-hidden="true" /> Banking
                </SmallButton>
                <span title="Reports arrive with the business ledger">
                  <SmallButton disabled>
                    <FileBarChart size={12} aria-hidden="true" /> Report
                  </SmallButton>
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label="More actions" className="flex h-9 w-9 items-center justify-center rounded-full bg-[#1C2325] text-[#F4F4F2] hover:bg-[#2A3134]">
                      <MoreHorizontal size={16} aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="rounded-2xl border-0 bg-[#111618] p-1.5 text-[#F4F4F2]">
                    {!d.business.archivedAt && (
                      <DropdownMenuItem onSelect={() => setEditOpen(true)} className="flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-[13px] focus:bg-[#1C2325] focus:text-[#F4F4F2]">
                        <Pencil size={14} aria-hidden="true" /> Edit details
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      disabled={archive.isPending}
                      onSelect={toggleArchive}
                      className="flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-[13px] focus:bg-[#1C2325] focus:text-[#F4F4F2]"
                    >
                      {d.business.archivedAt ? (
                        <><ArchiveRestore size={14} aria-hidden="true" /> Restore business</>
                      ) : (
                        <><Archive size={14} aria-hidden="true" /> Archive business</>
                      )}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </header>

            <section aria-label="Key figures" className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              <Kpi label="Revenue" value={money(d.kpis.revenue30d)} sub="Last 30 days" />
              <Kpi label="Expenses" value={money(d.kpis.expenses30d)} sub="Last 30 days" />
              <Kpi label="Profit margin" value={d.kpis.profitMarginPct == null ? DASH : `${d.kpis.profitMarginPct}%`} sub="Last 30 days" />
              <Kpi
                label="Needs attention"
                value={String(d.kpis.needsAttention)}
                sub={d.kpis.needsAttention ? "See notifications" : "Nothing outstanding"}
                tone={d.kpis.needsAttention ? "#F5B65C" : undefined}
              />
            </section>

            <div role="tablist" aria-label="Business sections" className="flex gap-1 overflow-x-auto">
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "h-10 shrink-0 rounded-full px-4 text-sm font-semibold transition-colors",
                    tab === t ? "bg-[#1C2325] text-[#F4F4F2]" : "text-[#A3A7AB] hover:text-[#F4F4F2]",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>

            <div role="tabpanel" aria-label={tab}>
              {tab === "Overview" && <Overview d={d} readOnly={!!d.business.archivedAt} onAction={onAction} />}
              {tab === "Financials" && (
                <Empty icon={FileBarChart} title="No financial data yet" body="Revenue, expenses and profit will appear once the business ledger or a bank account is connected. Transfers between your own companies won't be counted as revenue." />
              )}
              {tab === "Documents" && (
                <Empty icon={FileText} title="No documents yet" body="Company documents — certificates, filings and contracts — will be stored here." />
              )}
              {tab === "Activity" && <Activity d={d} />}
              {tab === "Invoices" && <Invoices />}
            </div>

            <EditBusinessDialog business={d.business} open={editOpen} onOpenChange={setEditOpen} />
            {firebaseUser && (
              <ShareholdersDialog detail={d} uid={firebaseUser.uid} open={sharesOpen} onOpenChange={setSharesOpen} />
            )}
          </>
        )}
      </div>
    </main>
  );
}
