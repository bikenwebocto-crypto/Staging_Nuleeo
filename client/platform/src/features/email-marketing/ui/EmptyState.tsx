import { MailPlus } from "lucide-react";

export interface EmptyStateProps {
  onCreate: () => void;
}

export function EmptyState({ onCreate }: EmptyStateProps) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm p-12 text-center">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-muted mb-4">
        <MailPlus size={20} className="text-muted-foreground" />
      </div>
      <h3 className="text-sm font-semibold text-foreground mb-1">No campaigns yet</h3>
      <p className="text-xs text-muted-foreground mb-5">
        Compose your first email to send to owners, tenants, or everyone on Olio.
      </p>
      <button
        onClick={onCreate}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition"
      >
        <MailPlus size={14} />
        New campaign
      </button>
    </div>
  );
}
