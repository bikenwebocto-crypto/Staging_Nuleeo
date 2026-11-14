import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  Building2,
  UserPlus,
  X,
  RefreshCw,
  User as UserIcon,
  ShoppingBag,
  Activity,
  FileText,
  FileBarChart2,
} from "lucide-react";
import { DesktopSidebar as SharedDesktopSidebar } from "@ui/components/common/DesktopSidebar";
import {
  menuItems,
  tenantMenuItems,
  adminMenuItems,
  BUSINESS_WORKSPACE_PATHS,
  businessOnlyMenuItems,
} from "@/lib/menuItems";
import { useMessagesUnread } from "@/lib/useMessagesUnread";
import { AddPropertyDrawer } from "@/components/owner/AddPropertyDrawer";
import { RecordActivityDialog } from "@/components/owner/RecordActivityDialog";
import { CreatePropertyReportDialog } from "@/components/owner/CreatePropertyReportDialog";
import { prefetchForPath } from "@/lib/prefetch";
import { useWorkspace } from "@/lib/workspaces";
import { WorkspaceSwitcher } from "@/components/owner/workspace/WorkspaceSwitcher";
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

  // ── Workspace switcher (owner side only) ─────────────────────────────
  // Replaces the old portfolio switcher: portfolios shared with this user via
  // portfolio access appear as shared real-estate workspaces, and selecting
  // one switches the active portfolio exactly as before.
  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  // Sidebar plan badge reflects the ACTIVE PORTFOLIO plan.
  const { plan: activePlan } = useActivePortfolioPlan();
  const { activeWorkspace } = useWorkspace();
  const workspaceSwitcher = role === "owner" ? <WorkspaceSwitcher /> : null;

  // A business workspace has no property data yet, so portfolio-only
  // sections are hidden there (they would show the real-estate portfolio).
  const visibleItems =
    role === "owner" && activeWorkspace?.type === "business"
      ? sidebarItems
          .filter((it) => BUSINESS_WORKSPACE_PATHS.includes(it.path))
          .flatMap((it) => (it.path === "/owner" ? [it, ...businessOnlyMenuItems] : [it]))
      : sidebarItems;

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
        items={visibleItems}
        brandHref={role === "tenant" ? "/tenant" : role === "owner" ? "/owner" : undefined}
        topSlot={workspaceSwitcher}
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
