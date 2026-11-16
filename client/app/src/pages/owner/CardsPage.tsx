// /owner/cards route. Static design: one card per company, card detail +
// card payments with receipt matching. Demo data only for now.

import { useState } from "react";
import { Plus } from "lucide-react";

import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { cn } from "@ui/lib/utils";

const CARD = "rounded-[24px] bg-[#111618] text-[#F4F4F2]";
const MUTED = "text-[#A3A7AB]";

type CardItem = {
  id: string;
  company: string;
  type: "Virtual" | "Physical";
  last4: string;
  spent: number;
  limit: number;
  swatch: string;
  expiry: string;
  iban: string;
};

const CARDS: CardItem[] = [
  {
    id: "thoma",
    company: "Thoma Holdings Ltd",
    type: "Virtual",
    last4: "4821",
    spent: 1756,
    limit: 5000,
    swatch: "#1C2325",
    expiry: "09/29",
    iban: "3300",
  },
  {
    id: "larnaca",
    company: "Larnaca Retail SPV",
    type: "Physical",
    last4: "1190",
    spent: 640,
    limit: 3000,
    swatch: "#73C2CD",
    expiry: "04/28",
    iban: "1190",
  },
  {
    id: "personal",
    company: "Thanos Thoma · personal",
    type: "Virtual",
    last4: "5519",
    spent: 120,
    limit: 1000,
    swatch: "#F5A524",
    expiry: "11/27",
    iban: "5519",
  },
];

type Payment = {
  initials: string;
  name: string;
  meta: string;
  amount: string;
  date: string;
  receipt: "matched" | "missing";
};

const PAYMENTS: Payment[] = [
  {
    initials: "TS",
    name: "Thermo Services Ltd",
    meta: "Repairs · Limassol Heights A2",
    amount: "−€1,240.00",
    date: "6 Oct",
    receipt: "matched",
  },
  {
    initials: "AC",
    name: "Andreou & Co Accountants",
    meta: "Accounting · Thoma Holdings Ltd",
    amount: "−€331.60",
    date: "3 Oct",
    receipt: "matched",
  },
  {
    initials: "KH",
    name: "Kanika Hardware",
    meta: "Repairs · Apartment 14B",
    amount: "−€142.00",
    date: "2 Oct",
    receipt: "missing",
  },
  {
    initials: "EF",
    name: "Epic Fibre",
    meta: "Utilities · Limassol Heights common areas",
    amount: "−€42.00",
    date: "1 Oct",
    receipt: "matched",
  },
];

const eur = (n: number) => `€${n.toLocaleString("en-US")}`;

export default function CardsPage() {
  const [selectedId, setSelectedId] = useState(CARDS[0].id);
  const [askReceipt, setAskReceipt] = useState(true);
  const selected = CARDS.find((c) => c.id === selectedId) ?? CARDS[0];
  const matched = PAYMENTS.filter((p) => p.receipt === "matched").length;

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4 text-[#F4F4F2]">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Cards</h1>
          <p className={cn("mt-1 text-sm", MUTED)}>
            A card for each company. Every payment lands tagged, with its receipt.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-[12px] bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90"
        >
          <Plus size={16} /> New card
        </button>
      </div>

      {/* Card selector */}
      <div className="mb-6 grid gap-4 md:grid-cols-3">
        {CARDS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setSelectedId(c.id)}
            className={cn(
              "flex items-center gap-4 rounded-[20px] px-4 py-4 text-left text-[#F4F4F2] transition",
              c.id === selectedId ? "bg-[#2A3134]" : "bg-[#111618] hover:bg-[#161C1E]",
            )}
          >
            <span
              className="h-7 w-10 shrink-0 rounded-[6px] border border-white/10"
              style={{ background: c.swatch }}
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{c.company}</span>
              <span className={cn("block text-xs", MUTED)}>
                {c.type} · •• {c.last4}
              </span>
              <span className={cn("block text-xs", MUTED)}>
                {eur(c.spent)} of {eur(c.limit)}
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[440px_1fr]">
        {/* Card detail */}
        <section className={cn(CARD, "p-6")}>
          <h2 className="text-base font-medium">{selected.company}</h2>

          <div className="relative mt-4 aspect-[1.65] overflow-hidden rounded-[18px] border border-white/10 bg-gradient-to-br from-[#2A2D2E] to-[#161819] p-6">
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full opacity-40"
              viewBox="0 0 400 240"
              fill="none"
            >
              <path d="M200 0v60l45 0-45 60v120" stroke="#3A3F42" />
              <path d="M270 30h130M270 30v160h130" stroke="#3A3F42" />
            </svg>
            <div className="relative flex h-full flex-col justify-between">
              <div className="flex items-start justify-between">
                <span className="text-xl font-bold">Nuleeo</span>
                <span className={cn("text-xs", MUTED)}>{selected.type}</span>
              </div>
              <span className="h-8 w-11 rounded-[6px] bg-gradient-to-br from-[#E6E6E6] to-[#9A9A9A]" />
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-sm text-[#D4F542]">Know what you own.</p>
                  <p className="mt-1 text-base tracking-wider">•••• {selected.last4}</p>
                </div>
                <span className={cn("text-sm", MUTED)}>{selected.expiry}</span>
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            {["Freeze", "Show details", "Add to wallet"].map((l) => (
              <button
                key={l}
                type="button"
                className="rounded-[12px] bg-[#1C2325] py-2 text-sm hover:bg-[#2A3134]"
              >
                {l}
              </button>
            ))}
          </div>

          <div className="mt-5 flex items-center justify-between text-sm">
            <span className={cn("text-xs", MUTED)}>Monthly limit</span>
            <span>
              {eur(selected.spent)} of {eur(selected.limit)}
            </span>
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-[#1C2325]">
            <div
              className="h-full rounded-full bg-white"
              style={{ width: `${(selected.spent / selected.limit) * 100}%` }}
            />
          </div>

          <div className="mt-5 rounded-[14px] bg-[#1C2325] p-4">
            <p className={cn("text-xs", MUTED)}>Auto-tagging</p>
            <p className="mt-1 text-xs leading-relaxed">
              Paid from the Nuleeo IBAN •••• {selected.iban}. Payments are tagged to{" "}
              {selected.company}; the property is picked from the receipt.
            </p>
          </div>

          <label className="mt-4 flex cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={askReceipt}
              onChange={(e) => setAskReceipt(e.target.checked)}
              className="h-4 w-4 accent-white"
            />
            Ask for the receipt after every payment
          </label>
        </section>

        {/* Payments */}
        <section className={cn(CARD, "self-start p-5")}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-base font-medium">Card payments · October</h2>
            <span className={cn("text-xs", MUTED)}>
              {matched} of {PAYMENTS.length} receipts matched
            </span>
          </div>
          <div className="divide-y divide-white/5">
            {PAYMENTS.map((p) => (
              <div key={p.name} className="flex items-center gap-3 py-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#1C2325] text-xs">
                  {p.initials}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{p.name}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("text-xs", MUTED)}>{p.meta}</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px]",
                        p.receipt === "matched"
                          ? "bg-[#1A3322] text-[#7BD88F]"
                          : "bg-[#3A2A0E] text-[#F5A524]",
                      )}
                    >
                      {p.receipt === "matched"
                        ? "Receipt matched"
                        : "Receipt missing · reminder sent"}
                    </span>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium">{p.amount}</p>
                  <p className={cn("text-[11px]", MUTED)}>{p.date}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <p className={cn("mt-6 text-xs", MUTED)}>
        Cards are issued through our banking partner payabl.
      </p>
    </div>
  );
}
