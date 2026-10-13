import type { BottomNavItem } from "@ui/components/common/BottomNav";
import type { HeaderTitleItem } from "@ui/components/common/DesktopHeader";
import { menuItems, tenantMenuItems, adminMenuItems } from "@/lib/menuItems";

// Per-app helper: maps a role to the items shown in the bottom nav. Mirrors
// client/app/src/lib/navItems.ts but reads the platform's own menu definitions
// — the platform's owner/tenant menus differ slightly from the app's.
export type BottomNavRole = "owner" | "tenant" | "admin";

// DesktopHeader uses these to derive the page title from the URL. Same source
// as the bottom nav, but unfiltered (the header looks up *any* menu item by path).
export function getHeaderTitleItems(role: BottomNavRole): HeaderTitleItem[] {
  if (role === "admin") return adminMenuItems;
  if (role === "tenant") return tenantMenuItems;
  return menuItems;
}

export function getBottomNavItems(role: BottomNavRole): BottomNavItem[] {
  if (role === "tenant") return tenantMenuItems;
  if (role === "admin") {
    return adminMenuItems.filter((item) =>
      ["Dashboard", "Users", "Units", "Transaction History", "Email Marketing"].includes(
        item.label,
      ),
    );
  }
  // owner default
  return menuItems.filter((item) =>
    ["Home", "Properties", "Agreements", "Activity", "Ask Olio"].includes(item.label),
  );
}
