import { ReactNode, useState } from "react";
import { BottomNav } from "@ui/components/common/BottomNav";
import { getBottomNavItems, getHeaderTitleItems } from "@/lib/navItems";
import { MobileHeader } from "@/components/common/MobileHeader";
import { DesktopSidebar } from "@/components/common/DesktopSidebar";
import { DesktopHeader } from "@ui/components/common/DesktopHeader";
import { AskOlioContent } from "@ui/components/common/AskOlioDrawer";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { useLocation } from "wouter";
import { useAdminSearchItems } from "@/lib/useSearchItems";

interface UserLayoutProps {
  children: ReactNode;
  showMobileHeader?: boolean;
  isTenantView?: boolean;
  role?: "owner" | "tenant" | "admin";
  desktopActions?: ReactNode;
}

export function UserLayout({
  children,
  showMobileHeader = true,
  isTenantView = false,
  role,
  desktopActions,
}: UserLayoutProps) {
  const [isAskOlioOpen, setIsAskOlioOpen] = useState(false);
  const [location] = useLocation();
  const searchItems = useAdminSearchItems();

  // Derive effective role: explicit role prop takes priority, then isTenantView for backwards compat
  const effectiveRole: "owner" | "tenant" | "admin" = role ?? (isTenantView ? "tenant" : "owner");

  // Floating mobile bottom nav is hidden on /profile and for tenants. When
  // shown, reserve space below the page content so the last content row
  // doesn't slide under the floating pill.
  const showBottomNav = !location.includes("/profile") && effectiveRole !== "tenant";

  return (
    <div className="bg-background flex font-sans overflow-x-hidden h-[100dvh]">
      <DesktopSidebar role={effectiveRole} />
      <div className="flex-1 relative overflow-y-auto overflow-x-hidden h-[100dvh] scroll-smooth overscroll-y-none flex flex-col">
        <DesktopHeader
          role={effectiveRole}
          actions={desktopActions}
          menuItems={getHeaderTitleItems(effectiveRole)}
          signOutRedirect="/login"
          searchItems={searchItems}
        />
        {showMobileHeader && <MobileHeader />}

        <ResponsiveDrawer open={isAskOlioOpen} onOpenChange={setIsAskOlioOpen} title="Ask Olio">
          <AskOlioContent />
        </ResponsiveDrawer>

        <div
          className={
            showBottomNav
              ? "flex-1 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] md:pb-0"
              : "flex-1"
          }
        >
          {children}
        </div>
      </div>

      {showBottomNav && (
        <BottomNav
          items={getBottomNavItems(effectiveRole)}
          onAskOlioClick={() => setIsAskOlioOpen(true)}
        />
      )}
    </div>
  );
}
