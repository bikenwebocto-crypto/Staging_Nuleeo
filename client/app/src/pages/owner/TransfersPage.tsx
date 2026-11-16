// /owner/transfers route. Static design of the "New transfer" flow:
// from account → payee → amount → tagging, with a live summary. Demo data only.

import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { Check, ChevronDown, ChevronRight, Plus, Search, Sparkles, X } from "lucide-react";

import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { cn } from "@ui/lib/utils";

const CARD = "rounded-[24px] bg-[#111618] text-[#F4F4F2]";
const MUTED = "text-[#A3A7AB]";
const FIELD =
  "flex w-full items-center rounded-full bg-[#1C2325] px-4 py-2.5 text-sm text-[#F4F4F2]";

type Group = "Business" | "Personal" | "My accounts";
type Payee = {
  id: string;
  initials: string;
  name: string;
  iban: string;
  meta: string;
  group: Group;
};

const PAYEES: Payee[] = [
  {
    id: "ac",
    initials: "AC",
    name: "Andreou & Co Accountants",
    iban: "CY89 •••• 2207",
    meta: "paid 6 times",
    group: "Business",
  },
  {
    id: "ts",
    initials: "TS",
    name: "Thermo Services Ltd",
    iban: "CY31 •••• 9024",
    meta: "paid 12 times",
    group: "Business",
  },
  {
    id: "lh",
    initials: "LH",
    name: "Limassol Heights Owners Committee",
    iban: "CY40 •••• 1182",
    meta: "common charges · monthly",
    group: "Business",
  },
  {
    id: "eg",
    initials: "EG",
    name: "Eleni Georgiou",
    iban: "GR16 •••• 5530",
    meta: "deposit refund · paid once",
    group: "Personal",
  },
];

const FILTERS: { id: "all" | Group; label: string; count: number }[] = [
  { id: "all", label: "All payees", count: 4 },
  { id: "Business", label: "Business", count: 3 },
  { id: "Personal", label: "Personal", count: 1 },
  { id: "My accounts", label: "My accounts", count: 3 },
];

const TIMING = ["Now", "Later", "Monthly"] as const;

export default function TransfersPage() {
  const [filter, setFilter] = useState<"all" | Group>("all");
  const [payeeId, setPayeeId] = useState("ac");
  const [query, setQuery] = useState("");
  const [timing, setTiming] = useState<(typeof TIMING)[number]>("Now");
  const payee = PAYEES.find((p) => p.id === payeeId) ?? PAYEES[0];

  const visible = PAYEES.filter(
    (p) =>
      (filter === "all" || p.group === filter) &&
      (!query || `${p.name} ${p.iban}`.toLowerCase().includes(query.toLowerCase())),
  );
  const groups = (["Business", "Personal"] as Group[])
    .map((g) => ({ g, items: visible.filter((p) => p.group === g) }))
    .filter((x) => x.items.length);

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-6 flex items-center justify-between text-sm text-[#F4F4F2]">
        <nav className="flex items-center gap-1">
          <span className={MUTED}>Transfers</span>
          <ChevronRight size={14} className={MUTED} />
          <span>New transfer</span>
        </nav>
        <Link
          href="/banking"
          className="grid h-10 w-10 place-items-center rounded-full bg-[#1C2325] hover:bg-[#2A3134]"
        >
          <X size={18} />
        </Link>
      </div>

      <div className="mx-auto max-w-[1060px] text-[#F4F4F2]">
        <h1 className="text-3xl font-semibold tracking-tight">New transfer</h1>
        <p className={cn("mt-1 text-sm", MUTED)}>Pay, tag and attach the invoice in one step.</p>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
          <section className={cn(CARD, "space-y-5 p-6")}>
            {/* 1. From */}
            <Step n={1} title="From" />
            <div>
              <Label>Account</Label>
              <button type="button" className={cn(FIELD, "justify-between")}>
                Thoma Holdings Ltd · Nuleeo IBAN · CY03 •••• 3300 · €18,200
                <ChevronDown size={14} className={MUTED} />
              </button>
              <p className={cn("mt-2 text-xs", MUTED)}>
                Payments go out from your Nuleeo IBAN. Connected banks are read-only.
              </p>
            </div>

            {/* 2. To */}
            <div className="flex items-center justify-between">
              <Step n={2} title="To" />
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-[12px] bg-[#1C2325] px-3 py-2 text-sm hover:bg-[#2A3134]"
              >
                <Plus size={14} /> New payee
              </button>
            </div>
            <div>
              <Label>Search payees</Label>
              <div className={FIELD}>
                <Search size={14} className={cn("mr-2", MUTED)} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name or IBAN"
                  className="w-full bg-transparent outline-none placeholder:text-[#F4F4F2]"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs transition",
                    filter === f.id ? "bg-white text-black" : "bg-[#1C2325] hover:bg-[#2A3134]",
                  )}
                >
                  {f.label} · {f.count}
                </button>
              ))}
            </div>
            {groups.length === 0 && <p className={cn("text-sm", MUTED)}>No payees found.</p>}
            {groups.map(({ g, items }) => (
              <div key={g} className="space-y-2">
                <p className={cn("text-xs", MUTED)}>
                  {g} · {items.length}
                </p>
                {items.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPayeeId(p.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-[14px] px-4 py-3 text-left transition",
                      p.id === payeeId ? "bg-[#2A3134]" : "bg-[#1C2325] hover:bg-[#232A2D]",
                    )}
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#111618] text-xs">
                      {p.initials}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{p.name}</span>
                      <span className={cn("block truncate text-xs", MUTED)}>
                        {p.iban} · {p.meta}
                      </span>
                    </span>
                    {p.id === payeeId && <Check size={16} />}
                  </button>
                ))}
              </div>
            ))}

            {/* 3. Amount */}
            <Step n={3} title="Amount" />
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Amount</Label>
                <div className={cn(FIELD, "py-3 text-xl font-medium")}>€420.00</div>
              </div>
              <div>
                <Label>Reference</Label>
                <div className={FIELD}>INV-2026-0918 · Q3 accounting</div>
              </div>
            </div>

            {/* 4. Tag */}
            <Step n={4} title="Tag this payment" />
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Category</Label>
                <SuggestSelect>Accounting fees</SuggestSelect>
              </div>
              <div>
                <Label>Property or entity</Label>
                <SuggestSelect>Thoma Holdings Ltd</SuggestSelect>
              </div>
            </div>
            <p className={cn("text-xs", MUTED)}>
              <span className="text-[#73C2CD]">✦</span> Suggested from your last 6 payments to this
              payee. Type follows the category: Expense.
            </p>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] bg-[#1C2325] px-4 py-3">
              <div>
                <p className="text-sm">INV-2026-0918.pdf</p>
                <p className="text-xs text-[#7BD88F]">Invoice matched · €420.00</p>
              </div>
              <div className="flex gap-1">
                {TIMING.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTiming(t)}
                    className={cn(
                      "rounded-[10px] px-3 py-1.5 text-xs transition",
                      timing === t ? "bg-white text-black" : cn(MUTED, "hover:text-[#F4F4F2]"),
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Summary */}
          <aside className={cn(CARD, "self-start p-6 lg:sticky lg:top-24")}>
            <h2 className="text-base font-medium">Summary</h2>
            <p className={cn("mt-3 text-xs", MUTED)}>You're sending</p>
            <p className="mt-1 text-4xl font-bold tracking-tight">€420.00</p>
            <p className="mt-3 text-sm">to {payee.name}</p>
            <p className="text-xs text-[#7BD88F]">{payee.iban} · ✓ name verified</p>
            <dl className="mt-4 space-y-2.5 text-xs">
              <Row k="From" v="Nuleeo IBAN •••• 3300" />
              <Row
                k="Arrives"
                v={
                  timing === "Now"
                    ? "In seconds · SEPA Instant"
                    : timing === "Later"
                      ? "On scheduled date"
                      : "Every month"
                }
              />
              <Row k="Tagged as" v="Accounting fees · Thoma Holdings Ltd" />
              <Row k="Invoice" v="Attached" />
              <Row k="Balance after" v="€17,780" />
            </dl>
            <button
              type="button"
              className="mt-5 w-full rounded-[12px] bg-white py-3 text-sm font-medium text-black hover:bg-white/90"
            >
              Confirm in the app
            </button>
            <p className={cn("mt-3 text-center text-xs", MUTED)}>
              You'll approve with Face ID or your PIN on your phone.
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Step({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-2 text-sm font-medium">
      <span className="grid h-5 w-5 place-items-center rounded-full bg-white text-[11px] text-black">
        {n}
      </span>
      {title}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className={cn("mb-2 text-xs", MUTED)}>{children}</p>;
}

function SuggestSelect({ children }: { children: ReactNode }) {
  return (
    <button type="button" className={cn(FIELD, "justify-between")}>
      <span className="inline-flex items-center gap-2">
        <Sparkles size={12} className="text-[#73C2CD]" />
        {children}
      </span>
      <ChevronDown size={14} className={MUTED} />
    </button>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className={MUTED}>{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
}
