import { useState } from "react";
import { usePartners } from "@/lib/ownerQueries";
import { Phone, Mail } from "lucide-react";
import {
  TableSortIcon,
  TableFiltersCard,
  TableShellCard,
  FilterPills,
  TableSearchInput,
  TableEmptyState,
} from "@ui/components/ui/data-table";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { PageHeader } from "@ui/components/common/PageHeader";
import { Avatar } from "@ui/components/common/Avatar";
import { Skeleton, SkeletonRow } from "@ui/components/common/Skeleton";
import { ListErrorState } from "@/components/common/ListErrorState";

export default function NetworkPage() {
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const {
    data: partners = [],
    isLoading: partnersLoading,
    isError: partnersError,
    refetch: refetchPartners,
  } = usePartners();

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

  const categories = [
    { id: "all", label: "All" },
    { id: "broker", label: "Brokers" },
    { id: "contractor", label: "Contractors" },
    { id: "legal", label: "Legal" },
    { id: "cleaning", label: "Cleaning" },
    { id: "insurance", label: "Insurance" },
  ];

  const filteredPartners = partners.filter((partner) => {
    const matchesCategory = selectedCategory === "all" || partner.type === selectedCategory;
    if (!matchesCategory) return false;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const hay =
      `${partner.name ?? ""} ${partner.email ?? ""} ${partner.location ?? ""} ${partner.type ?? ""}`.toLowerCase();
    return hay.includes(q);
  });

  const sortedPartners = [...filteredPartners].sort((a, b) => {
    if (!sortKey) return 0;
    const dir = sortDir === "asc" ? 1 : -1;
    const valA = (a as any)[sortKey];
    const valB = (b as any)[sortKey];
    if (typeof valA === "number" && typeof valB === "number") return (valA - valB) * dir;
    return String(valA).localeCompare(String(valB)) * dir;
  });

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <PageHeader title="Network" subtitle="Your trusted partners & contacts" />

      {/* Filters */}
      <TableFiltersCard>
        <TableSearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search by name, email, or location…"
        />
        <FilterPills options={categories} value={selectedCategory} onChange={setSelectedCategory} />
      </TableFiltersCard>

      {partnersError ? (
        <ListErrorState title="We couldn't load your network." onRetry={() => refetchPartners()} />
      ) : partnersLoading ? (
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
            {sortedPartners.map((partner) => (
              <div
                key={partner.id}
                className="bg-card border border-border rounded-2xl p-4 hover:border-foreground/20 transition"
              >
                <div className="flex items-center gap-3 mb-3">
                  <Avatar
                    src={partner.image}
                    name={partner.name}
                    email={partner.email}
                    size="md"
                    className="border-border/40"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-foreground truncate">{partner.name}</div>
                    <div className="text-xs text-muted-foreground truncate capitalize">
                      {partner.type}
                      {partner.location ? ` · ${partner.location}` : ""}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground truncate">{partner.email || ""}</span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {partner.phone && (
                      <a
                        href={`tel:${partner.phone}`}
                        aria-label={`Call ${partner.name}`}
                        className="p-2 rounded-full bg-secondary hover:bg-primary hover:text-primary-foreground transition"
                      >
                        <Phone size={14} />
                      </a>
                    )}
                    {partner.email && (
                      <a
                        href={`mailto:${partner.email}`}
                        aria-label={`Email ${partner.name}`}
                        className="p-2 rounded-full bg-secondary hover:bg-primary hover:text-primary-foreground transition"
                      >
                        <Mail size={14} />
                      </a>
                    )}
                  </div>
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
                          onClick={() => handleSort("name")}
                          className="flex w-full items-center gap-1.5 px-6 py-4 font-semibold cursor-pointer hover:bg-secondary/50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset"
                        >
                          Partner{" "}
                          <TableSortIcon column="name" sortKey={sortKey} sortDir={sortDir} />
                        </button>
                      </th>
                      <th className="p-0 font-semibold text-foreground select-none">
                        <button
                          type="button"
                          onClick={() => handleSort("type")}
                          className="flex w-full items-center gap-1.5 px-6 py-4 font-semibold cursor-pointer hover:bg-secondary/50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset"
                        >
                          Category{" "}
                          <TableSortIcon column="type" sortKey={sortKey} sortDir={sortDir} />
                        </button>
                      </th>
                      <th className="p-0 font-semibold text-foreground select-none">
                        <button
                          type="button"
                          onClick={() => handleSort("location")}
                          className="flex w-full items-center gap-1.5 px-6 py-4 font-semibold cursor-pointer hover:bg-secondary/50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset"
                        >
                          Location{" "}
                          <TableSortIcon column="location" sortKey={sortKey} sortDir={sortDir} />
                        </button>
                      </th>
                      <th className="px-6 py-4 font-semibold text-foreground">Contact</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sortedPartners.map((partner) => (
                      <tr key={partner.id} className="hover:bg-muted/50 transition cursor-pointer">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <Avatar
                              src={partner.image}
                              name={partner.name}
                              email={partner.email}
                              size="sm"
                              className="border-border/40"
                            />
                            <div>
                              <div className="font-medium text-foreground">{partner.name}</div>
                              <div className="text-xs text-muted-foreground">{partner.email}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className="capitalize text-muted-foreground">{partner.type}</span>
                        </td>
                        <td className="px-6 py-4 text-muted-foreground">{partner.location}</td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <a
                              href={`tel:${partner.phone}`}
                              className="p-1.5 rounded-full bg-secondary hover:bg-primary hover:text-primary-foreground transition"
                            >
                              <Phone size={14} />
                            </a>
                            <a
                              href={`mailto:${partner.email}`}
                              className="p-1.5 rounded-full bg-secondary hover:bg-primary hover:text-primary-foreground transition"
                            >
                              <Mail size={14} />
                            </a>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </TableShellCard>

          {filteredPartners.length === 0 && (
            <TableEmptyState title="No partners found" description="Try adjusting your filters" />
          )}
        </>
      )}
    </div>
  );
}
