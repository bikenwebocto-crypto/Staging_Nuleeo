// Transactions — /owner/transaction.
// Static design (no backend): entity + bank account switchers, ledger tabs,
// filters, summary totals and a ledger table with AI-suggested category /
// property fields that the owner approves row by row.
import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeftRight,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  FileText,
  Home,
  Paperclip,
  Plus,
  Search,
  Sparkles,
  Store,
  Upload,
  User,
  Wrench,
  Zap,
} from "lucide-react";

import { HeaderActions, PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { DARK_CARD, PILL_SOLID } from "@/components/owner/property/ui";
import { cn } from "@ui/lib/utils";

type TxType = "Income" | "Expense" | "Transfer" | "—";
type Tx = {
  id: string;
  date: string;
  description: string;
  icon: ReactNode;
  type: TxType;
  amount: number;
  category: string | null;
  property: string | null;
  suggested: boolean;
  invoice: "attached" | "add" | "none";
  status: "approved" | "pending" | "resolve";
};

const ENTITIES = [
  {
    id: "personal",
    name: "Thanos Thoma",
    meta: "Personal · 2 properties · 1 bank",
    icon: <User size={18} />,
  },
  {
    id: "holdings",
    name: "Thoma Holdings Ltd",
    meta: "Company · 2 properties · 3 banks",
    icon: <Building2 size={18} />,
  },
  {
    id: "larnaca",
    name: "Larnaca Retail SPV",
    meta: "Company · 1 property · 1 business · 1 bank",
    icon: <Store size={18} />,
  },
];

const ACCOUNTS = [
  { id: "boc", name: "Bank of Cyprus ••••4821", sub: "€48,300 · synced 2 min ago" },
  { id: "hel", name: "Hellenic ••••7734", sub: "€12,450" },
  { id: "rev", name: "Revolut ••••0092", sub: "€5,610" },
  { id: "all", name: "All accounts", sub: "Combined" },
];

const TABS = ["Ledger", "Needs attention", "Import", "Reconciliation"] as const;
const FILTERS = ["This month · Sep 2026", "Type", "Category", "Property or entity", "Status"];
const CATEGORIES = [
  "Rent",
  "Utilities",
  "Maintenance",
  "Professional fees",
  "Internal transfer",
  "Insurance",
];
const PROPERTIES = [
  "Apartment 14B",
  "Limassol Heights",
  "Limassol Heights · A1",
  "Limassol Heights · A3",
  "Thoma Holdings Ltd",
];

const CATEGORY_TYPE: Record<string, TxType> = {
  Rent: "Income",
  Utilities: "Expense",
  Maintenance: "Expense",
  "Professional fees": "Expense",
  Insurance: "Expense",
  "Internal transfer": "Transfer",
};

const INITIAL: Tx[] = [
  {
    id: "1",
    date: "8 Sep",
    description: "Rent · Maria Konstantinou",
    icon: <Home size={16} />,
    type: "Income",
    amount: 1200,
    category: "Rent",
    property: "Apartment 14B",
    suggested: false,
    invoice: "attached",
    status: "approved",
  },
  {
    id: "2",
    date: "6 Sep",
    description: "Rent · Andreas Christou",
    icon: <Home size={16} />,
    type: "Income",
    amount: 1100,
    category: "Rent",
    property: "Limassol Heights · A1",
    suggested: true,
    invoice: "add",
    status: "pending",
  },
  {
    id: "3",
    date: "5 Sep",
    description: "EAC Electricity",
    icon: <Zap size={16} />,
    type: "Expense",
    amount: -61,
    category: "Utilities",
    property: "Limassol Heights",
    suggested: true,
    invoice: "attached",
    status: "pending",
  },
  {
    id: "4",
    date: "4 Sep",
    description: "Rent · George Papadopoulos",
    icon: <Home size={16} />,
    type: "Income",
    amount: 1200,
    category: "Rent",
    property: "Limassol Heights · A3",
    suggested: true,
    invoice: "add",
    status: "pending",
  },
  {
    id: "5",
    date: "4 Sep",
    description: "Maintenance · plumbing",
    icon: <Wrench size={16} />,
    type: "Expense",
    amount: -500,
    category: "Maintenance",
    property: "Apartment 14B",
    suggested: true,
    invoice: "add",
    status: "pending",
  },
  {
    id: "6",
    date: "3 Sep",
    description: "Accounting fee",
    icon: <FileText size={16} />,
    type: "Expense",
    amount: -150,
    category: "Professional fees",
    property: "Thoma Holdings Ltd",
    suggested: false,
    invoice: "attached",
    status: "approved",
  },
  {
    id: "7",
    date: "3 Sep",
    description: "Transfer to tax wallet",
    icon: <ArrowLeftRight size={16} />,
    type: "Transfer",
    amount: -600,
    category: "Internal transfer",
    property: "Thoma Holdings Ltd",
    suggested: false,
    invoice: "none",
    status: "approved",
  },
  {
    id: "8",
    date: "2 Sep",
    description: "Incoming transfer · ref 88213",
    icon: <ArrowLeftRight size={16} />,
    type: "—",
    amount: 300,
    category: null,
    property: null,
    suggested: false,
    invoice: "add",
    status: "resolve",
  },
];

const GREEN = "text-[#7BD88F]";
const eur = (n: number) => `€${Math.abs(n).toLocaleString("en-US")}`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${eur(n)}`;

export default function TransactionsPage() {
  const [entity, setEntity] = useState("holdings");
  const [account, setAccount] = useState("boc");
  const [tab, setTab] = useState<(typeof TABS)[number]>("Ledger");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Tx[]>(INITIAL);

  const pendingCount = rows.filter((r) => r.status === "pending").length;
  const entityName = ENTITIES.find((e) => e.id === entity)?.name;
  const accountName = ACCOUNTS.find((a) => a.id === account)?.name;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab === "Needs attention" && r.status === "approved") return false;
      return !q || r.description.toLowerCase().includes(q);
    });
  }, [rows, search, tab]);

  const totals = useMemo(() => {
    let income = 0,
      expense = 0,
      transfers = 0;
    rows.forEach((r) => {
      if (r.type === "—") return; // uncategorised: excluded until resolved
      if (r.type === "Transfer") transfers += Math.abs(r.amount);
      else if (r.amount >= 0) income += r.amount;
      else expense += -r.amount;
    });
    return { income, expense, transfers, net: income - expense };
  }, [rows]);

  const update = (id: string, patch: Partial<Tx>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const approve = (id: string) => update(id, { status: "approved", suggested: false });
  const approveAll = () =>
    setRows((rs) =>
      rs.map((r) => (r.status === "pending" ? { ...r, status: "approved", suggested: false } : r)),
    );

  return (
    <>
      <HeaderActions>
        <div className="flex items-center gap-2">
          <button type="button" className={PILL_SOLID}>
            <Upload size={16} /> Upload invoices
          </button>
          <button type="button" className={PILL_SOLID}>
            <Download size={16} /> Export
          </button>
        </div>
      </HeaderActions>

      <div className={PAGE_CONTAINER_CLASSNAME}>
        <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 text-[#F4F4F2]">
          {/* Entity */}
          <div>
            <p className="mb-2 text-xs text-[#A3A7AB]">Entity</p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {ENTITIES.map((e) => {
                const active = e.id === entity;
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => setEntity(e.id)}
                    className={cn(
                      "flex items-center gap-4 rounded-[20px] px-4 py-4 text-left transition",
                      active ? "bg-[#1F2A2C]" : "bg-[#111618] hover:bg-[#161D1F]",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                        active ? "bg-white text-[#111618]" : "bg-[#1C2325] text-[#F4F4F2]",
                      )}
                    >
                      {e.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{e.name}</span>
                      <span className="block truncate text-xs text-[#A3A7AB]">{e.meta}</span>
                    </span>
                    {active ? <CheckCircle2 size={18} className="shrink-0" /> : null}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Bank account */}
          <div>
            <p className="mb-2 text-xs text-[#A3A7AB]">Bank account</p>
            <div className="flex flex-wrap gap-2">
              {ACCOUNTS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAccount(a.id)}
                  className={cn(
                    "rounded-xl px-3 py-2 text-left transition",
                    a.id === account ? "bg-[#1F2A2C]" : "hover:bg-[#161D1F]",
                  )}
                >
                  <span className="block text-xs font-medium">{a.name}</span>
                  <span className="block text-[11px] text-[#A3A7AB]">{a.sub}</span>
                </button>
              ))}
            </div>
          </div>

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
              </button>
            ))}
          </div>

          {/* Ledger card */}
          <section className={cn(DARK_CARD, "mt-6 overflow-hidden")}>
            <div className="flex flex-col gap-4 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-medium">
                  {entityName} · {accountName}
                </h2>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded-full bg-[#1C2325] px-4 py-2 text-sm hover:bg-[#252E31]"
                  >
                    <Plus size={14} className="mr-1 inline" /> Add transaction
                  </button>
                  <button
                    type="button"
                    onClick={approveAll}
                    disabled={!pendingCount}
                    className="rounded-full bg-white px-4 py-2 text-sm font-medium text-[#111618] disabled:opacity-50"
                  >
                    <Check size={14} className="mr-1 inline" /> Approve all suggested (
                    {pendingCount})
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="inline-flex items-center gap-2 rounded-full bg-[#1C2325] px-3 py-1.5 text-xs hover:bg-[#252E31]"
                  >
                    {f} <ChevronDown size={12} className="text-[#A3A7AB]" />
                  </button>
                ))}
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

              <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
                <div className="flex flex-wrap gap-6 text-sm text-[#A3A7AB]">
                  <span>
                    Income <b className={cn("font-semibold", GREEN)}>{eur(totals.income)}</b>
                  </span>
                  <span>
                    Expense <b className="font-semibold text-[#F4F4F2]">{eur(totals.expense)}</b>
                  </span>
                  <span>Transfers {eur(totals.transfers)}</span>
                  <span>
                    Net <b className="font-semibold text-[#F4F4F2]">{eur(totals.net)}</b>
                  </span>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#7BD88F]/10 px-3 py-1 text-xs text-[#7BD88F]">
                  <CheckCircle2 size={13} /> Bank-fed €48,300 matches Bank of Cyprus
                </span>
              </div>
              <p className="flex items-center gap-1.5 text-[11px] text-[#A3A7AB]">
                <Sparkles size={11} className="text-[#6FD3C9]" /> AI-suggested · check and approve
              </p>
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
                    <th className="px-3 py-4 text-left font-normal">Property or entity</th>
                    <th className="px-3 py-4 text-center font-normal">Invoice</th>
                    <th className="px-5 py-4 text-center font-normal">Approve</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const editable = r.status !== "approved";
                    return (
                      <tr key={r.id} className="h-14">
                        <td className="px-5 text-xs text-[#A3A7AB]">{r.date}</td>
                        <td className="px-3">
                          <div className="flex items-center gap-3">
                            <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-[#1C2325]">
                              {r.icon}
                              <span
                                className={cn(
                                  "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#111618]",
                                  r.amount >= 0 ? "bg-[#7BD88F]" : "bg-[#3A4346]",
                                )}
                              />
                            </span>
                            {r.description}
                          </div>
                        </td>
                        <td className="px-3">{r.type}</td>
                        <td className={cn("px-3 text-right font-medium", r.amount >= 0 && GREEN)}>
                          {signed(r.amount)}
                        </td>
                        <td className="px-3">
                          {editable ? (
                            <SuggestSelect
                              value={r.category}
                              options={CATEGORIES}
                              suggested={r.suggested}
                              onChange={(v) =>
                                update(r.id, { category: v, type: CATEGORY_TYPE[v] ?? r.type })
                              }
                            />
                          ) : (
                            r.category
                          )}
                        </td>
                        <td className="px-3">
                          {editable ? (
                            <SuggestSelect
                              value={r.property}
                              options={PROPERTIES}
                              suggested={r.suggested}
                              onChange={(v) => update(r.id, { property: v })}
                            />
                          ) : (
                            r.property
                          )}
                        </td>
                        <td className="px-3 text-center text-[#A3A7AB]">
                          {r.invoice === "attached" ? (
                            <Paperclip size={14} className="mx-auto" />
                          ) : r.invoice === "add" ? (
                            <button
                              type="button"
                              aria-label="Attach invoice"
                              className="hover:text-white"
                            >
                              <Plus size={14} />
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-5 text-center">
                          {r.status === "approved" ? (
                            <span className={cn("text-xs", GREEN)}>✓ Approved</span>
                          ) : r.status === "pending" ? (
                            <button
                              type="button"
                              onClick={() => approve(r.id)}
                              className="rounded-lg bg-[#1C2325] px-3 py-1.5 text-xs hover:bg-[#252E31]"
                            >
                              ✓ Approve
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={!r.category || !r.property}
                              onClick={() => approve(r.id)}
                              className="rounded-lg bg-[#1C2325] px-3 py-1.5 text-xs text-[#FF6B6B] hover:bg-[#252E31] disabled:cursor-not-allowed"
                            >
                              Resolve
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {!visible.length ? (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-sm text-[#A3A7AB]">
                        No transactions match.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <p className="px-5 py-4 text-xs text-[#A3A7AB]">
              Showing {visible.length} of 128 · Type follows the category: change the category and
              the type updates. ✦ fields are AI suggestions: adjust, then approve. Transfers between
              your own accounts are excluded from revenue: revenue counts tenant payments only.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}

function SuggestSelect({
  value,
  options,
  suggested,
  onChange,
}: {
  value: string | null;
  options: string[];
  suggested: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="relative flex h-8 w-[170px] items-center rounded-md bg-[#1C2325] px-2.5 text-xs">
      {suggested && value ? <span className="mr-1.5 text-[#6FD3C9]">✦</span> : null}
      <span className={cn("flex-1 truncate", !value && "text-[#7D8287]")}>
        {value ?? "Select..."}
      </span>
      <ChevronDown size={12} className="text-[#7D8287]" />
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="" disabled>
          Select...
        </option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
