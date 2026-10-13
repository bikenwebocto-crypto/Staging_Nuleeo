// "Property Documents" card on PropertyDetailsPage. Backed by the
// signed-URL gateway at /api/owner/documents/* (server/routes.ts). Gated on
// the owner-plan privilege `documents.upload`; locked users see the same
// PricingModal trigger as other paywalled features.
//
// Upload UX: opens a small dialog where the owner picks a file, optionally
// chooses which active tenancy this document is for, and submits. Picking a
// tenant attaches the document to that tenancy and the server pushes the
// tenant under the `documents` notification category.

import { useEffect, useRef, useState } from "react";
import { FileText, Upload, Lock, Loader2, Trash2, ExternalLink, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@ui/hooks/use-toast";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import { formatDate, formatBytes } from "@ui/lib/format";
import { uploadPropertyDocument, DOCUMENT_ACCEPT } from "@ui/lib/uploadPropertyDocument";
import { useActivePortfolioPlan } from "@/lib/useActivePortfolioPlan";
import { useCanOwnerPlan } from "@ui/lib/usePrivileges";
import { PricingModal } from "@ui/components/common/PricingModal";
import { useConfirm } from "@ui/components/common/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@ui/components/ui/dialog";
import type { DocumentRecord } from "@shared/firestore-schema";

interface Props {
  propertyId: string;
}

// Subset of /api/owner/tenants response we actually read here.
interface TenantRow {
  id: string;
  name: string;
  email: string;
  status: string;
  propertyId: string;
  unitLabel: string | null;
}

export function PropertyDocumentsSection({ propertyId }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { plan } = useActivePortfolioPlan();
  const canPlan = useCanOwnerPlan(plan);
  const canUpload = canPlan("documents.upload");
  const [isUploading, setIsUploading] = useState(false);
  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [tenantId, setTenantId] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: documents = [] } = useQuery<DocumentRecord[]>({
    queryKey: [`/api/owner/documents?propertyId=${propertyId}`],
    enabled: !!propertyId && canUpload,
  });

  // Active tenancies for this property — populates the dropdown. We only
  // fetch when the upload dialog is open to keep the page-load idle.
  const { data: tenants = [] } = useQuery<TenantRow[]>({
    queryKey: ["/api/owner/tenants"],
    enabled: dialogOpen && canUpload,
  });
  const activeTenants = tenants.filter((t) => t.propertyId === propertyId && t.status === "active");

  // Reset form state every time the dialog closes so reopening it starts
  // clean (no stale file/tenant selection from the previous upload).
  useEffect(() => {
    if (!dialogOpen) {
      setFile(null);
      setTenantId("");
    }
  }, [dialogOpen]);

  const openUpload = () => {
    if (!canUpload) {
      setIsPricingOpen(true);
      return;
    }
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!file) return;
    setIsUploading(true);
    try {
      await uploadPropertyDocument(file, propertyId, tenantId || undefined);
      qc.invalidateQueries({
        queryKey: [`/api/owner/documents?propertyId=${propertyId}`],
      });
      const sharedWith = tenantId ? activeTenants.find((t) => t.id === tenantId)?.name : null;
      toast({
        title: "Document uploaded",
        description: sharedWith ? `${file.name} — shared with ${sharedWith}` : file.name,
      });
      setDialogOpen(false);
    } catch (err) {
      toast({
        title: "Upload failed",
        description: parseApiError(err, "Upload failed"),
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async (doc: DocumentRecord) => {
    const ok = await confirm({
      title: `Delete "${doc.name}"?`,
      description: "This can't be undone.",
      confirmLabel: "Delete",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await apiRequest("DELETE", `/api/owner/documents/${doc.id}`);
      qc.invalidateQueries({
        queryKey: [`/api/owner/documents?propertyId=${propertyId}`],
      });
      toast({ title: "Document deleted" });
    } catch (err) {
      toast({
        title: "Delete failed",
        description: parseApiError(err, "Delete failed"),
        variant: "destructive",
      });
    }
  };

  return (
    <>
      {confirmDialog}
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-foreground text-lg">Property Documents</h3>
        <button
          onClick={openUpload}
          disabled={isUploading}
          className="px-4 py-2 rounded-full text-sm font-medium border border-border text-muted-foreground hover:text-foreground transition inline-flex items-center gap-2 disabled:opacity-50"
        >
          {isUploading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : canUpload ? (
            <Upload size={14} />
          ) : (
            <Lock size={14} />
          )}
          {isUploading ? "Uploading…" : canUpload ? "Upload" : "Upgrade"}
        </button>
      </div>

      <div className="bg-card rounded-2xl shadow-sm border border-border overflow-hidden mb-8">
        {documents.length === 0 ? (
          <div className="p-8 text-center flex flex-col items-center">
            <div className="w-12 h-12 bg-secondary rounded-full flex items-center justify-center mb-3 text-muted-foreground">
              <FileText size={22} />
            </div>
            <p className="text-sm text-muted-foreground">
              {canUpload
                ? "No documents yet — upload contracts, inspections, or tax forms."
                : "Document storage is a premium feature."}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {documents.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                <div className="w-9 h-9 bg-secondary rounded-lg flex items-center justify-center text-muted-foreground shrink-0">
                  <FileText size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <a
                    href={d.downloadURL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-foreground hover:underline truncate block"
                  >
                    {d.name}
                  </a>
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(d.size)} · {formatDate(d.createdAt)}
                    {d.tenantId &&
                      (() => {
                        const tName = tenants.find((t) => t.id === d.tenantId)?.name;
                        return tName ? ` · shared with ${tName}` : " · shared with tenant";
                      })()}
                  </p>
                </div>
                <a
                  href={d.downloadURL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition"
                  title="Open in new tab"
                >
                  <ExternalLink size={14} />
                </a>
                <button
                  onClick={() => handleDelete(d)}
                  className="p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload size={18} />
              Upload document
            </DialogTitle>
            <DialogDescription>
              Optionally share it with one of your tenants. They'll get a notification on their
              phone or browser.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">File</label>
              <input
                ref={fileInputRef}
                type="file"
                accept={DOCUMENT_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setFile(f);
                  e.target.value = "";
                }}
              />
              {file ? (
                <div className="flex items-center gap-2 p-3 rounded-lg border border-border bg-muted/40">
                  <FileText size={16} className="text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFile(null)}
                    className="p-1.5 rounded-md hover:bg-background text-muted-foreground"
                    title="Remove"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full p-4 rounded-lg border border-dashed border-border text-sm text-muted-foreground hover:bg-muted/40 transition"
                >
                  Choose a file…
                </button>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Share with tenant{" "}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <select
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                disabled={activeTenants.length === 0}
                className="w-full px-3 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
              >
                <option value="">Property-wide (no notification)</option>
                {activeTenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.unitLabel ? ` — ${t.unitLabel}` : ""}
                  </option>
                ))}
              </select>
              {activeTenants.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No active tenants on this property yet — the document will be saved to the
                  property only.
                </p>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                disabled={isUploading}
                className="flex-1 py-2.5 rounded-lg border border-border text-sm font-semibold text-foreground hover:bg-muted transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!file || isUploading}
                className="flex-1 py-2.5 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
              >
                {isUploading && <Loader2 size={14} className="animate-spin" />}
                {isUploading ? "Uploading…" : "Upload"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <PricingModal open={isPricingOpen} onOpenChange={setIsPricingOpen} />
    </>
  );
}
