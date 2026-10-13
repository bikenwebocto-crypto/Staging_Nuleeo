import type { BottomNavItem } from "@ui/components/common/BottomNav";
import type { HeaderTitleItem } from "@ui/components/common/DesktopHeader";
import { menuItems, tenantMenuItems, adminMenuItems } from "@/lib/menuItems";

// Per-app helper: maps a role to the items shown in the bottom nav. Lives here
// (not in client/shared) because the menu shape itself differs between the
// owner/tenant app and the admin platform — see `menuItems.ts` in each app.
export type BottomNavRole = "owner" | "tenant" | "admin";

// DesktopHeader uses these to derive the page title from the URL. Same source
// as the bottom nav, but unfiltered (the header looks up *any* menu item by path).
export function getHeaderTitleItems(role: BottomNavRole): HeaderTitleItem[] {
  if (role === "admin") return adminMenuItems;
  if (role === "tenant") return tenantMenuItems;
  return menuItems;
}

export function getBottomNavItems(role: BottomNavRole): BottomNavItem[] {
  if (role === "tenant") {
    // The Ask Olio AI assistant is intentionally an OWNER-experience feature and
    // is omitted from the tenant bottom nav. This is keyed on the active
    // experience (role), NOT on plan entitlement — so someone who is both a
    // tenant and a paid owner still sees no Ask Olio while in the tenant
    // experience. Owners reach Ask Olio from the pinned row at the top of the
    // Messages list (and the floating button on desktop); tenants get neither.
    return menuItems
      .filter((item) => ["Home", "Agreements", "Messages", "Activity"].includes(item.label))
      .map((item) => {
        if (item.label === "Home") return { ...item, path: "/tenant" };
        if (item.label === "Agreements") return { ...item, path: "/tenant/agreements" };
        // Messages is owner-pathed in the source list; re-point it at the tenant
        // thread so the bottom-nav entry (and its M-5 unread badge) works for
        // tenants on mobile, who otherwise had no bottom-nav route to Messages.
        if (item.label === "Messages") return { ...item, path: "/tenant/messages" };
        if (item.label === "Activity") return { ...item, path: "/tenant/activity" };
        return item;
      });
  }
  if (role === "admin") {
    return adminMenuItems.filter((item) =>
      ["Dashboard", "Users", "Units", "Transaction History", "Email Marketing"].includes(
        item.label,
      ),
    );
  }
  // owner default. The mobile chat entry point is "Messages" (routes to
  // /owner/messages) rather than the "Ask Olio" sentinel that pops the floating
  // drawer — Ask Olio is pinned at the top of the Messages list, so the owner
  // reaches it from there. (The desktop floating Ask Olio button still exists.)
  return menuItems.filter((item) =>
    ["Home", "Properties", "Agreements", "Messages", "Activity"].includes(item.label),
  );
}
