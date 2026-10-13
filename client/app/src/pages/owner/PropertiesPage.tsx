import { useState, useMemo } from "react";
import { Link } from "wouter";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { useOwnerProperties, type OwnerProperty as Property } from "@/lib/ownerQueries";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { PageHeader } from "@ui/components/common/PageHeader";
import { PropertyImage } from "@ui/components/common/PropertyImage";
import { Skeleton } from "@ui/components/common/Skeleton";
import { formatCurrencyCompact } from "@ui/lib/format";
import { TableFiltersCard, FilterPills, TableSearchInput } from "@ui/components/ui/data-table";
import { Search, Plus, Building, ChevronRight, Clock } from "lucide-react";

export default function PropertiesPage() {
  const { data: allProperties = [], isLoading: propertiesLoading } = useOwnerProperties();
  // Cross-portfolio mode is read-only. `isSelf` still gates the empty-state copy.
  // Adding a property now lives in the global "+" menu (Add Property), and
  // browsing listings lives in the Marketplace sidebar page — so this page
  // carries no header actions of its own.
  const { isSelf } = useActivePortfolio();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const statusOptions = [
    { id: "all", label: "All" },
    { id: "occupied", label: "Occupied" },
    { id: "vacant", label: "Vacant" },
  ];

  const filteredProperties = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allProperties.filter((p) => {
      // A pending invite counts as "not vacant" here — the owner has a tenant
      // lined up, so it shouldn't surface under the Vacant filter.
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "occupied" ? p.tenancyState !== "vacant" : p.tenancyState === "vacant");
      if (!matchesStatus) return false;
      if (!q) return true;
      const hay =
        `${p.name ?? ""} ${p.address ?? ""} ${p.city ?? ""} ${p.country ?? ""} ${p.tenantName ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [allProperties, searchQuery, statusFilter]);

  return (
    <>
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <PageHeader title="Properties" subtitle="Manage your real estate portfolio" />

        {allProperties.length > 0 && (
          <TableFiltersCard>
            <TableSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search by address, city, or tenant…"
            />
            <FilterPills options={statusOptions} value={statusFilter} onChange={setStatusFilter} />
          </TableFiltersCard>
        )}

        {/* Property List */}
        {propertiesLoading ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-2xl" />
            ))}
          </div>
        ) : allProperties.length === 0 ? (
          <div className="bg-card border border-border/60 rounded-2xl flex flex-col items-center justify-center py-16 px-6 text-center">
            <Building size={36} className="mb-4 text-muted-foreground opacity-30" />
            <h3 className="text-base font-semibold text-foreground">No properties yet</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              {isSelf
                ? "Add your first property to start tracking value, rent and tenants."
                : "This portfolio has no properties."}
            </p>
          </div>
        ) : filteredProperties.length === 0 ? (
          <div className="bg-card border border-border/60 rounded-2xl flex flex-col items-center justify-center py-12 px-6 text-center">
            <Search size={28} className="mb-3 text-muted-foreground opacity-30" />
            <p className="text-sm font-medium text-foreground">No properties match your search</p>
            <p className="text-xs text-muted-foreground mt-1">
              Try a different address or tenant name.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {filteredProperties.map((property) => (
              <Link href={`/properties/${property.id}`} key={property.id} className="block">
                <div className="bg-card overflow-hidden border border-border/60 cursor-pointer hover:border-border hover:shadow-lg transition-all duration-300 group rounded-2xl block">
                  {/* Table-like row */}
                  <div className="flex items-center p-4 w-full justify-between">
                    <div className="flex items-center gap-4">
                      {/* 1. Image Thumbnail */}
                      <div className="w-16 h-12 rounded-lg overflow-hidden bg-secondary flex-shrink-0 border border-border/40">
                        <PropertyImage src={property.image} alt={property.address} iconSize={18} />
                      </div>

                      {/* 2. Address & Tenant (Primary Info) */}
                      <div className="flex flex-col">
                        <h3 className="font-bold text-foreground text-sm truncate">
                          {property.name || property.address}
                        </h3>
                        <p className="text-xs text-muted-foreground truncate font-medium mt-0.5">
                          {property.tenancyState === "pending" ? (
                            <span className="text-warning flex items-center gap-1">
                              <Clock size={12} className="shrink-0" />{" "}
                              {property.tenantName ?? "Tenant"} · Pending
                            </span>
                          ) : property.tenancyState !== "vacant" && property.tenantName ? (
                            property.tenantName
                          ) : property.propertyUse === "hold" ? (
                            <span className="text-muted-foreground/70">Held for investment</span>
                          ) : property.propertyUse === "owner_occupied" ? (
                            <span className="text-muted-foreground/70">Owner-occupied</span>
                          ) : (
                            <span className="text-primary/70 flex items-center gap-1">
                              <Plus size={12} className="stroke-[3]" /> Add tenant
                            </span>
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      {/* Rent — hidden for vacant or zero-rent properties so we
                          never advertise €0/month income. */}
                      {property.tenancyState !== "vacant" && (property.rentAmount ?? 0) > 0 && (
                        <div className="text-right flex flex-col items-end">
                          <span className="block font-bold text-foreground text-base leading-none">
                            {formatCurrencyCompact(property.rentAmount)}
                          </span>
                          <span className="block text-[10px] text-muted-foreground font-medium mt-1">
                            /month
                          </span>
                        </div>
                      )}

                      {/* Arrow / Action */}
                      <div className="flex justify-end ml-1">
                        <ChevronRight
                          size={16}
                          className="text-muted-foreground group-hover:text-primary transition-colors"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
