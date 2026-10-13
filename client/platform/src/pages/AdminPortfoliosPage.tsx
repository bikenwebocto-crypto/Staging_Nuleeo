import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import { Search, Briefcase } from "lucide-react";
import {
  TableSortIcon,
  TableFiltersCard,
  TableShellCard,
  TableEmptyState,
  FilterPills,
} from "@ui/components/ui/data-table";
import { useState } from "react";
import { useAdminPortfolios } from "@/lib/adminQueries";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { ForbiddenView } from "@ui/components/ForbiddenView";
import {
  AdminListLoading,
  AdminListError,
  sortableThProps,
} from "@/components/common/AdminListStates";
import { formatCurrencyCompact } from "@ui/lib/format";

export default function AdminPortfoliosPage() {
  const { canPlatform } = usePrivileges();
  // Total portfolio value is a financial number. Plain properties.viewAll
  // admins (e.g. sales) can see the portfolio list, but the monetary
  // column is masked unless they also have finance.viewAll.
  const canSeeFinancials = canPlatform("finance.viewAll");
  const fmtMoney = (n: number) => (canSeeFinancials ? formatCurrencyCompact(n) : "—");
  const { data: portfolios = [], isLoading, isError, refetch } = useAdminPortfolios();
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState("All");
  const [sortKey, setSortKey] = useState<string | null>("unitsCount");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const perPage = 20;

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const filtered = portfolios.filter((p) => {
    const q = searchTerm.toLowerCase();
    const matchesSearch =
      p.portfolioName.toLowerCase().includes(q) ||
      p.ownerName.toLowerCase().includes(q) ||
      p.ownerEmail.toLowerCase().includes(q) ||
      (p.portfolioId?.toLowerCase().includes(q) ?? false);
    let matchesFilter = true;
    if (activeFilter === "Has Units") matchesFilter = p.unitsCount > 0;
    else if (activeFilter === "Empty") matchesFilter = p.unitsCount === 0;
    else if (activeFilter === "Fully Rented")
      matchesFilter = p.unitsCount > 0 && p.rentedOut === p.unitsCount;
    else if (activeFilter === "Has Vacancies")
      matchesFilter = p.unitsCount > 0 && p.rentedOut < p.unitsCount;
    else if (activeFilter === "Co-owned") matchesFilter = p.roles.length > 1;
    return matchesSearch && matchesFilter;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (!sortKey) return 0;
    const dir = sortDir === "asc" ? 1 : -1;
    const valA = (a as any)[sortKey];
    const valB = (b as any)[sortKey];
    if (typeof valA === "number" && typeof valB === "number") return (valA - valB) * dir;
    return String(valA).localeCompare(String(valB)) * dir;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const paginated = sorted.slice((currentPage - 1) * perPage, currentPage * perPage);

  if (!canPlatform("properties.viewAll")) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <ForbiddenView
          title="Portfolios locked"
          message="Your platform role doesn't include the 'View all properties' privilege. An admin can grant it in Settings → Platform Roles."
        />
      </div>
    );
  }

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-8 md:mb-2 mt-4 md:mt-0">
        <div className="md:hidden">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Portfolios</h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            All owner portfolios on the platform
          </p>
        </div>
      </div>

      <TableFiltersCard>
        <div className="flex flex-col md:flex-row gap-4 items-center">
          <div className="relative flex-1 w-full">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              placeholder="Search portfolios by owner, name, or ID..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
              className="w-full bg-muted border-none rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
            />
          </div>
        </div>
        <FilterPills
          options={["All", "Has Units", "Empty", "Fully Rented", "Has Vacancies", "Co-owned"].map(
            (t) => ({ id: t, label: t }),
          )}
          value={activeFilter}
          onChange={(v) => {
            setActiveFilter(v);
            setCurrentPage(1);
          }}
        />
      </TableFiltersCard>

      {isError ? (
        <AdminListError onRetry={() => refetch()} message="We couldn't load portfolios." />
      ) : isLoading ? (
        <AdminListLoading />
      ) : (
        <>
          {/* Mobile List */}
          <div className="md:hidden">
            <TableShellCard className="divide-y divide-border">
              {paginated.map((p) => (
                <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-10 h-10 rounded-lg bg-secondary flex-shrink-0 flex items-center justify-center text-muted-foreground border border-border">
                    <Briefcase size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-foreground text-sm truncate">
                      {p.portfolioName}
                    </div>
                    {p.portfolioId && (
                      <div className="text-xs text-muted-foreground font-mono truncate">
                        {p.portfolioId}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground truncate">
                      {p.unitsCount} units · {p.rentedOut} rented out
                      {canSeeFinancials ? ` · ${fmtMoney(p.totalValue)}` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </TableShellCard>
          </div>

          {/* Desktop Table */}
          <div className="hidden md:block">
            <TableShellCard>
              <div className="overflow-x-auto">
                <div className="inline-block min-w-full align-middle">
                  <table className="w-full text-left text-sm whitespace-nowrap">
                    <thead className="bg-muted border-b border-border">
                      <tr>
                        <th
                          className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "portfolioName")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Portfolio{" "}
                            <TableSortIcon
                              sortKey={sortKey}
                              sortDir={sortDir}
                              column="portfolioName"
                            />
                          </span>
                        </th>
                        <th
                          className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "unitsCount")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            # Units{" "}
                            <TableSortIcon
                              sortKey={sortKey}
                              sortDir={sortDir}
                              column="unitsCount"
                            />
                          </span>
                        </th>
                        <th className="px-6 py-4 font-semibold text-foreground">Owner Roles</th>
                        <th
                          className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "rentedOut")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Rented Out{" "}
                            <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="rentedOut" />
                          </span>
                        </th>
                        {/* Total Value sortable only when visible — non-finance admins
                        see "—" in every cell. */}
                        <th
                          className={`px-6 py-4 font-semibold text-foreground select-none ${canSeeFinancials ? "cursor-pointer hover:bg-secondary/50 transition" : ""}`}
                          {...(canSeeFinancials ? sortableThProps(handleSort, "totalValue") : {})}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Total Value{" "}
                            {canSeeFinancials && (
                              <TableSortIcon
                                sortKey={sortKey}
                                sortDir={sortDir}
                                column="totalValue"
                              />
                            )}
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {paginated.map((p) => (
                        <tr key={p.id} className="hover:bg-muted/50 transition">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-lg bg-secondary flex-shrink-0 flex items-center justify-center text-muted-foreground border border-border">
                                <Briefcase size={16} />
                              </div>
                              <div className="min-w-0">
                                <div className="font-medium text-foreground truncate">
                                  {p.portfolioName}
                                </div>
                                <div className="text-xs text-muted-foreground truncate">
                                  {p.ownerEmail}
                                </div>
                                {p.portfolioId && (
                                  <div className="text-xs text-muted-foreground font-mono truncate">
                                    {p.portfolioId}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className="font-medium text-foreground">{p.unitsCount}</span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-wrap gap-1.5">
                              {p.roles.map((role) => (
                                <span
                                  key={role}
                                  className="px-2 py-0.5 rounded-full text-xs font-medium bg-secondary text-foreground border border-border"
                                >
                                  {role}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className="text-muted-foreground">
                              {p.rentedOut} / {p.unitsCount}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <span className="font-medium text-foreground">
                              {fmtMoney(p.totalValue)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </TableShellCard>
          </div>

          {filtered.length === 0 && (
            <TableEmptyState
              icon={<Briefcase size={24} className="opacity-50" />}
              title="No portfolios found"
              description="Try adjusting your search."
            />
          )}

          {filtered.length > perPage && (
            <div className="flex items-center justify-between mt-4 text-sm">
              <span className="text-muted-foreground">
                Showing {(currentPage - 1) * perPage + 1}–
                {Math.min(currentPage * perPage, filtered.length)} of {filtered.length} portfolios
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span className="text-muted-foreground">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
