import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Building2,
  User as UserIcon,
  FileText,
  Briefcase,
  KeyRound,
  ShieldCheck,
  Crown,
  Scale,
} from "lucide-react";
import type { SearchItem } from "@ui/components/common/CommandPalette";
import { adminMenuItems } from "@/lib/menuItems";
import { usePrivileges } from "@ui/lib/usePrivileges";
import type {
  AdminAgreementRow,
  AdminPortfolioRow,
  AdminUnitRow,
  AdminUserRow,
} from "@/lib/adminQueries";

// Passive cache reads — does NOT trigger fetches. The admin dashboard and
// individual pages populate these keys; the palette just surfaces whatever's
// already loaded so it never inflates the platform's API traffic.
function useCachedQuery<T>(queryKey: readonly string[]) {
  return useQuery<T>({ queryKey: [...queryKey], enabled: false });
}

export function useAdminSearchItems(): SearchItem[] {
  const users = useCachedQuery<AdminUserRow[]>(["/api/admin/users"]);
  const units = useCachedQuery<AdminUnitRow[]>(["/api/admin/units"]);
  const portfolios = useCachedQuery<AdminPortfolioRow[]>(["/api/admin/portfolios"]);
  const agreements = useCachedQuery<AdminAgreementRow[]>(["/api/admin/agreements"]);
  const { canPlatform } = usePrivileges();
  const showRolesAndPlans = canPlatform("platform.viewSettings");
  const showCompliance = canPlatform("legal.compliance");
  const [, setLocation] = useLocation();

  return useMemo(() => {
    const items: SearchItem[] = [];

    for (const m of adminMenuItems) {
      items.push({
        id: `nav:${m.path}`,
        label: m.label,
        group: "Pages",
        href: m.path,
        icon: m.icon,
      });
    }

    // Surface settings sub-tabs (Portfolio Roles / Platform Roles / Owner
    // Plans / Compliance) in Cmd-K so users can still jump straight to them
    // even though they no longer have their own sidebar entries.
    const settingsTabs: {
      label: string;
      tab: string;
      icon: SearchItem["icon"];
      visible: boolean;
    }[] = [
      {
        label: "Portfolio Roles",
        tab: "Portfolio Roles",
        icon: KeyRound,
        visible: showRolesAndPlans,
      },
      {
        label: "Platform Roles",
        tab: "Platform Roles",
        icon: ShieldCheck,
        visible: showRolesAndPlans,
      },
      { label: "Owner Plans", tab: "Owner Plans", icon: Crown, visible: showRolesAndPlans },
      { label: "Compliance", tab: "Compliance", icon: Scale, visible: showCompliance },
    ];
    for (const s of settingsTabs) {
      if (!s.visible) continue;
      items.push({
        id: `nav:/admin/settings?tab=${s.tab}`,
        label: s.label,
        sublabel: "Settings",
        group: "Pages",
        icon: s.icon,
        // Use onSelect (not href) so we can also dispatch `settings-tab` —
        // AdminSettingsPage only reads `?tab=` once on mount, so a same-page
        // navigation needs the event to switch tabs.
        onSelect: () => {
          setLocation(`/admin/settings?tab=${s.tab}`);
          window.dispatchEvent(new CustomEvent("settings-tab", { detail: s.tab }));
        },
      });
    }

    for (const u of users.data ?? []) {
      items.push({
        id: `user:${u.id}`,
        label: u.name || u.email,
        sublabel: `${u.email} · ${u.roles.join(", ")}`,
        group: "Users",
        href: `/admin/users/${u.id}`,
        icon: UserIcon,
        keywords: [u.email, u.phone, ...u.roles].filter((x): x is string => !!x),
      });
    }

    for (const unit of units.data ?? []) {
      items.push({
        id: `unit:${unit.id}`,
        label: unit.address,
        sublabel: `${unit.ownerName} · ${unit.tenantName}`,
        group: "Units",
        href: `/admin/units/${unit.id}`,
        icon: Building2,
        keywords: [unit.city, unit.country, unit.ownerName, unit.tenantName].filter(
          (x): x is string => !!x,
        ),
      });
    }

    for (const p of portfolios.data ?? []) {
      items.push({
        id: `portfolio:${p.id}`,
        label: p.portfolioName || p.ownerName,
        sublabel: `${p.ownerEmail} · ${p.unitsCount} unit${p.unitsCount === 1 ? "" : "s"}`,
        group: "Portfolios",
        href: `/admin/portfolios/${p.ownerId}`,
        icon: Briefcase,
        keywords: [p.ownerEmail, p.ownerName].filter((x): x is string => !!x),
      });
    }

    for (const a of agreements.data ?? []) {
      items.push({
        id: `agreement:${a.id}`,
        label: `${a.tenantName} · ${a.propertyAddress}`,
        sublabel: `${a.ownerName} · ${a.status}`,
        group: "Agreements",
        href: `/admin/agreements/${a.id}`,
        icon: FileText,
        keywords: [a.tenantEmail, a.propertyAddress, a.ownerName, a.status].filter(
          (x): x is string => !!x,
        ),
      });
    }

    return items;
  }, [
    users.data,
    units.data,
    portfolios.data,
    agreements.data,
    showRolesAndPlans,
    showCompliance,
    setLocation,
  ]);
}
