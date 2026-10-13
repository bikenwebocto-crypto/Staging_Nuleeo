import { useState, useMemo, useEffect } from "react";
import { useTenantActivity, useTenantUnits, tenantActivityDisplayType } from "@/lib/tenantQueries";
import {
  useOwnerTransactions,
  useOwnerProperties,
  useVerifyRentPayment,
  useResolveRepair,
} from "@/lib/ownerQueries";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { useToast } from "@ui/hooks/use-toast";

// Display shape consumed by this page's render. Both tenant and owner sides
// adapt their API data into this shape so the JSX below stays uniform.
type ActivityRow = {
  id: string;
  name: string;
  date: string;
  timestamp: number;
  amount: number;
  currency: string; // display symbol, "€" not "EUR"
  type: "income" | "expense" | "neutral";
  category: string;
  status?: string;
  propertyId?: string;
  // Platform-commission breakdown carried through from the Transaction for
  // owner-side display. Absent on offline payments and pre-feature rows.
  applicationFeeCents?: number;
  ownerNetCents?: number;
  // Owner-self manual entries recorded within the last 24h can be corrected
  // in place — drives the edit pencil. Always false on the tenant side and on
  // system-generated rows (rent payments etc.). The server re-checks on PATCH;
  // this only governs whether the affordance is shown.
  editable?: boolean;
};

type ActivityProperty = {
  id: string;
  label: string;
};

// How long after recording a manual activity the owner may still edit it.
// Mirrors MANUAL_EDIT_WINDOW_MS on the server (finance.ts) — keep in sync.
const MANUAL_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
import { useLocation } from "wouter";
import {
  Search,
  Filter,
  ArrowDownUp,
  Download,
  TrendingUp,
  TrendingDown,
  X,
  Calendar,
  Building,
  Euro,
  ArrowRight,
  Check,
  Pencil,
} from "lucide-react";
import {
  RecordActivityDialog,
  type EditActivityValues,
} from "@/components/owner/RecordActivityDialog";
import { activityVisual, isRepairReport } from "@/lib/activityVisual";
import { RepairStatusBadge } from "@/components/common/RepairStatusBadge";
import { motion, AnimatePresence } from "framer-motion";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { PageHeader } from "@ui/components/common/PageHeader";
import { TableFiltersCard, FilterPills, TableSearchInput } from "@ui/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui/components/ui/select";
import { Skeleton } from "@ui/components/common/Skeleton";
import { ListErrorState } from "@/components/common/ListErrorState";
import {
  formatAmountTrim,
  formatCurrencyCompact,
  formatDateTime,
  formatMonthYearLong,
  formatDayMonthYearLong,
  currencySymbol,
} from "@ui/lib/format";

export default function ActivityPage() {
  const [location] = useLocation();
  const isTenantView = location.startsWith("/tenant");
  // Confirm is owner-self only: the verify endpoint requires tx.ownerId ===
  // caller, so a granted contact viewing someone else's portfolio can't (and
  // shouldn't) see the button.
  const { isSelf } = useActivePortfolio();
  const { toast } = useToast();
  const verifyPayment = useVerifyRentPayment();
  const confirmPayment = (id: string) => {
    verifyPayment.mutate(id, {
      onSuccess: () => {
        toast({
          title: "Payment confirmed",
          description: "Your tenant has been notified you received their rent.",
        });
      },
      onError: (err) => {
        toast({
          title: "Couldn't confirm payment",
          description: err.message || "Please try again.",
          variant: "destructive",
        });
      },
    });
  };
  // Owner marks a tenant-reported maintenance issue resolved. Owner-self only
  // (the mutation hits an ownerId-gated endpoint); the button below is gated on
  // !isTenantView + isSelf so a tenant or a granted contact never sees it.
  const resolveRepair = useResolveRepair();
  const markResolved = (id: string) => {
    resolveRepair.mutate(id, {
      onSuccess: () => {
        toast({
          title: "Marked resolved",
          description: "Your tenant has been notified the issue is fixed.",
        });
      },
      onError: (err) => {
        toast({
          title: "Couldn't update report",
          description: err.message || "Please try again.",
          variant: "destructive",
        });
      },
    });
  };

  const {
    data: tenantActivity,
    isLoading: tenantActivityLoading,
    isError: tenantActivityError,
    refetch: refetchTenantActivity,
  } = useTenantActivity();
  const { data: tenantUnits } = useTenantUnits();
  const {
    data: ownerTransactions,
    isLoading: ownerTransactionsLoading,
    isError: ownerTransactionsError,
    refetch: refetchOwnerTransactions,
  } = useOwnerTransactions();
  const { data: ownerProperties } = useOwnerProperties();

  // Only the active view's source query drives the loading/error chrome —
  // the off-view query is disabled-by-data (returns [] above) and shouldn't
  // gate this page.
  const activityLoading = isTenantView ? tenantActivityLoading : ownerTransactionsLoading;
  const activityError = isTenantView ? tenantActivityError : ownerTransactionsError;
  const retryActivity = isTenantView ? refetchTenantActivity : refetchOwnerTransactions;

  const formatDate = (ts: number) => formatDateTime(new Date(ts).toISOString());
  const symbol = (iso: string) => currencySymbol(iso);

  // Tenant view sources transactions from /api/tenant/activity. Rent payments
  // are recorded as `income` from the owner's perspective; flipped here so the
  // tenant sees them as outgoing expenses.
  const tenantTransactions: ActivityRow[] = useMemo(() => {
    if (!isTenantView || !tenantActivity) return [];
    return tenantActivity.map((tx) => {
      const ts = new Date(tx.timestamp).getTime() || Date.now();
      // Prepaid rent is a rent-category row but carries its own descriptive name
      // ("Prepaid rent · N months") — don't flatten it to the generic label.
      const isPrepaid = tx.source === "prepaid";
      const isRent = tx.category === "rent";
      // Tenants only ever pay: rent and every other charge are expenses; only
      // maintenance items are informational. A tenant never sees income — rent is
      // the landlord's income but the tenant's expense. Shared mapper so the
      // dashboard preview can't drift from this page.
      // Definition (product rule): a row is a TRANSACTION only when its amount is
      // greater than zero; an amount-0 row (e.g. a maintenance report) is a
      // notification regardless of its stored type.
      const displayType: ActivityRow["type"] =
        tx.amount > 0 ? tenantActivityDisplayType(tx) : "neutral";
      return {
        id: tx.id,
        name: isRent && !isPrepaid ? "Rent Payment" : tx.name,
        date: formatDate(ts),
        timestamp: ts,
        amount: tx.amount,
        currency: symbol(tx.currency),
        type: displayType,
        category: tx.category,
        status: tx.status,
        propertyId: tx.propertyId,
      };
    });
  }, [isTenantView, tenantActivity]);

  const tenantPropertiesForFilter: ActivityProperty[] = useMemo(() => {
    if (!isTenantView) return [];
    const seen = new Map<string, string>();
    (tenantUnits ?? []).forEach((u) => {
      if (u.propertyId && !seen.has(u.propertyId)) seen.set(u.propertyId, u.name);
    });
    (tenantActivity ?? []).forEach((tx) => {
      if (tx.propertyId && !seen.has(tx.propertyId)) {
        seen.set(tx.propertyId, tx.unitName || "");
      }
    });
    return Array.from(seen.entries()).map(([id, name]) => ({
      id,
      label: name || "My property",
    }));
  }, [isTenantView, tenantUnits, tenantActivity]);

  // Owner view: same shape transform as tenant, but sourced from the owner's
  // own transactions (no rent-direction flip — owners see their world directly).
  const ownerTransactionsTransformed: ActivityRow[] = useMemo(() => {
    if (isTenantView || !ownerTransactions) return [];
    const now = Date.now();
    return ownerTransactions.map((tx) => {
      const ts = new Date(tx.timestamp).getTime() || Date.now();
      // Editable = the owner's own manual entry, still inside the 24h window.
      // `createdAt` (real write time) gates the window, not the back-datable
      // activity `timestamp`. Owner-self only — a granted contact viewing this
      // portfolio can read but not rewrite the ledger.
      const createdMs = tx.createdAt ? new Date(tx.createdAt).getTime() : NaN;
      const editable =
        isSelf &&
        tx.source === "manual" &&
        Number.isFinite(createdMs) &&
        now - createdMs <= MANUAL_EDIT_WINDOW_MS;
      return {
        id: tx.id,
        name: tx.name,
        date: formatDate(ts),
        timestamp: ts,
        amount: tx.amount,
        currency: symbol(tx.currency),
        // Product rule: a row is a TRANSACTION only when amount > 0. An amount-0
        // row (e.g. a tenant-reported maintenance issue) is a notification —
        // force it to "neutral" so it never renders/sums as income/expense.
        type: tx.amount > 0 ? (tx.type as ActivityRow["type"]) : "neutral",
        category: tx.category,
        status: tx.status,
        propertyId: tx.propertyId,
        applicationFeeCents: tx.applicationFeeCents,
        ownerNetCents: tx.ownerNetCents,
        editable,
      };
    });
  }, [isTenantView, ownerTransactions, isSelf]);

  const ownerPropertiesForFilter: ActivityProperty[] = useMemo(() => {
    if (isTenantView || !ownerProperties) return [];
    return ownerProperties.map((p) => ({ id: p.id, label: p.name?.trim() || p.address }));
  }, [isTenantView, ownerProperties]);

  const transactions: ActivityRow[] = isTenantView
    ? tenantTransactions
    : ownerTransactionsTransformed;
  const filterProperties: ActivityProperty[] = isTenantView
    ? tenantPropertiesForFilter
    : ownerPropertiesForFilter;

  const [filter, setFilter] = useState<"all" | "income" | "expense" | "notification">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [showFilters, setShowFilters] = useState(false);
  // The manual entry currently being edited (owner-self only). Set on pencil
  // click from the underlying owner transaction; cleared when the dialog
  // closes. Held in state so its identity is stable across re-renders, which
  // keeps the edit dialog from re-seeding mid-edit.
  const [editingActivity, setEditingActivity] = useState<EditActivityValues | null>(null);
  const openEdit = (id: string) => {
    const tx = (ownerTransactions ?? []).find((t) => t.id === id);
    if (!tx) return;
    setEditingActivity({
      id: tx.id,
      propertyId: tx.propertyId ?? "",
      name: tx.name,
      amount: tx.amount,
      type: tx.type,
      category: tx.category,
      timestamp: tx.timestamp,
      notes: tx.notes,
    });
  };

  // Advanced Filters State
  const [dateRange, setDateRange] = useState({ start: "", end: "" });
  const [amountRange, setAmountRange] = useState({ min: "", max: "" });
  const [selectedProperty, setSelectedProperty] = useState("all");

  const availableMonths = useMemo(() => {
    const months = new Set<string>();
    transactions.forEach((tx) => {
      const dateObj = new Date(tx.timestamp);
      const monthYear = formatMonthYearLong(dateObj.toISOString());
      months.add(monthYear);
    });
    return Array.from(months).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
  }, [transactions]);

  const [selectedMonth, setSelectedMonth] = useState<string>(availableMonths[0] || "");

  useEffect(() => {
    if (availableMonths.length > 0 && !selectedMonth) {
      setSelectedMonth(availableMonths[0]);
    }
  }, [availableMonths, selectedMonth]);

  const filteredTransactions = useMemo(() => {
    let result = [...transactions];

    // Free-text search across the transaction name, category, and the linked
    // property's address (so "rent" or a street name both match).
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter((t) => {
        const propLabel = filterProperties.find((p) => p.id === t.propertyId)?.label ?? "";
        return `${t.name} ${t.category} ${propLabel}`.toLowerCase().includes(q);
      });
    }

    // Filter by type/category
    if (filter !== "all") {
      if (filter === "notification") {
        result = result.filter((t) => t.type === "neutral");
      } else {
        result = result.filter((t) => t.type === filter);
      }
    }

    // Advanced Filters
    if (selectedProperty !== "all") {
      result = result.filter((t) => t.propertyId === selectedProperty);
    }

    if (dateRange.start) {
      const startDate = new Date(dateRange.start).getTime();
      result = result.filter((t) => t.timestamp >= startDate);
    }

    if (dateRange.end) {
      const endDate = new Date(dateRange.end).getTime() + 86400000; // Include the end day
      result = result.filter((t) => t.timestamp <= endDate);
    }

    if (amountRange.min) {
      result = result.filter((t) => t.amount >= parseFloat(amountRange.min));
    }

    if (amountRange.max) {
      result = result.filter((t) => t.amount <= parseFloat(amountRange.max));
    }

    // Sort
    result.sort((a, b) => {
      if (sortOrder === "newest") {
        return b.timestamp - a.timestamp;
      } else {
        return a.timestamp - b.timestamp;
      }
    });

    return result;
  }, [
    filter,
    searchQuery,
    sortOrder,
    dateRange,
    amountRange,
    selectedProperty,
    isTenantView,
    transactions,
    filterProperties,
  ]);

  const groupedTransactions = useMemo(() => {
    const groups: Record<string, typeof filteredTransactions> = {};
    filteredTransactions.forEach((tx) => {
      const dateObj = new Date(tx.timestamp);
      const dayGroup = formatDayMonthYearLong(dateObj.toISOString());
      if (!groups[dayGroup]) groups[dayGroup] = [];
      groups[dayGroup].push(tx);
    });
    return groups;
  }, [filteredTransactions]);

  const clearAdvancedFilters = () => {
    setDateRange({ start: "", end: "" });
    setAmountRange({ min: "", max: "" });
    setSelectedProperty("all");
  };

  const hasActiveAdvancedFilters =
    dateRange.start ||
    dateRange.end ||
    amountRange.min ||
    amountRange.max ||
    selectedProperty !== "all";

  // Filter pills are owner-only; tenants see an unfiltered activity list.
  const filterPillOptions = [
    { id: "all", label: "All" },
    { id: "income", label: "Income" },
    { id: "expense", label: "Expense" },
    { id: "notification", label: "Notifications" },
  ];

  // Summary totals for the period currently shown by the month-pills selector,
  // or all of `transactions` when no month is selected. Filter pills + advanced
  // filters intentionally don't shrink these numbers — the cards are a period
  // overview, not a reflection of the visible list.
  const summaryTotals = useMemo(() => {
    const matchesMonth = (ts: number) => {
      if (!selectedMonth) return true;
      const my = formatMonthYearLong(new Date(ts).toISOString());
      return my === selectedMonth;
    };
    let income = 0;
    let expense = 0;
    transactions.forEach((tx) => {
      if (!matchesMonth(tx.timestamp)) return;
      if (tx.type === "income") income += tx.amount;
      else if (tx.type === "expense") expense += tx.amount;
    });
    return { income, expense, net: income - expense };
  }, [transactions, selectedMonth]);

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <PageHeader title="Activity" subtitle="Recent transactions and notifications" />

      {/* Advanced Filters Panel */}
      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden mb-4"
          >
            <div className="bg-background rounded-2xl p-4 border border-border space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="font-bold text-sm text-foreground">Filters</h3>
                <button
                  onClick={clearAdvancedFilters}
                  className="text-xs text-primary font-medium hover:underline"
                >
                  Reset all
                </button>
              </div>

              {/* Property Filter */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                  <Building size={12} /> Property
                </label>
                <select
                  value={selectedProperty}
                  onChange={(e) => setSelectedProperty(e.target.value)}
                  className="w-full bg-card border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition appearance-none"
                >
                  <option value="all">All Properties</option>
                  {filterProperties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Date Range */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                  <Calendar size={12} /> Date Range
                </label>
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={dateRange.start}
                    onChange={(e) => setDateRange((prev) => ({ ...prev, start: e.target.value }))}
                    className="flex-1 bg-card border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
                  />
                  <span className="self-center text-muted-foreground/70">-</span>
                  <input
                    type="date"
                    value={dateRange.end}
                    onChange={(e) => setDateRange((prev) => ({ ...prev, end: e.target.value }))}
                    className="flex-1 bg-card border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
                  />
                </div>
              </div>

              {/* Amount Range */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                  <Euro size={12} /> Amount Range
                </label>
                <div className="flex gap-2 items-center">
                  <div className="relative flex-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70 text-xs">
                      €
                    </span>
                    <input
                      type="number"
                      placeholder="Min"
                      value={amountRange.min}
                      onChange={(e) => setAmountRange((prev) => ({ ...prev, min: e.target.value }))}
                      className="w-full bg-card border border-border rounded-xl pl-6 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
                    />
                  </div>
                  <span className="text-muted-foreground/70">-</span>
                  <div className="relative flex-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70 text-xs">
                      €
                    </span>
                    <input
                      type="number"
                      placeholder="Max"
                      value={amountRange.max}
                      onChange={(e) => setAmountRange((prev) => ({ ...prev, max: e.target.value }))}
                      className="w-full bg-card border border-border rounded-xl pl-6 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
                    />
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Summary cards — period overview, owner-only. Icons are neutral (white
     glyph on a grey circle). Owners get income / expense / net; tenants
     don't see a summary bar. */}
      {!isTenantView && (
        <div className="grid grid-cols-3 gap-2 md:gap-4 mb-6">
          <div className="bg-card border border-border rounded-xl shadow-sm p-2.5 md:p-4 flex flex-col md:flex-row items-start md:items-center gap-1.5 md:gap-3">
            <div className="w-7 h-7 md:w-10 md:h-10 rounded-full bg-secondary text-foreground flex items-center justify-center shrink-0">
              <TrendingUp className="w-3.5 h-3.5 md:w-[18px] md:h-[18px]" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] md:text-xs text-muted-foreground">Income</p>
              <p className="text-sm md:text-lg font-bold text-foreground truncate">
                {formatCurrencyCompact(summaryTotals.income)}
              </p>
            </div>
          </div>
          <div className="bg-card border border-border rounded-xl shadow-sm p-2.5 md:p-4 flex flex-col md:flex-row items-start md:items-center gap-1.5 md:gap-3">
            <div className="w-7 h-7 md:w-10 md:h-10 rounded-full bg-secondary text-foreground flex items-center justify-center shrink-0">
              <TrendingDown className="w-3.5 h-3.5 md:w-[18px] md:h-[18px]" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] md:text-xs text-muted-foreground">Expense</p>
              <p className="text-sm md:text-lg font-bold text-foreground truncate">
                {formatCurrencyCompact(summaryTotals.expense)}
              </p>
            </div>
          </div>
          <div className="bg-card border border-border rounded-xl shadow-sm p-2.5 md:p-4 flex flex-col md:flex-row items-start md:items-center gap-1.5 md:gap-3">
            <div className="w-7 h-7 md:w-10 md:h-10 rounded-full bg-secondary text-foreground flex items-center justify-center shrink-0">
              <Euro className="w-3.5 h-3.5 md:w-[18px] md:h-[18px]" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] md:text-xs text-muted-foreground truncate">
                Net
                {selectedMonth ? <span className="hidden md:inline"> ({selectedMonth})</span> : ""}
              </p>
              <p
                className={`text-sm md:text-lg font-bold truncate ${summaryTotals.net < 0 ? "text-red-500" : "text-foreground"}`}
              >
                {summaryTotals.net < 0 ? "-" : ""}
                {formatCurrencyCompact(Math.abs(summaryTotals.net))}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Filters Card — unified for desktop + mobile */}
      <TableFiltersCard>
        <TableSearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search transactions…"
        />
        {!isTenantView && (
          <div className="pt-3 border-t border-border/40">
            <FilterPills
              options={filterPillOptions}
              value={filter}
              onChange={(id) => setFilter(id as any)}
            />
          </div>
        )}
        {filterProperties.length > 0 && (
          <div className="pt-3 border-t border-border/40">
            <Select value={selectedProperty} onValueChange={setSelectedProperty}>
              <SelectTrigger className="w-full md:w-64 h-10 rounded-xl bg-background border-border text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  <Building size={14} className="text-muted-foreground shrink-0" />
                  <SelectValue placeholder="All properties" />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All properties</SelectItem>
                {filterProperties.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {availableMonths.length > 0 && (
          <div className="relative pt-3 border-t border-border/40">
            {/* Right-edge fade signals there's more content to swipe through */}
            <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-card to-transparent z-10" />
            <div className="flex items-center gap-2 overflow-x-auto hide-scrollbar">
              {availableMonths.map((month) => (
                <button
                  key={month}
                  onClick={() => {
                    setSelectedMonth(month);
                    const el = document.getElementById(`month-${month.replace(/\s+/g, "-")}`);
                    if (el) {
                      el.scrollIntoView({ behavior: "smooth" });
                    } else {
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }
                  }}
                  className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
                    selectedMonth === month
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {month}
                </button>
              ))}
            </div>
          </div>
        )}
      </TableFiltersCard>

      {/* Transaction List */}
      <div className="space-y-6">
        {activityError ? (
          <ListErrorState title="We couldn't load your activity." onRetry={() => retryActivity()} />
        ) : activityLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center justify-between bg-card p-4 rounded-2xl shadow-sm border border-border"
              >
                <div className="flex items-center gap-4 flex-1">
                  <Skeleton className="w-12 h-12 rounded-full shrink-0" />
                  <div className="flex-1 min-w-0 space-y-2">
                    <Skeleton className="h-3.5 w-1/2" />
                    <Skeleton className="h-2.5 w-1/3" />
                  </div>
                </div>
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        ) : Object.keys(groupedTransactions).length > 0 ? (
          (() => {
            let currentRenderedMonth = "";
            return Object.keys(groupedTransactions).map((dayGroup) => {
              const dayTotal = groupedTransactions[dayGroup].reduce((acc, tx) => {
                return (
                  acc + (tx.type === "expense" ? -tx.amount : tx.type === "income" ? tx.amount : 0)
                );
              }, 0);

              const firstTxInGroup = groupedTransactions[dayGroup][0];
              const monthYearOfGroup = formatMonthYearLong(
                new Date(firstTxInGroup.timestamp).toISOString(),
              );

              let monthId = undefined;
              if (monthYearOfGroup !== currentRenderedMonth) {
                currentRenderedMonth = monthYearOfGroup;
                monthId = `month-${monthYearOfGroup.replace(/\s+/g, "-")}`;
              }

              return (
                <div key={dayGroup} id={monthId} className="space-y-3 scroll-mt-28">
                  <div className="flex items-center justify-between px-2">
                    <h3 className="text-sm font-bold text-foreground">{dayGroup}</h3>
                    <span className="text-xs text-muted-foreground font-medium">
                      {dayTotal < 0 ? "-" : ""}
                      {formatCurrencyCompact(Math.abs(dayTotal))}
                    </span>
                  </div>
                  <div className="space-y-3">
                    {groupedTransactions[dayGroup].map((tx, i) => {
                      const { Icon, className: iconClass } = activityVisual(tx.type, {
                        solid: true,
                      });
                      // Offline rent the tenant logged but the owner hasn't
                      // confirmed yet — owner-self only (see confirmPayment).
                      const isPendingRent =
                        !isTenantView &&
                        isSelf &&
                        tx.status === "pending" &&
                        tx.category === "rent";
                      // Tenant-reported maintenance issue: both personas see the
                      // Pending / Resolved badge; only the owner-self gets the
                      // inline Resolve action while it's still pending.
                      const repair = isRepairReport(tx);
                      const canResolve =
                        repair && !isTenantView && isSelf && tx.status === "pending";
                      return (
                        <motion.div
                          key={tx.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.05 }}
                          className="flex items-center justify-between bg-card p-4 rounded-2xl shadow-sm border border-border"
                        >
                          <div className="flex items-center gap-4">
                            <div
                              className={`w-12 h-12 rounded-full flex items-center justify-center text-lg overflow-hidden border ${iconClass}`}
                            >
                              <Icon size={20} />
                            </div>
                            <div className="flex flex-col">
                              <span className="font-semibold text-sm text-foreground line-clamp-1">
                                {tx.name}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {tx.propertyId
                                  ? `${filterProperties.find((p) => p.id === tx.propertyId)?.label || ""} • `
                                  : ""}
                                {tx.date.split(", ").pop() || tx.date}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {repair ? (
                              <div className="flex items-center gap-2">
                                <RepairStatusBadge status={tx.status} />
                                {canResolve ? (
                                  <button
                                    onClick={() => markResolved(tx.id)}
                                    disabled={resolveRepair.isPending}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-foreground text-background hover:opacity-90 transition disabled:opacity-50"
                                  >
                                    <Check size={12} />
                                    Resolve
                                  </button>
                                ) : null}
                              </div>
                            ) : (
                              <>
                                <div className="flex flex-col items-end min-w-[80px] gap-1">
                                  <span
                                    className={`font-bold text-sm ${
                                      tx.type === "income" ? "text-foreground" : "text-foreground"
                                    }`}
                                  >
                                    {tx.type === "expense" ? "-" : tx.type === "income" ? "+" : ""}
                                    {tx.currency}
                                    {formatAmountTrim(tx.amount)}
                                  </span>
                                  {isPendingRent ? (
                                    <button
                                      onClick={() => confirmPayment(tx.id)}
                                      disabled={verifyPayment.isPending}
                                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-foreground text-background hover:opacity-90 transition disabled:opacity-50"
                                    >
                                      <Check size={12} />
                                      Confirm
                                    </button>
                                  ) : typeof tx.applicationFeeCents === "number" &&
                                    tx.applicationFeeCents > 0 ? (
                                    <>
                                      <span className="text-[10px] text-muted-foreground/80">
                                        Olio fee −{tx.currency}
                                        {(tx.applicationFeeCents / 100).toFixed(2)}
                                      </span>
                                      {typeof tx.ownerNetCents === "number" ? (
                                        <span className="text-[10px] font-semibold text-foreground">
                                          Net {tx.currency}
                                          {(tx.ownerNetCents / 100).toFixed(2)}
                                        </span>
                                      ) : null}
                                    </>
                                  ) : (
                                    <span className="text-[10px] text-muted-foreground/70 capitalize">
                                      {tx.category}
                                    </span>
                                  )}
                                </div>
                                {tx.editable ? (
                                  <button
                                    type="button"
                                    onClick={() => openEdit(tx.id)}
                                    aria-label="Edit activity"
                                    title="Edit"
                                    className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition"
                                  >
                                    <Pencil size={15} />
                                  </button>
                                ) : null}
                              </>
                            )}
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              );
            });
          })()
        ) : (
          <div className="bg-card border border-border rounded-xl shadow-sm py-20 px-6 flex flex-col items-center justify-center text-center min-h-[420px]">
            <div className="w-20 h-20 rounded-full bg-secondary flex items-center justify-center mb-5">
              <Search size={28} className="opacity-50" />
            </div>
            <p className="text-base font-semibold text-foreground">
              {transactions.length === 0 ? "No activity yet" : "No transactions found"}
            </p>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              {transactions.length === 0
                ? isTenantView
                  ? "Your rent payments, expenses and notifications will appear here."
                  : "Income, expenses and notifications across your portfolio will appear here."
                : "Try adjusting your filters or pick a different month."}
            </p>
          </div>
        )}
      </div>

      {/* Edit drawer — owner-only. Reuses RecordActivityDialog in edit mode;
          mounted only on the owner view so it never fetches owner properties
          for a tenant. Closing clears the row so the next open re-seeds. */}
      {!isTenantView && (
        <RecordActivityDialog
          open={!!editingActivity}
          editing={editingActivity}
          onOpenChange={(o) => {
            if (!o) setEditingActivity(null);
          }}
        />
      )}
    </div>
  );
}
