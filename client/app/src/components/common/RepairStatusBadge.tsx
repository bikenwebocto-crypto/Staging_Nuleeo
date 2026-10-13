import { Clock, CheckCircle2 } from "lucide-react";

// Pending / Resolved pill for a tenant-reported maintenance issue. Shown to
// BOTH personas (tenant: read-only status; owner: alongside the Resolve
// action) on the Activity page and the dashboard activity widgets, so the
// styling lives in one place and can't drift across surfaces.
//
// `onDark` forces lighter glyph/text colours for surfaces that are always dark
// regardless of theme — the tenant mobile card sits on a property photo with a
// black overlay, where the mode-adaptive colours would be too dark to read.
// Mirrors the same affordance on `activityVisual()`.
export function RepairStatusBadge({
  status,
  onDark = false,
}: {
  status?: string | null;
  onDark?: boolean;
}) {
  const resolved = status === "resolved";
  const Icon = resolved ? CheckCircle2 : Clock;
  const label = resolved ? "Resolved" : "Pending";
  const tone = resolved
    ? onDark
      ? "bg-emerald-500/15 border-emerald-400/30 text-emerald-300"
      : "bg-emerald-500/15 border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
    : onDark
      ? "bg-amber-500/15 border-amber-400/30 text-amber-300"
      : "bg-amber-500/15 border-amber-500/30 text-amber-600 dark:text-amber-400";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold whitespace-nowrap ${tone}`}
    >
      <Icon size={11} strokeWidth={2.5} />
      {label}
    </span>
  );
}
