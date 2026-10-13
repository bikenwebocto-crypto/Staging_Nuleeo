import type { EmailCampaignStatus, EmailRecipientStatus } from "../api/types";

const CAMPAIGN_STYLES: Record<EmailCampaignStatus, string> = {
  draft: "bg-warning/10 text-warning border-warning/20",
  scheduled: "bg-info/10 text-info border-info/20",
  sending: "bg-info/10 text-info border-info/20",
  sent: "bg-success/10 text-success border-success/20",
  failed: "bg-destructive/10 text-destructive border-destructive/20",
  cancelled: "bg-muted text-muted-foreground border-border",
};

const CAMPAIGN_LABELS: Record<EmailCampaignStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  cancelled: "Cancelled",
};

const RECIPIENT_STYLES: Record<EmailRecipientStatus, string> = {
  queued: "bg-muted text-muted-foreground border-border",
  sending: "bg-info/10 text-info border-info/20",
  accepted: "bg-info/10 text-info border-info/20",
  sent: "bg-info/10 text-info border-info/20",
  delivered: "bg-success/10 text-success border-success/20",
  opened: "bg-success/10 text-success border-success/20",
  clicked: "bg-success/10 text-success border-success/20",
  failed: "bg-destructive/10 text-destructive border-destructive/20",
  unsubscribed: "bg-warning/10 text-warning border-warning/20",
  skipped: "bg-muted text-muted-foreground border-border",
};

export function CampaignStatusBadge({ status }: { status: EmailCampaignStatus }) {
  return (
    <span
      className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${CAMPAIGN_STYLES[status]}`}
    >
      {CAMPAIGN_LABELS[status]}
    </span>
  );
}

export function RecipientStatusBadge({ status }: { status: EmailRecipientStatus }) {
  return (
    <span
      className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${RECIPIENT_STYLES[status]} capitalize`}
    >
      {status}
    </span>
  );
}
