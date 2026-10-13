import { useState } from "react";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import {
  useAdminMarketplace,
  useUpdateMarketplaceListing,
  useDeleteMarketplaceListing,
  type AdminMarketplaceRow,
  type MarketplaceListingStatus,
  type MarketplaceListingTag,
} from "@/lib/adminQueries";
import { useToast } from "@ui/hooks/use-toast";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { ForbiddenView } from "@ui/components/ForbiddenView";
import {
  AdminListLoading,
  AdminListError,
  sortableThProps,
} from "@/components/common/AdminListStates";
import { useConfirm } from "@ui/components/common/ConfirmDialog";
import { formatCurrencyCompact } from "@ui/lib/format";
import { Search, Trash2, Store } from "lucide-react";
import {
  TableSortIcon,
  TableFiltersCard,
  TableShellCard,
  FilterPills,
  TableEmptyState,
} from "@ui/components/ui/data-table";

const STATUSES: MarketplaceListingStatus[] = ["active", "draft", "sold", "withdrawn"];
const TAGS: MarketplaceListingTag[] = ["Hot Deal", "New", "Featured", "Off-market"];

// Form state. Numbers are kept as strings while editing so the inputs can be
// blank without coercing to 0 (which would change semantics — 0 € is a real
// price; "" means "not set").
type EditingListing = {
  id: string;
  title: string;
  location: string;
  price: string;
  roi: string;
  beds: string;
  baths: string;
  sqm: string;
  image: string;
  tag: MarketplaceListingTag | "";
  status: MarketplaceListingStatus;
  externalUrl: string;
};

function toEditing(l: AdminMarketplaceRow): EditingListing {
  return {
    id: l.id,
    title: l.title ?? "",
    location: l.location ?? "",
    price: String(l.price ?? ""),
    roi: l.roi != null ? String(l.roi) : "",
    beds: l.beds != null ? String(l.beds) : "",
    baths: l.baths != null ? String(l.baths) : "",
    sqm: l.sqm != null ? String(l.sqm) : "",
    image: l.image ?? "",
    tag: l.tag ?? "",
    status: l.status ?? "active",
    externalUrl: l.externalUrl ?? "",
  };
}

// Translate the form state into the API input. Empty string fields are dropped
// (omitted) rather than sent as zero / undefined.
function toPayload(e: EditingListing) {
  const numOrUndef = (s: string) => {
    const n = Number(s);
    return s.trim() === "" || !Number.isFinite(n) ? undefined : n;
  };
  return {
    title: e.title.trim(),
    location: e.location.trim(),
    price: Number(e.price) || 0,
    roi: numOrUndef(e.roi),
    beds: numOrUndef(e.beds),
    baths: numOrUndef(e.baths),
    sqm: numOrUndef(e.sqm),
    image: e.image.trim() || undefined,
    tag: e.tag || undefined,
    status: e.status,
    externalUrl: e.externalUrl.trim() || undefined,
  };
}

const formatPrice = formatCurrencyCompact;

export default function AdminMarketplacePage() {
  const { canPlatform } = usePrivileges();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<"All" | MarketplaceListingStatus>("All");
  const [editing, setEditing] = useState<EditingListing | null>(null);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const { data: listings = [], isLoading, isError, refetch } = useAdminMarketplace();
  const { toast } = useToast();
  const updateListing = useUpdateMarketplaceListing();
  const deleteListing = useDeleteMarketplaceListing();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const isSaving = updateListing.isPending;

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: "Remove this listing?",
      description: "This will hide the listing from owners and remove its analytics.",
      confirmLabel: "Remove",
      tone: "destructive",
    });
    if (!ok) return;
    deleteListing.mutate(id, {
      onSuccess: () => toast({ title: "Listing removed" }),
      onError: (err: any) =>
        toast({ title: "Delete failed", description: err?.message, variant: "destructive" }),
    });
  };

  const handleSave = () => {
    if (!editing) return;
    if (!editing.title.trim()) {
      toast({ title: "Title is required", variant: "destructive" });
      return;
    }
    if (!editing.location.trim()) {
      toast({ title: "Location is required", variant: "destructive" });
      return;
    }
    const priceNum = Number(editing.price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      toast({ title: "Price must be a non-negative number", variant: "destructive" });
      return;
    }

    const payload = toPayload(editing);
    updateListing.mutate(
      { id: editing.id, patch: payload },
      {
        onSuccess: () => {
          setEditing(null);
          toast({ title: "Listing updated" });
        },
        onError: (err: any) =>
          toast({ title: "Update failed", description: err?.message, variant: "destructive" }),
      },
    );
  };

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const filtered = listings.filter((l) => {
    const q = searchQuery.toLowerCase();
    const matchesSearch = l.title.toLowerCase().includes(q) || l.location.toLowerCase().includes(q);
    const matchesStatus = activeFilter === "All" || l.status === activeFilter;
    return matchesSearch && matchesStatus;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (!sortKey) return 0;
    const dir = sortDir === "asc" ? 1 : -1;
    const valA = (a as any)[sortKey];
    const valB = (b as any)[sortKey];
    if (typeof valA === "number" && typeof valB === "number") return (valA - valB) * dir;
    return String(valA ?? "").localeCompare(String(valB ?? "")) * dir;
  });

  if (!canPlatform("comm.partners")) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <ForbiddenView
          title="Marketplace locked"
          message="Your platform role doesn't include the 'Manage partner listings' privilege. An admin can grant it in Settings → Platform Roles."
        />
      </div>
    );
  }

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      {confirmDialog}
      <div className="mb-8 md:mb-2 mt-4 md:mt-0">
        <div className="md:hidden">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Marketplace</h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Curate properties for sale shown to owners
          </p>
        </div>
      </div>

      {/* Filters & Search */}
      <TableFiltersCard>
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            placeholder="Search listings…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-muted border-none rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <FilterPills
          options={(["All", ...STATUSES] as const).map((t) => ({ id: t, label: t }))}
          value={activeFilter}
          onChange={(id) => setActiveFilter(id as "All" | MarketplaceListingStatus)}
          className="capitalize"
        />
      </TableFiltersCard>

      {isError ? (
        <AdminListError onRetry={() => refetch()} message="We couldn't load listings." />
      ) : isLoading ? (
        <AdminListLoading />
      ) : (
        <>
          {/* Table */}
          <TableShellCard>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-muted border-b border-border">
                  <tr>
                    <th
                      className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50"
                      {...sortableThProps(handleSort, "title")}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        Title <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="title" />
                      </span>
                    </th>
                    <th
                      className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50"
                      {...sortableThProps(handleSort, "location")}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        Location{" "}
                        <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="location" />
                      </span>
                    </th>
                    <th
                      className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50"
                      {...sortableThProps(handleSort, "price")}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        Price <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="price" />
                      </span>
                    </th>
                    <th className="px-6 py-4 font-semibold text-foreground hidden md:table-cell">
                      ROI
                    </th>
                    <th className="px-6 py-4 font-semibold text-foreground hidden md:table-cell">
                      Tag
                    </th>
                    <th
                      className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50"
                      {...sortableThProps(handleSort, "status")}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        Status <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="status" />
                      </span>
                    </th>
                    <th className="px-6 py-4 font-semibold text-foreground text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sorted.map((l) => (
                    <tr
                      key={l.id}
                      className="hover:bg-muted/50 transition cursor-pointer"
                      onClick={() => setEditing(toEditing(l))}
                    >
                      <td className="px-6 py-4 font-medium text-foreground">{l.title}</td>
                      <td className="px-6 py-4 text-muted-foreground">{l.location}</td>
                      <td className="px-6 py-4 text-foreground">{formatPrice(l.price)}</td>
                      <td className="px-6 py-4 text-muted-foreground hidden md:table-cell">
                        {l.roi != null ? `${l.roi}%` : "—"}
                      </td>
                      <td className="px-6 py-4 hidden md:table-cell">
                        {l.tag ? (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-foreground font-medium">
                            {l.tag}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${
                            l.status === "active"
                              ? "bg-emerald-500/10 text-emerald-500"
                              : l.status === "draft"
                                ? "bg-yellow-500/10 text-yellow-500"
                                : l.status === "sold"
                                  ? "bg-blue-500/10 text-blue-500"
                                  : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {l.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(l.id);
                          }}
                          className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition"
                          aria-label="Delete listing"
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TableShellCard>
          {sorted.length === 0 && (
            <TableEmptyState
              icon={<Store size={24} className="opacity-50" />}
              title="No listings yet"
              description='Use the "+" in the header to add the first one.'
            />
          )}
        </>
      )}

      {/* Edit modal */}
      {editing && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setEditing(null)}
        >
          <div
            className="bg-card rounded-2xl border border-border shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground">Edit Listing</h2>
              <button
                onClick={() => setEditing(null)}
                className="text-muted-foreground hover:text-foreground text-sm"
              >
                Close
              </button>
            </div>
            <div className="p-6 space-y-4">
              <Field label="Title" required>
                <input
                  type="text"
                  value={editing.title}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  className={inputCls}
                />
              </Field>
              <Field label="Location" required>
                <input
                  type="text"
                  value={editing.location}
                  placeholder="Limassol, Cyprus"
                  onChange={(e) => setEditing({ ...editing, location: e.target.value })}
                  className={inputCls}
                />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Price (€)" required>
                  <input
                    type="number"
                    min="0"
                    value={editing.price}
                    onChange={(e) => setEditing({ ...editing, price: e.target.value })}
                    className={inputCls}
                  />
                </Field>
                <Field label="ROI (%)">
                  <input
                    type="number"
                    step="0.1"
                    value={editing.roi}
                    onChange={(e) => setEditing({ ...editing, roi: e.target.value })}
                    className={inputCls}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-3 gap-3 sm:gap-4">
                <Field label="Beds">
                  <input
                    type="number"
                    min="0"
                    value={editing.beds}
                    onChange={(e) => setEditing({ ...editing, beds: e.target.value })}
                    className={inputCls}
                  />
                </Field>
                <Field label="Baths">
                  <input
                    type="number"
                    min="0"
                    value={editing.baths}
                    onChange={(e) => setEditing({ ...editing, baths: e.target.value })}
                    className={inputCls}
                  />
                </Field>
                <Field label="m²">
                  <input
                    type="number"
                    min="0"
                    value={editing.sqm}
                    onChange={(e) => setEditing({ ...editing, sqm: e.target.value })}
                    className={inputCls}
                  />
                </Field>
              </div>
              <Field label="Image URL">
                <input
                  type="url"
                  value={editing.image}
                  placeholder="https://… or /assets/…"
                  onChange={(e) => setEditing({ ...editing, image: e.target.value })}
                  className={inputCls}
                />
              </Field>
              <Field label="External URL">
                <input
                  type="url"
                  value={editing.externalUrl}
                  placeholder="Optional broker / docs link"
                  onChange={(e) => setEditing({ ...editing, externalUrl: e.target.value })}
                  className={inputCls}
                />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Tag">
                  <select
                    value={editing.tag}
                    onChange={(e) =>
                      setEditing({ ...editing, tag: e.target.value as EditingListing["tag"] })
                    }
                    className={inputCls}
                  >
                    <option value="">No tag</option>
                    {TAGS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Status">
                  <select
                    value={editing.status}
                    onChange={(e) =>
                      setEditing({ ...editing, status: e.target.value as MarketplaceListingStatus })
                    }
                    className={inputCls}
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s} className="capitalize">
                        {s}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button
                onClick={() => setEditing(null)}
                className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="px-4 py-2 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-60"
              >
                {isSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls =
  "w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}
