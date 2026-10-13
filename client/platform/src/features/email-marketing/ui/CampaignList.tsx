// Presentational table of campaigns. Pure renderer: callbacks bubble up to
// the page so the page owns mutation flow.

import { useState } from "react";
import { MailPlus, Pencil, Search, Trash2, Mail } from "lucide-react";
import {
  TableSortIcon,
  TableFiltersCard,
  TableShellCard,
  FilterPills,
  TableEmptyState,
} from "@ui/components/ui/data-table";
import type { EmailCampaign } from "../api/types";
import { CampaignStatusBadge } from "./StatusBadge";
import { audienceSummary } from "../model/audience";
import { fmtDateTime } from "../lib/format";
import { EmptyState } from "./EmptyState";

export interface CampaignListProps {
  campaigns: EmailCampaign[];
  loading: boolean;
  onCreate: () => void;
  onEdit: (id: string) => void;
  onViewStats: (id: string) => void;
  onDelete: (id: string) => void;
}

type FilterId = "All" | "Draft" | "Scheduled" | "Sent" | "Sending" | "Failed" | "Cancelled";

export function CampaignList({
  campaigns,
  loading,
  onCreate,
  onEdit,
  onViewStats,
  onDelete,
}: CampaignListProps) {
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterId>("All");
  const [sortKey, setSortKey] = useState<string>("when");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  if (!loading && campaigns.length === 0) {
    return <EmptyState onCreate={onCreate} />;
  }

  const filtered = campaigns.filter((c) => {
    const q = search.trim().toLowerCase();
    const matchesSearch =
      !q || c.subject.toLowerCase().includes(q) || (c.bodyText ?? "").toLowerCase().includes(q);
    let matchesFilter = true;
    if (activeFilter === "Draft") matchesFilter = c.status === "draft";
    else if (activeFilter === "Scheduled") matchesFilter = c.status === "scheduled";
    else if (activeFilter === "Sent") matchesFilter = c.status === "sent";
    else if (activeFilter === "Sending") matchesFilter = c.status === "sending";
    else if (activeFilter === "Failed") matchesFilter = c.status === "failed";
    else if (activeFilter === "Cancelled") matchesFilter = c.status === "cancelled";
    return matchesSearch && matchesFilter;
  });

  const whenOf = (c: EmailCampaign) =>
    c.sentAt ?? c.scheduledAt ?? c.updatedAt ?? c.createdAt ?? "";
  const sorted = [...filtered].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    if (sortKey === "subject") return (a.subject || "").localeCompare(b.subject || "") * dir;
    if (sortKey === "audience") return audienceSummary(a).localeCompare(audienceSummary(b)) * dir;
    if (sortKey === "status") return a.status.localeCompare(b.status) * dir;
    if (sortKey === "recipients") return ((a.recipientCount ?? 0) - (b.recipientCount ?? 0)) * dir;
    // default: "when"
    return whenOf(a).localeCompare(whenOf(b)) * dir;
  });

  return (
    <>
      <TableFiltersCard>
        <div className="flex flex-col md:flex-row gap-4 items-center">
          <div className="relative flex-1 w-full">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              size={18}
            />
            <input
              type="text"
              placeholder="Search by subject or content..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-muted border-none rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
            />
          </div>
          <button
            onClick={onCreate}
            className="w-full md:w-auto flex items-center justify-center gap-2 px-4 py-2.5 bg-foreground text-background rounded-lg text-sm font-semibold hover:opacity-90 transition whitespace-nowrap"
          >
            <MailPlus size={15} />
            New campaign
          </button>
        </div>
        <FilterPills
          options={["All", "Draft", "Scheduled", "Sending", "Sent", "Failed", "Cancelled"].map(
            (t) => ({
              id: t,
              label: t,
            }),
          )}
          value={activeFilter}
          onChange={(id) => setActiveFilter(id as FilterId)}
        />
      </TableFiltersCard>

      <TableShellCard>
        <div className="overflow-x-auto -mx-6 md:mx-0">
          <div className="inline-block min-w-full align-middle px-6 md:px-0">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted border-b border-border">
                <tr>
                  <th
                    className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                    onClick={() => handleSort("subject")}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      Subject <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="subject" />
                    </span>
                  </th>
                  <th
                    className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                    onClick={() => handleSort("audience")}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      Audience{" "}
                      <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="audience" />
                    </span>
                  </th>
                  <th
                    className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                    onClick={() => handleSort("recipients")}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      Recipients{" "}
                      <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="recipients" />
                    </span>
                  </th>
                  <th
                    className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                    onClick={() => handleSort("when")}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      Sent / scheduled{" "}
                      <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="when" />
                    </span>
                  </th>
                  <th
                    className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                    onClick={() => handleSort("status")}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      Status <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="status" />
                    </span>
                  </th>
                  <th className="px-6 py-4 font-semibold text-foreground text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading && campaigns.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-6 py-12 text-center text-sm text-muted-foreground"
                    >
                      Loading…
                    </td>
                  </tr>
                ) : (
                  sorted.map((c) => {
                    const editable = c.status === "draft";
                    const hasStats =
                      c.status === "sent" || c.status === "sending" || c.status === "cancelled";
                    const when = c.sentAt ?? c.scheduledAt;
                    return (
                      <tr
                        key={c.id}
                        className="hover:bg-muted/50 transition cursor-pointer"
                        onClick={() => (hasStats ? onViewStats(c.id) : onEdit(c.id))}
                      >
                        <td className="px-6 py-4 font-medium text-foreground">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-8 h-8 rounded-[10px] bg-muted border border-border flex items-center justify-center shrink-0">
                              <Mail size={14} className="text-muted-foreground" />
                            </div>
                            <div className="min-w-0">
                              <div className="truncate">{c.subject || "(no subject)"}</div>
                              <div className="text-xs text-muted-foreground truncate">
                                {(c.bodyText || "").slice(0, 80) || "—"}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-muted-foreground">
                          <span
                            className="px-2 py-1 bg-secondary rounded text-xs font-semibold text-muted-foreground max-w-[220px] inline-block truncate align-middle"
                            title={audienceSummary(c)}
                          >
                            {audienceSummary(c)}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-muted-foreground whitespace-nowrap">
                          {c.recipientCount ?? 0}
                        </td>
                        <td className="px-6 py-4 text-muted-foreground whitespace-nowrap">
                          {fmtDateTime(when)}
                        </td>
                        <td className="px-6 py-4">
                          <CampaignStatusBadge status={c.status} />
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center justify-end gap-1">
                            {editable && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onEdit(c.id);
                                }}
                                className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                                title="Edit"
                              >
                                <Pencil size={14} />
                              </button>
                            )}
                            {(editable || c.status === "cancelled") && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onDelete(c.id);
                                }}
                                className="p-1.5 rounded-lg hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive"
                                title="Delete"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="border-t border-border px-6 py-4 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Showing {sorted.length} of {campaigns.length} campaigns
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

      {sorted.length === 0 && !loading && (
        <TableEmptyState
          icon={<MailPlus size={24} className="opacity-50" />}
          title="No campaigns match your filters"
          description="Try adjusting your search or status filter."
        />
      )}
    </>
  );
}
