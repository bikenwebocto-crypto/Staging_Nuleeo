// Shared amber "couldn't load — retry" banner for list/table pages.
// Mirrors the inline error pattern on OwnerDashboard so a failed fetch reads
// as an error the user can retry, instead of an empty state ("no data") that
// hides the failure. Keep this visually in sync with OwnerDashboard's banner.
export function ListErrorState({
  title = "We couldn't load this page.",
  description = "Check your connection or try again.",
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 p-6 flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs opacity-80 mt-0.5">{description}</p>
      </div>
      <button
        onClick={onRetry}
        className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition shrink-0"
      >
        Retry
      </button>
    </div>
  );
}
