import { useState } from "react";
import { Mail, Phone, Home, Trash2, Calendar, Euro, Loader2, MessageSquare } from "lucide-react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import type { OwnerTenant } from "@/lib/ownerQueries";
import { useActivePortfolio, withOwnerScope } from "@/lib/activePortfolio";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { useConfirm } from "@ui/components/common/ConfirmDialog";
import { StatusPill } from "@ui/components/common/StatusPill";
import { Avatar } from "@ui/components/common/Avatar";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import { useToast } from "@ui/hooks/use-toast";
import { formatCurrencyCompact, formatDate } from "@ui/lib/format";

interface TenantDetailsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: OwnerTenant | null;
}

export function TenantDetailsDrawer({ open, onOpenChange, tenant }: TenantDetailsDrawerProps) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  const [ending, setEnding] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

  if (!tenant) return null;

  const isActive = tenant.status === "active";

  // POST the new /api/owner/tenants/:id/end endpoint. Flips the tenancy to
  // expired, batch-terminates any active agreements, and pushes the tenant
  // under propertyActivity. We confirm before firing because the action
  // can't be reversed from the UI today.
  const handleEndTenancy = async () => {
    if (!isActive) return;
    const ok = await confirm({
      title: `End tenancy for ${tenant.name}?`,
      description:
        "This marks them as expired and terminates any active agreement. We'll notify them if they have notifications on. This can't be undone here.",
      confirmLabel: "End tenancy",
      tone: "destructive",
    });
    if (!ok) return;
    setEnding(true);
    try {
      await apiRequest("POST", `/api/owner/tenants/${tenant.id}/end`);
      // Ending a tenancy flips the agreement to terminated and the
      // property to vacant. Invalidate every cache that touches that
      // state so the UI doesn't keep showing the tenant as active.
      // Scope the owner-list keys to the active portfolio (granted editors
      // read `?ownerId=…`); for self these resolve to the same bare keys.
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/tenants", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/agreements", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/properties", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      qc.invalidateQueries({
        queryKey: [
          withOwnerScope("/api/owner/summary", activeOwnerId, isSelf, activePortfolioDocId),
        ],
      });
      // Single-property read isn't owner-scoped (keyed by id only).
      if (tenant.propertyId) {
        qc.invalidateQueries({ queryKey: [`/api/properties/${tenant.propertyId}`] });
      }
      toast({ title: "Tenancy ended", description: tenant.name });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Couldn't end tenancy",
        description: parseApiError(err, "Failed to end tenancy"),
        variant: "destructive",
      });
    } finally {
      setEnding(false);
    }
  };

  const handleOpenChat = async () => {
    try {
      const res = await apiRequest("POST", "/api/messages/start", { tenancyId: tenant.id });
      const conv = (await res.json()) as { id: string };
      onOpenChange(false);
      // ?c= tells MessagesPage which thread to open — without it the page
      // auto-selects the most recently active thread, i.e. someone else.
      setLocation(`/owner/messages?c=${encodeURIComponent(conv.id)}`);
    } catch (err) {
      toast({
        title: "Can't open chat",
        description: parseApiError(err, "Failed to open chat"),
        variant: "destructive",
      });
    }
  };

  return (
    <>
      {confirmDialog}
      <ResponsiveDrawer open={open} onOpenChange={onOpenChange} title="Tenant Details">
        <div className="space-y-6">
          {/* Header Profile */}
          <div className="flex flex-col items-center">
            <Avatar
              name={tenant.name}
              size="xl"
              className="border-4 border-background shadow-lg mb-3"
            />

            <h2 className="text-2xl font-bold text-foreground">{tenant.name}</h2>
            <div className="mt-1">
              <StatusPill intent={tenant.status === "active" ? "success" : "neutral"}>
                {tenant.status === "active" ? "Active Tenant" : tenant.status}
              </StatusPill>
            </div>

            {/* Readable, tappable contact details. Skip the email when it's
              already the display name (invited tenant with no real name on
              file) so it isn't shown twice. */}
            {(tenant.phone || (tenant.email && tenant.email !== tenant.name)) && (
              <div className="mt-3 flex flex-col items-center gap-1 text-sm">
                {tenant.email && tenant.email !== tenant.name && (
                  <a
                    href={`mailto:${tenant.email}`}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition break-all"
                  >
                    <Mail size={14} className="shrink-0" /> {tenant.email}
                  </a>
                )}
                {tenant.phone && (
                  <a
                    href={`tel:${tenant.phone}`}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition"
                  >
                    <Phone size={14} className="shrink-0" /> {tenant.phone}
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Quick Actions — Email and Chat. The tenant's phone (when on file)
            is shown as a tap-to-call link above; no separate Call button. */}
          <div className="grid grid-cols-2 gap-3">
            <a
              href={tenant.email ? `mailto:${tenant.email}` : undefined}
              aria-disabled={!tenant.email}
              className={`bg-primary text-primary-foreground py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 hover:bg-primary/90 transition ${tenant.email ? "" : "opacity-50 pointer-events-none"}`}
            >
              <Mail size={18} /> Email
            </a>
            <button
              type="button"
              onClick={handleOpenChat}
              disabled={!tenant.userId}
              title={tenant.userId ? "Open chat" : "Tenant hasn't signed up yet"}
              className="bg-secondary text-foreground py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 hover:bg-secondary transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <MessageSquare size={18} /> Chat
            </button>
          </div>

          {/* Info Cards */}
          <div className="space-y-4">
            <div className="bg-background p-4 rounded-2xl border border-border flex items-center gap-4">
              <div className="w-10 h-10 bg-card rounded-full flex items-center justify-center text-primary shadow-sm">
                <Home size={20} />
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-bold uppercase">Property</p>
                <p className="font-bold text-foreground">{tenant.propertyAddress ?? "—"}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-background p-4 rounded-2xl border border-border">
                <div className="flex items-center gap-2 text-muted-foreground text-xs font-bold uppercase mb-1">
                  <Euro size={14} /> Rent
                </div>
                <p className="font-bold text-foreground text-lg">
                  {formatCurrencyCompact(tenant.rentAmount)}/mo
                </p>
              </div>
              <div className="bg-background p-4 rounded-2xl border border-border">
                <div className="flex items-center gap-2 text-muted-foreground text-xs font-bold uppercase mb-1">
                  <Calendar size={14} /> Next Pay
                </div>
                <p className="font-bold text-foreground text-lg">
                  {formatDate(tenant.nextPayment)}
                </p>
              </div>
            </div>
          </div>

          {/* End Tenancy */}
          <div className="pt-4 border-t border-border">
            <button
              type="button"
              onClick={handleEndTenancy}
              disabled={!isActive || ending}
              className="w-full bg-destructive/10 text-destructive font-bold py-4 rounded-2xl flex items-center justify-center gap-2 hover:bg-destructive/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {ending ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={20} />}
              {isActive ? (ending ? "Ending…" : "End Tenancy") : "Already ended"}
            </button>
            <p className="text-center text-xs text-muted-foreground/70 mt-2">
              Marks the tenancy as expired and terminates any active agreement. We'll notify the
              tenant if they have notifications on.
            </p>
          </div>
        </div>
      </ResponsiveDrawer>
    </>
  );
}
