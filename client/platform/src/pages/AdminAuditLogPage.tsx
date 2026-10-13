// Audit log — combined feed of impersonations + user-record changes
// across the platform. The two underlying collections are written by
// the impersonation endpoint and the admin user PATCH; this page is
// the only read surface. Used by superadmins to answer "who did what
// to whom, when" without dropping to raw Firestore queries.

import { useState } from "react";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import { Search, ShieldCheck, UserCog, Eye } from "lucide-react";
import {
  useAdminAuditLog,
  type AdminAuditEntry,
  type AdminAuditEntryType,
} from "@/lib/adminQueries";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { ForbiddenView } from "@ui/components/ForbiddenView";
import {
  TableFiltersCard,
  TableShellCard,
  FilterPills,
  TableEmptyState,
} from "@ui/components/ui/data-table";
import { formatDateTime } from "@ui/lib/format";

type TypeFilter = "All" | "Impersonation" | "Role changes";

const TYPE_FILTERS: TypeFilter[] = ["All", "Impersonation", "Role changes"];

function filterToApi(label: TypeFilter): AdminAuditEntryType | null {
  if (label === "Impersonation") return "impersonation";
  if (label === "Role changes") return "user-audit";
  return null;
}

// One-line description of what an audit entry represents. Keeps the
// table density high while still surfacing the diff for role/status
// changes.
const ACCOUNT_EVENT_LABELS: Record<string, string> = {
  "password-added": "Added a password",
  "password-removed": "Removed their password",
  "google-connected": "Connected Google",
  "google-disconnected": "Disconnected Google",
  "email-change-requested": "Requested an email change",
};

function describe(entry: AdminAuditEntry): string {
  if (entry.type === "impersonation") {
    return `Viewed as ${entry.targetEmail || entry.targetUid}`;
  }
  // Self-initiated credential-lifecycle events carry an `action` instead of
  // role/status diffs.
  if (entry.action) {
    return ACCOUNT_EVENT_LABELS[entry.action] ?? `Account event: ${entry.action}`;
  }
  const parts: string[] = [];
  if (
    entry.beforeRoles !== undefined &&
    entry.afterRoles !== undefined &&
    JSON.stringify(entry.beforeRoles) !== JSON.stringify(entry.afterRoles)
  ) {
    parts.push(
      `roles: ${entry.beforeRoles.join("+") || "—"} → ${entry.afterRoles.join("+") || "—"}`,
    );
  }
  if (
    entry.beforePlatformRole !== undefined &&
    entry.afterPlatformRole !== undefined &&
    entry.beforePlatformRole !== entry.afterPlatformRole
  ) {
    parts.push(
      `platformRole: ${entry.beforePlatformRole ?? "—"} → ${entry.afterPlatformRole ?? "—"}`,
    );
  }
  if (
    entry.beforeStatus !== undefined &&
    entry.afterStatus !== undefined &&
    entry.beforeStatus !== entry.afterStatus
  ) {
    parts.push(`status: ${entry.beforeStatus} → ${entry.afterStatus}`);
  }
  if (parts.length === 0) return "User record updated";
  return parts.join("  ·  ");
}

// Presentation for an entry's type chip — shared by the desktop table and the
// mobile cards so they never drift. Tokenized (warning/info) so it reads in
// both themes.
const typeMeta = (type: AdminAuditEntry["type"]) =>
  type === "impersonation"
    ? { Icon: Eye, label: "Impersonation", badge: "bg-warning/10 text-warning" }
    : { Icon: UserCog, label: "Role / status", badge: "bg-info/10 text-info" };

export default function AdminAuditLogPage() {
  const { canPlatform } = usePrivileges();
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("All");
  const [search, setSearch] = useState("");

  const { data, isLoading } = useAdminAuditLog({
    type: filterToApi(typeFilter),
  });
  const entries = data?.items ?? [];

  // Search filters client-side across actor / target emails — cheap +
  // matches the patterns the existing admin tables use.
  const q = search.trim().toLowerCase();
  const filtered = q
    ? entries.filter(
        (e) =>
          e.actorEmail.toLowerCase().includes(q) ||
          e.targetEmail.toLowerCase().includes(q) ||
          e.actorUid.toLowerCase().includes(q) ||
          e.targetUid.toLowerCase().includes(q),
      )
    : entries;

  if (!canPlatform("users.viewAll")) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <ForbiddenView
          title="Audit log locked"
          message="Your platform role doesn't include the 'View all users' privilege. An admin can grant it in Settings → Platform Roles."
        />
      </div>
    );
  }

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-8 md:mb-2 mt-4 md:mt-0">
        <div className="md:hidden">
          <h1 className="text-2xl md:text-3xl font-bold text-foreground tracking-tight">
            Audit Log
          </h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Who changed what, and when
          </p>
        </div>
      </div>

      <TableFiltersCard>
        <div className="flex flex-col md:flex-row gap-4 items-center">
          <div className="relative flex-1 w-full">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              size={18}
            />
            <input
              type="text"
              placeholder="Search by actor / target email or UID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-muted border-none rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
            />
          </div>
        </div>
        <FilterPills
          options={TYPE_FILTERS.map((t) => ({ id: t, label: t }))}
          value={typeFilter}
          onChange={(v) => setTypeFilter(v as TypeFilter)}
        />
      </TableFiltersCard>

      {/* Desktop: dense table */}
      <div className="hidden md:block">
        <TableShellCard>
          <table className="w-full text-sm">
            <thead className="text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider border-b border-border">
              <tr>
                <th className="p-3">When</th>
                <th className="p-3">Type</th>
                <th className="p-3">Actor</th>
                <th className="p-3">Target</th>
                <th className="p-3">Change</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => {
                const { Icon, label: typeLabel, badge: typeBg } = typeMeta(entry.type);
                return (
                  <tr
                    key={`${entry.type}-${entry.id}`}
                    className="border-b border-border last:border-0 hover:bg-muted/30 transition"
                  >
                    <td className="p-3 text-muted-foreground whitespace-nowrap">
                      {formatDateTime(entry.createdAt)}
                    </td>
                    <td className="p-3">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${typeBg}`}
                      >
                        <Icon size={12} />
                        {typeLabel}
                      </span>
                    </td>
                    <td className="p-3 text-foreground">
                      <div className="truncate max-w-[200px]" title={entry.actorEmail}>
                        {entry.actorEmail || entry.actorUid}
                      </div>
                    </td>
                    <td className="p-3 text-foreground">
                      <div className="truncate max-w-[200px]" title={entry.targetEmail}>
                        {entry.targetEmail || entry.targetUid}
                      </div>
                    </td>
                    <td className="p-3 text-muted-foreground">{describe(entry)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <TableEmptyState
              icon={<ShieldCheck size={32} className="text-muted-foreground" />}
              title={isLoading ? "Loading…" : "No audit entries"}
              description={
                isLoading
                  ? "Fetching the latest admin actions."
                  : q
                    ? "No entries match that search. Try clearing the filter."
                    : "Nothing recorded yet. Impersonations + role changes will appear here as admins act."
              }
            />
          )}
        </TableShellCard>
      </div>

      {/* Mobile: stacked cards (the raw table overflowed the viewport) */}
      <div className="md:hidden space-y-3">
        {filtered.map((entry) => {
          const { Icon, label: typeLabel, badge: typeBg } = typeMeta(entry.type);
          return (
            <div
              key={`${entry.type}-${entry.id}`}
              className="bg-card border border-border rounded-xl p-4 shadow-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${typeBg}`}
                >
                  <Icon size={12} />
                  {typeLabel}
                </span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {formatDateTime(entry.createdAt)}
                </span>
              </div>
              <div className="mt-3 text-sm">
                <span className="text-muted-foreground">Actor: </span>
                <span className="text-foreground break-all">
                  {entry.actorEmail || entry.actorUid}
                </span>
              </div>
              <div className="mt-1 text-sm">
                <span className="text-muted-foreground">Target: </span>
                <span className="text-foreground break-all">
                  {entry.targetEmail || entry.targetUid}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{describe(entry)}</p>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <TableShellCard>
            <TableEmptyState
              icon={<ShieldCheck size={32} className="text-muted-foreground" />}
              title={isLoading ? "Loading…" : "No audit entries"}
              description={
                isLoading
                  ? "Fetching the latest admin actions."
                  : q
                    ? "No entries match that search. Try clearing the filter."
                    : "Nothing recorded yet. Impersonations + role changes will appear here as admins act."
              }
            />
          </TableShellCard>
        )}
      </div>
    </div>
  );
}
