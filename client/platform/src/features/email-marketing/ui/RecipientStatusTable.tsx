import type { EmailCampaign, EmailRecipient } from "../api/types";
import { RecipientStatusBadge } from "./StatusBadge";
import { fmtPct, fmtDateTime } from "../lib/format";

export interface RecipientStatusTableProps {
  campaign: EmailCampaign;
  recipients: EmailRecipient[];
}

export function RecipientStatusTable({ campaign, recipients }: RecipientStatusTableProps) {
  const total = campaign.recipientCount ?? recipients.length;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Recipients" value={String(total)} />
        <Stat
          label="Delivered"
          value={String(campaign.deliveredCount ?? 0)}
          sub={fmtPct(campaign.deliveredCount, total)}
        />
        <Stat
          label="Opened"
          value={String(campaign.openedCount ?? 0)}
          sub={fmtPct(campaign.openedCount, total)}
        />
        <Stat
          label="Clicked"
          value={String(campaign.clickedCount ?? 0)}
          sub={fmtPct(campaign.clickedCount, total)}
        />
        <Stat
          label="Failed"
          value={String(campaign.failedCount ?? 0)}
          sub={fmtPct(campaign.failedCount, total)}
        />
      </div>

      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="hidden md:grid grid-cols-[1fr_140px_180px] gap-4 px-5 py-3 border-b border-border bg-muted/30">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Recipient
          </span>
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Status
          </span>
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Last update
          </span>
        </div>
        {recipients.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-muted-foreground">
            No recipients yet
          </div>
        ) : (
          recipients.map((r) => (
            <div
              key={r.userId}
              className="grid grid-cols-1 md:grid-cols-[1fr_140px_180px] gap-1 md:gap-4 px-5 py-3 border-b border-border last:border-b-0"
            >
              <div className="text-sm text-foreground truncate">{r.email}</div>
              <div className="flex items-center">
                <RecipientStatusBadge status={r.status} />
              </div>
              <div className="text-xs text-muted-foreground">
                {fmtDateTime(r.clickedAt ?? r.openedAt ?? r.deliveredAt ?? r.attemptedAt)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm p-4">
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
      </p>
      <p className="text-2xl font-bold text-foreground mt-1 leading-none">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}
