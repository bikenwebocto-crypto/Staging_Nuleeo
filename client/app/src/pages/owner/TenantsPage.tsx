import { useEffect, useMemo, useState } from "react";
import { HeaderActions, PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import {
  useOwnerTenants,
  useOwnerProperties,
  useSettleTenantBalance,
  type OwnerTenant as Tenant,
} from "@/lib/ownerQueries";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { TableFiltersCard, FilterPills, TableSearchInput } from "@ui/components/ui/data-table";
import { PageHeader, PageHeaderAction } from "@ui/components/common/PageHeader";
import { SkeletonRow } from "@ui/components/common/Skeleton";
import { ListErrorState } from "@/components/common/ListErrorState";
import { formatCurrencyCompact, formatDate } from "@ui/lib/format";
import { Search, Plus, ArrowRight, User, MessageSquare, Building2 } from "lucide-react";
import { useLocation, useParams } from "wouter";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import { useToast } from "@ui/hooks/use-toast";
import { AddTenantDrawer } from "@ui/components/owner/AddTenantDrawer";
import { TenantDetailsDrawer } from "@/components/tenant/TenantDetailsDrawer";
import { PricingModal } from "@ui/components/common/PricingModal";
import { useActivePortfolioPlan } from "@/lib/useActivePortfolioPlan";
import { useCanOwnerPlan } from "@ui/lib/usePrivileges";

// List route; the open tenant lives at `${TENANTS_PATH}/:id`.
const TENANTS_PATH = "/tenants";

export default function TenantsPage() {
  const { plan } = useActivePortfolioPlan();
  const canPlan = useCanOwnerPlan(plan);
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "expired" | "pending">("all");
  const [isAddTenantOpen, setIsAddTenantOpen] = useState(false);
  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const {
    data: tenants = [],
    isLoading: tenantsLoading,
    isError: tenantsError,
    refetch: refetchTenants,
  } = useOwnerTenants();
  const { data: properties = [] } = useOwnerProperties();
  const { isSelf } = useActivePortfolio();
  const [, setLocation] = useLocation();
  const settleBalance = useSettleTenantBalance();

  // The open tenant is driven by the URL (`/tenants/:id`) so the command
  // palette and shared links deep-link straight into the details drawer, and
  // the back button closes it. Derive it from the loaded list; a stale id
  // bounces back to the bare list.
  const { id: routeTenantId } = useParams<{ id?: string }>();
  const selectedTenant = useMemo<Tenant | null>(
    () => (routeTenantId ? (tenants.find((t) => t.id === routeTenantId) ?? null) : null),
    [routeTenantId, tenants],
  );
  useEffect(() => {
    // Only bounce a genuinely stale id once the list has loaded *successfully*
    // (keep it in the URL during a fetch error so Retry can re-resolve), and
    // `replace` so the dead id doesn't linger in history.
    if (routeTenantId && !tenantsLoading && !tenantsError && !selectedTenant) {
      setLocation(TENANTS_PATH, { replace: true });
    }
  }, [routeTenantId, tenantsLoading, tenantsError, selectedTenant, setLocation]);
  const { toast } = useToast();
  const handleSettleBalance = (tenancyId: string, amount: number) => {
    if (
      !window.confirm(
        `Mark the outstanding balance of ${formatCurrencyCompact(amount)} as settled?`,
      )
    )
      return;
    settleBalance.mutate(tenancyId, {
      onSuccess: () =>
        toast({ title: "Balance settled", description: "Recorded as collected rent." }),
      onError: (err) =>
        toast({
          title: "Couldn't settle balance",
          description: parseApiError(err, "Please try again."),
          variant: "destructive",
        }),
    });
  };

  // Starts (or fetches the existing) conversation with a tenant and routes
  // the owner to /owner/messages so they can begin typing. Disabled when
  // the tenant hasn't signed up yet (no User.id to address).
  const openConversation = async (tenant: Tenant) => {
    try {
      const res = await apiRequest("POST", "/api/messages/start", { tenancyId: tenant.id });
      const conv = (await res.json()) as { id: string };
      // ?c= tells MessagesPage which thread to open — without it the page
      // auto-selects the most recently active thread, i.e. someone else.
      setLocation(`/owner/messages?c=${encodeURIComponent(conv.id)}`);
    } catch (err) {
      toast({
        title: "Can't open chat",
        description: parseApiError(err, "Failed to open chat"),
        variant: "destructive",
      });
    }
  };

  const isTenantView = properties.length === 0;

  const filteredTenants = tenants.filter((t) => {
    const address = t.propertyAddress ?? "";
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      t.name.toLowerCase().includes(q) ||
      (t.email ?? "").toLowerCase().includes(q) ||
      (t.phone ?? "").toLowerCase().includes(q) ||
      address.toLowerCase().includes(q);
    const matchesFilter =
      filter === "all" ||
      (filter === "pending"
        ? t.status === "pending" || t.status === "invited"
        : t.status === filter);
    return matchesSearch && matchesFilter;
  });

  const handleAddTenantClick = () => {
    if (!canPlan("tenants.invite")) {
      setIsPricingOpen(true);
    } else {
      setIsAddTenantOpen(true);
    }
  };

  const headerActions = isSelf ? (
    <button
      onClick={handleAddTenantClick}
      className="bg-primary text-primary-foreground hover:opacity-90 px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition"
    >
      {isTenantView ? (
        "Own a property?"
      ) : (
        <>
          <Plus size={18} /> Add Agreement
        </>
      )}
    </button>
  ) : null;

  const filterOptions = [
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "expired", label: "Expired" },
    { id: "pending", label: "Pending" },
  ];

  return (
    <>
      {headerActions && <HeaderActions>{headerActions}</HeaderActions>}
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <AddTenantDrawer open={isAddTenantOpen} onOpenChange={setIsAddTenantOpen} />
        <TenantDetailsDrawer
          open={!!selectedTenant}
          onOpenChange={(open) => {
            if (!open) setLocation(TENANTS_PATH, { replace: true });
          }}
          tenant={selectedTenant}
        />
        <PricingModal open={isPricingOpen} onOpenChange={setIsPricingOpen} />

        <PageHeader
          title="Agreements"
          subtitle="Manage your agreements"
          action={
            isTenantView ? (
              <button
                onClick={handleAddTenantClick}
                className="bg-primary text-primary-foreground hover:opacity-90 px-3 py-1.5 rounded-full text-xs font-bold shadow-lg"
              >
                Own a property?
              </button>
            ) : (
              <PageHeaderAction
                onClick={handleAddTenantClick}
                icon={<Plus size={20} />}
                label="Add tenant"
              />
            )
          }
        />

        <TableFiltersCard>
          <TableSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search by name, email, or property…"
          />
          <FilterPills
            options={filterOptions}
            value={filter}
            onChange={(id) => setFilter(id as any)}
          />
        </TableFiltersCard>

        {/* Tenant List */}
        {tenantsError ? (
          <ListErrorState title="We couldn't load your tenants." onRetry={() => refetchTenants()} />
        ) : tenantsLoading ? (
          <div className="bg-card border border-border/60 rounded-2xl divide-y divide-border/40 overflow-hidden">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonRow key={i} lines={2} />
            ))}
          </div>
        ) : tenants.length === 0 ? (
          <div className="bg-card border border-border/60 rounded-2xl flex flex-col items-center justify-center py-16 px-6 text-center">
            <User size={36} className="mb-4 text-muted-foreground opacity-30" />
            <h3 className="text-base font-semibold text-foreground">
              {isTenantView ? "No agreements yet" : "No tenants yet"}
            </h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              {isTenantView
                ? "Once you own a property and add a tenant, agreements will appear here."
                : "Invite a tenant to one of your properties to start managing rent and agreements."}
            </p>
            {!isTenantView && (
              <button
                onClick={handleAddTenantClick}
                className="mt-5 bg-primary text-primary-foreground hover:opacity-90 px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 transition"
              >
                <Plus size={16} /> Add Agreement
              </button>
            )}
          </div>
        ) : filteredTenants.length === 0 ? (
          <div className="bg-card border border-border/60 rounded-2xl flex flex-col items-center justify-center py-12 px-6 text-center">
            <Search size={28} className="mb-3 text-muted-foreground opacity-30" />
            <p className="text-sm font-medium text-foreground">No tenants match your filters</p>
            <p className="text-xs text-muted-foreground mt-1">
              Try a different search or status filter.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredTenants.map((tenant, i) => (
              <div
                key={tenant.id}
                onClick={() => setLocation(`${TENANTS_PATH}/${tenant.id}`)}
                className="bg-card border border-border/60 cursor-pointer hover:border-border hover:shadow-sm transition group relative flex items-center p-4 gap-6 rounded-2xl overflow-hidden"
              >
                {/* Image Section with Overlap */}
                <div className="relative w-20 h-20 flex-shrink-0">
                  {/* Property Image */}
                  <div className="w-full h-full rounded-xl overflow-hidden shadow-sm bg-secondary flex items-center justify-center">
                    {tenant.propertyImage ? (
                      <img
                        src={tenant.propertyImage}
                        alt="Property"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Building2 size={24} className="text-muted-foreground/60" />
                    )}
                  </div>

                  {/* Tenant Avatar - Overlapping Edge — local initials, no third-party CDN */}
                  <div
                    role="img"
                    aria-label={`${tenant.name} avatar`}
                    className="absolute -right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full border-2 border-background shadow-md bg-primary/10 text-primary z-10 flex items-center justify-center text-sm font-semibold"
                  >
                    <span aria-hidden="true">{(tenant.name?.[0] ?? "?").toUpperCase()}</span>
                  </div>
                </div>

                <div className="flex-1 min-w-0 pl-2">
                  <div className="flex justify-between items-start mb-1">
                    <div>
                      <h3 className="font-bold text-foreground text-base truncate pr-2">
                        {tenant.propertyAddress ?? "—"}
                      </h3>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-muted-foreground truncate">
                          {tenant.name}
                        </p>
                        <span className="text-muted-foreground/40">•</span>
                        <span className="text-xs text-muted-foreground capitalize">
                          {tenant.status}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col items-end">
                      <span className="font-bold text-foreground">
                        {formatCurrencyCompact(tenant.rentAmount)}/mo
                      </span>
                      {tenant.status === "active" ? (
                        <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          {tenant.paymentStatus && (
                            <span
                              className={`px-1.5 py-0.5 rounded-full font-semibold ${
                                tenant.paymentStatus === "paid"
                                  ? "bg-success/10 text-success"
                                  : tenant.paymentStatus === "overdue"
                                    ? "bg-destructive/10 text-destructive"
                                    : "bg-warning/10 text-warning"
                              }`}
                            >
                              {tenant.paymentStatus}
                            </span>
                          )}
                          Next: {formatDate(tenant.nextPayment)}
                        </span>
                      ) : tenant.outstandingBalance > 0 ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSettleBalance(tenant.id, tenant.outstandingBalance);
                          }}
                          disabled={settleBalance.isPending}
                          title="Mark the final balance as settled"
                          className="text-[10px] font-semibold text-destructive hover:underline disabled:opacity-50"
                        >
                          Balance due {formatCurrencyCompact(tenant.outstandingBalance)} · Settle
                        </button>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">Review pending</span>
                      )}
                    </div>
                  </div>

                  {/* Status Indicator Bar */}
                  <div className="w-full bg-secondary h-1.5 rounded-full mt-3 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        tenant.status === "active"
                          ? "bg-success w-full"
                          : tenant.status === "expired"
                            ? "bg-destructive w-full"
                            : tenant.status === "invited"
                              ? "bg-warning w-1/3"
                              : "bg-warning w-2/3"
                      }`}
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void openConversation(tenant);
                  }}
                  disabled={!tenant.userId}
                  title={tenant.userId ? "Message tenant" : "Tenant hasn't signed up yet"}
                  className="self-center p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <MessageSquare size={16} />
                </button>

                <div className="hidden md:flex items-center self-center text-muted-foreground/70 group-hover:text-primary transition-colors pl-2">
                  <ArrowRight size={18} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
