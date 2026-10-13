import { useState } from "react";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import {
  useAdminPartners,
  useCreatePartner,
  useUpdatePartner,
  useDeletePartner,
  useRenewPartner,
  PARTNER_DURATION_OPTIONS,
  type AdminPartnerRow,
  type PartnerType,
  type PartnerDurationMonths,
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
import { StatusPill } from "@ui/components/common/StatusPill";
import { Avatar } from "@ui/components/common/Avatar";
import { formatDate } from "@ui/lib/format";
import { Search, Handshake, RefreshCw } from "lucide-react";
import {
  TableSortIcon,
  TableFiltersCard,
  TableShellCard,
  FilterPills,
  TableEmptyState,
} from "@ui/components/ui/data-table";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ui/components/ui/dropdown-menu";

type EditingPartner = {
  id: string;
  name: string;
  type: PartnerType;
  contactName: string;
  email: string;
  phone: string;
  status: "active" | "inactive";
  durationMonths: PartnerDurationMonths;
  activeUntil: string;
  location: string;
  image: string;
  rating: number;
  createdAt: string;
};

const emptyPartner: EditingPartner = {
  id: "",
  name: "",
  type: "broker",
  contactName: "",
  email: "",
  phone: "",
  status: "active",
  durationMonths: 1,
  activeUntil: "",
  location: "",
  image: "",
  rating: 0,
  createdAt: "",
};

function toEditing(p: AdminPartnerRow): EditingPartner {
  return {
    id: p.id,
    name: p.name ?? "",
    type: (p.type ?? "broker") as PartnerType,
    contactName: p.contactName ?? "",
    email: p.email ?? "",
    phone: p.phone ?? "",
    status: (p.status ?? "active") as "active" | "inactive",
    durationMonths: 1,
    activeUntil: (p as any).activeUntil ?? "",
    location: p.location ?? "",
    image: p.image ?? "",
    rating: p.rating ?? 0,
    createdAt: (p as any).createdAt ?? "",
  };
}

const formatActiveUntil = formatDate;

export default function AdminPartnersPage() {
  const { canPlatform } = usePrivileges();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState("All");
  const [editingPartner, setEditingPartner] = useState<EditingPartner | null>(null);
  const { data: partners = [], isLoading, isError, refetch } = useAdminPartners();
  const { toast } = useToast();
  const createPartner = useCreatePartner();
  const updatePartner = useUpdatePartner();
  const deletePartner = useDeletePartner();
  const renewPartner = useRenewPartner();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const isNew = !!editingPartner && !editingPartner.id;
  const isSaving = createPartner.isPending || updatePartner.isPending;

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: "Remove this partner?",
      description: "This will end their active period and detach any open referrals.",
      confirmLabel: "Remove",
      tone: "destructive",
    });
    if (!ok) return;
    deletePartner.mutate(id, {
      onSuccess: () => toast({ title: "Partner removed" }),
      onError: (err: any) =>
        toast({ title: "Delete failed", description: err?.message, variant: "destructive" }),
    });
  };

  const handleRenew = (id: string, durationMonths: PartnerDurationMonths) => {
    renewPartner.mutate(
      { id, durationMonths },
      {
        onSuccess: () =>
          toast({
            title: "Partner renewed",
            description: `Active period extended by ${durationMonths} month${durationMonths === 1 ? "" : "s"}.`,
          }),
        onError: (err: any) =>
          toast({ title: "Renew failed", description: err?.message, variant: "destructive" }),
      },
    );
  };

  const handleSave = () => {
    if (!editingPartner) return;
    const {
      id,
      name,
      type,
      contactName,
      email,
      phone,
      status,
      durationMonths,
      location,
      image,
      rating,
    } = editingPartner;
    if (isNew) {
      createPartner.mutate(
        { name, type, contactName, email, phone, durationMonths, location, image, rating },
        {
          onSuccess: () => {
            setEditingPartner(null);
            toast({ title: "Partner created" });
          },
          onError: (err: any) =>
            toast({ title: "Create failed", description: err?.message, variant: "destructive" }),
        },
      );
    } else {
      updatePartner.mutate(
        { id, patch: { name, type, contactName, email, phone, status, location, image, rating } },
        {
          onSuccess: () => {
            setEditingPartner(null);
            toast({ title: "Partner updated" });
          },
          onError: (err: any) =>
            toast({ title: "Update failed", description: err?.message, variant: "destructive" }),
        },
      );
    }
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

  const filteredPartners = partners.filter((partner) => {
    const matchesSearch =
      partner.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (partner.email ?? "").toLowerCase().includes(searchQuery.toLowerCase());
    let matchesFilter = true;
    if (activeFilter === "Active") matchesFilter = partner.status === "active";
    else if (activeFilter === "Inactive") matchesFilter = partner.status === "inactive";
    else if (activeFilter === "Broker") matchesFilter = partner.type === "broker";
    else if (activeFilter === "Contractor") matchesFilter = partner.type === "contractor";
    else if (activeFilter === "Legal") matchesFilter = partner.type === "legal";
    return matchesSearch && matchesFilter;
  });

  const sortedPartners = [...filteredPartners].sort((a, b) => {
    if (!sortKey) return 0;
    const dir = sortDir === "asc" ? 1 : -1;
    const valA = (a as any)[sortKey];
    const valB = (b as any)[sortKey];
    if (typeof valA === "number" && typeof valB === "number") return (valA - valB) * dir;
    return String(valA).localeCompare(String(valB)) * dir;
  });

  if (!canPlatform("comm.partners")) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <ForbiddenView
          title="Partners locked"
          message="Your platform role doesn't include the 'Manage partner listings' privilege. An admin can grant it in Settings → Platform Roles."
        />
      </div>
    );
  }

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      {confirmDialog}
      {/* Header */}
      <div className="mb-8 md:mb-2 mt-4 md:mt-0">
        <div className="md:hidden">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Partners</h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Manage real estate network partners
          </p>
        </div>
      </div>

      {/* Filters & Search */}
      <TableFiltersCard>
        <div className="flex flex-col md:flex-row gap-4 items-center">
          <div className="relative flex-1 w-full">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              size={18}
            />
            <input
              type="text"
              placeholder="Search by name, email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-muted border-none rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
            />
          </div>
          <button
            onClick={() => setEditingPartner({ ...emptyPartner })}
            className="px-4 py-2.5 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg transition shadow-sm whitespace-nowrap"
          >
            New Partner
          </button>
        </div>
        <FilterPills
          options={["All", "Active", "Inactive", "Broker", "Contractor", "Legal"].map((t) => ({
            id: t,
            label: t,
          }))}
          value={activeFilter}
          onChange={setActiveFilter}
        />
      </TableFiltersCard>

      {isError ? (
        <AdminListError onRetry={() => refetch()} message="We couldn't load partners." />
      ) : isLoading ? (
        <AdminListLoading />
      ) : (
        <>
          {/* Mobile: card list. Renew + edit happen via tap → drawer. */}
          <div className="md:hidden space-y-2">
            {sortedPartners.map((partner) => (
              <button
                key={partner.id}
                type="button"
                onClick={() => setEditingPartner(toEditing(partner))}
                className="w-full text-left bg-card border border-border rounded-2xl p-4 hover:border-foreground/20 active:bg-muted/50 transition"
              >
                <div className="flex items-center gap-3 mb-2">
                  <Avatar src={partner.image} name={partner.name} shape="squircle" />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-foreground truncate">{partner.name}</div>
                    <div className="text-xs text-muted-foreground capitalize">{partner.type}</div>
                  </div>
                  <StatusPill
                    intent={partner.status === "active" ? "success" : "neutral"}
                    size="sm"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${partner.status === "active" ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
                    />
                    {partner.status === "active" ? "Active" : "Inactive"}
                  </StatusPill>
                </div>
                <div className="text-xs text-muted-foreground">
                  Active until{" "}
                  <span className="text-foreground/80 font-medium">
                    {formatActiveUntil((partner as any).activeUntil)}
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
                        {...sortableThProps(handleSort, "name")}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          Partner Name{" "}
                          <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="name" />
                        </span>
                      </th>
                      <th
                        className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                        {...sortableThProps(handleSort, "type")}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          Type <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="type" />
                        </span>
                      </th>
                      <th
                        className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                        {...sortableThProps(handleSort, "activeUntil")}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          Active Until{" "}
                          <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="activeUntil" />
                        </span>
                      </th>
                      <th
                        className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                        {...sortableThProps(handleSort, "createdAt")}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          Created{" "}
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
                      <th className="px-6 py-4 font-semibold text-foreground text-right">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sortedPartners.map((partner) => (
                      <tr
                        key={partner.id}
                        className="hover:bg-muted/50 transition cursor-pointer"
                        onClick={() => setEditingPartner(toEditing(partner))}
                      >
                        <td className="px-6 py-4 font-medium text-foreground">
                          <div className="flex items-center gap-3">
                            <Avatar
                              src={partner.image}
                              name={partner.name}
                              shape="squircle"
                              size="sm"
                            />
                            <span>{partner.name}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 capitalize">
                          <span className="px-2 py-1 bg-secondary rounded text-xs font-semibold text-muted-foreground">
                            {partner.type}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-muted-foreground whitespace-nowrap">
                          {formatActiveUntil((partner as any).activeUntil)}
                        </td>
                        <td className="px-6 py-4 text-muted-foreground whitespace-nowrap">
                          {formatActiveUntil((partner as any).createdAt)}
                        </td>
                        <td className="px-6 py-4">
                          <StatusPill intent={partner.status === "active" ? "success" : "neutral"}>
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${partner.status === "active" ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
                            />
                            {partner.status === "active" ? "Active" : "Inactive"}
                          </StatusPill>
                        </td>
                        <td className="px-6 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                disabled={renewPartner.isPending}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-secondary/80 text-foreground rounded-md transition disabled:opacity-60"
                              >
                                <RefreshCw size={12} />
                                Renew
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-40">
                              <DropdownMenuLabel>Extend by</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              {PARTNER_DURATION_OPTIONS.map((m) => (
                                <DropdownMenuItem
                                  key={m}
                                  onClick={() => handleRenew(partner.id, m)}
                                >
                                  {m} {m === 1 ? "month" : "months"}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pagination (Mock) */}
            <div className="border-t border-border px-6 py-4 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Showing {filteredPartners.length} of {partners.length} partners
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
          {filteredPartners.length === 0 && (
            <TableEmptyState
              icon={<Handshake size={24} className="opacity-50" />}
              title="No partners found"
              description="Try adjusting your filters."
            />
          )}
        </>
      )}

      <ResponsiveDrawer
        open={!!editingPartner}
        onOpenChange={(open) => {
          if (!open) setEditingPartner(null);
        }}
        title={isNew ? "New Partner" : "Edit Partner"}
        footer={
          editingPartner && (
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setEditingPartner(null)}
                className="px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary rounded-lg transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg transition shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isSaving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          )
        }
      >
        {editingPartner && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Partner Name</label>
              <input
                type="text"
                value={editingPartner.name}
                onChange={(e) => setEditingPartner({ ...editingPartner, name: e.target.value })}
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Type</label>
                <select
                  value={editingPartner.type}
                  onChange={(e) =>
                    setEditingPartner({ ...editingPartner, type: e.target.value as PartnerType })
                  }
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 capitalize"
                >
                  <option value="broker">Broker</option>
                  <option value="contractor">Contractor</option>
                  <option value="legal">Legal</option>
                  <option value="cleaning">Cleaning</option>
                  <option value="insurance">Insurance</option>
                </select>
              </div>
              <div>
                {isNew ? (
                  <>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Active For
                    </label>
                    <select
                      value={editingPartner.durationMonths}
                      onChange={(e) =>
                        setEditingPartner({
                          ...editingPartner,
                          durationMonths: Number(e.target.value) as PartnerDurationMonths,
                        })
                      }
                      className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    >
                      {PARTNER_DURATION_OPTIONS.map((m) => (
                        <option key={m} value={m}>
                          {m} {m === 1 ? "month" : "months"}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground mt-1">
                      Auto-inactivates after this period.
                    </p>
                  </>
                ) : (
                  <>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Active Until
                    </label>
                    <div className="w-full bg-muted border border-input rounded-lg px-3 py-2 text-sm text-muted-foreground">
                      {formatActiveUntil(editingPartner.activeUntil)}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Use Renew to extend the active period.
                    </p>
                  </>
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Contact Person
              </label>
              <input
                type="text"
                value={editingPartner.contactName}
                onChange={(e) =>
                  setEditingPartner({ ...editingPartner, contactName: e.target.value })
                }
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Email</label>
                <input
                  type="email"
                  value={editingPartner.email}
                  onChange={(e) => setEditingPartner({ ...editingPartner, email: e.target.value })}
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Phone</label>
                <input
                  type="text"
                  value={editingPartner.phone}
                  onChange={(e) => setEditingPartner({ ...editingPartner, phone: e.target.value })}
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
          </div>
        )}
      </ResponsiveDrawer>
    </div>
  );
}
