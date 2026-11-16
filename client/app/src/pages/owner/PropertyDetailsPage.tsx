import { useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useRoute, useSearch } from "wouter";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  Edit,
  FileText,
  Landmark,
  MoreHorizontal,
  Trash2,
  TrendingDown,
  TrendingUp,
  ArrowRightLeft,
  Plus,
} from "lucide-react";

import {
  useOwnerAgreements,
  useOwnerProperty,
  useOwnerPropertyTransactions,
  useOwnerTenants,
  type OwnerAgreement,
  type OwnerTenant,
} from "@/lib/ownerQueries";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { usePublicProperty } from "@/lib/publicQueries";
import { useActivePortfolioPlan } from "@/lib/useActivePortfolioPlan";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { PublicPropertyView } from "@/components/common/PublicPropertyView";
import { EditPropertyDrawer } from "@/components/owner/EditPropertyDrawer";
import { DeletePropertyDialog } from "@/components/owner/DeletePropertyDialog";
import { TransferPropertyDrawer } from "@/components/owner/TransferPropertyDrawer";
import { PropertyDocumentsSection } from "@/components/owner/PropertyDocumentsSection";
import { PALETTE } from "@/components/owner/dashboard/tokens";
import {
  CardHeader,
  DARK_CARD,
  KV,
  KpiBar,
  PILL_SOLID,
  PILL_GHOST,
  StatusChip,
  TabBar,
  formatDay,
  money,
  moneyFull,
  pct,
} from "@/components/owner/property/ui";
import {
  daysUntil,
  financialSummary,
  humanizeDays,
  loanMetrics,
  resolveRentalUse,
  shortTermMonthlyRent,
  type FinancialRange,
} from "@/components/owner/property/metrics";
import {
  buildOccupancyHistory,
  OCCUPANCY_STATUS_LABEL,
  type OccupancyRecord,
} from "@/components/owner/property/occupancy";
import { AddTenantDrawer } from "@ui/components/owner/AddTenantDrawer";
import { PricingModal } from "@ui/components/common/PricingModal";
import { useCanOwnerPlan } from "@ui/lib/usePrivileges";
import { useToast } from "@ui/hooks/use-toast";
import { openBriefing } from "@ui/lib/briefing";
import { cn } from "@ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@ui/components/ui/dropdown-menu";
import { isRealizedRent } from "@shared/realizedRent";
import type { Transaction } from "@shared/firestore-schema";

type Tab = "overview" | "financials" | "tenant" | "documents" | "activity";

function Avatar({ name }: { name: string }) {
  return (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#1C2325] text-sm font-semibold">
      {(name?.[0] ?? "?").toUpperCase()}
    </span>
  );
}

function Notice({
  dot,
  title,
  sub,
  action,
}: {
  dot: string;
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} />
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          {sub ? (
            <p className="text-xs" style={{ color: PALETTE.muted }}>
              {sub}
            </p>
          ) : null}
        </div>
      </div>
      {action}
    </div>
  );
}

const NOTICE_BTN =
  "shrink-0 rounded-full bg-[#1C2325] px-3.5 py-1.5 text-sm transition hover:bg-[#2A3134] focus-visible:outline-2 focus-visible:outline-[#A78C68]";

export default function PropertyDetailsPage() {
  const [, params] = useRoute("/properties/:id");
  const propertyId = params?.id;
  const search = useSearch();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const tab = (new URLSearchParams(search).get("tab") as Tab) || "overview";
  const setTab = (t: Tab) =>
    navigate(
      t === "overview" ? `/properties/${propertyId}` : `/properties/${propertyId}?tab=${t}`,
      {
        replace: true,
      },
    );

  const [range, setRange] = useState<FinancialRange>("12m");
  const [isAddTenantOpen, setIsAddTenantOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isTransferOpen, setIsTransferOpen] = useState(false);
  const [isPricingOpen, setIsPricingOpen] = useState(false);

  const { data: property, isLoading, error } = useOwnerProperty(propertyId);
  const ownerErrMsg = error instanceof Error ? error.message : "";
  const ownerTransient = !!error && !/^40[34]/.test(ownerErrMsg);
  const tryPublic = !isLoading && !property && !ownerTransient;
  const { data: publicProperty, isLoading: publicLoading } = usePublicProperty(
    propertyId,
    tryPublic,
  );
  const { data: transactions = [] } = useOwnerPropertyTransactions(propertyId);
  const { data: tenants = [] } = useOwnerTenants();
  const { data: agreements = [] } = useOwnerAgreements();
  const { isSelf, activeOwnerId, activePortfolioDocId } = useActivePortfolio();
  const { plan } = useActivePortfolioPlan();
  const canPlan = useCanOwnerPlan(plan);

  const propertyTenants = useMemo(
    () => tenants.filter((t) => t.propertyId === propertyId),
    [tenants, propertyId],
  );
  const activeTenant = propertyTenants.find((t) => t.status === "active");
  const pendingTenant = propertyTenants.find(
    (t) => t.status === "pending" || t.status === "invited",
  );
  const displayTenant = activeTenant ?? pendingTenant;
  const displayAgreement: OwnerAgreement | undefined =
    (displayTenant && agreements.find((a) => a.tenantId === displayTenant.id)) ||
    agreements.find((a) => a.propertyId === propertyId && a.status === "active");
  const occupancyHistory = useMemo(
    () => buildOccupancyHistory(agreements, propertyId),
    [agreements, propertyId],
  );

  if (isLoading) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <div className="mx-auto w-full max-w-[1440px] animate-pulse space-y-6">
          <div className="h-4 w-60 rounded bg-muted" />
          <div className="h-8 w-80 rounded bg-muted" />
          <div className="h-20 rounded-[24px] bg-muted" />
          <div className="h-60 rounded-[24px] bg-muted" />
        </div>
      </div>
    );
  }

  if (!property) {
    if (tryPublic) {
      if (publicLoading) {
        return (
          <div className={PAGE_CONTAINER_CLASSNAME}>
            <div className="h-60 animate-pulse rounded-[24px] bg-muted" />
          </div>
        );
      }
      if (publicProperty) {
        return (
          <div className="relative flex-1">
            <PublicPropertyView
              property={publicProperty}
              heroOverlay={
                <Link href="/">
                  <button
                    type="button"
                    aria-label="Back"
                    className="flex h-10 w-10 items-center justify-center rounded-full bg-card/20 backdrop-blur-md transition hover:bg-card/30"
                  >
                    <ArrowLeft size={20} />
                  </button>
                </Link>
              }
            />
          </div>
        );
      }
    }
    const isReal404 = !error || /^404/.test(ownerErrMsg);
    const isForbidden = /^403/.test(ownerErrMsg);
    return (
      <div className="flex min-h-[60vh] flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="font-semibold text-foreground">
          {isForbidden
            ? "You don't have access to this property"
            : isReal404
              ? "Property not found"
              : "Couldn't load this property"}
        </p>
        <Link href="/portfolios" className={PILL_SOLID}>
          <ArrowLeft size={16} /> Back to portfolio
        </Link>
      </div>
    );
  }

  // ── Derived state ──────────────────────────────────────────────────
  const name = property.name?.trim() || property.address;
  const use = resolveRentalUse(property);
  const isCompany = property.ownershipType === "company";
  const ownerName = isCompany ? property.companyName || "Company" : "Personal";
  const completion = property.profileCompletion ?? 0;
  const isComplete = completion >= 100;
  // Edit rights: the server enforces the grant matrix on save; the UI hides
  // the wizard entry points for cross-portfolio (read-only) viewers.
  const canEdit = isSelf;
  const showTenant = use !== "not_rented" && use !== "short_term";

  const monthlyRent =
    use === "not_rented"
      ? null
      : use === "short_term"
        ? shortTermMonthlyRent(transactions)
        : (displayAgreement?.monthlyRent ?? activeTenant?.rentAmount ?? property.rentAmount ?? 0);
  const value = property.propertyValue ?? 0;
  const summary = financialSummary(transactions, {
    range,
    value,
    monthlyRent: monthlyRent ?? 0,
    profile: property.profile,
  });
  const yearly = financialSummary(transactions, {
    range: "12m",
    value,
    monthlyRent: monthlyRent ?? 0,
    profile: property.profile,
  });
  const loan = loanMetrics(value, property.profile, yearly.netIncome);
  const leaseEnd = activeTenant ? displayAgreement?.endDate : undefined;
  const occupancy12m = (() => {
    // Share of the last 365 days covered by any tenancy with dates.
    const from = Date.now() - 365 * 86_400_000;
    let covered = 0;
    for (const a of agreements.filter((x) => x.propertyId === propertyId && x.startDate)) {
      const s = Math.max(from, new Date(a.startDate).getTime());
      const e = Math.min(Date.now(), a.endDate ? new Date(a.endDate).getTime() : Date.now());
      if (e > s) covered += e - s;
    }
    return Math.min(100, (covered / (365 * 86_400_000)) * 100);
  })();

  const statusChip =
    use === "not_rented" ? (
      <StatusChip tone="muted">Not rented</StatusChip>
    ) : use === "short_term" ? (
      <StatusChip tone="cyan">Short-term</StatusChip>
    ) : activeTenant ? (
      <StatusChip tone="green">Occupied</StatusChip>
    ) : pendingTenant ? (
      <StatusChip tone="amber">Pending</StatusChip>
    ) : (
      <StatusChip tone="coral">Vacant</StatusChip>
    );

  const fourthKpi = !isComplete
    ? { label: "Profile", value: `${completion}%` }
    : leaseEnd
      ? { label: "Lease ends", value: formatDay(leaseEnd) }
      : { label: "Occupancy", value: pct(occupancy12m, 0) };

  // ── Notifications ──────────────────────────────────────────────────
  const notices: ReactNode[] = [];
  const leaseDays = daysUntil(leaseEnd);
  if (leaseDays != null && leaseDays >= 0 && leaseDays <= 60 && displayTenant) {
    notices.push(
      <Notice
        key="lease"
        dot={PALETTE.amber}
        title={`Lease ends in ${humanizeDays(leaseDays)}`}
        sub={`${displayTenant.name} · ${formatDay(leaseEnd)}`}
        action={
          <Link href="/owner/agreements" className={NOTICE_BTN}>
            Renew lease
          </Link>
        }
      />,
    );
  }
  const renewal = property.profile?.costs?.insurance?.renewalDate;
  const renewalDays = daysUntil(renewal);
  if (renewalDays != null && renewalDays <= 30) {
    notices.push(
      <Notice
        key="ins"
        dot={renewalDays < 0 ? PALETTE.coral : PALETTE.amber}
        title={
          renewalDays < 0
            ? "Insurance renewal is overdue"
            : `Insurance renews on ${formatDay(renewal)}`
        }
        action={
          canEdit ? (
            <Link href={`/properties/${property.id}/profile?step=5`} className={NOTICE_BTN}>
              Update
            </Link>
          ) : undefined
        }
      />,
    );
  }
  const certExpiry = property.profile?.details?.energyExpiry;
  const certDays = daysUntil(certExpiry);
  if (certDays != null && certDays <= 90) {
    notices.push(
      <Notice
        key="cert"
        dot={certDays < 0 ? PALETTE.coral : PALETTE.amber}
        title={
          certDays < 0
            ? `Energy certificate expired on ${formatDay(certExpiry)}`
            : `Energy certificate expires on ${formatDay(certExpiry)}`
        }
        action={
          canEdit ? (
            <Link href={`/properties/${property.id}/profile?step=6`} className={NOTICE_BTN}>
              Upload new
            </Link>
          ) : undefined
        }
      />,
    );
  }
  if (property.titleDeedsStatus === "pending") {
    notices.push(
      <Notice
        key="deed"
        dot={PALETTE.cyan}
        title="Title deed pending – we'll notify you when it's issued"
      />,
    );
  }

  const handleReport = async () => {
    if (!canPlan("briefing.property")) {
      setIsPricingOpen(true);
      return;
    }
    const pending = toast({ title: "Preparing report…" });
    const result = await openBriefing(
      { propertyId: property.id },
      { ownerId: activeOwnerId, isSelf, portfolioDocId: activePortfolioDocId },
    );
    pending.dismiss();
    if (!result.ok)
      toast({ title: "Report failed", description: result.error, variant: "destructive" });
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "financials", label: "Financials" },
    ...(showTenant ? [{ id: "tenant" as const, label: "Tenant" }] : []),
    { id: "documents", label: "Documents" },
    { id: "activity", label: "Activity" },
  ];
  const activeTab: Tab = tabs.some((t) => t.id === tab) ? tab : "overview";
  const ownershipKey = isCompany ? "company" : "personal";

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <AddTenantDrawer
        open={isAddTenantOpen}
        onOpenChange={setIsAddTenantOpen}
        propertyAddress={property.address}
      />
      <PricingModal open={isPricingOpen} onOpenChange={setIsPricingOpen} />
      {isSelf ? (
        <>
          <EditPropertyDrawer open={isEditOpen} onOpenChange={setIsEditOpen} property={property} />
          <DeletePropertyDialog
            open={isDeleteOpen}
            onOpenChange={setIsDeleteOpen}
            propertyId={property.id}
            propertyAddress={property.address}
          />
          <TransferPropertyDrawer
            open={isTransferOpen}
            onOpenChange={setIsTransferOpen}
            propertyId={property.id}
            propertyAddress={property.address}
          />
        </>
      ) : null}

      <div className="mx-auto w-full max-w-[1440px] space-y-6">
        {/* Breadcrumb */}
        <nav
          aria-label="Breadcrumb"
          className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground"
        >
          <Link href="/portfolios" className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft size={14} aria-hidden="true" /> Portfolio
          </Link>
          <ChevronRight size={14} aria-hidden="true" />
          <Link href={`/portfolios?ownership=${ownershipKey}`} className="hover:text-foreground">
            {isCompany ? "Company-owned" : "Personally owned"}
          </Link>
          <ChevronRight size={14} aria-hidden="true" />
          <span className="truncate text-foreground/60" aria-current="page">
            {name}
          </span>
        </nav>

        {/* Header */}
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold text-foreground">{name}</h1>
              {statusChip}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {[property.address, property.city].filter(Boolean).join(", ")} · {ownerName}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && !isComplete ? (
              <Link href={`/properties/${property.id}/profile`} className={PILL_GHOST}>
                Complete profile
              </Link>
            ) : null}
            <Link href="/banking" className={PILL_SOLID}>
              <Landmark size={16} aria-hidden="true" /> Banking
            </Link>
            <button type="button" onClick={handleReport} className={PILL_SOLID}>
              <FileText size={16} aria-hidden="true" /> Report
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label="More actions" className={cn(PILL_SOLID, "px-3")}>
                  <MoreHorizontal size={16} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 rounded-xl p-2">
                {canEdit ? (
                  <DropdownMenuItem onClick={() => setIsEditOpen(true)} className="gap-2 p-2.5">
                    <Edit size={16} /> Edit name & address
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onClick={handleReport} className="gap-2 p-2.5">
                  <Download size={16} /> Download PDF briefing
                </DropdownMenuItem>
                {canEdit ? (
                  <>
                    <DropdownMenuItem
                      onClick={() => setIsTransferOpen(true)}
                      className="gap-2 p-2.5"
                    >
                      <ArrowRightLeft size={16} /> Transfer ownership
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setIsDeleteOpen(true)}
                      className="gap-2 p-2.5 text-red-500 focus:bg-red-500/10 focus:text-red-500"
                    >
                      <Trash2 size={16} /> Delete property
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <KpiBar
          items={[
            { label: "Value", value: money(value) },
            { label: "Gross yield", value: pct(summary.grossYield) },
            {
              label: "Monthly rent",
              value: monthlyRent == null || monthlyRent === 0 ? "—" : money(monthlyRent),
              tone: monthlyRent ? "green" : undefined,
            },
            fourthKpi,
          ]}
        />

        <TabBar tabs={tabs} value={activeTab} onChange={setTab} />

        {activeTab === "overview" ? (
          <div className="space-y-6">
            {notices.length > 0 ? (
              <section className={cn(DARK_CARD, "pb-3")}>
                <CardHeader
                  title="Notifications"
                  action={
                    <span className="text-xs" style={{ color: PALETTE.muted }}>
                      {notices.length} new
                    </span>
                  }
                />
                <div className="px-5 pt-2">{notices}</div>
              </section>
            ) : null}

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <section className={cn(DARK_CARD, "pb-4")}>
                <CardHeader
                  title="Financial summary"
                  action={
                    <div className="flex gap-1" role="radiogroup" aria-label="Range">
                      {(["12m", "ytd"] as const).map((r) => (
                        <button
                          key={r}
                          type="button"
                          role="radio"
                          aria-checked={range === r}
                          onClick={() => setRange(r)}
                          className={cn(
                            "rounded-full px-3.5 py-1.5 text-sm",
                            range === r ? "bg-[#F4F4F2] text-[#060A0B]" : "bg-[#1C2325]",
                          )}
                        >
                          {r === "12m" ? "12M" : "YTD"}
                        </button>
                      ))}
                    </div>
                  }
                />
                <div className="px-5 pt-4">
                  <KV
                    label="Rental income"
                    value={
                      <span style={{ color: PALETTE.green }}>
                        {moneyFull(summary.rentalIncome)}
                      </span>
                    }
                  />
                  <KV label="Operating expenses" value={moneyFull(-summary.operatingExpenses)} />
                  <KV label="Net income" value={moneyFull(summary.netIncome)} />
                  <KV label="Gross yield" value={pct(summary.grossYield)} />
                  <KV label="Occupancy (12m)" value={pct(occupancy12m, 0)} />
                </div>
              </section>

              <section className={cn(DARK_CARD, "pb-4")}>
                <CardHeader
                  title="Property details"
                  action={
                    canEdit ? (
                      <Link
                        href={`/properties/${property.id}/profile?step=1`}
                        className="text-xs hover:text-white"
                        style={{ color: PALETTE.muted }}
                      >
                        Edit
                      </Link>
                    ) : undefined
                  }
                />
                <div className="px-5 pt-4">
                  <KV
                    label="Type"
                    value={
                      [
                        property.propertyType,
                        property.bedrooms != null ? `${property.bedrooms} bed` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "—"
                    }
                  />
                  <KV
                    label="Title deed"
                    value={
                      property.titleDeedsStatus === "issued" ? (
                        <StatusChip tone="green">Issued</StatusChip>
                      ) : property.titleDeedsStatus === "pending" ? (
                        <StatusChip tone="amber">Pending</StatusChip>
                      ) : (
                        "—"
                      )
                    }
                  />
                  <KV label="Year of acquisition" value={property.acquisitionYear || "—"} />
                  <KV label="Energy class" value={property.energyClass || "—"} />
                  <KV label="Owner" value={ownerName} />
                </div>
              </section>
            </div>

            {showTenant ? (
              <section className={cn(DARK_CARD, "pb-5")}>
                <CardHeader
                  title="Current tenant"
                  action={
                    displayTenant ? (
                      <button
                        type="button"
                        onClick={() => setTab("tenant")}
                        className="text-xs"
                        style={{ color: PALETTE.cyan }}
                      >
                        View tenant →
                      </button>
                    ) : undefined
                  }
                />
                {displayTenant ? (
                  <div className="flex flex-wrap items-center justify-between gap-4 px-5 pt-4">
                    <div className="flex items-center gap-3">
                      <Avatar name={displayTenant.name} />
                      <span className="font-semibold">{displayTenant.name}</span>
                      <span className="text-xs" style={{ color: PALETTE.muted }}>
                        {activeTenant
                          ? `Lease ends ${formatDay(displayAgreement?.endDate)}`
                          : displayTenant.status === "invited"
                            ? "Invitation sent"
                            : "Awaiting approval"}
                      </span>
                    </div>
                    <div className="flex gap-8">
                      {[
                        ["Monthly rent", displayAgreement?.monthlyRent ?? displayTenant.rentAmount],
                        [
                          "Advance payment",
                          (displayAgreement?.prepaidRents ?? 0) *
                            (displayAgreement?.monthlyRent ?? 0) || null,
                        ],
                        ["Deposit", displayAgreement?.deposit],
                      ].map(([l, v]) => (
                        <div key={l as string}>
                          <p className="text-xs" style={{ color: PALETTE.muted }}>
                            {l}
                          </p>
                          <p className="text-lg font-semibold tabular-nums">
                            {moneyFull(v as number | null | undefined)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
                    <p className="text-sm" style={{ color: PALETTE.muted }}>
                      No tenant on this property yet.
                    </p>
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={() =>
                          canPlan("tenants.invite")
                            ? setIsAddTenantOpen(true)
                            : setIsPricingOpen(true)
                        }
                        className={NOTICE_BTN}
                      >
                        <Plus size={14} className="mr-1 inline" aria-hidden="true" />
                        Add a tenant
                      </button>
                    ) : null}
                  </div>
                )}
              </section>
            ) : null}
          </div>
        ) : null}

        {activeTab === "financials" ? (
          <section className={cn(DARK_CARD, "pb-6")}>
            <CardHeader title="Financials & loan-ready profile" />
            <div className="grid grid-cols-1 gap-x-10 px-5 pt-4 md:grid-cols-2">
              <div>
                <p className="py-2 text-xs" style={{ color: PALETTE.muted }}>
                  Acquisition
                </p>
                <KV label="Purchase cost" value={moneyFull(property.acquisitionPrice || null)} />
                <KV label="Market value" value={moneyFull(value || null)} />
                <KV label="Year of acquisition" value={property.acquisitionYear || "—"} />
                <KV
                  label="Title deed"
                  value={
                    property.titleDeedsStatus === "issued" ? (
                      <StatusChip tone="green">Issued</StatusChip>
                    ) : property.titleDeedsStatus === "pending" ? (
                      <StatusChip tone="amber">Pending</StatusChip>
                    ) : (
                      "—"
                    )
                  }
                />
              </div>
              <div>
                <p className="py-2 text-xs" style={{ color: PALETTE.muted }}>
                  Financing
                </p>
                {property.profile?.financing?.hasLoan ? (
                  <>
                    <KV label="Lender" value={property.profile.financing.lender || "—"} />
                    <KV
                      label="Outstanding debt"
                      value={moneyFull(property.profile.financing.balance)}
                    />
                    <KV
                      label="Rate · maturity"
                      value={`${pct(property.profile.financing.ratePct)} · ${
                        property.profile.financing.endDate?.slice(0, 4) ?? "—"
                      }`}
                    />
                    <KV
                      label="LTV · DSCR"
                      value={
                        <span>
                          {pct(loan?.ltv, 0)} ·{" "}
                          <span
                            style={{
                              color:
                                loan?.dscr != null && loan.dscr < 1 ? PALETTE.coral : undefined,
                            }}
                          >
                            {loan?.dscr != null ? `${loan.dscr.toFixed(2)}×` : "—"}
                          </span>
                        </span>
                      }
                    />
                    <KV label="Equity" value={moneyFull(loan?.equity)} />
                  </>
                ) : property.profile?.financing ? (
                  <KV label="Loan" value="No loan on this property" />
                ) : (
                  <div className="flex items-center justify-between py-2.5 text-sm">
                    <span style={{ color: PALETTE.muted }}>No financing details yet</span>
                    {canEdit ? (
                      <Link
                        href={`/properties/${property.id}/profile?step=3`}
                        className="text-xs"
                        style={{ color: PALETTE.cyan }}
                      >
                        Add financing →
                      </Link>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === "tenant" ? (
          <TenantTab
            tenant={displayTenant}
            agreement={displayAgreement}
            history={occupancyHistory}
            onAdd={() =>
              canPlan("tenants.invite") ? setIsAddTenantOpen(true) : setIsPricingOpen(true)
            }
            canEdit={canEdit}
          />
        ) : null}

        {activeTab === "documents" && propertyId ? (
          <PropertyDocumentsSection propertyId={propertyId} />
        ) : null}

        {activeTab === "activity" ? (
          <ActivityTab transactions={transactions} propertyName={name} />
        ) : null}
      </div>
    </div>
  );
}

function TenantTab({
  tenant,
  agreement,
  history,
  onAdd,
  canEdit,
}: {
  tenant: OwnerTenant | undefined;
  agreement: OwnerAgreement | undefined;
  history: OccupancyRecord[];
  onAdd: () => void;
  canEdit: boolean;
}) {
  const progress = (() => {
    if (!agreement?.startDate || !agreement.endDate) return null;
    const s = new Date(agreement.startDate).getTime();
    const e = new Date(agreement.endDate).getTime();
    if (e <= s) return null;
    return Math.min(100, Math.max(0, ((Date.now() - s) / (e - s)) * 100));
  })();
  const ACTION =
    "rounded-full bg-[#1C2325] px-3 py-1.5 text-xs transition hover:bg-[#2A3134] focus-visible:outline-2 focus-visible:outline-[#A78C68]";

  return (
    <div className="space-y-6">
      <section className={cn(DARK_CARD, "pb-5")}>
        <CardHeader
          title="Tenancy"
          action={
            tenant && canEdit ? (
              <div className="flex gap-2">
                <Link href="/owner/agreements" className={ACTION}>
                  Change rent
                </Link>
                <Link href="/owner/agreements" className={ACTION}>
                  Renew
                </Link>
                <Link href="/owner/agreements" className={cn(ACTION, "text-[#FF7A7A]")}>
                  End lease
                </Link>
              </div>
            ) : undefined
          }
        />
        {tenant ? (
          <div className="px-5 pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <Avatar name={tenant.name} />
              <span className="font-semibold">{tenant.name}</span>
              <span className="text-xs" style={{ color: PALETTE.muted }}>
                {[tenant.email !== tenant.name ? tenant.email : null, tenant.phone]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-x-10 md:grid-cols-2">
              <div>
                <KV label="Lease start" value={formatDay(agreement?.startDate)} />
                <KV label="Lease end" value={formatDay(agreement?.endDate)} />
                <KV
                  label="Monthly rent"
                  value={moneyFull(agreement?.monthlyRent ?? tenant.rentAmount)}
                />
                <KV
                  label="Rent due day"
                  value={agreement?.paymentDayOfMonth ? ordinal(agreement.paymentDayOfMonth) : "—"}
                />
              </div>
              <div>
                <KV
                  label="Advance payment"
                  value={moneyFull(
                    (agreement?.prepaidRents ?? 0) * (agreement?.monthlyRent ?? 0) || null,
                  )}
                />
                <KV label="Deposit" value={moneyFull(agreement?.deposit)} />
                {progress != null ? (
                  <div className="py-2.5">
                    <p className="mb-2 text-xs" style={{ color: PALETTE.muted }}>
                      Lease progress
                    </p>
                    <div
                      className="h-1.5 rounded-full bg-[#1C2325]"
                      role="progressbar"
                      aria-valuenow={Math.round(progress)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${progress}%`, backgroundColor: PALETTE.green }}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between px-5 pt-4">
            <p className="text-sm" style={{ color: PALETTE.muted }}>
              No tenant on this property yet.
            </p>
            {canEdit ? (
              <button type="button" onClick={onAdd} className={ACTION}>
                + Add a tenant
              </button>
            ) : null}
          </div>
        )}
      </section>

      <section className={cn(DARK_CARD, "overflow-hidden")}>
        <CardHeader title="Occupancy history" />
        {history.length === 0 ? (
          <p className="px-5 pb-5 pt-4 text-sm" style={{ color: PALETTE.muted }}>
            No occupancy history yet. Past and current leases for this property will appear here.
          </p>
        ) : (
          <>
            <div
              className="mt-4 hidden grid-cols-[1fr_110px_110px_100px_110px] gap-4 bg-[#1C2325] px-5 py-3 text-xs md:grid"
              style={{ color: PALETTE.muted }}
            >
              <span>Tenant</span>
              <span>Start</span>
              <span>End</span>
              <span className="text-right">Rent</span>
              <span>Status</span>
            </div>
            <ul className="mt-2 md:mt-0">
              {history.map((r) => (
                <li key={r.agreementId}>
                  <Link
                    href={`/owner/agreements/${r.agreementId}`}
                    aria-label={`View agreement for ${r.tenantName}`}
                    className={cn(
                      "grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-3 transition hover:bg-[#1C2325] focus-visible:outline-2 focus-visible:outline-[#A78C68] md:grid-cols-[1fr_110px_110px_100px_110px]",
                      r.isCurrent && "border-l-2 border-[#4ADE80] bg-[#1C2325]/40",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{r.tenantName}</p>
                      <p className="text-xs md:hidden" style={{ color: PALETTE.muted }}>
                        {formatDay(r.startDate)} – {r.endDate ? formatDay(r.endDate) : "Present"}
                      </p>
                    </div>
                    <span className="hidden text-sm md:block">{formatDay(r.startDate)}</span>
                    <span className="hidden text-sm md:block">
                      {r.endDate ? formatDay(r.endDate) : "Present"}
                    </span>
                    <span className="text-xs tabular-nums md:text-right md:text-sm">
                      {moneyFull(r.monthlyRent)}
                      <span className="md:hidden"> / month</span>
                    </span>
                    <span className="col-start-2 row-start-1 md:col-start-auto md:row-start-auto">
                      <StatusChip
                        tone={
                          r.isCurrent ? "green" : r.status === "pending_tenant" ? "amber" : "muted"
                        }
                      >
                        {OCCUPANCY_STATUS_LABEL[r.status]}
                      </StatusChip>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function ActivityTab({
  transactions,
  propertyName,
}: {
  transactions: Transaction[];
  propertyName: string;
}) {
  return (
    <section className={cn(DARK_CARD, "pb-4")}>
      <CardHeader
        title="Activity"
        action={
          <Link href="/owner/activity" className="text-xs" style={{ color: PALETTE.muted }}>
            Open transactions →
          </Link>
        }
      />
      {transactions.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-12 text-center">
          <span
            className="mb-4 flex h-11 w-11 items-center justify-center rounded-full"
            style={{ backgroundColor: `${PALETTE.green}1F`, color: PALETTE.green }}
          >
            <Landmark size={18} aria-hidden="true" />
          </span>
          <p className="text-lg font-semibold">No activity yet for {propertyName}</p>
          <p className="mt-2 max-w-md text-sm" style={{ color: PALETTE.muted }}>
            Connect a bank account and rent, bills and payments for this property appear here
            automatically.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <Link
              href="/banking"
              className="rounded-full bg-[#F4F4F2] px-4 py-2 text-sm font-medium text-[#060A0B]"
            >
              Connect a bank
            </Link>
          </div>
        </div>
      ) : (
        <ul className="px-5 pt-3">
          {transactions.map((tx) => {
            const income = tx.type === "income";
            const rent = isRealizedRent(tx);
            return (
              <li key={tx.id} className="flex items-center justify-between gap-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#1C2325]">
                    {income ? (
                      <TrendingUp size={16} style={{ color: PALETTE.green }} />
                    ) : (
                      <TrendingDown size={16} style={{ color: PALETTE.muted }} />
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {tx.name} · {moneyFull(tx.amount)}
                    </p>
                    <p className="text-xs" style={{ color: PALETTE.muted }}>
                      {formatDay(tx.timestamp)} · {tx.category}
                    </p>
                  </div>
                </div>
                <StatusChip tone={rent ? "green" : income ? "cyan" : "muted"}>
                  {rent ? "Rent" : income ? "Income" : "Expense"}
                </StatusChip>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
