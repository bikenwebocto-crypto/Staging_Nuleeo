import { useLocation } from "wouter";
import { Banknote, Check, X } from "lucide-react";
import {
  useAcceptInvitation,
  useDeclineInvitation,
  usePendingInvitations,
  usePendingRentPayments,
  useVerifyRentPayment,
} from "@/lib/ownerQueries";
import { useTenantAgreements, useRespondToAgreement } from "@/lib/tenantQueries";
import { useToast } from "@ui/hooks/use-toast";
import { NotificationBell } from "@ui/components/common/NotificationBell";
import { formatCurrencyCompact, formatCurrencyTrim } from "@ui/lib/format";
import { PORTFOLIO_ACCESS_CONTACT_TYPES } from "@/components/common/AddPortfolioAccessDrawer";
import { pickFallbackImage } from "@/lib/fallbackImage";

// Header bell for things the user needs to act on outside the normal page
// flow. It unions every "requests that need your decision" source into one
// panel:
//   • pending lease agreements a landlord sent the tenant (approve/decline)
//   • pending portfolio-access invitations from other owners (accept/decline)
//   • offline rent payments a tenant logged that the owner must confirm
// Both render inline with action buttons so the user never has to hunt for
// the page. The bell shell (trigger + portal positioning) lives in the shared
// <NotificationBell>; this file just supplies the user-app rows.
export function NotificationsButton({ size = "desktop" }: { size?: "desktop" | "mobile" }) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // Leases the landlord sent that are still awaiting this user's approval.
  // /api/tenant/agreements is auth-only (no role gate) and returns [] for
  // non-tenants, so reading it from the global header is safe for everyone.
  const agreementsQuery = useTenantAgreements();
  const pendingAgreements = (agreementsQuery.data ?? []).filter(
    (a) => a.status === "pending_tenant",
  );
  const respond = useRespondToAgreement();

  const pendingInvitationsQuery = usePendingInvitations();
  const invitations = pendingInvitationsQuery.data ?? [];
  const acceptInvitation = useAcceptInvitation();
  const declineInvitation = useDeclineInvitation();

  // Offline rent payments a tenant logged that this owner still needs to
  // confirm. /api/owner/payments/pending is auth-only and returns [] for
  // non-owners, so reading it from the global header is safe for everyone.
  const pendingPaymentsQuery = usePendingRentPayments();
  const payments = pendingPaymentsQuery.data ?? [];
  const verifyPayment = useVerifyRentPayment();

  const acting =
    acceptInvitation.isPending ||
    declineInvitation.isPending ||
    respond.isPending ||
    verifyPayment.isPending;

  const respondToAgreement = (id: string, action: "approve" | "decline") => {
    respond.mutate(
      { id, action },
      {
        onSuccess: () => {
          toast({
            title: action === "approve" ? "Lease accepted" : "Lease declined",
            description:
              action === "approve"
                ? "Your lease is now active."
                : "You've declined this lease. Your landlord has been notified.",
          });
        },
        onError: (err) => {
          toast({
            title: "Something went wrong",
            description: err.message || "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const confirmPayment = (id: string) => {
    verifyPayment.mutate(id, {
      onSuccess: () => {
        toast({
          title: "Payment confirmed",
          description: "Your tenant has been notified you received their rent.",
        });
      },
      onError: (err) => {
        toast({
          title: "Couldn't confirm payment",
          description: err.message || "Please try again.",
          variant: "destructive",
        });
      },
    });
  };

  const totalCount = pendingAgreements.length + invitations.length + payments.length;

  const declineBtnClass =
    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition disabled:opacity-50";
  const approveBtnClass =
    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-foreground text-background hover:opacity-90 transition disabled:opacity-50";

  return (
    <NotificationBell count={totalCount} size={size} subtitle="Requests that need your decision.">
      {(close) => (
        <>
          {pendingAgreements.map((a) => (
            <div key={a.id} className="px-4 py-3 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  close();
                  setLocation("/tenant/agreements");
                }}
                className="flex items-start gap-3 text-left w-full rounded-lg hover:opacity-80 transition"
              >
                <div className="w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 bg-secondary">
                  <img
                    src={a.image ?? pickFallbackImage(a.id)}
                    alt={a.address}
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-foreground truncate">
                    {a.landlord || "Your landlord"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Sent you a lease for <span className="font-medium">{a.address}</span>
                    {typeof a.monthlyRent === "number"
                      ? ` (${formatCurrencyCompact(a.monthlyRent)}/mo)`
                      : ""}
                    . Approve to sign electronically.
                  </div>
                </div>
              </button>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => respondToAgreement(a.id, "decline")}
                  disabled={acting}
                  className={declineBtnClass}
                >
                  <X size={14} />
                  Decline
                </button>
                <button
                  onClick={() => respondToAgreement(a.id, "approve")}
                  disabled={acting}
                  className={approveBtnClass}
                >
                  <Check size={14} />
                  Approve
                </button>
              </div>
            </div>
          ))}

          {invitations.map((inv) => {
            const meta = PORTFOLIO_ACCESS_CONTACT_TYPES.find((t) => t.id === inv.type);
            return (
              <div key={inv.id} className="px-4 py-3 flex flex-col gap-2">
                <div className="flex items-start gap-3">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${meta?.bg ?? "bg-muted"}`}
                  >
                    {meta ? (
                      <meta.icon size={16} className={meta.color} />
                    ) : (
                      <Banknote size={16} className="text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-foreground truncate">
                      {inv.ownerName || inv.ownerEmail || "An Olio user"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Wants to grant you{" "}
                      <span className="font-medium">{(meta?.label ?? inv.type).toLowerCase()}</span>{" "}
                      access ({(meta?.permissions ?? "view only").toLowerCase()}).
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => declineInvitation.mutate(inv.id)}
                    disabled={acting}
                    className={declineBtnClass}
                  >
                    <X size={14} />
                    Decline
                  </button>
                  <button
                    onClick={() => acceptInvitation.mutate(inv.id)}
                    disabled={acting}
                    className={approveBtnClass}
                  >
                    <Check size={14} />
                    Approve
                  </button>
                </div>
              </div>
            );
          })}

          {payments.map((p) => {
            const methodLabel = (p.paymentMethod ?? "manual").replace(/_/g, " ");
            return (
              <div key={p.id} className="px-4 py-3 flex flex-col gap-2">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 bg-emerald-500/10">
                    <Banknote size={16} className="text-emerald-700 dark:text-emerald-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-foreground truncate">
                      {p.tenantName}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Logged a{" "}
                      <span className="font-medium">
                        {formatCurrencyTrim(p.amount, { currency: p.currency })}
                      </span>{" "}
                      {methodLabel} rent payment
                      {p.propertyAddress ? (
                        <>
                          {" "}
                          for <span className="font-medium">{p.propertyAddress}</span>
                        </>
                      ) : null}
                      . Confirm you received it.
                    </div>
                    {p.proofUrl ? (
                      <a
                        href={p.proofUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-block text-xs font-medium text-primary hover:underline"
                      >
                        View receipt
                      </a>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => confirmPayment(p.id)}
                    disabled={acting}
                    className={approveBtnClass}
                  >
                    <Check size={14} />
                    Confirm
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}
    </NotificationBell>
  );
}
