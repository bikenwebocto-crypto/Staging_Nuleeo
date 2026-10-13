import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, User as UserIcon, FileText, Home as HomeIcon } from "lucide-react";
import type { SearchItem } from "@ui/components/common/CommandPalette";
import { menuItems, tenantMenuItems } from "@/lib/menuItems";
import type { OwnerAgreement, OwnerProperty, OwnerTenant } from "@/lib/ownerQueries";
import type { TenantAgreement, TenantRentedUnit } from "@/lib/tenantQueries";
import { useActivePortfolio, withOwnerScope } from "@/lib/activePortfolio";

// We deliberately read from the React Query cache with `enabled: false` —
// the palette is a passive consumer and must not trigger new fetches. The
// prefetcher (lib/prefetch.ts) warms these keys for the active role at login,
// and individual pages refresh them. Tenants who never visit owner pages get
// an empty Properties/Tenants section, which is the correct outcome.
function useCachedQuery<T>(queryKey: readonly string[]) {
  return useQuery<T>({ queryKey: [...queryKey], enabled: false });
}

export function useOwnerSearchItems(): SearchItem[] {
  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  const properties = useCachedQuery<OwnerProperty[]>([
    withOwnerScope("/api/owner/properties", activeOwnerId, isSelf, activePortfolioDocId),
  ]);
  const tenants = useCachedQuery<OwnerTenant[]>([
    withOwnerScope("/api/owner/tenants", activeOwnerId, isSelf, activePortfolioDocId),
  ]);
  const agreements = useCachedQuery<OwnerAgreement[]>([
    withOwnerScope("/api/owner/agreements", activeOwnerId, isSelf, activePortfolioDocId),
  ]);

  return useMemo(() => {
    const items: SearchItem[] = [];

    for (const m of menuItems) {
      items.push({
        id: `nav:${m.path}`,
        label: m.label,
        group: "Pages",
        href: m.path,
        icon: m.icon,
      });
    }

    for (const p of properties.data ?? []) {
      items.push({
        id: `property:${p.id}`,
        label: p.address || p.buildingName || "Untitled property",
        sublabel: [p.city, p.country].filter(Boolean).join(", ") || undefined,
        group: "Properties",
        href: `/properties/${p.id}`,
        icon: Building2,
        keywords: [p.city, p.country, p.postalCode, p.buildingName].filter((x): x is string => !!x),
      });
    }

    for (const t of tenants.data ?? []) {
      items.push({
        id: `tenant:${t.id}`,
        label: t.name,
        sublabel: t.email || t.propertyAddress || undefined,
        group: "Tenants",
        href: `/tenants/${t.id}`,
        icon: UserIcon,
        keywords: [t.email, t.phone, t.propertyAddress].filter((x): x is string => !!x),
      });
    }

    for (const a of agreements.data ?? []) {
      items.push({
        id: `agreement:${a.id}`,
        label: `${a.tenantName} · ${a.address}`,
        sublabel: `${a.status} · ${a.leaseType}`,
        group: "Agreements",
        href: `/owner/agreements/${a.id}`,
        icon: FileText,
        keywords: [a.tenantEmail, a.address, a.status].filter((x): x is string => !!x),
      });
    }

    return items;
  }, [properties.data, tenants.data, agreements.data]);
}

export function useTenantSearchItems(): SearchItem[] {
  const units = useCachedQuery<TenantRentedUnit[]>(["/api/tenant/units"]);
  const agreements = useCachedQuery<TenantAgreement[]>(["/api/tenant/agreements"]);

  return useMemo(() => {
    const items: SearchItem[] = [];

    for (const m of tenantMenuItems) {
      items.push({
        id: `nav:${m.path}`,
        label: m.label,
        group: "Pages",
        href: m.path,
        icon: m.icon,
      });
    }

    for (const u of units.data ?? []) {
      items.push({
        id: `unit:${u.unitId}`,
        label: u.name || u.unitLabel || "My unit",
        sublabel: u.unitLabel || undefined,
        group: "My Units",
        href: `/tenant`,
        icon: HomeIcon,
      });
    }

    for (const a of agreements.data ?? []) {
      items.push({
        id: `agreement:${a.id}`,
        label: a.address,
        sublabel: `${a.landlord} · ${a.status}`,
        group: "Agreements",
        href: `/tenant/agreements`,
        icon: FileText,
        keywords: [a.landlord, a.city, a.country].filter((x): x is string => !!x),
      });
    }

    return items;
  }, [units.data, agreements.data]);
}
