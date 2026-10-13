import { ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import { cn } from "@ui/lib/utils";

type SortDir = "asc" | "desc";

export function TableSortIcon({
  column,
  sortKey,
  sortDir,
}: {
  column: string;
  sortKey: string | null;
  sortDir: SortDir;
}) {
  if (sortKey !== column) {
    return <ArrowUpDown size={12} className="text-muted-foreground/40" />;
  }
  return sortDir === "asc" ? (
    <ArrowUp size={12} className="text-foreground" />
  ) : (
    <ArrowDown size={12} className="text-foreground" />
  );
}

export function TableFiltersCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-card p-4 rounded-xl border border-border shadow-sm mb-6 space-y-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function TableShellCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("bg-card border border-border rounded-xl shadow-sm overflow-hidden", className)}
    >
      {children}
    </div>
  );
}

// Shared search box used in the filters bar across list pages (Properties,
// Marketplace, Agreements, Network, Insights, Activity…). Keeps the look —
// muted pill, leading magnifier, focus ring — identical everywhere.
export function TableSearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search
        className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        size={16}
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full bg-muted border-none rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
      />
    </div>
  );
}

export interface FilterPillOption {
  id: string;
  label: string;
}

export function FilterPills({
  options,
  value,
  onChange,
  className,
}: {
  options: FilterPillOption[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-2 overflow-x-auto hide-scrollbar", className)}>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          className={cn(
            "px-5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all",
            value === opt.id
              ? "bg-(--brand-accent-subtle) text-foreground ring-1 ring-inset ring-(--brand-accent-border)"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function TableEmptyState({
  icon,
  title = "No results found",
  description = "Try adjusting your filters",
  action,
  className,
}: {
  icon?: ReactNode;
  title?: string;
  description?: string;
  // Optional CTA shown beneath the description (e.g. "Add property").
  // Pass a button/link node; the component just centers it.
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-16 text-muted-foreground/70",
        className,
      )}
    >
      <div className="w-16 h-16 bg-secondary rounded-full flex items-center justify-center mb-4">
        {icon ?? <Search size={24} className="opacity-50" />}
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs mt-1 max-w-xs text-center">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
