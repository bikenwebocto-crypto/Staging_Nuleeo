// /banking route. Accounts overview (static demo data for now) + the existing
// shared <BankingSection /> under the "Open banking" tab for real setup.

import { useState, type ReactNode } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  ChevronRight,
  CreditCard,
  FileText,
  Info,
  Plus,
} from "lucide-react";

import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { BankingSection } from "@ui/components/owner/BankingSection";
import { useBankingScope } from "@/lib/useBankingScope";
import { cn } from "@ui/lib/utils";

const CARD = "rounded-[24px] bg-[#111618] text-[#F4F4F2]";
const MUTED = "text-[#A3A7AB]";

type Tab = "accounts" | "open" | "iban" | "import";
const TABS: { id: Tab; label: string }[] = [
  { id: "accounts", label: "Accounts" },
  { id: "open", label: "Open banking" },
  { id: "iban", label: "Nuleeo IBAN" },
  { id: "import", label: "Manual import" },
];

type Badge = { text: string; tone: "warn" | "ok" | "neutral" };
type Account = {
  initial: string;
  name: string;
  meta: string;
  synced?: string;
  balance: number;
  badge?: Badge;
};
type Structure = { name: string; dot: string; accounts: Account[] };

const STRUCTURES: Structure[] = [
  {
    name: "Thoma Holdings Ltd",
    dot: "#F4F4F2",
    accounts: [
      {
        initial: "B",
        name: "Bank of Cyprus · Operating",
        meta: "CY17 •••• 4821 · open banking",
        synced: "synced 2 min ago",
        balance: 30100,
      },
      {
        initial: "H",
        name: "Hellenic Bank",
        meta: "CY62 •••• 7734 · open banking",
        synced: "synced 1 h ago",
        balance: 12450,
      },
      {
        initial: "R",
        name: "Revolut Business",
        meta: "LT12 •••• 0092 · open banking",
        balance: 5610,
        badge: { text: "Consent expires in 8 days", tone: "warn" },
      },
      {
        initial: "N",
        name: "Nuleeo IBAN",
        meta: "CY03 •••• 3300 · issued by payabl. · payments enabled",
        balance: 18200,
        badge: { text: "Sends payments", tone: "ok" },
      },
    ],
  },
  {
    name: "Larnaca Retail SPV",
    dot: "#73C2CD",
    accounts: [
      {
        initial: "B",
        name: "Bank of Cyprus · Operating",
        meta: "CY17 •••• 1190 · open banking",
        synced: "synced 5 min ago",
        balance: 15520,
      },
    ],
  },
  {
    name: "Personally owned · Thanos Thoma",
    dot: "#F5A524",
    accounts: [
      {
        initial: "H",
        name: "Hellenic Bank · Personal",
        meta: "CY08 •••• 5519 · manual import · statement to 30 Sep",
        balance: 2320,
        badge: { text: "Import due", tone: "neutral" },
      },
    ],
  },
];

const eur = (n: number) => `€${n.toLocaleString("en-US")}`;
const sum = (s: Structure) => s.accounts.reduce((t, a) => t + a.balance, 0);
const TOTAL = STRUCTURES.reduce((t, s) => t + sum(s), 0);
const ACCOUNT_COUNT = STRUCTURES.reduce((t, s) => t + s.accounts.length, 0);

const BADGE_TONE: Record<Badge["tone"], string> = {
  warn: "bg-[#3A2A0E] text-[#F5A524]",
  ok: "bg-[#1A3322] text-[#7BD88F]",
  neutral: "bg-[#1C2325] text-[#A3A7AB]",
};

export default function BankingPage() {
  const scope = useBankingScope();
  const [tab, setTab] = useState<Tab>("accounts");

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-6 inline-flex flex-wrap gap-1 rounded-full bg-[#111618] p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "rounded-full px-4 py-1.5 text-sm transition",
              tab === t.id ? "bg-[#1C2325] text-[#F4F4F2]" : "text-[#A3A7AB] hover:text-[#F4F4F2]",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "accounts" ? (
        <AccountsTab />
      ) : (
        <BankingSection returnPath="/banking" scope={scope} />
      )}
    </div>
  );
}

function AccountsTab() {
  return (
    <div className="space-y-6">
      {/* Top: total balance + money in/out */}
      <div className="grid gap-6 lg:grid-cols-[1fr_260px_260px]">
        <div className="p-1 text-[#F4F4F2]">
          <p className={cn("text-sm", MUTED)}>
            Total balance · {STRUCTURES.length} structures · {ACCOUNT_COUNT} accounts
          </p>
          <p className="mt-2 text-5xl font-bold tracking-tight sm:text-6xl">{eur(TOTAL)}</p>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#A3A7AB]">
            {STRUCTURES.map((s) => (
              <span key={s.name} className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: s.dot }} />
                {s.name.replace(" Ltd", "").replace(" · Thanos Thoma", "")} {eur(sum(s))}
              </span>
            ))}
          </div>
          <div className="mt-5 flex gap-6">
            <QuickAction primary icon={<Plus size={20} />} label="Add money" />
            <QuickAction icon={<ArrowLeftRight size={18} />} label="Transfer" />
            <QuickAction icon={<CreditCard size={18} />} label="Cards" />
            <QuickAction icon={<FileText size={18} />} label="Statements" />
          </div>
        </div>
        <FlowCard
          title="Money in · October"
          amount="+€9,600"
          color="#7BD88F"
          sub="11 payments · all tagged"
        />
        <FlowCard
          title="Money out · October"
          amount="−€3,140"
          color="#F4F4F2"
          sub="18 payments · 2 receipts missing"
        />
      </div>

      {/* Bottom: accounts list + side cards */}
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <section className={cn(CARD, "overflow-hidden pb-1")}>
          <div className="flex items-center justify-between px-5 py-5">
            <h2 className="text-base font-medium">Accounts by structure</h2>
            <span className={cn("hidden text-xs sm:inline", MUTED)}>
              Each company keeps its own accounts
            </span>
          </div>
          {STRUCTURES.map((s) => (
            <div key={s.name}>
              <div className="flex items-center justify-between rounded-full bg-[#1C2325] px-5 py-2 text-sm">
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: s.dot }} />
                  {s.name}
                </span>
                <span>{eur(sum(s))}</span>
              </div>
              {s.accounts.map((a) => (
                <AccountRow key={a.meta} a={a} />
              ))}
            </div>
          ))}
        </section>

        <div className="space-y-6">
          <section className={cn(CARD, "p-5")}>
            <h2 className="text-base font-medium">Rent collection</h2>
            <p className={cn("mt-2 text-xs", MUTED)}>
              How tenants pay you. Every payment is tagged to its unit.
            </p>
            <div className="mt-4 space-y-4">
              <RentMethod title="Bank transfer (IBAN)" sub="Tenants pay into CY17 •••• 4821" />
              <RentMethod title="Card payments (Stripe)" sub="For tenants who prefer card" />
            </div>
          </section>

          <section className={cn(CARD, "p-5")}>
            <h2 className="text-base font-medium">Add an account</h2>
            <div className="mt-4 space-y-3">
              <AddOption
                title="Connect a bank"
                sub="Open banking · choose the property or company first"
              />
              <AddOption title="Open a Nuleeo IBAN" sub="Account and card with payabl." />
              <AddOption title="Import a statement" sub="PDF or CSV, for banks without a feed" />
            </div>
          </section>
        </div>
      </div>

      <div className={cn(CARD, "flex items-center gap-3 rounded-[16px] px-4 py-4 text-xs", MUTED)}>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#1C2325] text-[#73C2CD]">
          <Info size={14} />
        </span>
        Accounts belong to the company (or to you personally) that owns the property. Every account,
        whichever way it's connected, feeds one ledger.
      </div>
    </div>
  );
}

function QuickAction({
  icon,
  label,
  primary,
}: {
  icon: ReactNode;
  label: string;
  primary?: boolean;
}) {
  return (
    <button type="button" className="flex flex-col items-center gap-2 text-xs text-[#F4F4F2]">
      <span
        className={cn(
          "grid h-12 w-12 place-items-center rounded-full transition",
          primary ? "bg-white text-black hover:bg-white/90" : "bg-[#1C2325] hover:bg-[#2A3134]",
        )}
      >
        {icon}
      </span>
      {label}
    </button>
  );
}

function FlowCard({
  title,
  amount,
  color,
  sub,
}: {
  title: string;
  amount: string;
  color: string;
  sub: string;
}) {
  return (
    <div className={cn(CARD, "flex min-h-[200px] flex-col justify-between p-5")}>
      <p className={cn("text-sm", MUTED)}>{title}</p>
      <div>
        <p className="text-3xl font-bold" style={{ color }}>
          {amount}
        </p>
        <p className={cn("mt-1 text-xs", MUTED)}>{sub}</p>
      </div>
    </div>
  );
}

function AccountRow({ a }: { a: Account }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-[#161C1E]"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#1C2325] text-xs">
        {a.initial}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{a.name}</span>
        <span className={cn("block truncate text-xs", MUTED)}>
          {a.meta}
          {a.synced && <span className="text-[#73C2CD]"> · {a.synced}</span>}
        </span>
      </span>
      {a.badge && (
        <span
          className={cn(
            "hidden shrink-0 rounded-full px-2 py-0.5 text-[11px] sm:inline",
            BADGE_TONE[a.badge.tone],
          )}
        >
          {a.badge.text}
        </span>
      )}
      <span className="shrink-0 text-sm">{eur(a.balance)}</span>
      <ChevronRight size={16} className="shrink-0 text-[#7D8287]" />
    </button>
  );
}

function RentMethod({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="text-sm">{title}</p>
        <p className={cn("text-xs", MUTED)}>{sub}</p>
      </div>
      <span className="rounded-full bg-[#1A3322] px-2 py-0.5 text-[11px] text-[#7BD88F]">
        Active
      </span>
    </div>
  );
}

function AddOption({ title, sub }: { title: string; sub: string }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-[12px] bg-[#1C2325] px-3 py-3 text-left hover:bg-[#2A3134]"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{title}</span>
        <span className={cn("block text-xs", MUTED)}>{sub}</span>
      </span>
      <ArrowRight size={14} className="shrink-0 text-[#73C2CD]" />
    </button>
  );
}
