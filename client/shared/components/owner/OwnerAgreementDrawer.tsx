import { useEffect, useRef, useState } from "react";
import { Download, Pencil, MessageSquare, LogOut, Loader2, Upload, Trash2 } from "lucide-react";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { useConfirm } from "@ui/components/common/ConfirmDialog";
import { useToast } from "@ui/hooks/use-toast";
import { LEASE_DOC_ACCEPT } from "@ui/lib/uploadAgreementDocument";
import {
  AgreementDocument,
  openAgreementPdf,
  type AgreementDocumentData,
  type AgreementEditValues,
} from "@ui/components/agreements/AgreementDocument";

export type { AgreementEditValues };

// The owner agreements payload, narrowed to what this drawer renders. Carries
// the landlord (owner) + tenant display names the shared document needs, plus
// the tenant's contact details (so the owner sees more than an email) and the
// editable core terms.
export interface OwnerAgreementView extends AgreementDocumentData {
  owner: string;
  tenantName: string;
  tenantEmail: string;
  tenantPhone: string | null;
}

interface OwnerAgreementDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  agreement: OwnerAgreementView | null;
  // Owner-only controls. When omitted (a granted contact viewing someone
  // else's portfolio) the drawer stays a read-only printable document. When
  // provided, an action bar (Edit terms / Message tenant / End tenancy) renders
  // above the document and the core terms become inline-editable.
  owner?: {
    onMessage: () => void;
    // False when the tenant hasn't accepted their invite yet (no linked User
    // to chat with) — the Message button renders disabled with a hint, matching
    // the Tenants page / tenant drawer. Defaults to enabled when omitted.
    canMessage?: boolean;
    onEndTenancy: () => void;
    onSave: (values: AgreementEditValues) => Promise<void>;
    // Upload (or replace) the signed/physical lease PDF for this agreement, and
    // remove it. Both resolve once the parent has refetched, so the drawer's
    // view reflects the change. Errors are surfaced by the parent's toast.
    onUploadDocument: (file: File) => Promise<void>;
    onRemoveDocument: () => Promise<void>;
  };
}

// The owner's lease viewer — shows the same "Lease Agreement" document the
// tenant sees (shared AgreementDocument), wrapped with owner actions and an
// inline edit form for the core terms. Replaces the legacy AgreementModal "A4
// rental agreement" view on the owner agreements page.
export function OwnerAgreementDrawer({
  isOpen,
  onClose,
  agreement,
  owner,
}: OwnerAgreementDrawerProps) {
  const { toast } = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [docBusy, setDocBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({ monthlyRent: "", deposit: "", startDate: "", endDate: "" });

  // Whenever a different agreement opens (or the drawer reopens) drop back to
  // view mode and refill the edit fields from the latest data.
  useEffect(() => {
    setEditing(false);
    setSaving(false);
    if (agreement) {
      setForm({
        monthlyRent: agreement.monthlyRent == null ? "" : String(agreement.monthlyRent),
        deposit: agreement.deposit == null ? "" : String(agreement.deposit),
        startDate: (agreement.startDate ?? "").slice(0, 10),
        endDate: (agreement.endDate ?? "").slice(0, 10),
      });
    }
  }, [agreement?.id, isOpen]);

  if (!agreement) return null;

  // Closed leases are historical — their terms can't be edited (the server
  // enforces this too; the UI just hides the affordance).
  const closed =
    agreement.status === "expired" ||
    agreement.status === "terminated" ||
    agreement.status === "declined";

  const rentNum = Number(form.monthlyRent);
  const depositNum = Number(form.deposit);
  const datesOk =
    !!form.startDate && !!form.endDate && Date.parse(form.endDate) > Date.parse(form.startDate);
  const canSave =
    !!form.monthlyRent &&
    Number.isFinite(rentNum) &&
    rentNum > 0 &&
    Number.isFinite(depositNum) &&
    depositNum >= 0 &&
    datesOk;

  const handleSave = async () => {
    if (!owner || !canSave) return;
    setSaving(true);
    try {
      await owner.onSave({
        monthlyRent: rentNum,
        deposit: depositNum,
        startDate: form.startDate,
        endDate: form.endDate,
      });
      setEditing(false);
    } catch {
      // The parent surfaces the error toast; stay in edit mode for retry.
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadPdf = () => {
    openAgreementPdf(agreement, {
      landlordName: agreement.owner,
      tenantName: agreement.tenantName,
      tenantContact: { email: agreement.tenantEmail, phone: agreement.tenantPhone },
      onPopupBlocked: () =>
        toast({
          title: "Please allow pop-ups",
          description: "Enable pop-ups for this site to download the lease as a PDF.",
          variant: "destructive",
        }),
    });
  };

  // Whether a signed-lease PDF is currently attached. Keyed on the metadata
  // (name/uploadedAt), which is present whenever signedLeaseDocument is set —
  // NOT on documentUrl, which is a best-effort signed URL that can momentarily
  // be empty during a Storage/IAM signing blip. This keeps the owner from
  // seeing "Upload" (and risking an accidental overwrite) when a lease is in
  // fact attached. Captured per-render so the upload toast can say "uploaded"
  // vs "replaced".
  const hasDoc = !!(
    agreement.documentName ||
    agreement.documentUploadedAt ||
    agreement.documentUrl
  );

  const handleUpload = async (file: File) => {
    if (!owner) return;
    if (file.type && file.type !== "application/pdf") {
      toast({
        title: "PDF only",
        description: "The signed lease must be a PDF file.",
        variant: "destructive",
      });
      return;
    }
    setDocBusy(true);
    try {
      await owner.onUploadDocument(file);
      toast({
        title: hasDoc ? "Signed lease replaced" : "Signed lease uploaded",
        description: file.name,
      });
    } catch {
      // The parent surfaces the error toast.
    } finally {
      setDocBusy(false);
    }
  };

  const handleRemoveDoc = async () => {
    if (!owner) return;
    // Confirm BEFORE the busy state: removing hard-deletes the stored PDF (for
    // both parties) with no undo — gate it like End tenancy does on this page.
    const ok = await confirm({
      title: "Remove signed lease?",
      description:
        "This permanently deletes the uploaded PDF for both you and the tenant. This can't be undone.",
      confirmLabel: "Remove",
      tone: "destructive",
    });
    if (!ok) return;
    setDocBusy(true);
    try {
      await owner.onRemoveDocument();
      toast({ title: "Signed lease removed" });
    } catch {
      // The parent surfaces the error toast.
    } finally {
      setDocBusy(false);
    }
  };

  // Footer: while editing, Save/Cancel. Otherwise Download PDF + Close — mirrors
  // the tenant agreement drawer.
  const footer = editing ? (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => setEditing(false)}
        disabled={saving}
        className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-secondary transition disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={handleSave}
        disabled={!canSave || saving}
        className="px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:opacity-90 transition disabled:opacity-50 inline-flex items-center gap-2"
      >
        {saving && <Loader2 size={16} className="animate-spin" />}
        {saving ? "Saving…" : "Save changes"}
      </button>
    </div>
  ) : (
    <div className="space-y-2.5">
      <button
        onClick={handleDownloadPdf}
        className="w-full bg-primary text-primary-foreground font-bold py-3 rounded-xl hover:bg-primary/90 transition flex items-center justify-center gap-2"
      >
        <Download size={16} /> Download PDF
      </button>
      <button
        onClick={onClose}
        className="w-full text-muted-foreground font-medium py-2.5 rounded-xl hover:bg-muted/50 transition text-sm"
      >
        Close
      </button>
    </div>
  );

  return (
    <>
      {confirmDialog}
      <ResponsiveDrawer
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="Lease Agreement"
        footer={footer}
        desktopMaxWidth="max-w-[640px]"
      >
        {/* Owner action bar — only when the page wired up handlers and not editing. */}
        {owner && !editing && (
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {/* One hidden picker drives both Upload and Replace. PDF-only. */}
            <input
              ref={fileInputRef}
              type="file"
              accept={LEASE_DOC_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = ""; // allow re-picking the same file
                if (f) void handleUpload(f);
              }}
            />
            {!closed && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition"
              >
                <Pencil size={16} /> Edit terms
              </button>
            )}
            <button
              type="button"
              onClick={owner.onMessage}
              disabled={owner.canMessage === false}
              title={
                owner.canMessage === false
                  ? "You can message this tenant once they accept their invite and sign up."
                  : undefined
              }
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-secondary"
            >
              <MessageSquare size={16} /> Message tenant
            </button>
            {/* Signed-lease PDF controls. Upload when none attached; otherwise
              Replace + Remove (the document itself is shown — and downloadable
              by both parties — inside the lease card below). */}
            {!hasDoc ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={docBusy}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition disabled:opacity-50"
              >
                {docBusy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                {docBusy ? "Uploading…" : "Upload signed lease"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={docBusy}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition disabled:opacity-50"
                >
                  {docBusy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                  {docBusy ? "Working…" : "Replace lease PDF"}
                </button>
                <button
                  type="button"
                  onClick={handleRemoveDoc}
                  disabled={docBusy}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition disabled:opacity-50"
                >
                  <Trash2 size={16} /> Remove
                </button>
              </>
            )}
            {agreement.status === "active" && (
              <button
                type="button"
                onClick={owner.onEndTenancy}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-destructive/10 text-destructive hover:bg-destructive/20 transition sm:ml-auto"
              >
                <LogOut size={16} /> End tenancy
              </button>
            )}
          </div>
        )}

        {editing ? (
          /* Edit mode — compact form for the core lease terms. The total value and
       lease term update automatically server-side from the rent and dates. */
          <div className="bg-card w-full mx-auto p-6 text-sm rounded-lg border border-border space-y-5">
            <div>
              <h3 className="text-base font-semibold text-foreground">Edit agreement terms</h3>
              <p className="text-xs text-muted-foreground mt-1">
                The total value and lease term update automatically from the rent and dates.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block">
                <span className="text-xs font-semibold uppercase text-muted-foreground">
                  Monthly rent (€)
                </span>
                <input
                  type="number"
                  min="0"
                  inputMode="decimal"
                  value={form.monthlyRent}
                  onChange={(e) => setForm((f) => ({ ...f, monthlyRent: e.target.value }))}
                  className="mt-1 w-full bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase text-muted-foreground">
                  Deposit (€)
                </span>
                <input
                  type="number"
                  min="0"
                  inputMode="decimal"
                  value={form.deposit}
                  onChange={(e) => setForm((f) => ({ ...f, deposit: e.target.value }))}
                  className="mt-1 w-full bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase text-muted-foreground">
                  Lease start
                </span>
                <input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                  className="mt-1 w-full bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase text-muted-foreground">
                  Lease end
                </span>
                <input
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
                  className="mt-1 w-full bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </label>
            </div>
            {!!form.startDate && !!form.endDate && !datesOk && (
              <p className="text-xs text-destructive">End date must be after the start date.</p>
            )}
          </div>
        ) : (
          <AgreementDocument
            agreement={agreement}
            landlordName={agreement.owner}
            tenantName={agreement.tenantName}
            tenantContact={{ email: agreement.tenantEmail, phone: agreement.tenantPhone }}
          />
        )}
      </ResponsiveDrawer>
    </>
  );
}
