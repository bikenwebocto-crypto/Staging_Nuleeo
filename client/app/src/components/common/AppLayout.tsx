import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import { Eye, X } from "lucide-react";
import { BottomNav } from "@ui/components/common/BottomNav";
import { SkipToContent } from "@ui/components/common/SkipToContent";
import { MainRegion } from "@ui/components/common/MainRegion";
import { getBottomNavItems, getHeaderTitleItems } from "@/lib/navItems";
import { useMessagesUnread } from "@/lib/useMessagesUnread";
import { MobileHeader } from "@/components/common/MobileHeader";
import { DesktopSidebar } from "@/components/common/DesktopSidebar";
import { DesktopHeader } from "@ui/components/common/DesktopHeader";
import { AskOlioFloating } from "@ui/components/common/AskOlioFloating";
import { AddPortfolioAccessDrawer } from "@/components/common/AddPortfolioAccessDrawer";
import { NotificationsButton } from "@/components/common/NotificationsButton";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { useOwnerSearchItems, useTenantSearchItems } from "@/lib/useSearchItems";
import { useAuth } from "@ui/lib/useAuth";
import { usePlan } from "@ui/lib/usePlan";
import { isOwnerExperience } from "@/lib/isOwner";

export type AppRole = "owner" | "tenant" | "admin";

// Pages mounted at routes that don't already imply a role (e.g. /marketplace,
// /profile, /activity) call this to pick owner-vs-tenant. URL prefix wins
// when present; otherwise fall back to the user's active mode so a tenant
// visiting /profile/privacy doesn't see the owner sidebar.
export function useDerivedRole(): AppRole {
  const [location] = useLocation();
  const { profile } = useAuth();
  const { plan } = usePlan();
  // Segment-aware so the OWNER route "/tenants" (plural) doesn't collide with
  // the tenant-experience "/tenant" / "/tenant/*" paths — a bare startsWith
  // made the owner Tenants page (and /tenants/:id) render under tenant chrome.
  if (location === "/tenant" || location.startsWith("/tenant/")) return "tenant";
  if (location.startsWith("/owner")) return "owner";
  if (profile && !isOwnerExperience(profile, plan)) return "tenant";
  return "owner";
}

// Default padding for pages that don't manage their own full-bleed layout.
// Exported as a className so pages can opt-in by wrapping their content.
// Mirrors the platform's AdminLayout content wrapper — full-bleed (no max-width
// cap) so the app reads identically to platform.oliowallet.com on wide screens.
//
// Bottom clearance for the floating mobile nav lives HERE (on the page content),
// not on the scrolling <main>: MainRegion is a `flex-1 min-h-0` flex item, so
// once a page's content overflows, main's own `padding-bottom` gets buried and
// the last element (e.g. Log Out, Connect IBAN) ends up flush behind the fixed
// z-50 nav pill. Padding on the content box overflows *with* the content, so the
// last element actually clears. Symmetric with the top header clearance above.
export const PAGE_CONTAINER_CLASSNAME =
  "p-6 md:p-8 pt-[var(--mobile-header-clearance)] pb-[var(--mobile-nav-clearance)] md:pt-8 md:pb-8";

type AppShellContextValue = {
  actionsSlot: HTMLDivElement | null;
  hiddenMobileHeaderIds: Set<string>;
  setHiddenMobileHeaderId: (id: string, hidden: boolean) => void;
  hiddenBottomNavIds: Set<string>;
  setHiddenBottomNavId: (id: string, hidden: boolean) => void;
};

const AppShellContext = createContext<AppShellContextValue | null>(null);

// Portals its children into the desktop header's action area. Renders nothing
// during SSR / before the layout mounts. Multiple pages can declare actions —
// only the one currently rendered (the active route) will produce children.
export function HeaderActions({ children }: { children: ReactNode }) {
  const ctx = useContext(AppShellContext);
  if (!ctx?.actionsSlot) return null;
  return createPortal(children, ctx.actionsSlot);
}

// Hide the mobile top bar on this page (e.g. /profile owns its own chrome).
// Tracked by id so multiple consumers can request hide independently — the
// bar stays hidden as long as any consumer wants it hidden.
//
// `hidden` lets a page toggle the request on/off without violating the rules
// of hooks (the hook is still called unconditionally every render). Messages
// uses this to hide the bar only while a thread is open.
export function useHideMobileHeader(hidden: boolean = true) {
  const ctx = useContext(AppShellContext);
  const id = useId();
  // Depend on the setter, not the whole ctx. AppLayout memoizes the setter
  // with useCallback; depending on `ctx` (a fresh object every render) would
  // re-run this effect every render and ping-pong setHiddenIds → infinite
  // re-renders → React error #185.
  const setHiddenMobileHeaderId = ctx?.setHiddenMobileHeaderId;
  useEffect(() => {
    if (!setHiddenMobileHeaderId || !hidden) return;
    setHiddenMobileHeaderId(id, true);
    return () => setHiddenMobileHeaderId(id, false);
  }, [setHiddenMobileHeaderId, id, hidden]);
}

// Hide the floating bottom nav on this page. Same id-tracked, toggleable
// pattern as useHideMobileHeader. Messages uses it to go fully immersive
// (no nav pill over the composer) while a chat thread is open.
export function useHideBottomNav(hidden: boolean = true) {
  const ctx = useContext(AppShellContext);
  const id = useId();
  const setHiddenBottomNavId = ctx?.setHiddenBottomNavId;
  useEffect(() => {
    if (!setHiddenBottomNavId || !hidden) return;
    setHiddenBottomNavId(id, true);
    return () => setHiddenBottomNavId(id, false);
  }, [setHiddenBottomNavId, id, hidden]);
}

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const [location] = useLocation();
  const role = useDerivedRole();
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const [hiddenMobileHeaderIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [hiddenBottomNavIds, setHiddenNavIds] = useState<Set<string>>(() => new Set());

  const { isSelf, activePortfolio, canEdit, setActiveOwnerId } = useActivePortfolio();
  const inCrossPortfolioMode = !isSelf && activePortfolio && role === "owner";

  // Both hooks are passive cache reads (enabled: false), so calling both is
  // free — the prefetcher only warms the active role's keys, and the inactive
  // hook just returns empty data.
  const ownerSearchItems = useOwnerSearchItems();
  const tenantSearchItems = useTenantSearchItems();
  const searchItems = role === "tenant" ? tenantSearchItems : ownerSearchItems;

  // Total unread messages, surfaced as a badge on the Messages nav item so it's
  // visible from any page (not just inside Messages). Polls the shared
  // conversations cache app-wide.
  const messagesUnread = useMessagesUnread();
  const bottomNavItems = useMemo(() => {
    const items = getBottomNavItems(role);
    if (messagesUnread <= 0) return items;
    return items.map((it) => (it.label === "Messages" ? { ...it, badge: messagesUnread } : it));
  }, [role, messagesUnread]);

  // /profile owns its own footer chrome and hides the bottom nav; pages can
  // also request it hidden on demand via useHideBottomNav (e.g. Messages, when
  // a chat thread is open and goes full-screen).
  const showBottomNav = !location.includes("/profile") && hiddenBottomNavIds.size === 0;
  const showMobileHeader = hiddenMobileHeaderIds.size === 0;

  const setHiddenMobileHeaderId = useCallback((id: string, hidden: boolean) => {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (hidden) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const setHiddenBottomNavId = useCallback((id: string, hidden: boolean) => {
    setHiddenNavIds((prev) => {
      const next = new Set(prev);
      if (hidden) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const ctxValue = useMemo<AppShellContextValue>(
    () => ({
      actionsSlot,
      hiddenMobileHeaderIds,
      setHiddenMobileHeaderId,
      hiddenBottomNavIds,
      setHiddenBottomNavId,
    }),
    [
      actionsSlot,
      hiddenMobileHeaderIds,
      setHiddenMobileHeaderId,
      hiddenBottomNavIds,
      setHiddenBottomNavId,
    ],
  );

  return (
    <AppShellContext.Provider value={ctxValue}>
      <div className="bg-background flex font-sans overflow-x-hidden h-[var(--app-vh)]">
        <SkipToContent />
        <DesktopSidebar role={role} />
        <div
          data-app-scroll
          className="flex-1 relative overflow-y-auto overflow-x-hidden h-[var(--app-vh)] scroll-smooth overscroll-y-none flex flex-col"
        >
          <DesktopHeader
            role={role}
            actions={<div ref={setActionsSlot} className="flex items-center gap-2" />}
            menuItems={getHeaderTitleItems(role)}
            calculatorHref={role === "tenant" ? undefined : "/calculator"}
            headerExtras={<NotificationsButton />}
            searchItems={searchItems}
            privacyTermsHref={role === "tenant" ? "/tenant/privacy" : "/owner/privacy"}
          />
          {showMobileHeader && <MobileHeader />}

          {/* Hidden on the Messages page — Ask Olio is already pinned at the top
              of the conversation list there, so the floating shortcut is
              redundant (and on desktop it overlapped the composer's Send). */}
          {role !== "tenant" && !location.includes("/messages") && <AskOlioFloating />}
          {role === "owner" && <AddPortfolioAccessDrawer />}

          {inCrossPortfolioMode && activePortfolio && (
            <div className="px-4 md:px-6 pt-3">
              <div className="flex items-center gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-sm">
                <Eye size={16} className="text-blue-600 shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="font-semibold text-foreground">
                    Viewing {activePortfolio.ownerName || activePortfolio.ownerEmail}'s portfolio
                  </span>
                  <span className="text-muted-foreground ml-2">
                    ({activePortfolio.portfolioId} · {canEdit ? "view & edit" : "view only"})
                  </span>
                </div>
                <button
                  onClick={() => setActiveOwnerId(null)}
                  className="text-xs font-semibold text-blue-700 dark:text-blue-300 hover:underline shrink-0 flex items-center gap-1"
                >
                  <X size={12} /> Back to my portfolio
                </button>
              </div>
            </div>
          )}

          <MainRegion
            className={
              showBottomNav
                ? "flex-1 min-h-0 pb-[var(--mobile-nav-clearance)] md:pb-0"
                : "flex-1 min-h-0"
            }
          >
            {children}
          </MainRegion>
        </div>

        {showBottomNav && <BottomNav items={bottomNavItems} />}
      </div>
    </AppShellContext.Provider>
  );
}
