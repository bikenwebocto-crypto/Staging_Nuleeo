import type { KeyboardEvent } from "react";
import { Skeleton } from "@ui/components/common/Skeleton";

// ─────────────────────────── Sortable header a11y ───────────────────────────
//
// The admin tables sort by clicking a column header. The headers were
// mouse-only (`<th onClick>` + cursor-pointer) with no keyboard path. To make
// them operable from the keyboard without restructuring every table, spread
// `sortableThProps(handleSort, key)` onto the sortable `<th>`: it adds
// role="button", tabIndex, and an Enter/Space key handler that fires the same
// sort callback as the click.
export function sortableThProps(onSort: (key: string) => void, key: string) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: () => onSort(key),
    onKeyDown: (e: KeyboardEvent<HTMLTableCellElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSort(key);
      }
    },
  };
}

// ─────────────────────────── Loading state ───────────────────────────
//
// Shown while a list query is fetching for the first time. Renders a stack of
// row skeletons inside a card so the layout doesn't jolt when real rows land.
// Mirrors the PropertiesPage loading style (theme-aware Skeleton bars).
export function AdminListLoading({ rows = 6 }: { rows?: number }) {
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-4">
          <Skeleton className="w-10 h-10 rounded-full shrink-0" />
          <div className="flex-1 min-w-0 space-y-2">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
          <Skeleton className="h-3 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────── Error state ───────────────────────────
//
// Shown when a list query fails, BEFORE any empty state, so an API failure
// reads as "couldn't load / retry" instead of the misleading "no data" empty
// state. Mirrors the OwnerDashboard amber retry banner.
export function AdminListError({
  onRetry,
  message = "We couldn't load this data.",
}: {
  onRetry: () => void;
  message?: string;
}) {
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 p-4 flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-semibold">{message}</p>
        <p className="text-xs opacity-80 mt-0.5">Check your connection or try again.</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition shrink-0"
      >
        Retry
      </button>
    </div>
  );
}
