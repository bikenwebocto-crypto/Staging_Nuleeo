import { Link, useLocation } from "wouter";
import {
  Search,
  Calculator,
  Plus,
  UserPlus,
  Building2,
  FileText,
  FileBarChart2,
  Home,
  ShoppingBag,
  Activity,
  Bell,
  Banknote,
  Check,
  X as XIcon,
  FileSignature,
} from "lucide-react";
import { useState } from "react";
import { Drawer } from "vaul";
import { ProfileDrawer } from "@ui/components/common/ProfileDrawer";
import { AddPropertyDrawer } from "@/components/owner/AddPropertyDrawer";
import { RecordActivityDialog } from "@/components/owner/RecordActivityDialog";
import { CreatePropertyReportDialog } from "@/components/owner/CreatePropertyReportDialog";
import { useAuth } from "@ui/lib/useAuth";
import { usePlan } from "@ui/lib/usePlan";
import { useCanOwnerPlan } from "@ui/lib/usePrivileges";
import { useActivePortfolioPlan } from "@/lib/useActivePortfolioPlan";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { useToast } from "@ui/hooks/use-toast";
import { openBriefing } from "@ui/lib/briefing";
import { isOwnerExperience } from "@/lib/isOwner";
import {
  useAcceptInvitation,
  useAccessiblePortfolios,
  useDeclineInvitation,
  usePendingInvitations,
  usePendingRentPayments,
  useVerifyRentPayment,
} from "@/lib/ownerQueries";
import { useTenantAgreements, useRespondToAgreement } from "@/lib/tenantQueries";
import { formatCurrencyCompact, formatCurrencyTrim } from "@ui/lib/format";
import { PORTFOLIO_ACCESS_CONTACT_TYPES } from "@/components/common/AddPortfolioAccessDrawer";

type CreateAction =
  | "add-property"
  | "buy-property"
  | "add-portfolio-user"
  | "record-activity"
  | "create-report"
  | "create-property-report";

const createOptions: { icon: typeof UserPlus; label: string; action: CreateAction }[] = [
  { icon: Building2, label: "Add Property", action: "add-property" },
  { icon: ShoppingBag, label: "Buy a Property", action: "buy-property" },
  { icon: UserPlus, label: "Add Portfolio User", action: "add-portfolio-user" },
  { icon: Activity, label: "Record Activity", action: "record-activity" },
  { icon: FileText, label: "Create portfolio briefing", action: "create-report" },
  { icon: FileBarChart2, label: "Create property report", action: "create-property-report" },
];

export function MobileHeader() {
  const { profile } = useAuth();
  const { plan } = usePlan();
  const { plan: activePlan } = useActivePortfolioPlan();
  const { activeOwnerId, activePortfolioDocId, isSelf, setActiveOwnerId } = useActivePortfolio();
  // Owner-only: drives the "Switch Portfolio" row inside the profile drawer.
  // Shared query key, so this is a cache read warmed by the desktop sidebar /
  // AppLayout — ProfileDrawer hides the row unless there's >1 portfolio.
  const accessiblePortfolios = useAccessiblePortfolios().data ?? [];
  const canPrintBriefing = useCanOwnerPlan(activePlan)("briefing.portfolio");
  const { toast } = useToast();
  const initial = (profile?.firstName?.[0] ?? profile?.email?.[0] ?? "?").toUpperCase();
  // Remembers an avatar URL that failed to load (e.g. a stale Google photo
  // URL) so we render initials instead of a broken-image icon. Keyed on the
  // URL, so a later upload of a new photo is retried automatically.
  const [photoFailedSrc, setPhotoFailedSrc] = useState<string | null>(null);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isAddPropertyOpen, setIsAddPropertyOpen] = useState(false);
  const [isRecordActivityOpen, setIsRecordActivityOpen] = useState(false);
  const [isPropertyReportOpen, setIsPropertyReportOpen] = useState(false);
  const [location, setLocation] = useLocation();

  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const pendingInvitationsQuery = usePendingInvitations();
  const invitations = pendingInvitationsQuery.data ?? [];
  const acceptInvitation = useAcceptInvitation();
  const declineInvitation = useDeclineInvitation();

  // Pending leases the landlord sent that still need this user's approval —
  // surfaced alongside portfolio invitations so a tenant gets the same
  // "requests that need your decision" treatment on mobile.
  const agreementsQuery = useTenantAgreements();
  const pendingAgreements = (agreementsQuery.data ?? []).filter(
    (a) => a.status === "pending_tenant",
  );
  const respond = useRespondToAgreement();

  // Offline rent payments a tenant logged that this owner still needs to
  // confirm — surfaced next to lease approvals and portfolio invites so the
  // owner gets the same "requests that need your decision" treatment on mobile.
  const pendingPaymentsQuery = usePendingRentPayments();
  const payments = pendingPaymentsQuery.data ?? [];
  const verifyPayment = useVerifyRentPayment();

  const acting =
    acceptInvitation.isPending ||
    declineInvitation.isPending ||
    respond.isPending ||
    verifyPayment.isPending;
  const notificationsCount = pendingAgreements.length + invitations.length + payments.length;

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

  const openCreate = () => setIsCreateOpen(true);
  const closeCreate = () => setIsCreateOpen(false);
  const handleCreateAction = (action: CreateAction) => {
    closeCreate();
    if (action === "add-property") {
      setIsAddPropertyOpen(true);
    } else if (action === "buy-property") {
      setLocation("/marketplace");
    } else if (action === "add-portfolio-user") {
      // Opens the global AddPortfolioAccessDrawer in place — no navigation.
      window.dispatchEvent(new CustomEvent("open-portfolio-access-add"));
    } else if (action === "record-activity") {
      setIsRecordActivityOpen(true);
    } else if (action === "create-report") {
      void handleCreatePortfolioBriefing();
    } else if (action === "create-property-report") {
      setIsPropertyReportOpen(true);
    }
  };

  const handleCreatePortfolioBriefing = async () => {
    if (!canPrintBriefing) {
      toast({
        title: "Portfolio briefing is a premium feature",
        description: "Upgrade your plan to download your portfolio briefing as a PDF.",
      });
      return;
    }
    const r = await openBriefing("portfolio", {
      ownerId: activeOwnerId,
      isSelf,
      portfolioDocId: activePortfolioDocId,
    });
    if (!r.ok) {
      toast({ title: "Briefing failed", description: r.error, variant: "destructive" });
    }
  };

  const isTenantPath = location === "/tenant" || location.startsWith("/tenant/");
  const isOwnerPath = location === "/owner" || location.startsWith("/owner/");
  const isAdminView = location === "/admin" || location.startsWith("/admin/");
  // On role-neutral routes (/profile, /marketplace, etc.) the URL alone can't
  // tell us if the visitor is in tenant or owner mode — fall back to their
  // active experience so the header chrome matches the rest of the shell.
  const tenantByMode = !isOwnerPath && !!profile && !isOwnerExperience(profile, plan);
  const isTenantView = isTenantPath || tenantByMode;

  let role = "owner";
  if (isTenantView) role = "tenant";
  if (isAdminView) role = "admin";

  return (
    <>
      <ProfileDrawer
        open={isProfileOpen}
        onOpenChange={setIsProfileOpen}
        role={role as any}
        privacyTermsHref={role === "tenant" ? "/tenant/privacy" : "/owner/privacy"}
        settingsHref={role === "tenant" ? "/tenant/settings" : "/owner/settings"}
        portfolioSwitcher={{
          portfolios: accessiblePortfolios,
          activeOwnerId,
          onSelect: setActiveOwnerId,
        }}
      />
      <AddPropertyDrawer open={isAddPropertyOpen} onOpenChange={setIsAddPropertyOpen} />
      <RecordActivityDialog open={isRecordActivityOpen} onOpenChange={setIsRecordActivityOpen} />
      <CreatePropertyReportDialog
        open={isPropertyReportOpen}
        onOpenChange={setIsPropertyReportOpen}
      />

      {/* Notifications Drawer */}
      <Drawer.Root open={isNotificationsOpen} onOpenChange={setIsNotificationsOpen}>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100]" />
          <Drawer.Content
            className="fixed bottom-0 left-0 right-0 z-[101] outline-none"
            style={{ maxHeight: "80vh" }}
          >
            <div
              className="bg-card rounded-t-2xl border-t border-border overflow-y-auto overscroll-contain"
              style={{ maxHeight: "80vh" }}
            >
              <div className="mx-auto w-10 h-1 flex-shrink-0 rounded-full bg-muted-foreground/30 mt-3 mb-2" />
              <div className="px-6 pb-2">
                <Drawer.Title className="text-lg font-semibold text-foreground">
                  Notifications
                </Drawer.Title>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Requests that need your decision.
                </p>
              </div>
              <div className="px-6 pb-8 pt-2">
                {notificationsCount === 0 ? (
                  <div className="py-8 text-center">
                    <div className="mx-auto w-10 h-10 rounded-full bg-muted/60 flex items-center justify-center mb-2">
                      <Bell size={18} className="text-muted-foreground" />
                    </div>
                    <div className="text-sm font-medium text-foreground">You're all caught up</div>
                    <div className="text-xs text-muted-foreground mt-1">No new notifications.</div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {pendingAgreements.map((a) => (
                      <div
                        key={a.id}
                        className="rounded-2xl border border-border bg-background p-4 flex flex-col gap-3"
                      >
                        <div className="flex items-start gap-3">
                          <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 bg-amber-500/15">
                            <FileSignature size={18} className="text-amber-500" />
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
                        </div>
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => respondToAgreement(a.id, "decline")}
                            disabled={acting}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition disabled:opacity-50"
                          >
                            <XIcon size={14} />
                            Decline
                          </button>
                          <button
                            onClick={() => respondToAgreement(a.id, "approve")}
                            disabled={acting}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-foreground text-background hover:opacity-90 transition disabled:opacity-50"
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
                        <div
                          key={inv.id}
                          className="rounded-2xl border border-border bg-background p-4 flex flex-col gap-3"
                        >
                          <div className="flex items-start gap-3">
                            <div
                              className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${meta?.bg ?? "bg-muted"}`}
                            >
                              {meta ? (
                                <meta.icon size={18} className={meta.color} />
                              ) : (
                                <Bell size={18} className="text-muted-foreground" />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold text-foreground truncate">
                                {inv.ownerName || inv.ownerEmail || "An Olio user"}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                Wants to grant you{" "}
                                <span className="font-medium">
                                  {(meta?.label ?? inv.type).toLowerCase()}
                                </span>{" "}
                                access ({(meta?.permissions ?? "view only").toLowerCase()}).
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => declineInvitation.mutate(inv.id)}
                              disabled={acting}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition disabled:opacity-50"
                            >
                              <XIcon size={14} />
                              Decline
                            </button>
                            <button
                              onClick={() => acceptInvitation.mutate(inv.id)}
                              disabled={acting}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-foreground text-background hover:opacity-90 transition disabled:opacity-50"
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
                        <div
                          key={p.id}
                          className="rounded-2xl border border-border bg-background p-4 flex flex-col gap-3"
                        >
                          <div className="flex items-start gap-3">
                            <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 bg-emerald-500/10">
                              <Banknote
                                size={18}
                                className="text-emerald-700 dark:text-emerald-400"
                              />
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
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-foreground text-background hover:opacity-90 transition disabled:opacity-50"
                            >
                              <Check size={14} />
                              Confirm
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>

      {/* Create New Drawer */}
      <Drawer.Root
        open={isCreateOpen}
        onOpenChange={(open) => {
          if (!open) closeCreate();
          else setIsCreateOpen(true);
        }}
      >
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100]" />
          <Drawer.Content
            className="fixed bottom-0 left-0 right-0 z-[101] outline-none"
            style={{ maxHeight: "75vh" }}
          >
            <div
              className="bg-card rounded-t-2xl border-t border-border overflow-y-auto overscroll-contain"
              style={{ maxHeight: "75vh" }}
            >
              <div className="mx-auto w-10 h-1 flex-shrink-0 rounded-full bg-muted-foreground/30 mt-3 mb-2" />

              {/* Header */}
              <div className="px-6 pb-2 flex items-center gap-2">
                <div>
                  <Drawer.Title className="text-lg font-semibold text-foreground">
                    Create New
                  </Drawer.Title>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    What would you like to create?
                  </p>
                </div>
              </div>

              <div className="px-6 pb-8 pt-2">
                <div className="space-y-1 -mx-2">
                  {createOptions.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() => handleCreateAction(option.action)}
                      className="flex items-center gap-3 w-full px-3 py-3 rounded-xl hover:bg-secondary active:bg-secondary transition-all duration-200 text-left"
                    >
                      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                        <option.icon size={20} className="text-primary" />
                      </div>
                      <span className="font-medium text-sm text-foreground">{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>

      <div
        className={`md:hidden fixed top-0 left-0 right-0 z-40 transition-all duration-300 pt-[calc(env(safe-area-inset-top)+1rem)] pb-2 px-6 ${
          isAdminView
            ? "bg-card/80 backdrop-blur-xl border-b border-border/50 shadow-sm"
            : "bg-transparent"
        }`}
      >
        {/* Subtle gradient overlay for readability against dark hero backgrounds */}
        {!isAdminView && (
          <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/20 to-transparent pointer-events-none -z-10" />
        )}

        <div className="flex items-center gap-3 relative z-50">
          <button
            type="button"
            onClick={() => setIsProfileOpen(true)}
            aria-label="Open profile"
            className={`w-10 h-10 rounded-full overflow-hidden flex-shrink-0 cursor-pointer shadow-sm border flex items-center justify-center focus:outline-none focus-visible:ring-2 ${
              isAdminView
                ? "border-border bg-muted text-foreground focus-visible:ring-ring"
                : "border-white/20 bg-white/10 text-white focus-visible:ring-white"
            }`}
          >
            {profile?.photoURL && profile.photoURL !== photoFailedSrc ? (
              <img
                src={profile.photoURL}
                alt="Profile"
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
                onError={() => setPhotoFailedSrc(profile?.photoURL ?? null)}
              />
            ) : (
              <span className="text-sm font-semibold">{initial}</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("command-palette:open"))}
            aria-label="Open search"
            className={`flex-1 h-10 backdrop-blur-xl rounded-full flex items-center px-4 border text-left focus:outline-none focus-visible:ring-2 ${
              isAdminView
                ? "bg-muted/80 border-border/50 text-foreground focus-visible:ring-ring"
                : "bg-white/10 border-white/10 text-white focus-visible:ring-white"
            }`}
          >
            <Search
              size={16}
              className={`mr-2 ${isAdminView ? "text-muted-foreground" : "text-white/50"}`}
            />
            <span
              className={`bg-transparent text-sm font-medium w-full ${
                isAdminView ? "text-muted-foreground" : "text-white/50"
              }`}
            >
              Search
            </span>
          </button>

          <div className="flex gap-2">
            {!isTenantView && (
              <button
                type="button"
                onClick={openCreate}
                aria-label="Create new"
                className={`w-10 h-10 rounded-full backdrop-blur-xl flex items-center justify-center transition-all active:scale-95 border focus:outline-none focus-visible:ring-2 ${
                  isAdminView
                    ? "bg-muted/80 border-border/50 text-foreground focus-visible:ring-ring"
                    : "bg-white/10 border-white/10 text-white focus-visible:ring-white"
                }`}
              >
                <Plus size={17} strokeWidth={2} />
              </button>
            )}
            <Link
              href={
                isTenantView
                  ? location === "/tenant/agreements"
                    ? "/tenant"
                    : "/tenant/agreements"
                  : "/calculator"
              }
            >
              <button
                type="button"
                aria-label={
                  isTenantView
                    ? location === "/tenant/agreements"
                      ? "Go to tenant home"
                      : "View agreements"
                    : "Open calculator"
                }
                className={`w-10 h-10 rounded-full backdrop-blur-xl flex items-center justify-center transition-all active:scale-95 border ${
                  isAdminView
                    ? "bg-muted/80 border-border/50 text-foreground"
                    : "bg-white/10 border-white/10 text-white"
                }`}
              >
                {isTenantView ? (
                  location === "/tenant/agreements" ? (
                    <Home size={17} strokeWidth={2} />
                  ) : (
                    <FileText size={17} strokeWidth={2} />
                  )
                ) : (
                  <Calculator size={17} strokeWidth={2} />
                )}
              </button>
            </Link>
            <button
              type="button"
              onClick={() => setIsNotificationsOpen(true)}
              aria-label={
                notificationsCount > 0 ? `Notifications (${notificationsCount})` : "Notifications"
              }
              className={`relative w-10 h-10 rounded-full backdrop-blur-xl flex items-center justify-center transition-all active:scale-95 border ${
                isAdminView
                  ? "bg-muted/80 border-border/50 text-foreground"
                  : "bg-white/10 border-white/10 text-white"
              }`}
            >
              <Bell size={17} strokeWidth={2} />
              {notificationsCount > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-background" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Spacer for non-dashboard pages to prevent content hidden behind header */}
      {/* Spacer removed - padding handled in individual pages */}
      {/* {!isDashboard && <div className="h-20 md:hidden" />} */}
    </>
  );
}
