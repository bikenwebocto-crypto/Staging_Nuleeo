import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import {
  Search,
  User,
  Building,
  FileText,
  CreditCard,
  Activity,
  Wrench,
  Package,
  Copy,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { motion } from "framer-motion";
import { useAdminActivity, type AdminActivityRow } from "@/lib/adminQueries";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { ForbiddenView } from "@ui/components/ForbiddenView";
import { AdminListLoading, AdminListError } from "@/components/common/AdminListStates";
import { TableEmptyState } from "@ui/components/ui/data-table";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { formatDateTime } from "@ui/lib/format";
import { useToast } from "@ui/hooks/use-toast";

const entityIcon: Record<string, { icon: typeof User; color: string; bg: string }> = {
  user: { icon: User, color: "text-muted-foreground", bg: "bg-muted dark:bg-card" },
  property: { icon: Building, color: "text-muted-foreground", bg: "bg-muted dark:bg-card" },
  agreement: { icon: FileText, color: "text-muted-foreground", bg: "bg-muted dark:bg-card" },
  access: { icon: ShieldCheck, color: "text-muted-foreground", bg: "bg-muted dark:bg-card" },
  transaction: { icon: CreditCard, color: "text-muted-foreground", bg: "bg-muted dark:bg-card" },
  ticket: { icon: Wrench, color: "text-muted-foreground", bg: "bg-muted dark:bg-card" },
  subscription: { icon: Package, color: "text-muted-foreground", bg: "bg-muted dark:bg-card" },
};

export default function AdminActivityLogPage() {
  const { canPlatform } = usePrivileges();
  const { data: activities = [], isLoading, isError, refetch } = useAdminActivity();
  const [searchTerm, setSearchTerm] = useState("");
  const [filterEntity, setFilterEntity] = useState("All");
  const [selected, setSelected] = useState<AdminActivityRow | null>(null);
  const { toast } = useToast();

  const filteredActivities = activities.filter((act) => {
    const q = searchTerm.toLowerCase();
    const matchesSearch =
      act.title.toLowerCase().includes(q) ||
      act.description.toLowerCase().includes(q) ||
      (act.actorName ?? "").toLowerCase().includes(q);

    const matchesEntity =
      filterEntity === "All" || act.entity.toLowerCase() === filterEntity.toLowerCase();

    return matchesSearch && matchesEntity;
  });

  const formatDate = formatDateTime;

  // The audit-trail "payment" event lists EVERY logged rent payment (offline,
  // cash, manual ledger entries included) — it is NOT the Stripe-only
  // Transaction History page. Labelled "Payments" so it doesn't read as that
  // page; the filter value stays "Transaction" to match the feed's entity tag.
  const entities: Array<{ label: string; value: string }> = [
    { label: "All", value: "All" },
    { label: "User", value: "User" },
    { label: "Property", value: "Property" },
    { label: "Agreement", value: "Agreement" },
    { label: "Access", value: "Access" },
    { label: "Subscription", value: "Subscription" },
    { label: "Payments", value: "Transaction" },
    { label: "Ticket", value: "Ticket" },
  ];

  if (!canPlatform("comm.activityLog")) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <ForbiddenView
          title="Activity log locked"
          message="Your platform role doesn't include the 'View activity log' privilege. An admin can grant it in Settings → Platform Roles."
        />
      </div>
    );
  }

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-8 md:mb-2 mt-4 md:mt-0">
        <div className="md:hidden">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            Platform Activity Log
          </h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Comprehensive audit trail of all system events and user actions
          </p>
        </div>
      </div>

      {/* Filters & Search */}
      <div className="bg-card p-4 rounded-xl border border-border shadow-sm mb-6 space-y-4">
        <div className="flex flex-col md:flex-row gap-4 items-center">
          <div className="relative flex-1 w-full">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              placeholder="Search logs..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-muted border-none rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
            />
          </div>
        </div>
        <div className="relative">
          <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-card to-transparent z-10" />
          <div className="flex gap-2 overflow-x-auto hide-scrollbar">
            {entities.map(({ label, value }) => (
              <button
                key={value}
                onClick={() => setFilterEntity(value)}
                className={`px-5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
                  filterEntity === value
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Activity Timeline */}
      {isError ? (
        <AdminListError onRetry={() => refetch()} message="We couldn't load the activity log." />
      ) : isLoading ? (
        <AdminListLoading />
      ) : (
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden p-6">
          <div className="space-y-6">
            {filteredActivities.length > 0 ? (
              filteredActivities.map((activity, idx) => {
                const meta = entityIcon[activity.entity] ?? {
                  icon: Activity,
                  color: "text-muted-foreground",
                  bg: "bg-muted dark:bg-card",
                };
                const Icon = meta.icon;
                return (
                  <motion.button
                    type="button"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(idx * 0.02, 0.5) }}
                    key={activity.id}
                    onClick={() => setSelected(activity)}
                    className="w-full text-left flex gap-4 relative hover:bg-muted/40 -mx-2 px-2 py-1 rounded-md transition"
                  >
                    {/* Timeline connector */}
                    {idx !== filteredActivities.length - 1 && (
                      <div className="absolute left-7 top-10 bottom-[-16px] w-px bg-border z-0" />
                    )}

                    <div
                      className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center relative z-10 ${meta.bg} border border-border/50`}
                    >
                      <Icon size={18} className={meta.color} />
                    </div>

                    <div className="flex-1 pb-2">
                      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-1 sm:gap-4 mb-1">
                        <h4 className="text-sm font-bold text-foreground">{activity.title}</h4>
                        <span className="text-xs text-muted-foreground font-medium whitespace-nowrap bg-secondary px-2 py-0.5 rounded-md w-fit">
                          {formatDate(activity.timestamp)}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mb-2">{activity.description}</p>
                      <div className="flex items-center gap-3 text-xs">
                        <span className="flex items-center gap-1 font-medium text-foreground bg-secondary/50 px-2 py-1 rounded">
                          <User size={12} className="opacity-50" /> {activity.actorName ?? "System"}
                        </span>
                        <span className="text-muted-foreground">ID: {activity.id}</span>
                      </div>
                    </div>
                  </motion.button>
                );
              })
            ) : (
              <TableEmptyState
                icon={<Activity size={24} className="opacity-50" />}
                title="No activities found"
                description="Try adjusting your filters or search query"
              />
            )}
          </div>
        </div>
      )}

      <ResponsiveDrawer
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title="Activity detail"
      >
        {selected &&
          (() => {
            const meta = entityIcon[selected.entity] ?? {
              icon: Activity,
              color: "text-muted-foreground",
              bg: "bg-muted dark:bg-card",
            };
            const Icon = meta.icon;
            const copy = (value: string, label: string) => {
              navigator.clipboard.writeText(value).then(
                () => toast({ title: `${label} copied` }),
                () =>
                  toast({ title: `Could not copy ${label.toLowerCase()}`, variant: "destructive" }),
              );
            };
            return (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-12 h-12 rounded-full flex-shrink-0 flex items-center justify-center ${meta.bg} border border-border/50`}
                  >
                    <Icon size={22} className={meta.color} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-foreground">{selected.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatDateTime(selected.timestamp)}
                    </div>
                  </div>
                </div>

                <div className="bg-muted/40 rounded-lg p-4 text-sm text-foreground leading-relaxed">
                  {selected.description}
                </div>

                <dl className="space-y-3 text-sm">
                  <Row
                    label="Event ID"
                    value={selected.id}
                    mono
                    onCopy={() => copy(selected.id, "Event ID")}
                  />
                  <Row label="Kind" value={selected.kind} mono />
                  <Row label="Entity" value={selected.entity} />
                  <Row
                    label="Actor"
                    value={selected.actorName ?? "System"}
                    sub={selected.actorEmail ?? undefined}
                    onCopy={
                      selected.actorEmail ? () => copy(selected.actorEmail!, "Email") : undefined
                    }
                  />
                  <Row
                    label="When"
                    value={formatDateTime(selected.timestamp)}
                    sub={new Date(selected.timestamp).toISOString()}
                  />
                </dl>
              </div>
            );
          })()}
      </ResponsiveDrawer>
    </div>
  );
}

function Row({
  label,
  value,
  sub,
  mono,
  onCopy,
}: {
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
  onCopy?: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-border last:border-0">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider w-24 flex-shrink-0">
        {label}
      </div>
      <div className="flex-1 text-right min-w-0">
        <div className={`text-foreground ${mono ? "font-mono text-xs" : "text-sm"} break-all`}>
          {value}
        </div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5 break-all">{sub}</div>}
      </div>
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          aria-label={`Copy ${label}`}
          className="flex-shrink-0 p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition"
        >
          <Copy size={14} />
        </button>
      )}
    </div>
  );
}
