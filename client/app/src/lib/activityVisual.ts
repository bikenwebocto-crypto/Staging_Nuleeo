import { TrendingUp, TrendingDown, AlertTriangle, type LucideIcon } from "lucide-react";
import type { TransactionType } from "@shared/firestore-schema";

// Per-type icon + colour for an activity row's leading circle. Single source of
// truth so the Activity page and the owner/tenant dashboard previews can't
// drift: income = green, expense = red, neutral (maintenance / repairs) =
// orange. Mirrors the colour scheme the Activity page has always used.
//
// `solid` is the standard treatment across every activity surface (owner +
// tenant dashboards and the Activity page): a *solid* colour-filled circle with
// a white glyph — bold, high-contrast and legible on both light and dark
// theme-adaptive surfaces as well as the tenant photo card. Maintenance uses
// the deeper amber-600 so the white glyph clears the contrast bar. Without it,
// the default is the subtler theme-adaptive *coloured* glyph on a faint tint.
export function activityVisual(
  type: TransactionType,
  opts?: { solid?: boolean },
): { Icon: LucideIcon; className: string } {
  const solid = opts?.solid ?? false;
  switch (type) {
    case "income":
      return {
        Icon: TrendingUp,
        className: solid
          ? "bg-emerald-500 border-emerald-500 text-white"
          : "bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-400",
      };
    case "expense":
      return {
        Icon: TrendingDown,
        className: solid
          ? "bg-red-500 border-red-500 text-white"
          : "bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400",
      };
    case "neutral":
    default:
      return {
        Icon: AlertTriangle,
        className: solid
          ? "bg-amber-600 border-amber-600 text-white"
          : "bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-400",
      };
  }
}

// A "repair report" is a tenant-reported maintenance issue mirrored into the
// activity ledger (see POST /api/tickets) — always a neutral / maintenance row
// carrying a pending → resolved lifecycle the owner drives. Owner-recorded
// maintenance ledger entries are *expenses* (status "completed"), so this
// deliberately keys on type+category+status to single out only the reports
// that show a Pending / Resolved badge. Both personas' activity surfaces share
// this predicate so they can't drift.
export function isRepairReport(tx: {
  type?: string;
  category?: string;
  status?: string | null;
}): boolean {
  return (
    tx.type === "neutral" &&
    tx.category === "maintenance" &&
    (tx.status === "pending" || tx.status === "resolved")
  );
}

// An activity amount is "blank" when it rounds to zero cents — those rows
// (e.g. a maintenance report with no cost yet) shouldn't render a "€0" figure.
// Rounds to whole cents first so a sub-cent float never leaks a misleading 0.
export function hasDisplayableAmount(amount: number): boolean {
  return Math.round(amount * 100) !== 0;
}
