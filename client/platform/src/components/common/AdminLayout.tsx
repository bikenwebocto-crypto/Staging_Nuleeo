import { ReactNode, createContext, useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BottomNav } from "@ui/components/common/BottomNav";
import { SkipToContent } from "@ui/components/common/SkipToContent";
import { MainRegion } from "@ui/components/common/MainRegion";
import { getBottomNavItems, getHeaderTitleItems } from "@/lib/navItems";
import { MobileHeader } from "@/components/common/MobileHeader";
import { DesktopSidebar } from "@/components/common/DesktopSidebar";
import { DesktopHeader } from "@ui/components/common/DesktopHeader";
import { AdminNotificationsButton } from "@/components/common/AdminNotificationsButton";
import { AskOlioContent } from "@ui/components/common/AskOlioDrawer";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { useAdminSearchItems } from "@/lib/useSearchItems";

// Default padding for admin pages. Exported as a className so each page opts in
// by wrapping its content — mirrors the user app's PAGE_CONTAINER_CLASSNAME.
// This is the exact value AdminLayout used to apply by default, so pages look
// identical after the mount-once refactor.
export const PAGE_CONTAINER_CLASSNAME = "p-6 md:p-8 pt-[var(--mobile-header-clearance)] md:pt-8";

type AdminShellContextValue = {
  actionsSlot: HTMLDivElement | null;
};

const AdminShellContext = createContext<AdminShellContextValue | null>(null);

// Portals its children into the desktop header's action area. Renders nothing
// until the layout has mounted its actions slot. Only the currently-rendered
// page produces children, so the active route owns the header actions — the
// per-page equivalent of the old `desktopActions` prop now that AdminLayout is
// mounted once instead of per-page.
export function HeaderActions({ children }: { children: ReactNode }) {
  const ctx = useContext(AdminShellContext);
  if (!ctx?.actionsSlot) return null;
  return createPortal(children, ctx.actionsSlot);
}

// AdminLayout (sidebar + header + bottom nav) is mounted ONCE around the admin
// route switch (see App.tsx → AdminShell), so it stays in place across
// navigation — only the routed page content swaps, the sidebar/header never
// re-mount. Each page renders just its content; pages that want the standard
// page padding wrap it in PAGE_CONTAINER_CLASSNAME, and pages that need header
// actions portal them in via <HeaderActions>.
export function AdminLayout({ children }: { children: ReactNode }) {
  const [isAskOlioOpen, setIsAskOlioOpen] = useState(false);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const searchItems = useAdminSearchItems();

  // Memoized so HeaderActions consumers only re-render when the slot element
  // itself changes (once, on mount), not on every AdminLayout render.
  const ctxValue = useMemo<AdminShellContextValue>(() => ({ actionsSlot }), [actionsSlot]);

  return (
    <AdminShellContext.Provider value={ctxValue}>
      <div className="bg-[#060A0B] bg-[linear-gradient(180deg,#103E42E5_0%,#060A0B00_51%)] flex font-sans h-[100dvh]">
        <SkipToContent />
        <DesktopSidebar role="admin" />
        <MobileHeader />

        <div className="flex-1 overflow-y-auto overflow-x-hidden h-[100dvh] w-full relative max-w-[100vw] flex flex-col">
          <DesktopHeader
            role="admin"
            actions={<div ref={setActionsSlot} className="flex items-center gap-2" />}
            menuItems={getHeaderTitleItems("admin")}
            signOutRedirect="/login"
            calculatorHref="/admin/calculator"
            searchItems={searchItems}
            headerExtras={<AdminNotificationsButton />}
          />

          <ResponsiveDrawer open={isAskOlioOpen} onOpenChange={setIsAskOlioOpen} title="Ask Olio">
            <AskOlioContent />
          </ResponsiveDrawer>

          <MainRegion className="flex-1 pb-[var(--mobile-nav-clearance)] md:pb-0">
            {children}
          </MainRegion>
        </div>

        <BottomNav
          items={getBottomNavItems("admin")}
          onAskOlioClick={() => setIsAskOlioOpen(true)}
        />
      </div>
    </AdminShellContext.Provider>
  );
}
