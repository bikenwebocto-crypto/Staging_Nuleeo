// Compose / edit / send a campaign. Holds local form state until the admin
// hits Save (or Send / Schedule); persistence is one HTTP call per action.
//
// Audience is held locally as the rich `AudienceValue` (filter | user mode)
// even though the wire format is the discriminated `CampaignAudienceInput`
// (`{filter}` | `{targetUserId}` | `{audience}`). Conversion happens at
// save time via `toAudienceInput` — see below.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Eye,
  EyeOff,
  FileText,
  Save,
  SendHorizontal,
  Send,
} from "lucide-react";
import { useToast } from "@ui/hooks/use-toast";
import { useConfirm } from "@ui/components/common/ConfirmDialog";
import { useAdminUsers, type AdminUserRow } from "@/lib/adminQueries";
import { cancel, createDraft, deleteDraft, schedule, sendNow, updateDraft } from "../api/campaigns";
import type { CampaignAudienceInput, EmailCampaign, EmailTemplate } from "../api/types";
import { audienceSummary } from "../model/audience";
import { AudiencePicker, DEFAULT_AUDIENCE, type AudienceValue } from "./AudiencePicker";
import { CampaignPreview } from "./CampaignPreview";
import { ScheduleControl } from "./ScheduleControl";
import { SendTestModal } from "./SendTestModal";
import { TemplatesDrawer } from "./TemplatesDrawer";

export interface CampaignEditorProps {
  campaign: EmailCampaign | null;
  loading: boolean;
  onBack: () => void;
  onChanged: () => Promise<void> | void;
}

// Pre-filled into the signature field for new campaigns. Fully editable (and
// clearable) — it's a starting point, not a locked footer.
const DEFAULT_SIGNATURE = "Best regards,\nThe Olio Team";

// Merge tokens offered as one-click chips above the body. Clicking one inserts
// it at the cursor of whichever field (subject or body) was last focused.
const MERGE_TOKENS = ["{{name}}", "{{first_name}}", "{{date}}", "{{email}}"] as const;

// Convert UI state → wire format. Exactly one branch fires (the
// discriminated CampaignAudienceInput shape).
function toAudienceInput(value: AudienceValue): CampaignAudienceInput {
  if (value.kind === "user") {
    if (!value.user) {
      throw new Error("Pick a recipient first");
    }
    return { targetUserId: value.user.id };
  }
  return { filter: value.filter };
}

// Hydrate UI state from a saved campaign. Campaigns can persist any of:
//   { filter }           — rich filter (new shape)
//   { targetUserId }     — single-recipient (e.g. password-reset push)
//   { audience }         — legacy enum (existing drafts before the refactor)
// All three resolve to an AudienceValue the picker understands.
function fromCampaign(campaign: EmailCampaign, users: AdminUserRow[]): AudienceValue {
  if (campaign.targetUserId) {
    const user = users.find((u) => u.id === campaign.targetUserId) ?? null;
    return { kind: "user", filter: DEFAULT_AUDIENCE.filter, user };
  }
  if (campaign.filter) {
    return { kind: "filter", filter: campaign.filter, user: null };
  }
  if (campaign.audience) {
    // Legacy enum → filter role. "all" / "owners" / "tenants" are valid
    // MarketingAudienceFilter.role values too, so this is a lossless lift.
    return {
      kind: "filter",
      filter: { ...DEFAULT_AUDIENCE.filter, role: campaign.audience },
      user: null,
    };
  }
  return DEFAULT_AUDIENCE;
}

export function CampaignEditor({ campaign, loading, onBack, onChanged }: CampaignEditorProps) {
  const { toast } = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();

  // Load admin users so the user-mode picker can resolve targetUserId →
  // user row for display, and the picker can offer a typeahead.
  const { data: adminUsers = [] } = useAdminUsers();

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [signature, setSignature] = useState(DEFAULT_SIGNATURE);
  const [footerText, setFooterText] = useState("");

  // Refs + last-focused tracking so the merge-token chips insert into the
  // field the admin was actually editing (subject or body), at the cursor.
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastFocusedRef = useRef<"subject" | "body">("body");
  const [ctaLabel, setCtaLabel] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [audience, setAudience] = useState<AudienceValue>(DEFAULT_AUDIENCE);
  const [sendMode, setSendMode] = useState<"now" | "schedule">("now");
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);

  const [busy, setBusy] = useState<null | "save" | "send" | "schedule" | "cancel" | "delete">(null);
  const [showPreview, setShowPreview] = useState(false);
  const [showTest, setShowTest] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  // Hydrate form from loaded campaign. Re-runs when the campaign id
  // changes OR when admin users finish loading (so a targetUserId
  // campaign resolves to a user row once the user list arrives).
  useEffect(() => {
    if (!campaign) return;
    setSubject(campaign.subject);
    setBody(campaign.bodyText);
    setSignature(campaign.signature ?? "");
    setFooterText(campaign.footerText ?? "");
    setCtaLabel(campaign.cta?.label ?? "");
    setCtaUrl(campaign.cta?.url ?? "");
    setAudience(fromCampaign(campaign, adminUsers));
    if (campaign.scheduledAt) {
      setSendMode("schedule");
      setScheduledAt(campaign.scheduledAt);
    } else {
      setSendMode("now");
      setScheduledAt(null);
    }
  }, [campaign?.id, adminUsers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const isExisting = campaign !== null;
  const editable = !isExisting || campaign?.status === "draft";
  const readonlyReason =
    !editable && campaign?.status === "sent"
      ? "Sent campaigns are read-only"
      : !editable && campaign?.status === "scheduled"
        ? "Cancel the schedule to edit again"
        : !editable && campaign?.status === "sending"
          ? "Campaign is currently sending"
          : null;

  // Audience-summary label for the preview pane + any list-row badge.
  // Derived from the live form state (not the saved campaign) so the
  // admin sees their pending edits reflected before save.
  const audienceLabel = useMemo(
    () =>
      audienceSummary({
        audience:
          audience.kind === "filter" && !audience.filter.status && !audience.filter.plans?.length
            ? audience.filter.role
            : undefined,
        filter: audience.kind === "filter" ? audience.filter : undefined,
        targetUserId: audience.kind === "user" ? (audience.user?.id ?? undefined) : undefined,
      }),
    [audience],
  );

  const audienceValid =
    audience.kind === "filter" || (audience.kind === "user" && audience.user !== null);

  // The CTA button is optional, but if the admin fills one half they must fill
  // the other, and the link must be an http(s) URL (mirrors the server guard).
  const ctaError = useMemo(() => {
    const label = ctaLabel.trim();
    const url = ctaUrl.trim();
    if (!label && !url) return null;
    if (!label) return "Add button text, or clear the link.";
    if (!url) return "Add a link, or clear the button text.";
    if (!/^https?:\/\/\S+$/i.test(url)) return "Link must start with http:// or https://";
    return null;
  }, [ctaLabel, ctaUrl]);

  const canSubmit =
    subject.trim().length > 0 && body.trim().length > 0 && audienceValid && !ctaError && !busy;

  // Content extras shared by every save/send call. A blank signature/footer or
  // an empty CTA is sent as-is so the server clears the field on an existing
  // draft (empty string / null → Firestore field delete).
  const buildExtras = () => {
    const label = ctaLabel.trim();
    const url = ctaUrl.trim();
    return {
      signature,
      footerText,
      cta: label || url ? { label, url } : null,
    };
  };

  // Insert a merge token into the last-focused field at the caret (or append
  // if nothing is focused yet). Restores focus + caret after React re-renders.
  const insertVariable = (token: string) => {
    if (!editable) return;
    const target = lastFocusedRef.current;
    const el = target === "subject" ? subjectRef.current : bodyRef.current;
    const current = target === "subject" ? subject : body;
    const setter = target === "subject" ? setSubject : setBody;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    setter(next);
    const caret = start + token.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  // ── actions ──────────────────────────────────────────────────────────────

  const handleSaveDraft = async () => {
    setBusy("save");
    try {
      const audiencePayload = toAudienceInput(audience);
      const extras = buildExtras();
      if (campaign) {
        await updateDraft(campaign.id, { subject, bodyText: body, ...audiencePayload, ...extras });
        toast({ title: "Draft saved" });
      } else {
        const created = await createDraft({
          subject,
          bodyText: body,
          ...audiencePayload,
          ...extras,
        });
        toast({ title: "Draft saved" });
        await onChanged();
        return created;
      }
      await onChanged();
    } catch (err) {
      toast({ title: "Save failed", description: msg(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleSendOrSchedule = async () => {
    if (!subject.trim() || !body.trim() || !audienceValid) return;

    // Send Now is irreversible past the queue → emails accepted by
    // Resend can't be recalled. Gate on a typed confirmation that
    // surfaces the recipient count. Schedule path stays unconfirmed
    // (cancel-while-queued still works there).
    if (sendMode === "now") {
      const recipientCount = campaign?.recipientCount ?? null;
      const audienceCopy =
        typeof recipientCount === "number" && recipientCount > 0
          ? `Send to ${recipientCount.toLocaleString()} ${recipientCount === 1 ? "recipient" : "recipients"}?`
          : "Send this campaign now?";
      const ok = await confirm({
        title: audienceCopy,
        description:
          "The campaign will start delivering immediately. You can cancel while it's still queueing, but emails already accepted by Resend can't be recalled.",
        confirmLabel: "Send now",
        tone: "destructive",
      });
      if (!ok) return;
    }

    setBusy(sendMode === "schedule" ? "schedule" : "send");
    try {
      const audiencePayload = toAudienceInput(audience);
      const extras = buildExtras();
      // Persist the latest edits to the draft first.
      let id = campaign?.id;
      if (!id) {
        const created = await createDraft({
          subject,
          bodyText: body,
          ...audiencePayload,
          ...extras,
        });
        id = created.id;
      } else if (campaign?.status === "draft") {
        await updateDraft(id, { subject, bodyText: body, ...audiencePayload, ...extras });
      }

      if (!id) throw new Error("Could not create campaign");

      if (sendMode === "schedule") {
        if (!scheduledAt) throw new Error("Pick a date and time first");
        await schedule(id, { scheduledAt });
        toast({ title: "Campaign scheduled" });
      } else {
        await sendNow(id);
        toast({ title: "Campaign queued for delivery" });
      }
      await onChanged();
      onBack();
    } catch (err) {
      toast({ title: "Send failed", description: msg(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleCancel = async () => {
    if (!campaign) return;
    setBusy("cancel");
    try {
      await cancel(campaign.id);
      toast({ title: "Campaign cancelled" });
      await onChanged();
    } catch (err) {
      toast({ title: "Cancel failed", description: msg(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (!campaign) return;
    const ok = await confirm({
      title: "Delete this draft?",
      description: "This can't be undone.",
      confirmLabel: "Delete",
      tone: "destructive",
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await deleteDraft(campaign.id);
      toast({ title: "Draft deleted" });
      await onChanged();
      onBack();
    } catch (err) {
      toast({ title: "Delete failed", description: msg(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const applyTemplate = (t: EmailTemplate) => {
    setSubject(t.subject);
    setBody(t.body);
    setShowTemplates(false);
    toast({ title: `Applied template "${t.name}"` });
  };

  if (loading && !campaign && isExisting) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <>
      {confirmDialog}
      <div className="mb-6 mt-4 md:mt-0 flex items-center justify-between gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition"
        >
          <ArrowLeft size={16} />
          Back to campaigns
        </button>
        <button
          onClick={() => setShowTemplates(true)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition"
        >
          <FileText size={14} />
          Templates
        </button>
      </div>

      {readonlyReason && (
        <div className="mb-6 p-3 rounded-lg bg-warning/10 border border-warning/20 text-xs text-warning">
          {readonlyReason}
        </div>
      )}

      <div className="bg-card p-4 rounded-xl border border-border shadow-sm mb-6">
        <AudiencePicker
          value={audience}
          onChange={setAudience}
          disabled={!editable}
          showCount={editable}
        />
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 space-y-4">
          <div className="bg-card p-5 rounded-xl border border-border shadow-sm space-y-4">
            <div>
              <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Subject
              </label>
              <input
                ref={subjectRef}
                type="text"
                value={subject}
                disabled={!editable}
                onChange={(e) => setSubject(e.target.value)}
                onFocus={() => (lastFocusedRef.current = "subject")}
                className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 transition disabled:opacity-60"
                placeholder="Enter email subject..."
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Body
                </label>
                <div className="flex gap-1.5">
                  {MERGE_TOKENS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      disabled={!editable}
                      onClick={() => insertVariable(v)}
                      title="Insert into subject or body"
                      className="inline-flex items-center px-2 py-0.5 rounded bg-muted text-[10px] text-muted-foreground font-mono border border-border hover:bg-primary/10 hover:text-foreground hover:border-primary/30 transition disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <textarea
                ref={bodyRef}
                value={body}
                disabled={!editable}
                onChange={(e) => setBody(e.target.value)}
                onFocus={() => (lastFocusedRef.current = "body")}
                className="w-full h-72 px-4 py-3 rounded-lg border border-border bg-muted text-foreground text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/20 transition resize-none disabled:opacity-60"
                placeholder="Type your email content here..."
              />
            </div>

            <div className="space-y-4 pt-4 border-t border-border">
              {/* Call-to-action button */}
              <div>
                <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  Call-to-action button
                  <span className="ml-1.5 normal-case font-normal text-muted-foreground/70">
                    optional
                  </span>
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={ctaLabel}
                    disabled={!editable}
                    onChange={(e) => setCtaLabel(e.target.value)}
                    className="flex-1 px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition disabled:opacity-60"
                    placeholder="Button text (e.g. View listing)"
                  />
                  <input
                    type="url"
                    value={ctaUrl}
                    disabled={!editable}
                    onChange={(e) => setCtaUrl(e.target.value)}
                    className="flex-1 px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition disabled:opacity-60"
                    placeholder="https://…"
                  />
                </div>
                {ctaError && <p className="mt-1.5 text-xs text-destructive">{ctaError}</p>}
              </div>

              {/* Signature */}
              <div>
                <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  Signature
                  <span className="ml-1.5 normal-case font-normal text-muted-foreground/70">
                    optional
                  </span>
                </label>
                <textarea
                  value={signature}
                  disabled={!editable}
                  onChange={(e) => setSignature(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-3 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition resize-none disabled:opacity-60"
                  placeholder={"Best regards,\nThe Olio Team"}
                />
              </div>

              {/* Footer note */}
              <div>
                <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  Footer note
                  <span className="ml-1.5 normal-case font-normal text-muted-foreground/70">
                    optional
                  </span>
                </label>
                <textarea
                  value={footerText}
                  disabled={!editable}
                  onChange={(e) => setFooterText(e.target.value)}
                  rows={2}
                  className="w-full px-4 py-3 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition resize-none disabled:opacity-60"
                  placeholder="e.g. Olio Wallet Ltd · Nicosia, Cyprus"
                />
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Shown above the unsubscribe line. Merge tags like{" "}
                  <span className="font-mono">{"{{first_name}}"}</span> work here too.
                </p>
              </div>
            </div>

            {editable && (
              <ScheduleControl
                mode={sendMode}
                scheduledAt={scheduledAt}
                onModeChange={setSendMode}
                onScheduledAtChange={setScheduledAt}
              />
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {editable && (
                <>
                  <button
                    onClick={handleSaveDraft}
                    disabled={!canSubmit}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-muted transition disabled:opacity-40"
                  >
                    {busy === "save" ? (
                      <div className="w-4 h-4 border-2 border-foreground/30 border-t-foreground rounded-full animate-spin" />
                    ) : (
                      <Save size={14} />
                    )}
                    Save draft
                  </button>
                  <button
                    onClick={handleSendOrSchedule}
                    disabled={!canSubmit || (sendMode === "schedule" && !scheduledAt)}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-40"
                  >
                    {busy === "send" || busy === "schedule" ? (
                      <div className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
                    ) : sendMode === "schedule" ? (
                      <CalendarClock size={14} />
                    ) : (
                      <SendHorizontal size={14} />
                    )}
                    {sendMode === "schedule" ? "Schedule" : "Send now"}
                  </button>
                </>
              )}

              {campaign && editable && (
                <button
                  onClick={() => setShowTest(true)}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition"
                >
                  <Send size={14} />
                  Send test
                </button>
              )}

              <button
                onClick={() => setShowPreview(!showPreview)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition lg:hidden"
              >
                {showPreview ? <EyeOff size={14} /> : <Eye size={14} />}
                {showPreview ? "Hide preview" : "Preview"}
              </button>

              <div className="ml-auto flex items-center gap-2">
                {campaign && (campaign.status === "scheduled" || campaign.status === "sending") && (
                  <button
                    onClick={handleCancel}
                    className="px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-warning hover:bg-warning/10 transition"
                  >
                    {busy === "cancel" ? "Cancelling…" : "Cancel send"}
                  </button>
                )}
                {campaign && (campaign.status === "draft" || campaign.status === "cancelled") && (
                  <button
                    onClick={handleDelete}
                    className="px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-destructive hover:bg-destructive/10 transition"
                  >
                    {busy === "delete" ? "Deleting…" : "Delete"}
                  </button>
                )}
                {campaign?.status === "sent" && (
                  <span className="inline-flex items-center gap-1 text-xs text-success">
                    <CheckCircle2 size={14} />
                    Sent
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div
          className={`w-full lg:w-[380px] shrink-0 ${showPreview ? "block" : "hidden lg:block"}`}
        >
          <CampaignPreview
            subject={subject}
            body={body}
            audienceLabel={audienceLabel}
            signature={signature}
            footerText={footerText}
            cta={ctaLabel.trim() || ctaUrl.trim() ? { label: ctaLabel, url: ctaUrl } : null}
          />
        </div>
      </div>

      {showTest && campaign && (
        <SendTestModal campaignId={campaign.id} onClose={() => setShowTest(false)} />
      )}
      {showTemplates && (
        <TemplatesDrawer
          currentSubject={subject}
          currentBody={body}
          onApply={applyTemplate}
          onClose={() => setShowTemplates(false)}
        />
      )}
    </>
  );
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}
