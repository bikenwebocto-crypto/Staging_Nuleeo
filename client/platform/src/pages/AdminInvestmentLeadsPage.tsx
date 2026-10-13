import { useMemo, useState } from "react";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import { Search, Briefcase, Mail, Home, MapPin } from "lucide-react";
import { useToast } from "@ui/hooks/use-toast";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { ForbiddenView } from "@ui/components/ForbiddenView";
import {
  AdminListLoading,
  AdminListError,
  sortableThProps,
} from "@/components/common/AdminListStates";
import { formatCurrencyCompact, formatDate } from "@ui/lib/format";
import {
  TableSortIcon,
  TableFiltersCard,
  TableShellCard,
  FilterPills,
  TableEmptyState,
} from "@ui/components/ui/data-table";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { StatusPill, type StatusIntent } from "@ui/components/common/StatusPill";
import { Avatar } from "@ui/components/common/Avatar";
import {
  useAdminSuggestionRequests,
  useUpdateSuggestionRequest,
  useAdminMarketplaceLeads,
  useUpdateMarketplaceLead,
  type AdminSuggestionRequestRow,
  type AdminMarketplaceLeadRow,
} from "@/lib/adminQueries";

type LeadStatus = "new" | "contacted" | "closed";

const statusIntent: Record<LeadStatus, StatusIntent> = {
  new: "info",
  contacted: "warning",
  closed: "neutral",
};

const statusDot: Record<LeadStatus, string> = {
  new: "bg-blue-500",
  contacted: "bg-amber-500",
  closed: "bg-muted-foreground/50",
};

const statusLabel: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  closed: "Closed",
};

// Unified row used by the table. The two source collections have different
// shapes (general search vs per-listing interest), so we widen here once and
// branch on `kind` for columns that differ.
type UnifiedLead =
  | ({ kind: "suggestion" } & AdminSuggestionRequestRow)
  | ({ kind: "marketplace" } & AdminMarketplaceLeadRow);

function leadSubject(lead: UnifiedLead): string {
  return lead.kind === "marketplace" ? lead.listingTitle : lead.location || "—";
}

function leadAmount(lead: UnifiedLead): number | null {
  return lead.kind === "marketplace" ? lead.listingPrice : lead.budget;
}

function formatAmount(value: number | null): string {
  return typeof value === "number" ? formatCurrencyCompact(value) : "—";
}

export default function AdminInvestmentLeadsPage() {
  const { canPlatform } = usePrivileges();
  const {
    data: suggestions = [],
    isLoading: suggestionsLoading,
    isError: suggestionsError,
    refetch: refetchSuggestions,
  } = useAdminSuggestionRequests();
  const {
    data: marketplaceLeads = [],
    isLoading: marketplaceLoading,
    isError: marketplaceError,
    refetch: refetchMarketplace,
  } = useAdminMarketplaceLeads();
  const updateSuggestion = useUpdateSuggestionRequest();
  const updateMarketplace = useUpdateMarketplaceLead();
  const { toast } = useToast();

  const isLoading = suggestionsLoading || marketplaceLoading;
  const isError = suggestionsError || marketplaceError;
  const refetch = () => {
    refetchSuggestions();
    refetchMarketplace();
  };

  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState("All");
  const [selected, setSelected] = useState<UnifiedLead | null>(null);
  const [sortKey, setSortKey] = useState<string | null>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const unified = useMemo<UnifiedLead[]>(() => {
    return [
      ...suggestions.map((s): UnifiedLead => ({ kind: "suggestion", ...s })),
      ...marketplaceLeads.map((m): UnifiedLead => ({ kind: "marketplace", ...m })),
    ];
  }, [suggestions, marketplaceLeads]);

  const filtered = unified.filter((l) => {
    const q = searchQuery.toLowerCase();
    const haystack = [
      l.userName,
      l.userEmail,
      l.kind === "suggestion" ? l.location : l.listingTitle,
      l.kind === "marketplace" ? l.listingLocation : "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchesSearch = haystack.includes(q);

    let matchesFilter = true;
    if (activeFilter === "New") matchesFilter = l.status === "new";
    else if (activeFilter === "Contacted") matchesFilter = l.status === "contacted";
    else if (activeFilter === "Closed") matchesFilter = l.status === "closed";
    else if (activeFilter === "Specific listing") matchesFilter = l.kind === "marketplace";
    else if (activeFilter === "General search") matchesFilter = l.kind === "suggestion";
    else if (activeFilter === "Apartment")
      matchesFilter = l.kind === "suggestion" && l.propertyType === "Apartment";
    else if (activeFilter === "House")
      matchesFilter = l.kind === "suggestion" && l.propertyType === "House";
    else if (activeFilter === "Building")
      matchesFilter = l.kind === "suggestion" && l.propertyType === "Building";
    else if (activeFilter === "Commercial")
      matchesFilter = l.kind === "suggestion" && l.propertyType === "Commercial";
    else if (activeFilter === "Plot")
      matchesFilter = l.kind === "suggestion" && l.propertyType === "Plot";
    return matchesSearch && matchesFilter;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (!sortKey) return 0;
    const dir = sortDir === "asc" ? 1 : -1;
    let valA: unknown;
    let valB: unknown;
    if (sortKey === "subject") {
      valA = leadSubject(a);
      valB = leadSubject(b);
    } else if (sortKey === "amount") {
      valA = leadAmount(a);
      valB = leadAmount(b);
    } else {
      valA = (a as unknown as Record<string, unknown>)[sortKey];
      valB = (b as unknown as Record<string, unknown>)[sortKey];
    }
    if (valA == null && valB == null) return 0;
    if (valA == null) return 1;
    if (valB == null) return -1;
    if (typeof valA === "number" && typeof valB === "number") return (valA - valB) * dir;
    return String(valA).localeCompare(String(valB)) * dir;
  });

  const handleStatusChange = (lead: UnifiedLead, status: LeadStatus) => {
    const onSuccess = (updated: { status: LeadStatus }) => {
      toast({
        title: "Status updated",
        description: `Marked as ${statusLabel[status]}.`,
      });
      if (selected?.id === lead.id) {
        setSelected({ ...selected, status: updated.status } as UnifiedLead);
      }
    };
    const onError = (err: unknown) =>
      toast({
        title: "Update failed",
        description: err instanceof Error ? err.message : "Try again.",
        variant: "destructive",
      });

    if (lead.kind === "marketplace") {
      updateMarketplace.mutate({ id: lead.id, status }, { onSuccess, onError });
    } else {
      updateSuggestion.mutate({ id: lead.id, status }, { onSuccess, onError });
    }
  };

  // comm.activityLog (not comm.partners): this page shows cross-user lead PII
  // and BOTH its data sources (GET /api/admin/suggestion-requests + GET
  // /api/admin/marketplace-leads) are server-gated on comm.activityLog. Gating
  // the UI on comm.partners diverged from that — a comm.partners-only role saw
  // an empty 403 page, and the new lead-notification bell (also comm.activityLog)
  // could deep-link comm.activityLog roles to a "locked" screen.
  if (!canPlatform("comm.activityLog")) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <ForbiddenView
          title="Marketplace leads locked"
          message="Your platform role doesn't include the 'Manage partner listings' privilege. An admin can grant it in Settings → Platform Roles."
        />
      </div>
    );
  }

  const subjectLine = (lead: UnifiedLead) =>
    lead.kind === "marketplace"
      ? `${lead.listingTitle} · ${lead.listingLocation}`
      : `${lead.location || "—"} · ${lead.propertyType}`;

  const mailtoFor = (lead: UnifiedLead) => {
    const subject =
      lead.kind === "marketplace"
        ? `Olio — ${lead.listingTitle}`
        : `Olio — Investment suggestions for ${lead.location}`;
    return `mailto:${lead.userEmail}?subject=${encodeURIComponent(subject)}`;
  };

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-8 md:mb-2 mt-4 md:mt-0">
        <div className="md:hidden">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Marketplace Leads</h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Owners interested in a listing or asking for suggestions
          </p>
        </div>
      </div>

      <TableFiltersCard>
        <div className="flex flex-col md:flex-row gap-4 items-center">
          <div className="relative flex-1 w-full">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              size={18}
            />
            <input
              type="text"
              placeholder="Search by name, email, listing, location..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-muted border-none rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
            />
          </div>
        </div>
        <FilterPills
          options={[
            "All",
            "New",
            "Contacted",
            "Closed",
            "Specific listing",
            "General search",
            "Apartment",
            "House",
            "Building",
            "Commercial",
            "Plot",
          ].map((t) => ({ id: t, label: t }))}
          value={activeFilter}
          onChange={setActiveFilter}
        />
      </TableFiltersCard>

      {isError ? (
        <AdminListError onRetry={refetch} message="We couldn't load investment leads." />
      ) : isLoading ? (
        <AdminListLoading />
      ) : (
        <>
          {/* Mobile: card list */}
          <div className="md:hidden space-y-2">
            {sorted.map((lead) => (
              <button
                key={`${lead.kind}-${lead.id}`}
                type="button"
                onClick={() => setSelected(lead)}
                className="w-full text-left bg-card border border-border rounded-2xl p-4 hover:border-foreground/20 active:bg-muted/50 transition"
              >
                <div className="flex items-center gap-3 mb-2">
                  <Avatar
                    src={lead.userImage}
                    name={lead.userName}
                    email={lead.userEmail}
                    shape="squircle"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-foreground truncate">
                      {lead.userName || "(no name)"}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{lead.userEmail}</div>
                  </div>
                  <StatusPill intent={statusIntent[lead.status]} size="sm">
                    <span className={`w-1.5 h-1.5 rounded-full ${statusDot[lead.status]}`} />
                    {statusLabel[lead.status]}
                  </StatusPill>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  {lead.kind === "marketplace" ? (
                    <Home size={12} className="shrink-0" />
                  ) : (
                    <MapPin size={12} className="shrink-0" />
                  )}
                  <span className="truncate">{subjectLine(lead)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">
                    Submitted {formatDate(lead.createdAt)}
                  </span>
                  <span className="text-xs font-medium text-foreground">
                    {formatAmount(leadAmount(lead))}
                  </span>
                </div>
              </button>
            ))}
          </div>

          {/* Desktop: table */}
          <TableShellCard className="hidden md:block">
            <div className="overflow-x-auto -mx-6 md:mx-0">
              <div className="inline-block min-w-full align-middle px-6 md:px-0">
                <table className="w-full text-sm text-left">
                  <thead className="bg-muted border-b border-border">
                    <tr>
                      <th
                        className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                        {...sortableThProps(handleSort, "userName")}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          Owner{" "}
                          <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="userName" />
                        </span>
                      </th>
                      <th className="px-6 py-4 font-semibold text-foreground">Kind</th>
                      <th
                        className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                        {...sortableThProps(handleSort, "subject")}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          Subject{" "}
                          <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="subject" />
                        </span>
                      </th>
                      <th
                        className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                        {...sortableThProps(handleSort, "amount")}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          Price / Budget{" "}
                          <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="amount" />
                        </span>
                      </th>
                      <th
                        className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                        {...sortableThProps(handleSort, "createdAt")}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          Submitted{" "}
                          <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="createdAt" />
                        </span>
                      </th>
                      <th
                        className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                        {...sortableThProps(handleSort, "status")}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          Status{" "}
                          <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="status" />
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sorted.map((lead) => (
                      <tr
                        key={`${lead.kind}-${lead.id}`}
                        className="hover:bg-muted/50 transition cursor-pointer"
                        onClick={() => setSelected(lead)}
                      >
                        <td className="px-6 py-4 font-medium text-foreground">
                          <div className="flex items-center gap-3">
                            <Avatar
                              src={lead.userImage}
                              name={lead.userName}
                              email={lead.userEmail}
                              shape="squircle"
                              size="sm"
                            />
                            <div className="min-w-0">
                              <div className="truncate">{lead.userName || "(no name)"}</div>
                              <div className="text-xs text-muted-foreground truncate">
                                {lead.userEmail}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold ${
                              lead.kind === "marketplace"
                                ? "bg-primary/10 text-primary"
                                : "bg-secondary text-muted-foreground"
                            }`}
                          >
                            {lead.kind === "marketplace" ? (
                              <>
                                <Home size={11} /> Specific listing
                              </>
                            ) : (
                              <>
                                <MapPin size={11} /> General search
                              </>
                            )}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-muted-foreground max-w-[280px] truncate">
                          {subjectLine(lead)}
                        </td>
                        <td className="px-6 py-4 text-muted-foreground whitespace-nowrap">
                          {formatAmount(leadAmount(lead))}
                        </td>
                        <td className="px-6 py-4 text-muted-foreground whitespace-nowrap">
                          {formatDate(lead.createdAt)}
                        </td>
                        <td className="px-6 py-4">
                          <StatusPill intent={statusIntent[lead.status]}>
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${statusDot[lead.status]}`}
                            />
                            {statusLabel[lead.status]}
                          </StatusPill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="border-t border-border px-6 py-4 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Showing {filtered.length} of {unified.length} leads
              </span>
              <div className="flex gap-2">
                <button
                  className="px-3 py-1 bg-muted rounded hover:bg-secondary transition disabled:opacity-50"
                  disabled
                >
                  Previous
                </button>
                <button
                  className="px-3 py-1 bg-muted rounded hover:bg-secondary transition disabled:opacity-50"
                  disabled
                >
                  Next
                </button>
              </div>
            </div>
          </TableShellCard>

          {filtered.length === 0 && (
            <TableEmptyState
              icon={<Briefcase size={24} className="opacity-50" />}
              title={
                unified.length === 0 ? "No marketplace leads yet" : "No leads match your filters"
              }
              description={
                unified.length === 0
                  ? "Owners clicking 'I'm interested' on a listing — or submitting the 'Find me a property' form — will show up here."
                  : "Try adjusting your filters."
              }
            />
          )}
        </>
      )}

      <ResponsiveDrawer
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title="Lead Details"
        footer={
          selected && (
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setSelected(null)}
                className="px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary rounded-lg transition"
              >
                Close
              </button>
              <a
                href={mailtoFor(selected)}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg transition shadow-sm"
              >
                <Mail size={14} />
                Email owner
              </a>
            </div>
          )
        }
      >
        {selected && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Avatar
                src={selected.userImage}
                name={selected.userName}
                email={selected.userEmail}
                shape="squircle"
                className="w-12 h-12"
              />
              <div className="min-w-0">
                <p className="font-semibold text-foreground truncate">
                  {selected.userName || "(no name)"}
                </p>
                <a
                  href={`mailto:${selected.userEmail}`}
                  className="text-sm text-muted-foreground hover:text-foreground truncate block"
                >
                  {selected.userEmail}
                </a>
              </div>
            </div>

            {selected.kind === "marketplace" ? (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      Listing
                    </label>
                    <p className="text-sm text-foreground font-medium">{selected.listingTitle}</p>
                    <p className="text-xs text-muted-foreground">{selected.listingLocation}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      Listing price
                    </label>
                    <p className="text-sm text-foreground">{formatAmount(selected.listingPrice)}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      Submitted
                    </label>
                    <p className="text-sm text-foreground">{formatDate(selected.createdAt)}</p>
                  </div>
                </div>
                {selected.message && (
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      Note from owner
                    </label>
                    <p className="text-sm text-foreground whitespace-pre-wrap bg-muted rounded-lg p-3">
                      {selected.message}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Preferred Location
                  </label>
                  <p className="text-sm text-foreground">{selected.location || "—"}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Budget
                  </label>
                  <p className="text-sm text-foreground">{formatAmount(selected.budget)}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Property Type
                  </label>
                  <p className="text-sm text-foreground">{selected.propertyType}</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Submitted
                  </label>
                  <p className="text-sm text-foreground">{formatDate(selected.createdAt)}</p>
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Status</label>
              <select
                value={selected.status}
                onChange={(e) => handleStatusChange(selected, e.target.value as LeadStatus)}
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="new">New</option>
                <option value="contacted">Contacted</option>
                <option value="closed">Closed</option>
              </select>
            </div>
          </div>
        )}
      </ResponsiveDrawer>
    </div>
  );
}
