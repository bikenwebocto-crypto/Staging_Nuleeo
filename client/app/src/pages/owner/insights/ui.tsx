// Shared presentational primitives for the Olio Insights sections. Kept here so
// each section file stays focused on its own layout, and so the dark-mode token
// rules + chart styling live in exactly one place.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { TrendingUp, TrendingDown, type LucideIcon } from "lucide-react";

// Fixed, dark-mode-safe palettes shared by donut / composition / trend charts so
// a category reads the same colour everywhere. --brand-accent is a runtime CSS
// var (accentStore); the rest are mid-tones legible on light or dark cards.
export const CATEGORY_COLORS: Record<string, string> = {
  maintenance: "var(--brand-accent)",
  tax: "#f59e0b",
  fee: "#a78bfa",
  other: "#94a3b8",
};
export const TYPE_COLORS: Record<string, string> = {
  Apartment: "var(--brand-accent)",
  House: "#a78bfa",
  Villa: "#34d399",
  Commercial: "#f59e0b",
  Plot: "#60a5fa",
  Unknown: "#94a3b8",
  Other: "#94a3b8",
};
export const SOURCE_LABELS: Record<string, string> = {
  rent: "Card / online",
  manual: "Offline (recorded)",
  prepaid: "Prepaid (advance)",
  system: "System / legacy",
};

// Recharts tooltip styling — matches the existing cash-flow chart so every chart
// reads consistently in dark mode.
export const CHART_TOOLTIP_STYLE = {
  borderRadius: "12px",
  border: "1px solid var(--border)",
  backgroundColor: "var(--card)",
  color: "var(--foreground)",
  boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
} as const;

export function fmtPct(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}%`;
}

// Mount-on-scroll wrapper. Long-scroll page would otherwise mount every recharts
// canvas at once; this defers each chart until it nears the viewport, recovering
// the perf a tabbed layout would have given. Reserves minHeight so layout
// doesn't jump as charts hydrate.
export function LazyChart({
  children,
  minHeight = 256,
  label,
}: {
  children: ReactNode;
  minHeight?: number;
  // a11y: a concise description of what the chart shows. When set, the wrapper
  // is exposed to screen readers as a single labelled image (role="img") so the
  // recharts SVG soup isn't read out as meaningless nodes.
  label?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (shown || !ref.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          obs.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [shown]);
  return (
    <div ref={ref} style={{ minHeight }} {...(label ? { role: "img", "aria-label": label } : {})}>
      {shown ? children : null}
    </div>
  );
}

// Sticky scroll-spy nav. Each chip jumps to its section and highlights when that
// section is the one in view.
export function SectionNav({
  sections,
  active,
  right,
}: {
  sections: { id: string; label: string }[];
  active: string;
  right?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-20 -mx-4 px-4 sm:-mx-6 sm:px-6 mb-6 bg-background/80 backdrop-blur border-b border-border">
      <div className="flex items-center justify-between gap-3 py-3 overflow-x-auto">
        <div className="flex items-center gap-1.5">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                document
                  .getElementById(s.id)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition ${
                active === s.id
                  ? "bg-(--brand-accent-subtle) text-foreground ring-1 ring-inset ring-(--brand-accent-border)"
                  : "bg-secondary text-muted-foreground hover:text-foreground"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
      </div>
    </div>
  );
}

export function SectionHeader({
  id,
  title,
  subtitle,
}: {
  id: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div id={id} className="scroll-mt-20 mb-4 mt-2">
      <h2 className="text-lg font-bold text-foreground">{title}</h2>
      {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  height = 224,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  height?: number;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center text-center text-muted-foreground px-4"
      style={{ minHeight: height }}
    >
      <Icon size={28} className="opacity-30 mb-3" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="text-xs mt-1 max-w-xs">{hint}</p>}
    </div>
  );
}

// Signed period-over-period change chip. `invert` flips the good/bad colours for
// metrics where lower is better (expense ratio).
export function DeltaChip({
  deltaPct,
  invert = false,
}: {
  deltaPct: number | null;
  invert?: boolean;
}) {
  if (deltaPct == null || !Number.isFinite(deltaPct)) {
    return <span className="text-[11px] text-muted-foreground/70">no prior period</span>;
  }
  const up = deltaPct >= 0;
  const good = invert ? !up : up;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${
        good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
      }`}
    >
      <Icon size={12} />
      {up ? "+" : ""}
      {deltaPct.toFixed(1)}%
    </span>
  );
}

// Decorative-blur stat card matching the existing top-row cards.
export function StatCard({
  icon: Icon,
  label,
  value,
  caption,
  accent = "bg-blue-500/10",
  children,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  caption?: ReactNode;
  accent?: string;
  children?: ReactNode;
}) {
  return (
    <div className="bg-card p-6 rounded-2xl border border-border shadow-sm relative overflow-hidden">
      <div
        className={`absolute -right-6 -top-6 w-24 h-24 ${accent} rounded-full blur-2xl opacity-60`}
      />
      <div className="relative z-10">
        <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
          <Icon size={16} className="text-muted-foreground" /> {label}
        </div>
        <h3 className="text-3xl font-bold text-foreground mb-1">{value}</h3>
        {caption && <div className="text-xs text-muted-foreground/70 mt-2">{caption}</div>}
        {children}
      </div>
    </div>
  );
}

const GRADE_STYLES: Record<string, string> = {
  A: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  B: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  C: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
  D: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30",
  F: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
};

// Tenant payment-reliability badge. Unrated → slate dash; low-confidence → dotted
// ring (back-dated offline timestamps can't be fully trusted).
export function ScoreBadge({
  grade,
  score,
  state,
  lowConfidence,
}: {
  grade: string | null;
  score: number | null;
  state: "rated" | "provisional" | "unrated";
  lowConfidence?: boolean;
}) {
  if (state === "unrated" || grade == null) {
    return (
      <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl border border-border bg-secondary text-muted-foreground text-sm font-bold">
        —
      </span>
    );
  }
  return (
    <span
      className={`inline-flex flex-col items-center justify-center w-10 h-10 rounded-xl border text-sm font-bold ${
        GRADE_STYLES[grade] ?? GRADE_STYLES.F
      } ${lowConfidence ? "border-dashed" : ""}`}
      title={`Score ${score}${state === "provisional" ? " · limited history" : ""}${lowConfidence ? " · low confidence (mostly offline)" : ""}`}
    >
      {grade}
      <span className="text-[9px] font-medium leading-none opacity-70">{score}</span>
    </span>
  );
}

// Tiny lateness sparkline: a baseline at 0, each payment a bar — green on/early,
// red late. Pure inline SVG (no recharts) so it's cheap in a list row.
export function LatenessSparkline({ values }: { values: number[] }) {
  if (!values.length) return <span className="text-xs text-muted-foreground/60">—</span>;
  const w = 56;
  const h = 18;
  const max = Math.max(5, ...values.map((v) => Math.abs(v)));
  const step = w / Math.max(1, values.length);
  const mid = h / 2;
  return (
    <svg width={w} height={h} className="overflow-visible">
      <line x1={0} y1={mid} x2={w} y2={mid} stroke="var(--border)" strokeWidth={1} />
      {values.map((v, i) => {
        const barH = (Math.abs(v) / max) * (h / 2 - 1);
        const late = v > 3;
        return (
          <rect
            key={i}
            x={i * step + 1}
            y={late ? mid : mid - barH}
            width={Math.max(1, step - 2)}
            height={Math.max(1, barH)}
            rx={1}
            className={late ? "fill-red-500" : "fill-emerald-500"}
            opacity={0.8}
          />
        );
      })}
    </svg>
  );
}
