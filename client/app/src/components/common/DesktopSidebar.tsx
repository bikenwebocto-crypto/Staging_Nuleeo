import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  Building2,
  UserPlus,
  X,
  Check,
  RefreshCw,
  User as UserIcon,
  ChevronDown,
  Wallet,
  Shield,
  Scale,
  CreditCard,
  ShoppingBag,
  Activity,
  FileText,
  FileBarChart2,
} from "lucide-react";
import { cn } from "@ui/lib/utils";
import { DesktopSidebar as SharedDesktopSidebar } from "@ui/components/common/DesktopSidebar";
import { menuItems, tenantMenuItems, adminMenuItems } from "@/lib/menuItems";
import { useMessagesUnread } from "@/lib/useMessagesUnread";
import { AddPropertyDrawer } from "@/components/owner/AddPropertyDrawer";
import { RecordActivityDialog } from "@/components/owner/RecordActivityDialog";
import { CreatePropertyReportDialog } from "@/components/owner/CreatePropertyReportDialog";
import { prefetchForPath } from "@/lib/prefetch";
import { useAccessiblePortfolios } from "@/lib/ownerQueries";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { useActivePortfolioPlan } from "@/lib/useActivePortfolioPlan";
import { useAuth } from "@ui/lib/useAuth";
import { usePlan } from "@ui/lib/usePlan";
import { useCanOwnerPlan } from "@ui/lib/usePrivileges";
import { useToast } from "@ui/hooks/use-toast";
import { openBriefing } from "@ui/lib/briefing";
import { isOwnerExperience } from "@/lib/isOwner";

interface DesktopSidebarProps {
  role?: "owner" | "tenant" | "admin";
}

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

export function DesktopSidebar({ role = "owner" }: DesktopSidebarProps) {
  const [, setLocation] = useLocation();
  const { profile } = useAuth();
  const { plan } = usePlan();
  // Owner mode is opt-in: a tenant only sees the "Switch to Owner" button
  // after flipping the toggle in Tenant Settings. If they're already on the
  // owner side we always show the button so they have a way back.
  const ownerModeOn = profile ? isOwnerExperience(profile, plan) : false;

  // Pick the right menu list for the current role.
  let items = menuItems;
  if (role === "tenant") items = tenantMenuItems;
  if (role === "admin") items = adminMenuItems;

  // Badge the Messages row with the total unread count so it's visible without
  // opening the thread list.
  const messagesUnread = useMessagesUnread();
  const sidebarItems =
    messagesUnread > 0
      ? items.map((it) => (it.label === "Messages" ? { ...it, badge: messagesUnread } : it))
      : items;

  // ── Portfolio switcher (owner side only) ─────────────────────────────
  const portfoliosQuery = useAccessiblePortfolios();
  const accessiblePortfolios = portfoliosQuery.data ?? [];
  const { activeOwnerId, activePortfolioDocId, isSelf, setActiveOwnerId } = useActivePortfolio();
  // Sidebar plan badge reflects the ACTIVE PORTFOLIO's plan, not the caller's
  // own subscription — so a granted contact viewing a Pro portfolio sees "PRO".
  const { plan: activePlan } = useActivePortfolioPlan();
  const activePortfolio =
    accessiblePortfolios.find((p) => p.ownerId === activeOwnerId) ??
    accessiblePortfolios.find((p) => p.isSelf) ??
    accessiblePortfolios[0];
  const [isPortfolioMenuOpen, setIsPortfolioMenuOpen] = useState(false);

  // Close the portfolio dropdown when clicking outside it.
  useEffect(() => {
    if (!isPortfolioMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-portfolio-switcher]")) {
        setIsPortfolioMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isPortfolioMenuOpen]);

  const portfolioSwitcher =
    role === "owner" && activePortfolio ? (
      <div className="relative mb-3" data-portfolio-switcher>
        <button
          onClick={() => setIsPortfolioMenuOpen((v) => !v)}
          className="w-full flex items-center gap-2 rounded-lg border border-border bg-secondary/30 hover:bg-secondary transition-colors text-foreground justify-between px-3 py-2"
        >
          <span className="flex items-center gap-2 min-w-0">
            <Wallet size={16} className="shrink-0 text-muted-foreground" />
            <span className="flex flex-col items-start min-w-0">
              <span className="text-[11px] font-mono font-semibold text-foreground truncate leading-tight">
                {activePortfolio.portfolioId || "—"}
              </span>
              <span className="text-[10px] text-muted-foreground truncate leading-tight">
                {activePortfolio.ownerName || activePortfolio.ownerEmail}
              </span>
            </span>
          </span>
          <ChevronDown
            size={14}
            className={cn(
              "text-muted-foreground shrink-0 transition-transform",
              isPortfolioMenuOpen && "rotate-180",
            )}
          />
        </button>

        {isPortfolioMenuOpen && (
          <div className="absolute top-full left-0 right-0 mt-2 bg-card border border-border rounded-lg shadow-lg overflow-hidden z-50">
            <div className="px-3 py-2 border-b border-border">
              <p className="text-[10px] uppercase font-bold text-muted-foreground tracking-wide">
                Your Portfolios
              </p>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {accessiblePortfolios.length === 0 && (
                <div className="px-3 py-3 text-xs text-muted-foreground">No portfolios yet</div>
              )}
              {accessiblePortfolios.map((p) => {
                const RoleIcon =
                  p.role === "self"
                    ? Wallet
                    : p.role === "legacy"
                      ? Shield
                      : p.role === "legal"
                        ? Scale
                        : CreditCard;
                const roleLabel =
                  p.role === "self"
                    ? "Owner"
                    : p.role === "legacy"
                      ? "Legacy"
                      : p.role === "legal"
                        ? "Legal"
                        : "Financial";
                const isActive = p.ownerId === activePortfolio.ownerId;
                return (
                  <button
                    key={p.ownerId}
                    onClick={() => {
                      setIsPortfolioMenuOpen(false);
                      setActiveOwnerId(p.isSelf ? null : p.ownerId);
                    }}
                    className={cn(
                      "w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-secondary transition-colors",
                      isActive && "bg-secondary/50",
                    )}
                  >
                    <RoleIcon size={14} className="text-muted-foreground shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-mono font-semibold text-foreground truncate">
                          {p.portfolioId || "—"}
                        </span>
                        <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-secondary text-muted-foreground tracking-wide">
                          {roleLabel}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {p.ownerName || p.ownerEmail}
                      </div>
                    </div>
                    {isActive && <Check size={14} className="text-primary shrink-0 mt-1" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    ) : null;

  // ── Switch Mode (Tenant ↔ Owner) ─────────────────────────────────────
  // Hidden for tenants who haven't activated owner mode yet — they enable it
  // from Tenant Settings → "Activate Landlord View" first.
  const showSwitchMode = role !== "admin" && (role === "owner" || ownerModeOn);
  const switchModeButton = showSwitchMode ? (
    <button
      onClick={() => setLocation(role === "tenant" ? "/owner" : "/tenant")}
      className="w-full flex items-center gap-2 rounded-lg border border-border bg-secondary/30 hover:bg-secondary transition-colors text-foreground justify-between px-3 py-2"
    >
      <span className="flex items-center gap-2 min-w-0">
        {role === "tenant" ? (
          <Building2 size={16} className="shrink-0 text-muted-foreground" />
        ) : (
          <UserIcon size={16} className="shrink-0 text-muted-foreground" />
        )}
        <span className="text-xs font-medium truncate">
          Switch to {role === "tenant" ? "Owner" : "Tenant"}
        </span>
      </span>
      <RefreshCw size={14} className="text-muted-foreground shrink-0" />
    </button>
  ) : null;

  // ── Create modal (header `+` button dispatches open-admin-create) ────
  // App-side options are different from platform: owners create properties,
  // browse the marketplace, invite portfolio contacts, or log activity.
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isAddPropertyOpen, setIsAddPropertyOpen] = useState(false);
  const [isRecordActivityOpen, setIsRecordActivityOpen] = useState(false);
  const [isPropertyReportOpen, setIsPropertyReportOpen] = useState(false);

  // "Create portfolio briefing" generates the portfolio briefing PDF. The plan
  // gate mirrors OwnerDashboard's old Briefing button (active portfolio's plan).
  const canPrintBriefing = useCanOwnerPlan(activePlan)("briefing.portfolio");
  const { toast } = useToast();

  useEffect(() => {
    const handler = () => setIsCreateOpen(true);
    window.addEventListener("open-admin-create", handler);
    return () => window.removeEventListener("open-admin-create", handler);
  }, []);

  const closeCreateModal = () => setIsCreateOpen(false);

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

  const handleCreateAction = (action: CreateAction) => {
    closeCreateModal();
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

  return (
    <>
      <SharedDesktopSidebar
        role={role}
        items={sidebarItems}
        brandHref={role === "tenant" ? "/tenant" : role === "owner" ? "/owner" : undefined}
        topSlot={portfolioSwitcher}
        bottomSlot={switchModeButton}
        onItemHover={prefetchForPath}
        currentPlan={activePlan}
      />

      {isCreateOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={closeCreateModal}
          />
          <div className="relative bg-card rounded-2xl shadow-xl border border-border w-[420px] max-w-[90vw] max-h-[85vh] overflow-y-auto">
            <div className="sticky top-0 bg-card rounded-t-2xl p-6 pb-4 border-b border-border z-10">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-foreground">Create New</h3>
                <button
                  onClick={closeCreateModal}
                  className="p-1 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="p-6 pt-4">
              <div className="space-y-1">
                {createOptions.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => handleCreateAction(option.action)}
                    className="flex items-center gap-3 w-full px-3 py-3 rounded-xl cursor-pointer hover:bg-secondary transition-all duration-200 group text-left"
                  >
                    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                      <option.icon size={18} className="text-primary" />
                    </div>
                    <span className="font-medium text-sm text-foreground">{option.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <AddPropertyDrawer open={isAddPropertyOpen} onOpenChange={setIsAddPropertyOpen} />
      <RecordActivityDialog open={isRecordActivityOpen} onOpenChange={setIsRecordActivityOpen} />
      <CreatePropertyReportDialog
        open={isPropertyReportOpen}
        onOpenChange={setIsPropertyReportOpen}
      />
    </>
  );
}
