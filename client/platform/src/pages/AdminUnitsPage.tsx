import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import { Search, Home } from "lucide-react";
import {
  TableSortIcon,
  TableFiltersCard,
  TableShellCard,
  FilterPills,
  TableEmptyState,
} from "@ui/components/ui/data-table";
import { useState, useMemo, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { PropertyImage } from "@ui/components/common/PropertyImage";
import { YearSelect } from "@ui/components/common/YearSelect";
import { AddressAutocomplete } from "@ui/components/common/AddressAutocomplete";
import { useAdminUnits, useUpdateUnit, type UnitUpdate } from "@/lib/adminQueries";
import { useToast } from "@ui/hooks/use-toast";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { ForbiddenView } from "@ui/components/ForbiddenView";
import {
  AdminListLoading,
  AdminListError,
  sortableThProps,
} from "@/components/common/AdminListStates";
import { formatCurrencyCompact } from "@ui/lib/format";

export default function AdminUnitsPage() {
  const { canPlatform } = usePrivileges();
  // Per-property rent + valuation are financial detail. Plain
  // properties.viewAll admins (e.g. sales) can see the unit list, but
  // money columns are masked unless they also have finance.viewAll.
  const canSeeFinancials = canPlatform("finance.viewAll");
  const fmtMoney = (n: number) => (canSeeFinancials ? formatCurrencyCompact(n) : "—");
  const { data: allGeneratedProperties = [], isLoading, isError, refetch } = useAdminUnits();
  const { toast } = useToast();
  const updateUnit = useUpdateUnit();
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState("All");
  const [editingUnit, setEditingUnit] = useState<any>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const perPage = 20;

  // Deep link: the platform dashboard's map-pin popup links here with
  // ?property=<propertyId> (clicking a pin's photo). Open that property's edit
  // drawer directly. Match on propertyId — a property with multiple units
  // shares it across rows, so we open the first matching one — then clear the
  // param so a refresh/back-nav doesn't re-trigger the drawer.
  const [, setLocation] = useLocation();
  const search = useSearch();
  useEffect(() => {
    const wanted = new URLSearchParams(search).get("property");
    if (!wanted || allGeneratedProperties.length === 0) return;
    const row = allGeneratedProperties.find((p) => p.propertyId === wanted);
    if (row) {
      setEditingUnit(row);
    } else {
      // The map shows every property, but this list is capped (newest 500) and
      // omits soft-deactivated rows — so a pin can deep-link to a property
      // that isn't here. Tell the admin instead of silently doing nothing.
      toast({
        title: "Property not in this list",
        description: "It may be deactivated or beyond the most-recent 500.",
      });
    }
    setLocation("/admin/units", { replace: true });
  }, [search, allGeneratedProperties, setLocation, toast]);

  const handleSave = () => {
    if (!editingUnit) return;
    const u = editingUnit;
    const optStr = (v: unknown) => (typeof v === "string" && v.trim() ? { value: v.trim() } : null);
    const optNum = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? { value: n } : null;
    };
    const optBool = (v: unknown) => (typeof v === "boolean" ? { value: v } : null);

    const patch: UnitUpdate = {
      address: u.address,
      rentAmount: Number(u.rentAmount) || 0,
      propertyValue: Number(u.propertyValue) || 0,
      acquisitionPrice: Number(u.acquisitionPrice) || 0,
      ...(optStr(u.city) ? { city: optStr(u.city)!.value } : {}),
      ...(optStr(u.country) ? { country: optStr(u.country)!.value } : {}),
      ...(optStr(u.postalCode) ? { postalCode: optStr(u.postalCode)!.value } : {}),
      ...(typeof u.lat === "number" ? { lat: u.lat } : {}),
      ...(typeof u.lng === "number" ? { lng: u.lng } : {}),
      ...(u.propertyType ? { propertyType: u.propertyType } : {}),
      ...(optStr(u.buildingName) ? { buildingName: optStr(u.buildingName)!.value } : {}),
      ...(optStr(u.floor) ? { floor: optStr(u.floor)!.value } : {}),
      ...(optStr(u.sqm) ? { sqm: optStr(u.sqm)!.value } : {}),
      ...(optStr(u.builtYear) ? { builtYear: optStr(u.builtYear)!.value } : {}),
      ...(u.energyClass ? { energyClass: u.energyClass } : {}),
      ...(optNum(u.parking) ? { parking: optNum(u.parking)!.value } : {}),
      ...(optBool(u.elevator) ? { elevator: optBool(u.elevator)!.value } : {}),
      ...(optBool(u.heating) ? { heating: optBool(u.heating)!.value } : {}),
      ...(optBool(u.cooling) ? { cooling: optBool(u.cooling)!.value } : {}),
      ...(optBool(u.solarPanels) ? { solarPanels: optBool(u.solarPanels)!.value } : {}),
      ...(optBool(u.storageUnit) ? { storageUnit: optBool(u.storageUnit)!.value } : {}),
      ...(u.ownershipType ? { ownershipType: u.ownershipType } : {}),
      ...(u.ownershipType === "company" && optStr(u.companyName)
        ? { companyName: optStr(u.companyName)!.value }
        : {}),
      ...(u.titleDeedsStatus ? { titleDeedsStatus: u.titleDeedsStatus } : {}),
      ...(u.developmentStatus ? { developmentStatus: u.developmentStatus } : {}),
      ...(u.propertyUse ? { propertyUse: u.propertyUse } : {}),
      ...(optStr(u.acquisitionYear) ? { acquisitionYear: optStr(u.acquisitionYear)!.value } : {}),
      ...(optStr(u.developmentYear) ? { developmentYear: optStr(u.developmentYear)!.value } : {}),
      ...(optNum(u.rentPrice) ? { rentPrice: optNum(u.rentPrice)!.value } : {}),
    };
    updateUnit.mutate(
      { id: u.id, patch },
      {
        onSuccess: () => {
          setEditingUnit(null);
          toast({ title: "Unit updated" });
        },
        onError: (err: any) =>
          toast({ title: "Update failed", description: err.message, variant: "destructive" }),
      },
    );
  };

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

  const filteredProperties = allGeneratedProperties.filter((property) => {
    const matchesSearch = property.address.toLowerCase().includes(searchTerm.toLowerCase());
    let matchesFilter = true;
    if (activeFilter === "Occupied") matchesFilter = property.tenantName !== "Vacant";
    else if (activeFilter === "Vacant") matchesFilter = property.tenantName === "Vacant";
    else if (activeFilter === "Paid") matchesFilter = property.paymentStatus === "paid";
    else if (activeFilter === "Pending") matchesFilter = property.paymentStatus === "pending";
    else if (activeFilter === "Overdue") matchesFilter = property.paymentStatus === "overdue";
    return matchesSearch && matchesFilter;
  });

  const sortedProperties = [...filteredProperties].sort((a, b) => {
    if (!sortKey) return 0;
    const dir = sortDir === "asc" ? 1 : -1;
    const valA = (a as any)[sortKey];
    const valB = (b as any)[sortKey];
    if (typeof valA === "number" && typeof valB === "number") return (valA - valB) * dir;
    return String(valA).localeCompare(String(valB)) * dir;
  });

  const totalPages = Math.ceil(filteredProperties.length / perPage);
  const paginatedProperties = sortedProperties.slice(
    (currentPage - 1) * perPage,
    currentPage * perPage,
  );

  if (!canPlatform("properties.viewAll")) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <ForbiddenView
          title="Units locked"
          message="Your platform role doesn't include the 'View all properties' privilege. An admin can grant it in Settings → Platform Roles."
        />
      </div>
    );
  }

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-8 md:mb-2 mt-4 md:mt-0">
        <div className="md:hidden">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Units</h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Overview of all registered properties
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
              placeholder="Search properties by address..."
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
          // Paid/Pending/Overdue pills imply a financial signal (counts of overdue
          // tenants). Hide them from non-finance admins; they still get Occupied/Vacant.
          options={(canSeeFinancials
            ? ["All", "Occupied", "Vacant", "Paid", "Pending", "Overdue"]
            : ["All", "Occupied", "Vacant"]
          ).map((t) => ({ id: t, label: t }))}
          value={activeFilter}
          onChange={(id) => {
            setActiveFilter(id);
            setCurrentPage(1);
          }}
        />
      </TableFiltersCard>

      {isError ? (
        <AdminListError onRetry={() => refetch()} message="We couldn't load units." />
      ) : isLoading ? (
        <AdminListLoading />
      ) : (
        <>
          {/* Mobile List */}
          <div className="md:hidden">
            <TableShellCard className="divide-y divide-border">
              {paginatedProperties.map((property) => (
                <button
                  key={property.id}
                  type="button"
                  className="w-full text-left flex items-center gap-3 px-4 py-3 active:bg-muted/50 transition cursor-pointer"
                  onClick={() => setEditingUnit(property)}
                >
                  <div className="w-10 h-10 rounded-lg bg-secondary flex-shrink-0 overflow-hidden border border-border">
                    <PropertyImage
                      src={property.image?.startsWith("http") ? property.image : undefined}
                      alt={property.address}
                      icon={Home}
                      iconSize={16}
                    />
                  </div>
                  <span className="font-medium text-foreground text-sm">{property.address}</span>
                </button>
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
                          {...sortableThProps(handleSort, "address")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Property{" "}
                            <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="address" />
                          </span>
                        </th>
                        <th
                          className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "tenantName")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Current Tenant{" "}
                            <TableSortIcon
                              sortKey={sortKey}
                              sortDir={sortDir}
                              column="tenantName"
                            />
                          </span>
                        </th>
                        {/* Rent + Est. Value: sortable only when the user can actually see the
     numbers. Non-finance admins see '—' in every cell — clicking a sort
     arrow would have no visible effect. */}
                        <th
                          className={`px-6 py-4 font-semibold text-foreground select-none ${canSeeFinancials ? "cursor-pointer hover:bg-secondary/50 transition" : ""}`}
                          {...(canSeeFinancials ? sortableThProps(handleSort, "rentAmount") : {})}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Rent{" "}
                            {canSeeFinancials && (
                              <TableSortIcon
                                sortKey={sortKey}
                                sortDir={sortDir}
                                column="rentAmount"
                              />
                            )}
                          </span>
                        </th>
                        {/* Occupied/Vacant — derived from tenantName. Not independently
     sortable; clicking previously flipped the same arrow as the
     "Current Tenant" header, which is confusing UX. */}
                        <th className="px-6 py-4 font-semibold text-foreground select-none">
                          <span className="inline-flex items-center gap-1.5">Status</span>
                        </th>
                        <th
                          className={`px-6 py-4 font-semibold text-foreground select-none ${canSeeFinancials ? "cursor-pointer hover:bg-secondary/50 transition" : ""}`}
                          {...(canSeeFinancials
                            ? sortableThProps(handleSort, "propertyValue")
                            : {})}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Est. Value{" "}
                            {canSeeFinancials && (
                              <TableSortIcon
                                sortKey={sortKey}
                                sortDir={sortDir}
                                column="propertyValue"
                              />
                            )}
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {paginatedProperties.map((property) => (
                        <tr
                          key={property.id}
                          className="hover:bg-muted/50 transition cursor-pointer"
                          onClick={() => setEditingUnit(property)}
                        >
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-lg bg-secondary flex-shrink-0 overflow-hidden border border-border">
                                <PropertyImage
                                  src={
                                    property.image?.startsWith("http") ? property.image : undefined
                                  }
                                  alt={property.address}
                                  icon={Home}
                                  iconSize={16}
                                />
                              </div>
                              <div className="font-medium text-foreground">{property.address}</div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            {property.tenantName !== "Vacant" ? (
                              <span className="text-foreground">{property.tenantName}</span>
                            ) : (
                              <span className="text-muted-foreground italic">Vacant</span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            {/* Hide rent for vacant or zero-rent units so we
                                never show €0/mo income; show "—" to keep the
                                table column aligned. */}
                            {property.tenantName !== "Vacant" && (property.rentAmount ?? 0) > 0 ? (
                              <>
                                <span className="font-medium text-foreground">
                                  {fmtMoney(property.rentAmount)}
                                </span>
                                {canSeeFinancials && (
                                  <span className="text-muted-foreground text-xs">/mo</span>
                                )}
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            <span
                              className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                                property.tenantName !== "Vacant"
                                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                  : "bg-secondary text-muted-foreground"
                              }`}
                            >
                              {property.tenantName !== "Vacant" ? "Occupied" : "Vacant"}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-muted-foreground ">
                            {fmtMoney(property.propertyValue)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </TableShellCard>
          </div>
          {filteredProperties.length === 0 && (
            <TableEmptyState
              icon={<Home size={24} className="opacity-50" />}
              title="No units found"
              description="Try adjusting your filters."
            />
          )}

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4 text-sm">
            <span className="text-muted-foreground">
              Showing {(currentPage - 1) * perPage + 1}–
              {Math.min(currentPage * perPage, filteredProperties.length)} of{" "}
              {filteredProperties.length} properties
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setCurrentPage((p) => Math.max(1, p - 1));
                }}
                disabled={currentPage === 1}
                className="px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-muted-foreground">
                Page {currentPage} of {totalPages}
              </span>
              <button
                onClick={() => {
                  setCurrentPage((p) => Math.min(totalPages, p + 1));
                }}
                disabled={currentPage === totalPages}
                className="px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}

      {/* Edit Unit Drawer */}
      <ResponsiveDrawer
        open={!!editingUnit}
        onOpenChange={(open) => {
          if (!open) setEditingUnit(null);
        }}
        title="Edit Unit"
        footer={
          editingUnit ? (
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setEditingUnit(null)}
                className="px-4 py-2 border border-border rounded-lg text-sm font-medium hover:bg-muted transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={updateUnit.isPending}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {updateUnit.isPending ? "Saving..." : "Save Changes"}
              </button>
            </div>
          ) : undefined
        }
      >
        {editingUnit && (
          <div className="space-y-5">
            {/* Photo */}
            {editingUnit.image?.startsWith("http") && (
              <div className="w-full h-40 rounded-lg overflow-hidden border border-border">
                <img src={editingUnit.image} alt="" className="w-full h-full object-cover" />
              </div>
            )}

            {/* Property Name & Type */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Building Name
                </label>
                <input
                  type="text"
                  value={editingUnit.buildingName ?? ""}
                  onChange={(e) => setEditingUnit({ ...editingUnit, buildingName: e.target.value })}
                  placeholder="e.g. Sunset Towers"
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Property Type
                </label>
                <select
                  value={editingUnit.propertyType ?? "Apartment"}
                  onChange={(e) => setEditingUnit({ ...editingUnit, propertyType: e.target.value })}
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="Apartment">Apartment</option>
                  <option value="House">House</option>
                  <option value="Villa">Villa</option>
                  <option value="Commercial">Commercial</option>
                  <option value="Plot">Plot</option>
                </select>
              </div>
            </div>

            {/* Address */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Address</label>
              <AddressAutocomplete
                value={editingUnit.address ?? ""}
                onChange={(v) =>
                  setEditingUnit({ ...editingUnit, address: v, lat: undefined, lng: undefined })
                }
                onPick={(p) =>
                  setEditingUnit({
                    ...editingUnit,
                    address: p.fullAddress,
                    city: p.city || editingUnit.city,
                    postalCode: p.postalCode || editingUnit.postalCode,
                    country: p.country || editingUnit.country,
                    lat: p.lat,
                    lng: p.lng,
                  })
                }
                placeholder="Search address"
                testId="input-edit-unit-address"
              />
              {typeof editingUnit.lat === "number" && typeof editingUnit.lng === "number" && (
                <p className="text-[11px] text-muted-foreground mt-1 ml-1">
                  Pinned at {editingUnit.lat.toFixed(5)}, {editingUnit.lng.toFixed(5)}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">City</label>
                <input
                  type="text"
                  value={editingUnit.city ?? ""}
                  onChange={(e) => setEditingUnit({ ...editingUnit, city: e.target.value })}
                  placeholder="e.g. Limassol"
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Postal Code
                </label>
                <input
                  type="text"
                  value={editingUnit.postalCode ?? ""}
                  onChange={(e) => setEditingUnit({ ...editingUnit, postalCode: e.target.value })}
                  placeholder="e.g. 3036"
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Country</label>
                <input
                  type="text"
                  value={editingUnit.country ?? ""}
                  onChange={(e) => setEditingUnit({ ...editingUnit, country: e.target.value })}
                  placeholder="e.g. Cyprus"
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Floor</label>
                <input
                  type="text"
                  value={editingUnit.floor ?? ""}
                  onChange={(e) => setEditingUnit({ ...editingUnit, floor: e.target.value })}
                  placeholder="e.g. 4"
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>

            {/* Tenant & Status */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Current Tenant
                </label>
                <input
                  type="text"
                  value={editingUnit.tenantName}
                  readOnly
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm text-muted-foreground"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Occupancy Status
                </label>
                <input
                  type="text"
                  value={editingUnit.tenantName !== "Vacant" ? "Occupied" : "Vacant"}
                  readOnly
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm text-muted-foreground"
                />
              </div>
            </div>

            {/* Development & Use */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Development Status
                </label>
                <select
                  value={editingUnit.developmentStatus ?? "fully_developed"}
                  onChange={(e) =>
                    setEditingUnit({ ...editingUnit, developmentStatus: e.target.value })
                  }
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="off_plan">Off Plan</option>
                  <option value="under_construction">Under Construction</option>
                  <option value="fully_developed">Completed</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Property Use
                </label>
                <select
                  value={editingUnit.propertyUse ?? "rent"}
                  onChange={(e) => setEditingUnit({ ...editingUnit, propertyUse: e.target.value })}
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="rent">Rent</option>
                  <option value="hold">Hold</option>
                  <option value="owner_occupied">Owner-occupied</option>
                </select>
              </div>
            </div>

            {/* Specs */}
            <div className="grid grid-cols-3 sm:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Size (sqm)</label>
                <input
                  type="number"
                  value={editingUnit.sqm ?? ""}
                  onChange={(e) => setEditingUnit({ ...editingUnit, sqm: e.target.value })}
                  placeholder="e.g. 85"
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Built Year</label>
                <YearSelect
                  noIcon
                  value={editingUnit.builtYear ?? ""}
                  onChange={(y) => setEditingUnit({ ...editingUnit, builtYear: y })}
                  min={1800}
                  max={new Date().getFullYear() + 5}
                  className="w-full appearance-none bg-background border border-input rounded-lg pl-3 pr-9 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Energy Class
                </label>
                <select
                  value={editingUnit.energyClass ?? ""}
                  onChange={(e) =>
                    setEditingUnit({ ...editingUnit, energyClass: e.target.value || undefined })
                  }
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">—</option>
                  {["A+", "A", "B", "C", "D", "E", "F", "G"].map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Building Features */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Building Features
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
                {(
                  [
                    { key: "heating", label: "Heating" },
                    { key: "cooling", label: "Cooling" },
                    { key: "solarPanels", label: "Solar Panels" },
                    { key: "elevator", label: "Elevator" },
                    { key: "storageUnit", label: "Storage" },
                  ] as const
                ).map(({ key, label }) => (
                  <label
                    key={key}
                    className="flex items-center gap-2 p-2 rounded-lg border border-border bg-background cursor-pointer hover:bg-muted transition"
                  >
                    <input
                      type="checkbox"
                      checked={!!editingUnit[key]}
                      onChange={(e) => setEditingUnit({ ...editingUnit, [key]: e.target.checked })}
                      className="rounded"
                    />
                    <span className="text-xs font-medium">{label}</span>
                  </label>
                ))}
                <label className="flex items-center gap-2 p-2 rounded-lg border border-border bg-background cursor-pointer hover:bg-muted transition">
                  <input
                    type="number"
                    min={0}
                    value={editingUnit.parking ?? 0}
                    onChange={(e) =>
                      setEditingUnit({ ...editingUnit, parking: Number(e.target.value) })
                    }
                    className="w-12 bg-transparent border-0 p-0 text-xs font-medium focus:outline-none"
                  />
                  <span className="text-xs font-medium">Parking</span>
                </label>
              </div>
            </div>

            {/* Financials — hidden from admins without finance.viewAll. Acquisition
     Year + Payment Status (non-monetary) stay visible. */}
            {canSeeFinancials ? (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Rent (€/mo)
                    </label>
                    <input
                      type="number"
                      value={editingUnit.rentAmount}
                      onChange={(e) =>
                        setEditingUnit({ ...editingUnit, rentAmount: Number(e.target.value) })
                      }
                      className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Payment Status
                    </label>
                    <input
                      type="text"
                      value={editingUnit.paymentStatus}
                      readOnly
                      className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm text-muted-foreground capitalize"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Acquisition Price (€)
                    </label>
                    <input
                      type="number"
                      value={editingUnit.acquisitionPrice}
                      onChange={(e) =>
                        setEditingUnit({ ...editingUnit, acquisitionPrice: Number(e.target.value) })
                      }
                      className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Acquisition Year
                    </label>
                    <YearSelect
                      noIcon
                      value={editingUnit.acquisitionYear ?? ""}
                      onChange={(y) => setEditingUnit({ ...editingUnit, acquisitionYear: y })}
                      min={1800}
                      max={new Date().getFullYear()}
                      className="w-full appearance-none bg-background border border-input rounded-lg pl-3 pr-9 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Current Value (€)
                    </label>
                    <input
                      type="number"
                      value={editingUnit.propertyValue}
                      onChange={(e) =>
                        setEditingUnit({ ...editingUnit, propertyValue: Number(e.target.value) })
                      }
                      className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Total Collected (€)
                    </label>
                    <input
                      type="number"
                      value={editingUnit.totalCollected}
                      readOnly
                      className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm text-muted-foreground"
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="bg-muted/50 border border-border rounded-lg px-3 py-2 text-xs text-muted-foreground">
                Financial fields are hidden — ask an admin to grant the{" "}
                <span className="font-medium">finance.viewAll</span> privilege to edit rent and
                valuations.
              </div>
            )}

            {/* Lease Info */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Next Payment
                </label>
                <input
                  type="text"
                  value={editingUnit.nextPaymentDate}
                  readOnly
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm text-muted-foreground"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Lease End</label>
                <input
                  type="text"
                  value={editingUnit.leaseEnd}
                  readOnly
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm text-muted-foreground"
                />
              </div>
            </div>

            {/* Ownership */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Owner Email
                </label>
                <input
                  type="email"
                  value={editingUnit.ownerEmail ?? ""}
                  readOnly
                  className="w-full bg-muted border border-input rounded-lg px-3 py-2 text-sm text-muted-foreground cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Ownership Type
                </label>
                <select
                  value={editingUnit.ownershipType ?? "individual"}
                  onChange={(e) =>
                    setEditingUnit({ ...editingUnit, ownershipType: e.target.value })
                  }
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="individual">Individual</option>
                  <option value="company">Company</option>
                </select>
              </div>
            </div>

            {editingUnit.ownershipType === "company" && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Company Name
                </label>
                <input
                  type="text"
                  value={editingUnit.companyName ?? ""}
                  onChange={(e) => setEditingUnit({ ...editingUnit, companyName: e.target.value })}
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Title Deeds Status
              </label>
              <select
                value={editingUnit.titleDeedsStatus ?? "issued"}
                onChange={(e) =>
                  setEditingUnit({ ...editingUnit, titleDeedsStatus: e.target.value })
                }
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="issued">Issued</option>
                <option value="pending">Pending</option>
              </select>
            </div>
          </div>
        )}
      </ResponsiveDrawer>
    </div>
  );
}
