import { useMemo, useState } from "react";
import { Trash2, Edit2, UserPlus } from "lucide-react";
import { useAccessContacts, useDeleteAccessContact } from "@/lib/ownerQueries";
import type { AccessContactType } from "@shared/firestore-schema";
import {
  TableShellCard,
  TableEmptyState,
  TableFiltersCard,
  TableSearchInput,
  FilterPills,
} from "@ui/components/ui/data-table";
import { StatusPill } from "@ui/components/common/StatusPill";
import { PageHeader } from "@ui/components/common/PageHeader";
import { PORTFOLIO_ACCESS_CONTACT_TYPES } from "@/components/common/AddPortfolioAccessDrawer";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { useConfirm } from "@ui/components/common/ConfirmDialog";
import { useToast } from "@ui/hooks/use-toast";

export default function PortfolioAccessPage() {
  const accessContactsQuery = useAccessContacts();
  const accessContacts = accessContactsQuery.data ?? [];
  const deleteAccessContact = useDeleteAccessContact();
  const { toast } = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const handleDelete = async (contact: (typeof accessContacts)[number], label: string) => {
    const ok = await confirm({
      title: "Remove access contact?",
      description: (
        <>
          This removes <span className="font-semibold text-foreground">{contact.name}</span> as your{" "}
          {label}. They'll lose the associated access to your portfolio.
        </>
      ),
      confirmLabel: "Remove",
      tone: "destructive",
    });
    if (!ok) return;
    deleteAccessContact.mutate(contact.type, {
      onError: () =>
        toast({
          title: "Couldn't remove contact",
          description: "Something went wrong. Please try again.",
        }),
    });
  };

  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  const handleEdit = (type: AccessContactType) => {
    const existing = accessContacts.find((c) => c.type === type);
    if (!existing) return;
    window.dispatchEvent(
      new CustomEvent("open-portfolio-access-edit", {
        detail: { type: existing.type, name: existing.name, email: existing.email },
      }),
    );
  };

  const visibleRows = accessContacts
    .map((c) => ({
      contact: c,
      meta: PORTFOLIO_ACCESS_CONTACT_TYPES.find((t) => t.id === c.type)!,
    }))
    .filter((r) => r.meta);

  // "All" plus one pill per contact type (Legacy / Legal / Financial),
  // dropping the redundant " Contact" suffix so the pills stay compact.
  const typeFilterOptions = [
    { id: "all", label: "All" },
    ...PORTFOLIO_ACCESS_CONTACT_TYPES.map((t) => ({
      id: t.id,
      label: t.label.replace(/ Contact$/, ""),
    })),
  ];

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return visibleRows.filter(({ contact, meta }) => {
      if (typeFilter !== "all" && meta.id !== typeFilter) return false;
      if (!q) return true;
      const hay =
        `${contact.name} ${contact.email} ${meta.label} ${meta.permissions}`.toLowerCase();
      return hay.includes(q);
    });
  }, [visibleRows, searchQuery, typeFilter]);

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <PageHeader
        title="Portfolio Access"
        subtitle="Manage who has access to your data and properties"
      />
      {confirmDialog}

      <div className="max-w-md mx-auto md:max-w-none md:mx-0">
        <TableFiltersCard>
          <TableSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search by name, email, or contact type…"
          />
          <FilterPills options={typeFilterOptions} value={typeFilter} onChange={setTypeFilter} />
        </TableFiltersCard>

        {/* Desktop Table */}
        <div className="hidden md:block">
          <TableShellCard>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted border-b border-border">
                  <tr>
                    <th className="px-6 py-4 font-semibold text-foreground">Contact Type</th>
                    <th className="px-6 py-4 font-semibold text-foreground">Permissions</th>
                    <th className="px-6 py-4 font-semibold text-foreground">Assigned Contact</th>
                    <th className="px-6 py-4 font-semibold text-foreground">Status</th>
                    <th className="px-6 py-4 font-semibold text-foreground text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredRows.map(({ contact, meta }) => (
                    <tr key={contact.type} className="hover:bg-muted/50 transition">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${meta.bg}`}
                          >
                            <meta.icon size={18} className={meta.color} />
                          </div>
                          <div>
                            <div className="font-semibold text-foreground">{meta.label}</div>
                            <div className="text-xs text-muted-foreground">{meta.description}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-[11px] font-bold bg-secondary text-muted-foreground px-2.5 py-1 rounded-md uppercase">
                          {meta.permissions}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-muted-foreground font-bold text-xs flex-shrink-0">
                            {contact.name.charAt(0)}
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium text-foreground truncate">
                              {contact.name}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              {contact.email}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <StatusPill intent="success" size="sm">
                          Active
                        </StatusPill>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => handleEdit(contact.type)}
                            className="p-2 text-muted-foreground/70 hover:text-foreground transition rounded-lg hover:bg-secondary"
                            title="Edit"
                          >
                            <Edit2 size={16} />
                          </button>
                          <button
                            onClick={() => handleDelete(contact, meta.label)}
                            className="p-2 text-muted-foreground/70 hover:text-destructive transition rounded-lg hover:bg-destructive/10"
                            title="Remove"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TableShellCard>
          {filteredRows.length === 0 && (
            <TableEmptyState
              icon={<UserPlus size={24} className="opacity-50" />}
              title={
                visibleRows.length === 0
                  ? "No portfolio access contacts yet"
                  : "No contacts match your search"
              }
              description={
                visibleRows.length === 0
                  ? "Use the + button in the header and choose Add Portfolio User to grant access."
                  : "Try a different search or contact-type filter."
              }
            />
          )}
        </div>

        {/* Mobile */}
        <div className="md:hidden">
          {accessContactsQuery.isLoading ? null : filteredRows.length === 0 ? (
            <div className="mb-4 p-6 rounded-2xl border border-dashed border-border bg-card/40 text-center">
              <p className="text-sm font-semibold text-foreground">
                {visibleRows.length === 0
                  ? "No portfolio access contacts yet"
                  : "No contacts match your search"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {visibleRows.length === 0
                  ? "Use the + button in the header and choose Add Portfolio User to grant access."
                  : "Try a different search or contact-type filter."}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredRows.map(({ contact, meta }) => (
                <div
                  key={contact.type}
                  className="bg-card p-5 rounded-2xl shadow-sm border border-border"
                >
                  <div className="flex items-start justify-between mb-1">
                    <div className="flex items-center gap-4">
                      <div
                        className={`w-12 h-12 rounded-full flex items-center justify-center ${meta.bg}`}
                      >
                        <meta.icon size={22} className={meta.color} />
                      </div>
                      <div>
                        <h3 className="font-bold text-foreground text-[16px] leading-tight">
                          {meta.label}
                        </h3>
                        <p className="text-[13px] text-muted-foreground leading-snug pr-4">
                          {meta.description}
                        </p>
                      </div>
                    </div>
                    <span className="text-[11px] font-bold bg-secondary text-muted-foreground px-3 py-1.5 rounded-xl uppercase flex-shrink-0 mt-1">
                      {meta.permissions}
                    </span>
                  </div>
                  <div className="mt-4 bg-background rounded-[1.25rem] p-4 flex items-center justify-between border border-border shadow-inner">
                    <div className="flex items-center gap-3 overflow-hidden">
                      <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-muted-foreground font-bold text-sm flex-shrink-0">
                        {contact.name.charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[15px] font-bold text-foreground truncate tracking-tight">
                          {contact.name}
                        </p>
                        <p className="text-[13px] text-muted-foreground truncate">
                          {contact.email}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <StatusPill intent="success" size="sm" className="mr-2">
                        Active
                      </StatusPill>
                      <button
                        onClick={() => handleEdit(contact.type)}
                        className="p-1.5 text-muted-foreground/70 hover:text-foreground transition rounded-lg hover:bg-secondary"
                      >
                        <Edit2 size={16} />
                      </button>
                      <button
                        onClick={() => handleDelete(contact, meta.label)}
                        className="p-1.5 text-muted-foreground/70 hover:text-destructive transition rounded-lg hover:bg-destructive/10"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
