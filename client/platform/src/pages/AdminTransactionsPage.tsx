import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import {
  Search,
  Filter,
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  MoreHorizontal,
  Building,
  User,
  FileText,
  Receipt,
} from "lucide-react";
import {
  TableSortIcon,
  TableFiltersCard,
  TableShellCard,
  FilterPills,
  TableEmptyState,
} from "@ui/components/ui/data-table";
import { useState } from "react";
import { useAdminTransactions } from "@/lib/adminQueries";
import { InvoiceModal } from "@/components/admin/InvoiceModal";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { ForbiddenView } from "@ui/components/ForbiddenView";
import {
  AdminListLoading,
  AdminListError,
  sortableThProps,
} from "@/components/common/AdminListStates";
import { formatCurrency, formatDateTime } from "@ui/lib/format";

export default function AdminTransactionsPage() {
  const { canPlatform } = usePrivileges();
  const [searchTerm, setSearchTerm] = useState("");
  const [filter, setFilter] = useState("All");
  const [selectedInvoice, setSelectedInvoice] = useState<any>(null);

  const { data, isLoading, isError, refetch } = useAdminTransactions();
  const transactions = data?.rows ?? [];
  const truncated = !!data && (data.rentCapped || data.subscriptionsCapped);

  // Adapt API rows to the field shape the table + InvoiceModal render.
  // Rows are real Stripe movements only: the payer is the tenant for a
  // Connect rent payment and the owner for a subscription payment.
  const mappedTransactions = transactions.map((tx) => ({
    id: tx.id,
    kind: tx.kind,
    type: tx.name,
    amount: tx.amount,
    platformFee: tx.platformFeeCents != null ? tx.platformFeeCents / 100 : null,
    // Refund (rent only) — amount returned to the cardholder and the platform
    // fee refunded, in major units. null when the payment was never refunded.
    refund: tx.refundedAmountCents != null ? tx.refundedAmountCents / 100 : null,
    feeRefund: tx.feeRefundedCents != null ? tx.feeRefundedCents / 100 : null,
    status:
      tx.status === "completed" ? "Completed" : tx.status === "pending" ? "Pending" : "Failed",
    date: tx.timestamp,
    property: tx.propertyAddress ?? "-",
    // No cross-party fallback: a rent row whose tenancy can no longer be
    // resolved (deleted account, legacy row) must show "—", not the OWNER's
    // name labeled as the paying tenant. "Subscriber" rather than "Owner"
    // because a subscription buyer isn't guaranteed to hold the owner role.
    user: (tx.kind === "subscription" ? tx.ownerName : tx.tenantName) ?? "—",
    userRole: tx.kind === "subscription" ? "Subscriber" : "Tenant",
    via: tx.kind === "subscription" ? "Stripe Billing" : "Stripe Connect",
  }));

  const filteredTransactions = mappedTransactions.filter((tx) => {
    // Text search
    const matchesSearch =
      tx.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      tx.user.toLowerCase().includes(searchTerm.toLowerCase()) ||
      tx.type.toLowerCase().includes(searchTerm.toLowerCase()) ||
      tx.property.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesFilter =
      filter === "Rent payments"
        ? tx.kind === "rent"
        : filter === "Subscriptions"
          ? tx.kind === "subscription"
          : true;

    return matchesSearch && matchesFilter;
  });

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

  const sortedTransactions = [...filteredTransactions].sort((a, b) => {
    if (!sortKey) return 0;
    const dir = sortDir === "asc" ? 1 : -1;
    const valA = (a as any)[sortKey];
    const valB = (b as any)[sortKey];
    // Numeric columns can hold null (platformFee on fee-less rent rows) —
    // sink those below every real number in BOTH directions (a fixed
    // sentinel would float every "—" row to the top on the first,
    // ascending click) instead of string-comparing "null".
    if (typeof valA === "number" || typeof valB === "number") {
      const sentinel = dir === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      const numA = typeof valA === "number" ? valA : sentinel;
      const numB = typeof valB === "number" ? valB : sentinel;
      return (numA - numB) * dir;
    }
    return String(valA).localeCompare(String(valB)) * dir;
  });

  // Shadow the shared formatters so call sites at this scope keep working:
  // local formatCurrency expects a possibly-signed amount and applies abs(),
  // local formatDate is en-IE date+time. Implemented as thin wrappers.
  const fmtCurrency = (amount: number) => formatCurrency(Math.abs(amount));
  const formatDate = (dateString: string) => formatDateTime(dateString);

  if (!canPlatform("finance.viewAll")) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <ForbiddenView
          title="Transactions locked"
          message="Your platform role doesn't include the 'View all transactions' privilege. An admin can grant it in Settings → Platform Roles."
        />
      </div>
    );
  }

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-8 md:mb-2 mt-4 md:mt-0">
        <div className="md:hidden">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Transaction History</h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Payments processed through Stripe — rent payments and owner subscriptions
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
              placeholder="Search by ID, user, or property..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-muted border-none rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
            />
          </div>
        </div>
        <FilterPills
          options={["All", "Rent payments", "Subscriptions"].map((t) => ({ id: t, label: t }))}
          value={filter}
          onChange={setFilter}
        />
        {/* Scope note at every breakpoint — the page subtitle above only
            renders on mobile, and offline rows vanishing without a visible
            explanation would read as missing data to a desktop admin. */}
        <p className="text-xs text-muted-foreground mt-3">
          Only payments processed through Stripe are listed — offline rent and owner-recorded ledger
          entries are not included.
        </p>
        {/* Disclose the cap so older rows vanishing past it isn't read as data
            loss. Without this the newest-N window looks like the full history. */}
        {truncated && (
          <p className="text-xs text-warning mt-1">
            Showing the most recent payments only — older entries beyond this window aren&apos;t
            listed here. See the Stripe Dashboard for the complete history.
          </p>
        )}
      </TableFiltersCard>

      {isError ? (
        <AdminListError onRetry={() => refetch()} message="We couldn't load transactions." />
      ) : isLoading ? (
        <AdminListLoading />
      ) : (
        <>
          {/* Mobile List */}
          <div className="md:hidden">
            <TableShellCard className="divide-y divide-border">
              {sortedTransactions.map((tx) => (
                <button
                  key={tx.id}
                  type="button"
                  className="w-full text-left flex items-center justify-between px-4 py-2.5 active:bg-muted/50 transition cursor-pointer"
                  onClick={() => setSelectedInvoice(tx)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`p-1 rounded-full shrink-0 ${
                        tx.amount > 0
                          ? "bg-success text-success-foreground"
                          : "bg-warning text-warning-foreground"
                      }`}
                    >
                      {tx.amount > 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-foreground text-sm truncate">{tx.user}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{tx.type}</div>
                    </div>
                  </div>
                  <div className="shrink-0 ml-3 text-right">
                    <span
                      className={`text-sm font-semibold ${tx.amount > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"}`}
                    >
                      {tx.amount > 0 ? "+" : "-"}
                      {fmtCurrency(tx.amount)}
                    </span>
                    {tx.kind === "rent" && tx.platformFee != null && (
                      <div className="text-[11px] text-muted-foreground">
                        Fee {fmtCurrency(tx.platformFee)}
                      </div>
                    )}
                    {tx.refund != null && tx.refund > 0 && (
                      <div className="text-[11px] text-destructive">
                        −{fmtCurrency(tx.refund)} refunded
                      </div>
                    )}
                  </div>
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
                          {...sortableThProps(handleSort, "id")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Transaction ID{" "}
                            <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="id" />
                          </span>
                        </th>
                        <th
                          className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "user")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            User <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="user" />
                          </span>
                        </th>
                        <th
                          className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "type")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Details{" "}
                            <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="type" />
                          </span>
                        </th>
                        <th
                          className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "amount")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Amount{" "}
                            <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="amount" />
                          </span>
                        </th>
                        <th
                          className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "platformFee")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Platform Fee{" "}
                            <TableSortIcon
                              sortKey={sortKey}
                              sortDir={sortDir}
                              column="platformFee"
                            />
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
                        <th
                          className="px-6 py-4 font-semibold text-foreground cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "date")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Date <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="date" />
                          </span>
                        </th>
                        <th className="px-6 py-4 font-semibold text-foreground text-right">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {sortedTransactions.map((tx) => (
                        <tr key={tx.id} className="hover:bg-muted/50 transition">
                          <td className="px-6 py-4">
                            <span className="font-medium text-foreground">{tx.id}</span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-col">
                              <span className="font-medium text-foreground">{tx.user}</span>
                              <span className="text-xs text-muted-foreground">{tx.userRole}</span>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-col">
                              <span className="text-foreground">{tx.type}</span>
                              {tx.property !== "-" ? (
                                <span className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                                  <Building size={10} />
                                  {tx.property}
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground mt-0.5">
                                  {tx.via}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              <div
                                className={`p-1 rounded-full ${
                                  tx.amount > 0
                                    ? "bg-success text-success-foreground"
                                    : "bg-warning text-warning-foreground"
                                }`}
                              >
                                {tx.amount > 0 ? (
                                  <ArrowUpRight size={12} />
                                ) : (
                                  <ArrowDownRight size={12} />
                                )}
                              </div>
                              <div className="flex flex-col">
                                <span
                                  className={`font-medium ${tx.amount > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"}`}
                                >
                                  {tx.amount > 0 ? "+" : "-"}
                                  {fmtCurrency(tx.amount)}
                                </span>
                                {tx.refund != null && tx.refund > 0 && (
                                  <span className="text-[11px] text-destructive">
                                    −{fmtCurrency(tx.refund)} refunded
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            {tx.platformFee != null ? (
                              <span className="font-medium text-foreground">
                                {fmtCurrency(tx.platformFee)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            <span
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                                tx.status === "Completed"
                                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                  : tx.status === "Failed"
                                    ? "bg-red-500/10 text-red-600 dark:text-red-400"
                                    : "bg-orange-500/10 text-orange-600 dark:text-orange-400"
                              }`}
                            >
                              {tx.status}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-muted-foreground text-xs ">
                            {formatDate(tx.date)}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {/* Single action: open the invoice. The modal's footer prints / saves
     as PDF, which covers the download intent — so a separate inert
     "Download" button (no server-side PDF export yet) was removed
     rather than left promising an unimplemented action. */}
                              <button
                                type="button"
                                onClick={() => setSelectedInvoice(tx)}
                                aria-label="View invoice"
                                className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-lg transition"
                                title="View Invoice"
                              >
                                <FileText size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </TableShellCard>
          </div>
          {filteredTransactions.length === 0 && (
            <TableEmptyState
              icon={<Receipt size={24} className="opacity-50" />}
              title="No transactions found"
              description="Try adjusting your filters."
            />
          )}
        </>
      )}

      <InvoiceModal
        isOpen={!!selectedInvoice}
        onClose={() => setSelectedInvoice(null)}
        transaction={selectedInvoice}
      />
    </div>
  );
}
