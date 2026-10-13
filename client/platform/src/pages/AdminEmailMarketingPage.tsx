// Route shell for /admin/email-marketing. Composes the email-marketing
// feature slices and gates on the `comm.email` platform privilege.

import { useCallback, useState } from "react";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { ForbiddenView } from "@ui/components/ForbiddenView";
import { useToast } from "@ui/hooks/use-toast";
import { Users, Calendar, Send } from "lucide-react";
import {
  CampaignEditor,
  CampaignList,
  RecipientStatusTable,
  deleteDraft,
  useCampaign,
  useCampaigns,
} from "@/features/email-marketing";
import { audienceSummary } from "@/features/email-marketing/model/audience";
import { CampaignStatusBadge } from "@/features/email-marketing/ui/StatusBadge";
import { fmtDateTime } from "@/features/email-marketing/lib/format";

type View = { kind: "list" } | { kind: "edit"; id: string | null } | { kind: "stats"; id: string };

export default function AdminEmailMarketingPage() {
  const { canPlatform } = usePrivileges();
  const allowed = canPlatform("comm.email");

  const [view, setView] = useState<View>({ kind: "list" });
  const { toast } = useToast();
  const { campaigns, loading, reload } = useCampaigns();
  const detailId = view.kind === "edit" || view.kind === "stats" ? view.id : null;
  const {
    campaign,
    recipients,
    loading: detailLoading,
    reload: reloadDetail,
  } = useCampaign(detailId);

  const handleEdit = useCallback((id: string) => setView({ kind: "edit", id }), []);
  const handleStats = useCallback((id: string) => setView({ kind: "stats", id }), []);
  const handleCreate = useCallback(() => setView({ kind: "edit", id: null }), []);
  const handleBack = useCallback(() => setView({ kind: "list" }), []);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this draft?")) return;
      try {
        await deleteDraft(id);
        toast({ title: "Draft deleted" });
        await reload();
      } catch (err) {
        toast({
          title: "Delete failed",
          description: err instanceof Error ? err.message : "Try again",
          variant: "destructive",
        });
      }
    },
    [reload, toast],
  );

  const handleChanged = useCallback(async () => {
    await Promise.all([reload(), reloadDetail()]);
  }, [reload, reloadDetail]);

  if (!allowed) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <ForbiddenView
          title="Email marketing locked"
          message="Your platform role doesn't include the 'Manage email marketing' privilege. An admin can grant it in Settings → Platform Roles."
        />
      </div>
    );
  }

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      {view.kind === "list" ? (
        <>
          <div className="mb-8 md:mb-2 mt-4 md:mt-0">
            <div className="md:hidden">
              <h1 className="text-2xl font-bold text-foreground tracking-tight">Email Marketing</h1>
              <p className="text-muted-foreground mt-1 text-sm">
                Send campaigns to owners, tenants, or both.
              </p>
            </div>
          </div>
          <CampaignList
            campaigns={campaigns}
            loading={loading}
            onCreate={handleCreate}
            onEdit={handleEdit}
            onViewStats={handleStats}
            onDelete={handleDelete}
          />
        </>
      ) : view.kind === "edit" ? (
        <CampaignEditor
          campaign={campaign}
          loading={detailLoading}
          onBack={handleBack}
          onChanged={handleChanged}
        />
      ) : (
        <CampaignStatsView
          loading={detailLoading}
          onBack={handleBack}
          campaign={campaign}
          recipients={recipients}
        />
      )}
    </div>
  );
}

function CampaignStatsView({
  loading,
  onBack,
  campaign,
  recipients,
}: {
  loading: boolean;
  onBack: () => void;
  campaign: ReturnType<typeof useCampaign>["campaign"];
  recipients: ReturnType<typeof useCampaign>["recipients"];
}) {
  if (loading || !campaign) {
    return (
      <div className="text-sm text-muted-foreground">
        <button onClick={onBack} className="mb-4 text-muted-foreground hover:text-foreground">
          ← Back
        </button>
        Loading…
      </div>
    );
  }
  const when = campaign.sentAt ?? campaign.scheduledAt;
  const whenLabel = campaign.sentAt ? "Sent" : campaign.scheduledAt ? "Scheduled" : "Updated";
  return (
    <>
      <div className="mb-6 mt-4 md:mt-0">
        <button
          onClick={onBack}
          className="text-sm text-muted-foreground hover:text-foreground transition"
        >
          ← Back to campaigns
        </button>
        <div className="flex items-center gap-3 mt-3 flex-wrap">
          <h2 className="text-lg font-semibold">{campaign.subject || "(no subject)"}</h2>
          <CampaignStatusBadge status={campaign.status} />
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border shadow-sm p-5 mb-6 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="flex items-start gap-3">
          <Users size={16} className="text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Target audience
            </p>
            <p className="text-sm text-foreground mt-1">{audienceSummary(campaign)}</p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <Calendar size={16} className="text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              {whenLabel}
            </p>
            <p className="text-sm text-foreground mt-1">
              {fmtDateTime(when ?? campaign.updatedAt)}
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <Send size={16} className="text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Recipients
            </p>
            <p className="text-sm text-foreground mt-1">{campaign.recipientCount ?? 0}</p>
          </div>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden mb-6">
        <div className="px-5 py-3 border-b border-border bg-muted/30">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Content
          </p>
        </div>
        <div className="p-5 space-y-2 text-sm text-foreground/90 leading-relaxed">
          {(campaign.bodyText || "").trim() ? (
            (campaign.bodyText || "").split("\n").map((line, i) => (
              <p key={i} className="min-h-[1em] whitespace-pre-wrap">
                {line}
              </p>
            ))
          ) : (
            <p className="text-muted-foreground italic">No content</p>
          )}
        </div>
      </div>

      <RecipientStatusTable campaign={campaign} recipients={recipients} />
    </>
  );
}
