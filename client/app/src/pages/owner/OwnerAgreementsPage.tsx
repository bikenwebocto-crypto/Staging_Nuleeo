import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { PageHeader } from "@ui/components/common/PageHeader";
import { useOwnerAgreements, useUpdateAgreement, type OwnerAgreement } from "@/lib/ownerQueries";
import { useActivePortfolio, withOwnerScope } from "@/lib/activePortfolio";
import {
  OwnerAgreementDrawer,
  type AgreementEditValues,
} from "@ui/components/owner/OwnerAgreementDrawer";
import { useConfirm } from "@ui/components/common/ConfirmDialog";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import { uploadAgreementDocument, removeAgreementDocument } from "@ui/lib/uploadAgreementDocument";
import { useToast } from "@ui/hooks/use-toast";
import { formatCurrencyCompact, formatDate } from "@ui/lib/format";
import { Skeleton, SkeletonRow } from "@ui/components/common/Skeleton";
import { ListErrorState } from "@/components/common/ListErrorState";
import {
  TableSortIcon,
  TableFiltersCard,
  TableShellCard,
  FilterPills,
  TableSearchInput,
  TableEmptyState,
} from "@ui/components/ui/data-table";

// Human label + colour for each agreement status the owner can see. Mirrors
// the tenant-side vocabulary (TenantAgreementsPage) so both personas read the
// same words. "draft" never reaches these reads (filtered server-side) but is
// mapped defensively.
const STATUS_META: Record<string, { label: string; className: string }> = {
  pending_tenant: {
    label: "Pending tenant",
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  },
  active: {
    label: "Active",
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  },
  declined: {
    label: "Declined",
    className: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  },
  expired: {
    label: "Expired",
    className: "bg-muted text-muted-foreground border-border",
  },
  terminated: {
    label: "Terminated",
    className: "bg-muted text-muted-foreground border-border",
  },
  draft: {
    label: "Draft",
    className: "bg-muted text-muted-foreground border-border",
  },
};

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? {
    label: status,
    className: "bg-muted text-muted-foreground border-border",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

// List route; the open agreement lives at `${AGREEMENTS_PATH}/:id`.
const AGREEMENTS_PATH = "/owner/agreements";

export default function OwnerAgreementsPage() {
  const [activeFilter, setActiveFilter] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");

  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const {
    data: agreements = [],
    isLoading: agreementsLoading,
    isError: agreementsError,
    refetch: refetchAgreements,
  } = useOwnerAgreements();

  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  const [, setLocation] = useLocation();

  // The open agreement is driven by the URL (`/owner/agreements/:id`) so the
  // command palette and shared links deep-link straight into the drawer, and
  // the back button closes it. Derive it from the loaded list; a stale id
  // (deleted/foreign agreement) bounces back to the bare list.
  const { id: routeAgreementId } = useParams<{ id?: string }>();
  const selectedAgreement = useMemo<OwnerAgreement | null>(
    () => (routeAgreementId ? (agreements.find((a) => a.id === routeAgreementId) ?? null) : null),
    [routeAgreementId, agreements],
  );
  useEffect(() => {
    // Only bounce a genuinely stale/foreign id once the list has loaded
    // *successfully* — on a fetch error keep the id in the URL so the list's
    // Retry can still re-resolve the drawer. `replace` so the dead id doesn't
    // linger in history and re-trigger on Back.
    if (routeAgreementId && !agreementsLoading && !agreementsError && !selectedAgreement) {
      setLocation(AGREEMENTS_PATH, { replace: true });
    }
  }, [routeAgreementId, agreementsLoading, agreementsError, selectedAgreement, setLocation]);
  const { toast } = useToast();
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const updateAgreement = useUpdateAgreement();

  // Open (or resume) the conversation with this agreement's tenant. The button
  // is pre-disabled when the tenant hasn't signed up (canMessage, from
  // tenantUserId); the server still validates and we toast as a fallback.
  const handleMessage = async () => {
    if (!selectedAgreement) return;
    try {
      const res = await apiRequest("POST", "/api/messages/start", {
        tenancyId: selectedAgreement.tenantId,
      });
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

  // End the tenancy behind this agreement. Mirrors TenantDetailsDrawer:
  // confirm first (irreversible here), then invalidate every cache the
  // move-out touches.
  const handleEndTenancy = async () => {
    if (!selectedAgreement) return;
    const name = selectedAgreement.tenantName || "this tenant";
    const ok = await confirm({
      title: `End tenancy for ${name}?`,
      description:
        "This marks them as expired and terminates the active agreement. We'll notify them if they have notifications on. This can't be undone here.",
      confirmLabel: "End tenancy",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await apiRequest("POST", `/api/owner/tenants/${selectedAgreement.tenantId}/end`);
      // Scope the invalidations to the active portfolio so a granted editor's
      // (`?ownerId=…`) lists refetch too — mirrors useUpdateAgreement. For self
      // these resolve to the same bare keys.
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/agreements", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/tenants", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/properties", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/summary", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      toast({ title: "Tenancy ended", description: name });
      setLocation(AGREEMENTS_PATH, { replace: true });
    } catch (err) {
      toast({
        title: "Couldn't end tenancy",
        description: parseApiError(err, "Failed to end tenancy"),
        variant: "destructive",
      });
    }
  };

  // Persist edited terms. The drawer reads `selectedAgreement` derived from the
  // agreements list, so the mutation's cache invalidation refetches and the open
  // drawer reflects the new terms automatically — no local patch needed. Re-throw
  // on failure so the modal keeps the user in edit mode to retry.
  const handleSave = async (values: AgreementEditValues) => {
    if (!selectedAgreement) return;
    try {
      await updateAgreement.mutateAsync({ id: selectedAgreement.id, ...values });
      toast({ title: "Agreement updated" });
    } catch (err) {
      toast({
        title: "Couldn't update agreement",
        description: parseApiError(err, "Failed to update agreement"),
        variant: "destructive",
      });
      throw err;
    }
  };

  // Upload (or replace) the signed/physical lease PDF for the open agreement,
  // then await the agreements refetch so the drawer — driven by selectedAgreement
  // derived from the list — shows the new attachment when its busy state clears.
  // Re-throw so the drawer stays in its busy state's catch (it shows no success
  // toast on failure; the toast here reports the error).
  const handleUploadDocument = async (file: File) => {
    if (!selectedAgreement) return;
    try {
      await uploadAgreementDocument(file, selectedAgreement.id);
      await qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/agreements", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: parseApiError(err, "Failed to upload the signed lease"),
        variant: "destructive",
      });
      throw err;
    }
  };

  const handleRemoveDocument = async () => {
    if (!selectedAgreement) return;
    try {
      await removeAgreementDocument(selectedAgreement.id);
      await qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/agreements", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
    } catch (err) {
      toast({
        title: "Couldn't remove the signed lease",
        description: parseApiError(err, "Failed to remove the signed lease"),
        variant: "destructive",
      });
      throw err;
    }
  };

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const filterOptions = [
    { id: "All", label: "All" },
    { id: "Pending", label: "Pending" },
    { id: "Active", label: "Active" },
    { id: "Expiring Soon", label: "Expiring Soon" },
    { id: "Expired", label: "Expired" },
  ];

  const filteredAgreements = agreements.filter((agreement) => {
    const matchesStatus = (() => {
      // Leases the tenant hasn't responded to yet (awaiting Approve/Decline).
      if (activeFilter === "Pending") return agreement.status === "pending_tenant";
      if (activeFilter === "Active") return agreement.status === "active";
      if (activeFilter === "Expiring Soon") {
        const exp = agreement.endDate ? new Date(agreement.endDate) : null;
        const now = new Date();
        const soon = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
        return agreement.status === "active" && !!exp && exp < soon;
      }
      if (activeFilter === "Expired") return agreement.status === "expired";
      return true;
    })();
    if (!matchesStatus) return false;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const hay =
      `${agreement.tenantName ?? ""} ${agreement.tenantEmail ?? ""} ${agreement.tenantPhone ?? ""} ${agreement.address ?? ""}`.toLowerCase();
    return hay.includes(q);
  });

  const sortedAgreements = [...filteredAgreements].sort((a, b) => {
    if (!sortKey) return 0;
    const dir = sortDir === "asc" ? 1 : -1;
    const valA = (a as any)[sortKey];
    const valB = (b as any)[sortKey];
    if (typeof valA === "number" && typeof valB === "number") return (valA - valB) * dir;
    // ONLY date columns sort chronologically — otherwise "2026-1-5" would sort
    // after "2026-10-1". Gated by key: Date.parse would otherwise lenient-parse
    // addresses ("Flat 5", "Apt 12") as dates and scramble the Property column.
    if (sortKey === "endDate" || sortKey === "startDate" || sortKey === "createdAt") {
      const dA = Date.parse(valA);
      const dB = Date.parse(valB);
      if (!Number.isNaN(dA) && !Number.isNaN(dB)) return (dA - dB) * dir;
    }
    return String(valA).localeCompare(String(valB)) * dir;
  });

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <PageHeader title="Agreements" subtitle="Monitor your rental agreements" />

      <TableFiltersCard>
        <TableSearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search by tenant, email, phone, or property…"
        />
        <FilterPills options={filterOptions} value={activeFilter} onChange={setActiveFilter} />
      </TableFiltersCard>

      {agreementsError ? (
        <ListErrorState
          title="We couldn't load your agreements."
          onRetry={() => refetchAgreements()}
        />
      ) : agreementsLoading ? (
        <>
          {/* Mobile: card skeletons */}
          <div className="md:hidden space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-card border border-border rounded-2xl">
                <SkeletonRow lines={2} />
              </div>
            ))}
          </div>
          {/* Desktop: table skeleton */}
          <TableShellCard className="hidden md:block">
            <div className="divide-y divide-border">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="px-6 py-4">
                  <Skeleton className="h-4 w-full" />
                </div>
              ))}
            </div>
          </TableShellCard>
        </>
      ) : (
        <>
          {/* Mobile: card list */}
          <div className="md:hidden space-y-2">
            {sortedAgreements.map((agreement) => (
              // role=button (not a <button>) so the tel:/mailto: contact links can nest
              // validly — interactive anchors can't live inside a <button>.
              <div
                key={agreement.id}
                role="button"
                tabIndex={0}
                onClick={() => setLocation(`${AGREEMENTS_PATH}/${agreement.id}`)}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    setLocation(`${AGREEMENTS_PATH}/${agreement.id}`);
                  }
                }}
                className="w-full text-left bg-card border border-border rounded-2xl p-4 hover:border-foreground/20 active:bg-muted/50 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-9 h-9 rounded-full bg-secondary border border-border/40 flex items-center justify-center text-sm font-semibold text-muted-foreground flex-shrink-0">
                    {agreement.tenantName?.charAt(0).toUpperCase() ?? "?"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-foreground truncate">
                      {agreement.tenantName}
                    </div>
                    {/* Skip the email line when it's already the display name (no real
             name on file), so the email isn't shown twice. */}
                    {agreement.tenantEmail && agreement.tenantEmail !== agreement.tenantName && (
                      <a
                        href={`mailto:${agreement.tenantEmail}`}
                        onClick={(e) => e.stopPropagation()}
                        className="block text-xs text-muted-foreground hover:text-foreground hover:underline truncate"
                      >
                        {agreement.tenantEmail}
                      </a>
                    )}
                    {agreement.tenantPhone && (
                      <a
                        href={`tel:${agreement.tenantPhone}`}
                        onClick={(e) => e.stopPropagation()}
                        className="block text-xs text-muted-foreground hover:text-foreground hover:underline truncate"
                      >
                        {agreement.tenantPhone}
                      </a>
                    )}
                  </div>
                </div>
                <div className="text-sm text-foreground/80 truncate mb-2">{agreement.address}</div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <StatusBadge status={agreement.status} />
                  <span className="font-medium text-foreground text-sm">
                    {agreement.agreementValue
                      ? formatCurrencyCompact(agreement.agreementValue)
                      : "—"}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {agreement.endDate ? `Ends ${formatDate(agreement.endDate)}` : "No expiry"}
                </div>
              </div>
            ))}
          </div>

          {/* Desktop: table */}
          <TableShellCard className="hidden md:block">
            <div className="overflow-x-auto -mx-6 md:mx-0">
              <div className="inline-block min-w-full align-middle px-6 md:px-0">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead className="bg-muted border-b border-border">
                    <tr>
                      <th className="p-0 font-semibold text-foreground select-none">
                        <button
                          type="button"
                          onClick={() => handleSort("tenantName")}
                          className="flex w-full items-center gap-1.5 px-6 py-4 font-semibold cursor-pointer hover:bg-secondary/50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset"
                        >
                          Tenant{" "}
                          <TableSortIcon column="tenantName" sortKey={sortKey} sortDir={sortDir} />
                        </button>
                      </th>
                      <th className="p-0 font-semibold text-foreground select-none">
                        <button
                          type="button"
                          onClick={() => handleSort("status")}
                          className="flex w-full items-center gap-1.5 px-6 py-4 font-semibold cursor-pointer hover:bg-secondary/50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset"
                        >
                          Status{" "}
                          <TableSortIcon column="status" sortKey={sortKey} sortDir={sortDir} />
                        </button>
                      </th>
                      <th className="p-0 font-semibold text-foreground select-none">
                        <button
                          type="button"
                          onClick={() => handleSort("address")}
                          className="flex w-full items-center gap-1.5 px-6 py-4 font-semibold cursor-pointer hover:bg-secondary/50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset"
                        >
                          Property{" "}
                          <TableSortIcon column="address" sortKey={sortKey} sortDir={sortDir} />
                        </button>
                      </th>
                      <th className="p-0 font-semibold text-foreground select-none">
                        <button
                          type="button"
                          onClick={() => handleSort("agreementValue")}
                          className="flex w-full items-center gap-1.5 px-6 py-4 font-semibold cursor-pointer hover:bg-secondary/50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset"
                        >
                          Agreement Value{" "}
                          <TableSortIcon
                            column="agreementValue"
                            sortKey={sortKey}
                            sortDir={sortDir}
                          />
                        </button>
                      </th>
                      <th className="p-0 font-semibold text-foreground select-none">
                        <button
                          type="button"
                          onClick={() => handleSort("endDate")}
                          className="flex w-full items-center gap-1.5 px-6 py-4 font-semibold cursor-pointer hover:bg-secondary/50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset"
                        >
                          Expiration{" "}
                          <TableSortIcon column="endDate" sortKey={sortKey} sortDir={sortDir} />
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sortedAgreements.map((agreement) => (
                      <tr
                        key={agreement.id}
                        className="hover:bg-muted/50 transition cursor-pointer"
                        onClick={() => setLocation(`${AGREEMENTS_PATH}/${agreement.id}`)}
                      >
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-secondary overflow-hidden border border-border/40 flex-shrink-0 flex items-center justify-center text-xs font-semibold text-muted-foreground">
                              {agreement.tenantName?.charAt(0).toUpperCase() ?? "?"}
                            </div>
                            <div>
                              <div className="font-medium text-foreground">
                                {agreement.tenantName}
                              </div>
                              {/* Skip the email line when it's already the display name (no real name
     on file), so the email isn't shown twice. */}
                              {agreement.tenantEmail &&
                                agreement.tenantEmail !== agreement.tenantName && (
                                  <a
                                    href={`mailto:${agreement.tenantEmail}`}
                                    onClick={(e) => e.stopPropagation()}
                                    className="block text-xs text-muted-foreground hover:text-foreground hover:underline"
                                  >
                                    {agreement.tenantEmail}
                                  </a>
                                )}
                              {agreement.tenantPhone && (
                                <a
                                  href={`tel:${agreement.tenantPhone}`}
                                  onClick={(e) => e.stopPropagation()}
                                  className="block text-xs text-muted-foreground hover:text-foreground hover:underline"
                                >
                                  {agreement.tenantPhone}
                                </a>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <StatusBadge status={agreement.status} />
                        </td>
                        <td className="px-6 py-4 text-muted-foreground">{agreement.address}</td>
                        <td className="px-6 py-4 font-medium text-foreground">
                          {agreement.agreementValue
                            ? formatCurrencyCompact(agreement.agreementValue)
                            : "-"}
                        </td>
                        <td className="px-6 py-4 text-muted-foreground">
                          {agreement.endDate ? formatDate(agreement.endDate) : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </TableShellCard>

          {sortedAgreements.length === 0 && (
            <TableEmptyState
              title={
                agreements.length === 0 ? "No agreements yet" : "No agreements match your filters"
              }
              description={
                agreements.length === 0
                  ? "Leases you create appear here — pending until the tenant approves, then active."
                  : "Try a different search or filter."
              }
            />
          )}
        </>
      )}

      <OwnerAgreementDrawer
        isOpen={!!selectedAgreement}
        // Close = replace (open via row click was a push) so dismissing the drawer
        // and pressing Back doesn't re-open it.
        onClose={() => setLocation(AGREEMENTS_PATH, { replace: true })}
        agreement={selectedAgreement}
        // Owner actions only on your own portfolio — granted contacts read but
        // can't mutate (mirrors the server's owner-self mutation rule).
        owner={
          isSelf
            ? {
                onMessage: handleMessage,
                // No chattable counterpart until the tenant accepts their invite.
                canMessage: !!selectedAgreement?.tenantUserId,
                onEndTenancy: handleEndTenancy,
                onSave: handleSave,
                onUploadDocument: handleUploadDocument,
                onRemoveDocument: handleRemoveDocument,
              }
            : undefined
        }
      />
      {confirmDialog}
    </div>
  );
}
