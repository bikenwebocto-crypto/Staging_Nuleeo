import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import {
  Search,
  MoreHorizontal,
  Filter,
  FileText,
  Download,
  Printer,
  FileSignature,
} from "lucide-react";
import {
  TableSortIcon,
  TableFiltersCard,
  TableShellCard,
  FilterPills,
  TableEmptyState,
} from "@ui/components/ui/data-table";
import { useState, useRef, useEffect } from "react";
import { useAdminAgreements } from "@/lib/adminQueries";
import { AgreementModal } from "@ui/components/admin/AgreementModal";
import { Avatar } from "@ui/components/common/Avatar";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { ForbiddenView } from "@ui/components/ForbiddenView";
import {
  AdminListLoading,
  AdminListError,
  sortableThProps,
} from "@/components/common/AdminListStates";
import { formatCurrencyCompact } from "@ui/lib/format";

export default function AdminAgreementsPage() {
  const { canPlatform } = usePrivileges();
  // Contract monetary value is financial detail. Legal-only admins (e.g.
  // paralegals with legal.viewAll but not finance) still see the
  // agreement list but the value column is masked.
  const canSeeFinancials = canPlatform("finance.viewAll");
  const fmtMoney = (n: number) => (canSeeFinancials ? formatCurrencyCompact(n) : "—");
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState("All");
  const [openActionId, setOpenActionId] = useState<string | null>(null);
  const [selectedAgreement, setSelectedAgreement] = useState<any>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (actionMenuRef.current && !actionMenuRef.current.contains(e.target as Node)) {
        setOpenActionId(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const { data: agreements = [], isLoading, isError, refetch } = useAdminAgreements();

  const filteredAgreements = agreements.filter((row) => {
    const matchesSearch =
      row.tenantName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      row.propertyAddress.toLowerCase().includes(searchTerm.toLowerCase());
    let matchesFilter = true;
    if (activeFilter === "Active") {
      // "Active" means the lease STATUS is active — not merely "end date in the
      // future" (which let pending/declined/terminated leases through).
      matchesFilter = row.status === "active";
    } else if (activeFilter === "Expiring Soon") {
      const exp = row.expiration ? new Date(row.expiration) : null;
      const now = new Date();
      const soon = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      // Only active leases can be "expiring soon".
      matchesFilter = row.status === "active" && !!exp && exp > now && exp <= soon;
    } else if (activeFilter === "Expired") {
      const exp = row.expiration ? new Date(row.expiration) : null;
      matchesFilter = exp ? exp <= new Date() : false;
    }
    return matchesSearch && matchesFilter;
  });

  const sortedTenants = [...filteredAgreements].sort((a, b) => {
    if (!sortKey) return 0;
    const dir = sortDir === "asc" ? 1 : -1;
    const valA = (a as any)[sortKey];
    const valB = (b as any)[sortKey];
    if (typeof valA === "number" && typeof valB === "number") return (valA - valB) * dir;
    return String(valA).localeCompare(String(valB)) * dir;
  });

  if (!canPlatform("legal.viewAll")) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <ForbiddenView
          title="Agreements locked"
          message="Your platform role doesn't include the 'View all agreements' privilege. An admin can grant it in Settings → Platform Roles."
        />
      </div>
    );
  }

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-8 md:mb-2 mt-4 md:mt-0">
        <div className="md:hidden">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Agreements</h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Monitor all rental agreements
          </p>
        </div>
      </div>

      {/* Filters & Search */}
      <TableFiltersCard>
        <div className="flex flex-col md:flex-row gap-4 items-center">
          <div className="relative flex-1 w-full">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              placeholder="Search agreements..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-muted border-none rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
            />
          </div>
        </div>
        <FilterPills
          options={["All", "Active", "Expiring Soon", "Expired"].map((t) => ({ id: t, label: t }))}
          value={activeFilter}
          onChange={setActiveFilter}
        />
      </TableFiltersCard>

      {isError ? (
        <AdminListError onRetry={() => refetch()} message="We couldn't load agreements." />
      ) : isLoading ? (
        <AdminListLoading />
      ) : (
        <>
          {/* Mobile: card list (table doesn't fit on phones). */}
          <div className="md:hidden space-y-2">
            {sortedTenants.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() =>
                  setSelectedAgreement({
                    ...row,
                    name: row.tenantName,
                    email: row.tenantEmail,
                    image: row.tenantImage ?? "",
                    owner: row.ownerName,
                    status: row.status,
                  })
                }
                className="w-full text-left bg-card border border-border rounded-2xl p-4 hover:border-foreground/20 active:bg-muted/50 transition"
              >
                <div className="flex items-center gap-3 mb-3">
                  <Avatar
                    src={row.tenantImage}
                    name={row.tenantName}
                    email={row.tenantEmail}
                    size="sm"
                    className="w-9 h-9 border-border/40"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-foreground truncate">{row.tenantName}</div>
                    <div className="text-xs text-muted-foreground truncate">{row.tenantEmail}</div>
                  </div>
                </div>
                <div className="text-sm text-foreground/80 truncate mb-2">
                  {row.propertyAddress}
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{row.ownerName || "—"}</span>
                  <span className="font-medium text-foreground">
                    {row.agreementValue ? fmtMoney(row.agreementValue) : "—"}
                  </span>
                </div>
                {row.expiration && (
                  <div className="text-[11px] text-muted-foreground mt-1">
                    Expires {row.expiration}
                  </div>
                )}
              </button>
            ))}
          </div>

          {/* Desktop: table view */}
          <TableShellCard className="hidden md:block">
            <div className="overflow-x-auto -mx-6 md:mx-0">
              <div className="inline-block min-w-full align-middle px-6 md:px-0">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead className="bg-muted border-b border-border">
                    <tr>
                      <th
                        className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                        {...sortableThProps(handleSort, "name")}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          Tenant <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="name" />
                        </span>
                      </th>
                      <th
                        className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                        {...sortableThProps(handleSort, "owner")}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          Owner <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="owner" />
                        </span>
                      </th>
                      <th
                        className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                        {...sortableThProps(handleSort, "propertyAddress")}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          Property{" "}
                          <TableSortIcon
                            sortKey={sortKey}
                            sortDir={sortDir}
                            column="propertyAddress"
                          />
                        </span>
                      </th>
                      {/* Sortable only when visible — legal-only admins see "—" in every cell. */}
                      <th
                        className={`px-6 py-4 font-semibold text-foreground select-none ${canSeeFinancials ? "cursor-pointer hover:bg-secondary/50 transition" : ""}`}
                        {...(canSeeFinancials ? sortableThProps(handleSort, "agreementValue") : {})}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          Agreement Value{" "}
                          {canSeeFinancials && (
                            <TableSortIcon
                              sortKey={sortKey}
                              sortDir={sortDir}
                              column="agreementValue"
                            />
                          )}
                        </span>
                      </th>
                      <th
                        className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                        {...sortableThProps(handleSort, "expiration")}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          Expiration{" "}
                          <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="expiration" />
                        </span>
                      </th>
                      <th className="px-6 py-4 font-semibold text-foreground text-right">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sortedTenants.map((row) => {
                      const tenant = {
                        ...row,
                        name: row.tenantName,
                        email: row.tenantEmail,
                        image: row.tenantImage ?? "",
                        owner: row.ownerName,
                        status: row.status,
                      };
                      return (
                        <tr
                          key={tenant.id}
                          className="hover:bg-muted/50 transition cursor-pointer"
                          onClick={() => setSelectedAgreement(tenant)}
                        >
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <Avatar
                                src={tenant.image}
                                name={tenant.name}
                                email={tenant.email}
                                size="sm"
                                className="border-border/40"
                              />
                              <div>
                                <div className="font-medium text-foreground">{tenant.name}</div>
                                <div className="text-xs text-muted-foreground">{tenant.email}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-muted-foreground">{tenant.owner || "-"}</td>
                          <td className="px-6 py-4 text-muted-foreground">
                            {tenant.propertyAddress}
                          </td>
                          <td className="px-6 py-4 font-medium text-foreground">
                            {tenant.agreementValue ? fmtMoney(tenant.agreementValue) : "—"}
                          </td>
                          <td className="px-6 py-4 text-muted-foreground">
                            {tenant.expiration || "—"}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <div
                              className="relative inline-block"
                              ref={openActionId === tenant.id ? actionMenuRef : undefined}
                            >
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenActionId(openActionId === tenant.id ? null : tenant.id);
                                }}
                                className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition"
                              >
                                <MoreHorizontal size={16} />
                              </button>
                              {openActionId === tenant.id && (
                                <div className="absolute right-0 top-full mt-1 w-48 bg-card border border-border rounded-lg shadow-lg z-50 py-1">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedAgreement(tenant);
                                      setOpenActionId(null);
                                    }}
                                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-muted transition"
                                  >
                                    <FileText size={15} className="text-muted-foreground" />
                                    View Agreement
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setOpenActionId(null);
                                    }}
                                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-muted transition"
                                  >
                                    <Download size={15} className="text-muted-foreground" />
                                    Download PDF
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      window.print();
                                      setOpenActionId(null);
                                    }}
                                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-muted transition"
                                  >
                                    <Printer size={15} className="text-muted-foreground" />
                                    Print Agreement
                                  </button>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </TableShellCard>
          {sortedTenants.length === 0 && (
            <TableEmptyState
              icon={<FileSignature size={24} className="opacity-50" />}
              title="No agreements found"
              description="Try adjusting your filters."
            />
          )}
        </>
      )}

      <AgreementModal
        isOpen={!!selectedAgreement}
        onClose={() => setSelectedAgreement(null)}
        agreement={selectedAgreement}
      />
    </div>
  );
}
