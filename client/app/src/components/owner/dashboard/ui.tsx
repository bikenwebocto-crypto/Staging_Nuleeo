// Scoped design primitives for the owner dashboard.
//
// The palette is intentionally local to the dashboard cards: the app shell
// (page background, sidebar, header) keeps its existing theme. These tokens
// only paint the premium cards so the rest of the product is untouched.
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn } from "@ui/lib/utils";
import { CARD, PALETTE } from "./tokens";

export function Panel({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        CARD,
        "p-5 sm:p-6 transition-colors duration-200 hover:border-transparent",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function SectionLabel({
  icon: Icon,
  title,
  subtitle,
  tone = PALETTE.cyan,
  className,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  tone?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <span
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: `${tone}1A`, color: tone }}
      >
        <Icon size={16} strokeWidth={1.9} />
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold leading-tight" style={{ color: PALETTE.text }}>
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-0.5 truncate text-[11px] leading-tight" style={{ color: PALETTE.muted }}>
            {subtitle}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function DeltaChip({
  value,
  suffix = "vs last month",
  invert = false,
}: {
  value: number | null | undefined;
  suffix?: string;
  invert?: boolean;
}) {
  if (value == null || !Number.isFinite(value)) {
    return (
      <span className="text-[11px] font-medium" style={{ color: PALETTE.muted }}>
        —
      </span>
    );
  }
  const up = value >= 0;
  const good = invert ? !up : up;
  const color = good ? PALETTE.green : PALETTE.coral;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[11px] font-semibold">
      <span className="inline-flex items-center gap-0.5" style={{ color }}>
        <Icon size={12} strokeWidth={2.4} />
        {up ? "+" : ""}
        {value.toFixed(1)}%
      </span>
      <span className="font-normal" style={{ color: PALETTE.muted }}>
        {suffix}
      </span>
    </span>
  );
}

// Lightweight inline sparkline — pure SVG so the dashboard chunk stays free of
// a charting dependency (recharts is reserved for the heavy /insights route).
export function Sparkline({
  values,
  color = PALETTE.cyan,
  className,
}: {
  values: number[];
  color?: string;
  className?: string;
}) {
  const clean = values.length > 0 ? values.map((v) => (Number.isFinite(v) ? v : 0)) : [0, 0];
  const safe = clean.length === 1 ? [clean[0], clean[0]] : clean;
  const max = Math.max(...safe);
  const min = Math.min(...safe, 0);
  const span = max - min || 1;
  const w = 120;
  const h = 36;
  const points = safe
    .map((v, i) => {
      const x = (i / (safe.length - 1)) * w;
      const y = h - 3 - ((v - min) / span) * (h - 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = `0,${h} ${points} ${w},${h}`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={cn("h-8 w-24 overflow-visible", className)}
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <polygon points={area} fill={color} opacity={0.12} />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export type BadgeTone = "positive" | "warning" | "critical" | "info" | "neutral";

const BADGE_COLOR: Record<BadgeTone, string> = {
  positive: PALETTE.green,
  warning: PALETTE.amber,
  critical: PALETTE.coral,
  info: PALETTE.cyan,
  neutral: PALETTE.muted,
};

export function StatusBadge({
  tone = "neutral",
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  const color = BADGE_COLOR[tone];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-4"
      style={{ backgroundColor: `${color}1F`, color }}
    >
      {children}
    </span>
  );
}

export function PriorityDot({ priority }: { priority: "critical" | "warning" | "info" }) {
  const color =
    priority === "critical" ? PALETTE.coral : priority === "warning" ? PALETTE.amber : PALETTE.cyan;
  return (
    <span
      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: color, boxShadow: `0 0 0 3px ${color}1F` }}
      aria-hidden="true"
    />
  );
}

export function DashSkeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-[#1C2325]", className)} />;
}

// Shared card footer link treatment.
export function CardLink({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 text-[11px] font-semibold transition-colors",
        className,
      )}
      style={{ color: PALETTE.muted }}
    >
      {children}
    </button>
  );
}
