// Building blocks for the Portfolio list, Property page and Complete-profile
// wizard (Nuleeo "final direction" designs). Dark cards on the page surface,
// pill-shaped inputs, and text-only segmented toggles where the selected
// option becomes a filled pill.
import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@ui/lib/utils";
import { PALETTE } from "@/components/owner/dashboard/tokens";

export const DARK_CARD = "rounded-[24px] bg-[#111618] text-[#F4F4F2]";
export const PILL_BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68] disabled:opacity-50";
export const PILL_DARK = `${PILL_BTN} bg-[#1C2325] text-[#F4F4F2] hover:bg-[#2A3134]`;
export const PILL_SOLID = `${PILL_BTN} bg-[#111618] text-[#F4F4F2] hover:bg-[#1C2325]`;
export const PILL_GHOST = `${PILL_BTN} text-foreground hover:bg-muted/60`;

// €3.28M / €380K / €1.2K / €950
export function money(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const sign = amount < 0 ? "−" : "";
  const a = Math.abs(amount);
  if (a >= 1_000_000) return `${sign}€${(a / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (a >= 1_000) return `${sign}€${(a / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${sign}€${Math.round(a)}`;
}

// €14,400
export function moneyFull(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const sign = amount < 0 ? "−" : "";
  return `${sign}€${Math.round(Math.abs(amount)).toLocaleString("en-GB")}`;
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits).replace(/\.0$/, "")}%`;
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function formatMonth(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 7 ? `${iso}-01` : iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

type Tone = "green" | "amber" | "coral" | "cyan" | "muted";
const TONE: Record<Tone, string> = {
  green: PALETTE.green,
  amber: PALETTE.amber,
  coral: PALETTE.coral,
  cyan: PALETTE.cyan,
  muted: PALETTE.muted,
};

export function StatusChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  const c = TONE[tone];
  return (
    <span
      className="inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-4"
      style={{ backgroundColor: `${c}1F`, color: c }}
    >
      {children}
    </span>
  );
}

export function KpiBar({
  items,
}: {
  items: { label: string; value: ReactNode; tone?: "green" | "coral" }[];
}) {
  return (
    <section className={cn(DARK_CARD, "grid grid-cols-2 gap-y-4 px-4 py-5 md:grid-cols-4")}>
      {items.map((k) => (
        <div key={k.label} className="text-center">
          <p className="text-xs" style={{ color: PALETTE.muted }}>
            {k.label}
          </p>
          <p
            className="mt-1 text-xl font-semibold tabular-nums"
            style={{ color: k.tone ? TONE[k.tone] : PALETTE.text }}
          >
            {k.value}
          </p>
        </div>
      ))}
    </section>
  );
}

export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div
      role="tablist"
      className="inline-flex max-w-full gap-1 overflow-x-auto rounded-full bg-[#111618] p-1"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className="shrink-0 rounded-full px-3 py-1.5 text-sm transition focus-visible:outline-2 focus-visible:outline-[#A78C68]"
          style={{ color: value === t.id ? PALETTE.text : PALETTE.muted }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CardHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 pt-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {action}
    </div>
  );
}

export function KV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
      <span style={{ color: PALETTE.muted }}>{label}</span>
      <span className="text-right font-medium tabular-nums">{value}</span>
    </div>
  );
}

// ── Form controls (wizard) ─────────────────────────────────────────────

export function Field({
  label,
  error,
  warning,
  children,
  className,
}: {
  label: string;
  error?: string | null;
  warning?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      ) : warning ? (
        <span className="text-xs text-amber-700 dark:text-amber-300">{warning}</span>
      ) : null}
    </label>
  );
}

export function PillInput({
  suffix,
  invalid,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { suffix?: string; invalid?: boolean }) {
  return (
    <span
      className={cn(
        "flex h-10 items-center rounded-full bg-[#111618] px-4 text-sm text-[#F4F4F2] focus-within:ring-2 focus-within:ring-[#A78C68]",
        invalid && "ring-2 ring-red-500/70",
        className,
      )}
    >
      <input
        {...props}
        aria-invalid={invalid || undefined}
        className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-[#7D8287] disabled:opacity-50 [color-scheme:dark]"
      />
      {suffix ? <span className="ml-2 text-xs text-[#A3A7AB]">{suffix}</span> : null}
    </span>
  );
}

export function PillSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <span className="flex h-10 items-center rounded-full bg-[#111618] px-4 text-sm text-[#F4F4F2] focus-within:ring-2 focus-within:ring-[#A78C68]">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // The native option popup doesn't inherit the pill's dark background
        // (Windows Chrome draws it white), so the select and every option carry
        // explicit dark colours or the light text is unreadable.
        className="h-full w-full cursor-pointer bg-[#111618] text-[#F4F4F2] outline-none [color-scheme:dark]"
      >
        {placeholder ? (
          <option value="" className="bg-[#111618] text-[#9AA3A5]">
            {placeholder}
          </option>
        ) : null}
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-[#111618] text-[#F4F4F2]">
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T | undefined;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-full px-3.5 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-[#A78C68]",
              on ? "bg-[#111618] text-[#F4F4F2]" : "text-foreground hover:bg-muted/60",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
