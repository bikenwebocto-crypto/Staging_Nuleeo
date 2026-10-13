import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Banknote, Check, CreditCard } from "lucide-react";
import { NotificationBell } from "@ui/components/common/NotificationBell";
import { Avatar } from "@ui/components/common/Avatar";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { useToast } from "@ui/hooks/use-toast";
import { formatCurrencyCompact, formatCurrencyTrim } from "@ui/lib/format";
import {
  useAdminMarketplaceLeads,
  useUpdateMarketplaceLead,
  useAdminTransactions,
} from "@/lib/adminQueries";

// localStorage baseline for "transactions I've already seen". Transactions are
// an immutable ledger with no per-admin read flag, so the bell treats anything
// newer than this timestamp as new.
const TX_SEEN_KEY = "adminTxSeenAt";

// Cap the rendered transaction feed so a long absence can't dump hundreds of
// rows into the dropdown; any overflow is disclosed by a "+N more" row.
const MAX_TX_ROWS = 15;

// Admin header bell. Surfaces things staff act on without watching a table:
//   • NEW marketplace leads (an owner clicked "I'm interested") — gated on
//     comm.activityLog (the server gate for lead PII), with Mark-contacted.
//   • NEW money movements (real Stripe rent + subscription payments) — gated on
//     finance.viewAll (the server gate for the transactions feed).
// Each source is gated independently; an admin with only one privilege sees
// only that source, and an admin with neither gets no bell at all.
export function AdminNotificationsButton() {
  const { canPlatform } = usePrivileges();
  const canLeads = canPlatform("comm.activityLog");
  const canTx = canPlatform("finance.viewAll");
  // Guard BEFORE the data hooks so unprivileged admins never fire the (403'd,
  // PII-bearing) queries. Mounting the inner component conditionally keeps its
  // hook calls unconditional.
  if (!canLeads && !canTx) return null;
  return <AdminNotifications canLeads={canLeads} canTx={canTx} />;
}

function AdminNotifications({ canLeads, canTx }: { canLeads: boolean; canTx: boolean }) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: leads = [] } = useAdminMarketplaceLeads(canLeads);
  const update = useUpdateMarketplaceLead();
  const newLeads = canLeads ? leads.filter((l) => l.status === "new") : [];

  const { data: txResp } = useAdminTransactions(canTx);
  const txRows = txResp?.rows ?? [];

  // Initialise to "now" on first ever load so the platform's transaction
  // history doesn't all read as new the first time an admin opens the app.
  const [txSeenAt, setTxSeenAt] = useState<string>(() => {
    if (typeof window === "undefined") return new Date().toISOString();
    return localStorage.getItem(TX_SEEN_KEY) ?? new Date().toISOString();
  });
  useEffect(() => {
    if (typeof window !== "undefined" && !localStorage.getItem(TX_SEEN_KEY)) {
      localStorage.setItem(TX_SEEN_KEY, txSeenAt);
    }
  }, [txSeenAt]);
  const markTxSeen = () => {
    const now = new Date().toISOString();
    setTxSeenAt(now);
    if (typeof window !== "undefined") localStorage.setItem(TX_SEEN_KEY, now);
  };

  // ISO 8601 sorts lexicographically, so a string compare is a valid time test.
  const newTransactions = canTx ? txRows.filter((t) => t.timestamp > txSeenAt) : [];
  const shownTransactions = newTransactions.slice(0, MAX_TX_ROWS);
  const extraTransactions = newTransactions.length - shownTransactions.length;

  // Badge total is the TRUE count; the feed below caps at MAX_TX_ROWS and
  // discloses the remainder, so the count never silently outruns the list.
  const count = newLeads.length + newTransactions.length;

  const markContacted = (id: string) => {
    update.mutate(
      { id, status: "contacted" },
      {
        onSuccess: () => toast({ title: "Lead marked as contacted" }),
        onError: (err) =>
          toast({
            title: "Couldn't update lead",
            description: err.message || "Please try again.",
            variant: "destructive",
          }),
      },
    );
  };

  const sourceParts: string[] = [];
  if (canLeads) sourceParts.push("marketplace leads");
  if (canTx) sourceParts.push("transactions");
  const subtitle = `New ${sourceParts.join(" & ")}.`;

  const viewBtnClass =
    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-foreground text-background hover:opacity-90 transition disabled:opacity-50";
  const contactedBtnClass =
    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition disabled:opacity-50";

  return (
    <NotificationBell
      count={count}
      subtitle={subtitle}
      emptyTitle="You're all caught up"
      emptySubtitle="New leads and transactions show up here."
    >
      {(close) => (
        <>
          {newLeads.map((lead) => {
            const goToLeads = () => {
              close();
              setLocation("/admin/investment-leads");
            };
            return (
              <div key={lead.id} className="px-4 py-3 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={goToLeads}
                  className="flex items-start gap-3 text-left w-full rounded-lg hover:opacity-80 transition"
                >
                  <Avatar
                    src={lead.userImage}
                    name={lead.userName}
                    email={lead.userEmail}
                    size="sm"
                    className="flex-shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-foreground truncate">
                      {lead.userName || lead.userEmail || "An Olio user"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Interested in <span className="font-medium">{lead.listingTitle}</span>
                      {lead.listingPrice ? ` (${formatCurrencyCompact(lead.listingPrice)})` : ""}.
                    </div>
                    {lead.message ? (
                      <div className="text-xs text-muted-foreground/80 italic mt-0.5 truncate">
                        “{lead.message}”
                      </div>
                    ) : null}
                  </div>
                </button>
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => markContacted(lead.id)}
                    disabled={update.isPending}
                    className={contactedBtnClass}
                  >
                    <Check size={14} />
                    Mark contacted
                  </button>
                  <button onClick={goToLeads} className={viewBtnClass}>
                    View
                  </button>
                </div>
              </div>
            );
          })}

          {shownTransactions.map((t) => {
            const isRent = t.kind === "rent";
            const secondary = isRent
              ? [t.tenantName, t.propertyAddress].filter(Boolean).join(" · ") || t.name
              : t.name;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  markTxSeen();
                  close();
                  setLocation("/admin/transactions");
                }}
                className="w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-muted/40 transition"
              >
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                    isRent ? "bg-emerald-500/10" : "bg-indigo-500/10"
                  }`}
                >
                  {isRent ? (
                    <Banknote size={16} className="text-emerald-700 dark:text-emerald-400" />
                  ) : (
                    <CreditCard size={16} className="text-indigo-600 dark:text-indigo-400" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-foreground truncate">
                    {formatCurrencyTrim(t.amount, { currency: t.currency })}
                    <span className="font-normal text-muted-foreground">
                      {" · "}
                      {isRent ? "Rent" : "Subscription"}
                    </span>
                  </div>
                  {secondary ? (
                    <div className="text-xs text-muted-foreground truncate">{secondary}</div>
                  ) : null}
                </div>
                {t.status !== "completed" ? (
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wide flex-shrink-0 ${
                      t.status === "failed" ? "text-red-500" : "text-amber-500"
                    }`}
                  >
                    {t.status}
                  </span>
                ) : null}
              </button>
            );
          })}

          {extraTransactions > 0 ? (
            <button
              type="button"
              onClick={() => {
                markTxSeen();
                close();
                setLocation("/admin/transactions");
              }}
              className="w-full px-4 py-3 text-center text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/40 transition"
            >
              +{extraTransactions} more — view all transactions
            </button>
          ) : null}
        </>
      )}
    </NotificationBell>
  );
}
