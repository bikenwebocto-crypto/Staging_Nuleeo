// Transactions — /owner/transaction.
// Live ledger for the active portfolio:
//   • Ledger / Needs attention — GET /api/owner/transactions (wide window);
//     bank-imported rows awaiting review are classified + approved/rejected via
//     POST /api/owner/transactions/:id/review.
//   • Import — bank-statement CSV parsed in the browser, sent to
//     POST /api/owner/transactions/import (server dedupes + suggests matches).
//   • Reconciliation — GET/POST /api/owner/reconciliation.
//   • Export — CSV of the currently filtered rows.
// Review/import are owner-self only on the server, so they're hidden when
// viewing a portfolio someone else granted access to.
import { useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  ArrowLeftRight,
  Check,
  Download,
  FileText,
  Home,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Upload,
  Wrench,
  X,
  Zap,
} from "lucide-react";

import { HeaderActions, PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { DARK_CARD, PILL_SOLID } from "@/components/owner/property/ui";
import { RecordActivityDialog } from "@/components/owner/RecordActivityDialog";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { downloadCsv, parseBankCsv, type ParsedStatement } from "@/lib/bankCsv";
import {
  useImportTransactions,
  useOwnerLedgerTransactions,
  useOwnerProperties,
  useOwnerReconciliation,
  useResolveReconciliation,
  useReviewTransaction,
  type OwnerTransaction,
  type TransactionImportResult,
} from "@/lib/ownerQueries";
import { useToast } from "@ui/hooks/use-toast";
import { parseApiError } from "@ui/lib/queryClient";
import { cn } from "@ui/lib/utils";
import type { TransactionCategory } from "@shared/firestore-schema";
import { isAwaitingReview } from "@shared/transactions";

const TABS = ["Ledger", "Needs attention", "Import", "Reconciliation"] as const;
type Tab = (typeof TABS)[number];

const CATEGORY_LABEL: Record<TransactionCategory, string> = {
  rent: "Rent",
  security_deposit: "Security deposit",
  maintenance: "Maintenance",
  tax: "Tax",
  insurance: "Insurance",
  utilities: "Utilities",
  professional_fee: "Professional fees",
  mortgage: "Mortgage",
  fee: "Fees",
  transfer: "Internal transfer",
  refund: "Refund",
  other: "Other",
};
// Categories the review endpoint accepts.
const REVIEW_CATEGORIES: TransactionCategory[] = [
  "rent",
  "security_deposit",
  "maintenance",
  "tax",
  "insurance",
  "utilities",
  "professional_fee",
  "mortgage",
  "fee",
  "transfer",
  "other",
];
const INCOME_CATEGORIES = new Set<TransactionCategory>(["rent", "security_deposit"]);

type ReviewDraft = {
  type: "income" | "expense";
  category: TransactionCategory;
  propertyId: string;
};

const GREEN = "text-[#7BD88F]";
const SELECT =
  "h-8 rounded-md bg-[#1C2325] px-2 text-xs text-[#F4F4F2] outline-none hover:bg-[#252E31]";
const money = (n: number, ccy = "EUR") =>
  new Intl.NumberFormat("en-IE", { style: "currency", currency: ccy, maximumFractionDigits: 2 })
    .format(Math.abs(n))
    .replace(/\.00$/, "");
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const monthKey = (iso: string) => iso.slice(0, 7);

function signedAmount(t: OwnerTransaction): number {
  const type = isAwaitingReview(t) ? t.classification?.type : t.type;
  return type === "expense" ? -Math.abs(t.amount) : Math.abs(t.amount);
}

function statusLabel(t: OwnerTransaction): string {
  if (isAwaitingReview(t)) return "Needs review";
  if (t.status === "completed") return "Approved";
  return t.status.charAt(0).toUpperCase() + t.status.slice(1);
}

function rowIcon(t: OwnerTransaction) {
  if (t.category === "rent") return <Home size={16} />;
  if (t.category === "utilities") return <Zap size={16} />;
  if (t.category === "maintenance") return <Wrench size={16} />;
  if (t.category === "transfer") return <ArrowLeftRight size={16} />;
  return <FileText size={16} />;
}

export default function TransactionsPage() {
  const { toast } = useToast();
  const { isSelf } = useActivePortfolio();
  const canEdit = isSelf;

  const { data: txs = [], isLoading, error } = useOwnerLedgerTransactions();
  const { data: properties = [] } = useOwnerProperties();
  const review = useReviewTransaction();

  const [tab, setTab] = useState<Tab>("Ledger");
  const [search, setSearch] = useState("");
  const [month, setMonth] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [propertyFilter, setPropertyFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);

  const propertyName = useMemo(() => {
    const m = new Map<string, string>();
    properties.forEach((p) => m.set(p.id, p.name || p.address));
    return m;
  }, [properties]);

  const months = useMemo(
    () =>
      Array.from(new Set(txs.map((t) => monthKey(t.timestamp))))
        .sort()
        .reverse(),
    [txs],
  );

  const awaiting = useMemo(() => txs.filter(isAwaitingReview), [txs]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return txs.filter((t) => {
      const pending = isAwaitingReview(t);
      if (tab === "Needs attention" && !pending && t.status !== "pending") return false;
      if (month !== "all" && monthKey(t.timestamp) !== month) return false;
      const effType = pending ? t.classification?.type : t.type;
      if (typeFilter !== "all" && effType !== typeFilter) return false;
      if (categoryFilter !== "all" && t.category !== categoryFilter) return false;
      if (propertyFilter !== "all" && (t.propertyId ?? "") !== propertyFilter) return false;
      if (statusFilter === "review" && !pending) return false;
      if (statusFilter !== "all" && statusFilter !== "review" && t.status !== statusFilter)
        return false;
      if (!q) return true;
      return [t.name, t.propertyAddress, t.notes]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(q));
    });
  }, [txs, tab, search, month, typeFilter, categoryFilter, propertyFilter, statusFilter]);

  // Only verified activity counts; pending imports are excluded until approved.
  const totals = useMemo(() => {
    let income = 0,
      expense = 0,
      transfers = 0;
    visible.forEach((t) => {
      if (t.status !== "completed") return;
      if (t.category === "transfer") transfers += t.amount;
      else if (t.type === "income") income += t.amount;
      else if (t.type === "expense") expense += t.amount;
    });
    return { income, expense, transfers, net: income - expense };
  }, [visible]);

  const draftFor = (t: OwnerTransaction): ReviewDraft =>
    drafts[t.id] ?? {
      type: (t.classification?.type === "income" ? "income" : "expense") as "income" | "expense",
      category: t.classification?.category ?? "other",
      propertyId: t.classification?.propertyId ?? t.propertyId ?? "",
    };

  const setDraft = (t: OwnerTransaction, patch: Partial<ReviewDraft>) =>
    setDrafts((d) => ({ ...d, [t.id]: { ...draftFor(t), ...patch } }));

  const markBusy = (id: string, on: boolean) =>
    setBusyIds((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const doReview = async (t: OwnerTransaction, action: "approve" | "reject") => {
    const d = draftFor(t);
    markBusy(t.id, true);
    try {
      await review.mutateAsync(
        action === "approve"
          ? {
              id: t.id,
              action,
              type: d.type,
              category: d.category,
              ...(d.propertyId ? { propertyId: d.propertyId } : {}),
            }
          : { id: t.id, action },
      );
      return true;
    } catch (err) {
      toast({
        title: action === "approve" ? "Approve failed" : "Reject failed",
        description: parseApiError(err, "Please try again"),
        variant: "destructive",
      });
      return false;
    } finally {
      markBusy(t.id, false);
    }
  };

  const approveAll = async () => {
    let ok = 0;
    for (const t of awaiting) if (await doReview(t, "approve")) ok++;
    toast({ title: `Approved ${ok} of ${awaiting.length} transactions` });
  };

  const exportCsv = () => {
    downloadCsv(
      `olio-transactions-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        "Date",
        "Description",
        "Type",
        "Amount",
        "Currency",
        "Category",
        "Property",
        "Status",
        "Source",
        "Payment method",
        "Notes",
        "ID",
      ],
      visible.map((t) => [
        t.timestamp.slice(0, 10),
        t.name,
        isAwaitingReview(t) ? `${t.classification?.type ?? ""} (suggested)` : t.type,
        signedAmount(t),
        t.currency ?? "EUR",
        CATEGORY_LABEL[t.category] ?? t.category,
        t.propertyAddress ?? (t.propertyId ? propertyName.get(t.propertyId) : "") ?? "",
        statusLabel(t),
        t.source ?? "",
        t.paymentMethod ?? "",
        t.notes ?? "",
        t.id,
      ]),
    );
  };

  return (
    <>
      <HeaderActions>
        <div className="flex items-center gap-2">
          {canEdit ? (
            <button type="button" className={PILL_SOLID} onClick={() => setTab("Import")}>
              <Upload size={16} /> Upload statement
            </button>
          ) : null}
          <button
            type="button"
            className={cn(PILL_SOLID, "disabled:opacity-50")}
            onClick={exportCsv}
            disabled={!visible.length}
            title={visible.length ? "Export the filtered rows as CSV" : "Nothing to export"}
          >
            <Download size={16} /> Export
          </button>
        </div>
      </HeaderActions>

      <div className={PAGE_CONTAINER_CLASSNAME}>
        <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 text-[#F4F4F2]">
          {/* Tabs */}
          <div className="inline-flex w-fit flex-wrap gap-1 rounded-full bg-[#1C2325] p-1">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-full px-4 py-2 text-sm transition",
                  t === tab ? "bg-[#111618] text-[#F4F4F2]" : "text-[#A3A7AB] hover:text-[#F4F4F2]",
                )}
              >
                {t}
                {t === "Needs attention" && awaiting.length ? ` (${awaiting.length})` : ""}
              </button>
            ))}
          </div>

          {tab === "Import" ? (
            <ImportPanel canEdit={canEdit} onDone={() => setTab("Needs attention")} />
          ) : tab === "Reconciliation" ? (
            <ReconciliationPanel canEdit={canEdit} txs={txs} />
          ) : (
            <section className={cn(DARK_CARD, "mt-2 overflow-hidden")}>
              <div className="flex flex-col gap-4 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-base font-medium">Ledger</h2>
                  {canEdit ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setAddOpen(true)}
                        className="rounded-full bg-[#1C2325] px-4 py-2 text-sm hover:bg-[#252E31]"
                      >
                        <Plus size={14} className="mr-1 inline" /> Add transaction
                      </button>
                      <button
                        type="button"
                        onClick={approveAll}
                        disabled={!awaiting.length || busyIds.size > 0}
                        className="rounded-full bg-white px-4 py-2 text-sm font-medium text-[#111618] disabled:opacity-50"
                      >
                        <Check size={14} className="mr-1 inline" /> Approve all suggested (
                        {awaiting.length})
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={month}
                    onChange={(e) => setMonth(e.target.value)}
                    className={SELECT}
                  >
                    <option value="all">All dates</option>
                    {months.map((m) => (
                      <option key={m} value={m}>
                        {new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", {
                          month: "short",
                          year: "numeric",
                          timeZone: "UTC",
                        })}
                      </option>
                    ))}
                  </select>
                  <select
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value)}
                    className={SELECT}
                  >
                    <option value="all">All types</option>
                    <option value="income">Income</option>
                    <option value="expense">Expense</option>
                    <option value="neutral">Neutral</option>
                  </select>
                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    className={SELECT}
                  >
                    <option value="all">All categories</option>
                    {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <select
                    value={propertyFilter}
                    onChange={(e) => setPropertyFilter(e.target.value)}
                    className={SELECT}
                  >
                    <option value="all">All properties</option>
                    <option value="">Unassigned</option>
                    {properties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || p.address}
                      </option>
                    ))}
                  </select>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className={SELECT}
                  >
                    <option value="all">All statuses</option>
                    <option value="review">Needs review</option>
                    <option value="completed">Approved</option>
                    <option value="pending">Pending</option>
                    <option value="failed">Rejected / failed</option>
                    <option value="resolved">Resolved</option>
                  </select>
                  <label className="flex h-8 min-w-[200px] flex-1 items-center gap-2 rounded-full bg-[#1C2325] px-3 text-xs">
                    <Search size={14} className="text-[#7D8287]" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search transactions..."
                      className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-[#7D8287]"
                    />
                  </label>
                </div>

                <div className="flex flex-wrap gap-6 pt-3 text-sm text-[#A3A7AB]">
                  <span>
                    Income <b className={cn("font-semibold", GREEN)}>{money(totals.income)}</b>
                  </span>
                  <span>
                    Expense <b className="font-semibold text-[#F4F4F2]">{money(totals.expense)}</b>
                  </span>
                  <span>Transfers {money(totals.transfers)}</span>
                  <span>
                    Net{" "}
                    <b className="font-semibold text-[#F4F4F2]">
                      {totals.net < 0 ? "−" : ""}
                      {money(totals.net)}
                    </b>
                  </span>
                </div>
                {awaiting.length ? (
                  <p className="flex items-center gap-1.5 text-[11px] text-[#A3A7AB]">
                    <Sparkles size={11} className="text-[#6FD3C9]" /> Imported rows are suggestions
                    · check type, category and property, then approve
                  </p>
                ) : null}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[1000px] text-sm">
                  <thead className="bg-[#1A2123] text-xs text-[#A3A7AB]">
                    <tr>
                      <th className="px-5 py-4 text-left font-normal">Date</th>
                      <th className="px-3 py-4 text-left font-normal">Description</th>
                      <th className="px-3 py-4 text-left font-normal">Type</th>
                      <th className="px-3 py-4 text-right font-normal">Amount</th>
                      <th className="px-3 py-4 text-left font-normal">Category</th>
                      <th className="px-3 py-4 text-left font-normal">Property</th>
                      <th className="px-5 py-4 text-center font-normal">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((t) => {
                      const pending = canEdit && isAwaitingReview(t);
                      const d = pending ? draftFor(t) : null;
                      const amt =
                        pending && d
                          ? d.type === "expense"
                            ? -t.amount
                            : t.amount
                          : signedAmount(t);
                      const busy = busyIds.has(t.id);
                      return (
                        <tr key={t.id} className="h-14 border-t border-[#1C2325]">
                          <td className="whitespace-nowrap px-5 text-xs text-[#A3A7AB]">
                            {fmtDate(t.timestamp)}
                          </td>
                          <td className="px-3">
                            <div className="flex items-center gap-3">
                              <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1C2325]">
                                {rowIcon(t)}
                                <span
                                  className={cn(
                                    "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#111618]",
                                    amt >= 0 ? "bg-[#7BD88F]" : "bg-[#3A4346]",
                                  )}
                                />
                              </span>
                              <span className="min-w-0 truncate">{t.name}</span>
                            </div>
                          </td>
                          <td className="px-3">
                            {pending && d ? (
                              <select
                                value={d.type}
                                onChange={(e) =>
                                  setDraft(t, { type: e.target.value as "income" | "expense" })
                                }
                                className={SELECT}
                              >
                                <option value="income">Income</option>
                                <option value="expense">Expense</option>
                              </select>
                            ) : (
                              <span className="capitalize">{t.type}</span>
                            )}
                          </td>
                          <td className={cn("px-3 text-right font-medium", amt >= 0 && GREEN)}>
                            {amt >= 0 ? "+" : "−"}
                            {money(amt, t.currency)}
                          </td>
                          <td className="px-3">
                            {pending && d ? (
                              <select
                                value={d.category}
                                onChange={(e) => {
                                  const category = e.target.value as TransactionCategory;
                                  setDraft(t, {
                                    category,
                                    ...(INCOME_CATEGORIES.has(category)
                                      ? { type: "income" as const }
                                      : category !== "transfer" && category !== "other"
                                        ? { type: "expense" as const }
                                        : {}),
                                  });
                                }}
                                className={cn(SELECT, "w-[160px]")}
                              >
                                {REVIEW_CATEGORIES.map((c) => (
                                  <option key={c} value={c}>
                                    {CATEGORY_LABEL[c]}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              (CATEGORY_LABEL[t.category] ?? t.category)
                            )}
                          </td>
                          <td className="px-3">
                            {pending && d ? (
                              <select
                                value={d.propertyId}
                                onChange={(e) => setDraft(t, { propertyId: e.target.value })}
                                className={cn(SELECT, "w-[180px]")}
                              >
                                <option value="">No property</option>
                                {properties.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name || p.address}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="text-[#A3A7AB]">
                                {t.propertyAddress ??
                                  (t.propertyId ? propertyName.get(t.propertyId) : null) ??
                                  "—"}
                              </span>
                            )}
                          </td>
                          <td className="px-5 text-center">
                            {pending ? (
                              <div className="flex items-center justify-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => doReview(t, "approve")}
                                  className="rounded-lg bg-[#1C2325] px-3 py-1.5 text-xs hover:bg-[#252E31] disabled:opacity-50"
                                >
                                  {busy ? (
                                    <Loader2 size={12} className="inline animate-spin" />
                                  ) : (
                                    "✓ Approve"
                                  )}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  aria-label="Reject"
                                  title="Reject (not a real ledger entry)"
                                  onClick={() => doReview(t, "reject")}
                                  className="rounded-lg bg-[#1C2325] px-2 py-1.5 text-xs text-[#FF6B6B] hover:bg-[#252E31] disabled:opacity-50"
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            ) : (
                              <span
                                className={cn(
                                  "text-xs",
                                  t.status === "completed"
                                    ? GREEN
                                    : t.status === "failed" || t.status === "rejected"
                                      ? "text-[#FF6B6B]"
                                      : "text-[#A3A7AB]",
                                )}
                              >
                                {statusLabel(t)}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {!visible.length ? (
                      <tr>
                        <td colSpan={7} className="py-10 text-center text-sm text-[#A3A7AB]">
                          {isLoading ? (
                            <Loader2 size={16} className="mx-auto animate-spin" />
                          ) : error ? (
                            parseApiError(error, "Failed to load transactions")
                          ) : txs.length ? (
                            "No transactions match."
                          ) : (
                            "No transactions yet. Upload a bank statement or add one manually."
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              <p className="px-5 py-4 text-xs text-[#A3A7AB]">
                Showing {visible.length} of {txs.length} · Totals count approved rows only. Imported
                rows don't affect income or expense until approved; transfers are excluded from
                revenue.
              </p>
            </section>
          )}
        </div>
      </div>

      <RecordActivityDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}

// ---------------------------------------------------------------- Import

function ImportPanel({ canEdit, onDone }: { canEdit: boolean; onDone: () => void }) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const importTx = useImportTransactions();
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParsedStatement | null>(null);
  const [result, setResult] = useState<TransactionImportResult | null>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!f) return;
    setResult(null);
    setFileName(f.name);
    if (!/\.(csv|txt|tsv)$/i.test(f.name)) {
      setParsed({ movements: [], skipped: 0, error: "Please upload a CSV export from your bank." });
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      setParsed({ movements: [], skipped: 0, error: "File is larger than 5 MB." });
      return;
    }
    setParsed(parseBankCsv(await f.text()));
  };

  const submit = async () => {
    if (!parsed?.movements.length) return;
    try {
      const r = await importTx.mutateAsync({
        movements: parsed.movements,
        name: fileName || undefined,
      });
      setResult(r);
      setParsed(null);
      toast({
        title: "Statement imported",
        description: `${r.importedCount} new, ${r.matchedCount} matched, ${r.alreadyImportedCount} already imported`,
      });
    } catch (err) {
      toast({
        title: "Import failed",
        description: parseApiError(err, "Please try again"),
        variant: "destructive",
      });
    }
  };

  if (!canEdit) {
    return (
      <section className={cn(DARK_CARD, "mt-2 p-6 text-sm text-[#A3A7AB]")}>
        Only the portfolio owner can import bank statements.
      </section>
    );
  }

  return (
    <section className={cn(DARK_CARD, "mt-2 flex flex-col gap-4 p-6")}>
      <div>
        <h2 className="text-base font-medium">Import a bank statement</h2>
        <p className="mt-1 text-xs text-[#A3A7AB]">
          CSV with a date column, a description, and either a signed Amount or Debit/Credit columns.
          Re-importing the same statement is safe: duplicates are skipped, and lines that match
          payments already recorded are offered under Reconciliation instead of being added twice.
        </p>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".csv,.tsv,.txt,text/csv"
        className="hidden"
        onChange={onFile}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[#3A4346] px-6 py-10 text-sm text-[#A3A7AB] hover:border-[#6FD3C9] hover:text-[#F4F4F2]"
      >
        <Upload size={20} />
        {fileName ? `Selected: ${fileName} — choose another` : "Choose a CSV file"}
      </button>

      {parsed?.error ? <p className="text-sm text-[#FF6B6B]">{parsed.error}</p> : null}

      {parsed && !parsed.error ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {parsed.movements.length} transactions found
            {parsed.skipped ? (
              <span className="text-[#A3A7AB]">
                {" "}
                · {parsed.skipped} rows skipped (no date/amount)
              </span>
            ) : null}
          </p>
          {parsed.movements.length ? (
            <div className="overflow-x-auto rounded-xl bg-[#111618]">
              <table className="w-full text-xs">
                <thead className="text-[#A3A7AB]">
                  <tr>
                    <th className="px-3 py-2 text-left font-normal">Date</th>
                    <th className="px-3 py-2 text-left font-normal">Description</th>
                    <th className="px-3 py-2 text-right font-normal">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.movements.slice(0, 10).map((m, i) => (
                    <tr key={i} className="border-t border-[#1C2325]">
                      <td className="px-3 py-2">{m.date}</td>
                      <td className="px-3 py-2">{m.description}</td>
                      <td className={cn("px-3 py-2 text-right", m.amount >= 0 && GREEN)}>
                        {m.amount >= 0 ? "+" : "−"}
                        {money(m.amount, m.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.movements.length > 10 ? (
                <p className="px-3 py-2 text-[11px] text-[#7D8287]">
                  …and {parsed.movements.length - 10} more
                </p>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            onClick={submit}
            disabled={!parsed.movements.length || importTx.isPending}
            className="w-fit rounded-full bg-white px-5 py-2 text-sm font-medium text-[#111618] disabled:opacity-50"
          >
            {importTx.isPending ? (
              <Loader2 size={14} className="mr-1 inline animate-spin" />
            ) : (
              <Upload size={14} className="mr-1 inline" />
            )}
            Import {parsed.movements.length} transactions
          </button>
        </div>
      ) : null}

      {result ? (
        <div className="rounded-xl bg-[#111618] p-4 text-sm">
          <p className="font-medium">Import complete</p>
          <ul className="mt-2 space-y-1 text-xs text-[#A3A7AB]">
            <li>{result.importedCount} new rows added for review</li>
            <li>{result.matchedCount} matched existing payments (see Reconciliation)</li>
            <li>{result.alreadyImportedCount} already imported (skipped)</li>
            {result.failedCount ? <li>{result.failedCount} rows rejected by the server</li> : null}
          </ul>
          {result.importedCount ? (
            <button
              type="button"
              onClick={onDone}
              className="mt-3 rounded-full bg-[#1C2325] px-4 py-2 text-xs hover:bg-[#252E31]"
            >
              Review imported rows
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- Reconciliation

function ReconciliationPanel({ canEdit, txs }: { canEdit: boolean; txs: OwnerTransaction[] }) {
  const { toast } = useToast();
  const { data: matches = [], isLoading } = useOwnerReconciliation();
  const resolve = useResolveReconciliation();
  const byId = useMemo(() => new Map(txs.map((t) => [t.id, t])), [txs]);

  const act = async (matchId: string, action: "approve" | "reject") => {
    try {
      await resolve.mutateAsync({ matchId, action });
    } catch (err) {
      toast({
        title: "Couldn't update match",
        description: parseApiError(err, "Please try again"),
        variant: "destructive",
      });
    }
  };

  return (
    <section className={cn(DARK_CARD, "mt-2 flex flex-col gap-3 p-6")}>
      <div>
        <h2 className="text-base font-medium">Reconciliation</h2>
        <p className="mt-1 text-xs text-[#A3A7AB]">
          Bank lines that look like payments already in your ledger. Confirm to mark the payment as
          matched; reject to add the bank line as a separate transaction.
        </p>
      </div>
      {isLoading ? (
        <Loader2 size={16} className="animate-spin text-[#A3A7AB]" />
      ) : !matches.length ? (
        <p className="py-6 text-center text-sm text-[#A3A7AB]">Nothing to reconcile.</p>
      ) : (
        matches.map((m) => {
          const tx = byId.get(m.transactionId);
          return (
            <div
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#111618] p-4 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate">
                  Bank: {m.movement?.description ?? "Bank movement"} ·{" "}
                  {m.movement?.date ? fmtDate(m.movement.date) : ""} · {money(m.amount, m.currency)}
                </p>
                <p className="truncate text-xs text-[#A3A7AB]">
                  Ledger: {tx ? `${tx.name} · ${fmtDate(tx.timestamp)}` : m.transactionId}
                  {m.confidence ? ` · ${Math.round(m.confidence * 100)}% match` : ""}
                </p>
              </div>
              {canEdit ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={resolve.isPending}
                    onClick={() => act(m.id, "approve")}
                    className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-[#111618] disabled:opacity-50"
                  >
                    ✓ Confirm match
                  </button>
                  <button
                    type="button"
                    disabled={resolve.isPending}
                    onClick={() => act(m.id, "reject")}
                    className="rounded-lg bg-[#1C2325] px-3 py-1.5 text-xs text-[#FF6B6B] hover:bg-[#252E31] disabled:opacity-50"
                  >
                    Not a match
                  </button>
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </section>
  );
}
