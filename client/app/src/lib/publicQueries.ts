// Public, unauthenticated property read. Backs the shareable
// /properties/:id view: logged-out visitors get this directly, and
// logged-in users who aren't the owner/granted-reader fall back to it
// when the auth-gated owner read returns "no access".
//
// Mirrors the server whitelist in GET /api/public/properties/:id — only
// public-safe descriptors are present (no financials, tenant, ownership,
// compliance, documents, or transactions).

import { useQuery } from "@tanstack/react-query";

export interface PublicProperty {
  id: string;
  name?: string;
  address: string;
  city?: string;
  country?: string;
  postalCode?: string;
  image?: string;
  lat?: number;
  lng?: number;
  propertyType?: string;
  buildingName?: string;
  floor?: string;
  sqm?: string;
  bedrooms?: number;
  baths?: number;
  builtYear?: string;
  energyClass?: string;
  developmentStatus?: string;
  propertyUse?: string;
  parking?: number;
  elevator?: boolean;
  heating?: boolean;
  cooling?: boolean;
  solarPanels?: boolean;
  storageUnit?: boolean;
}

// `enabled` lets a caller defer the fetch — PropertyDetailsPage only
// reaches for the public view after its owner read has resolved with no
// access, so the owner themselves never triggers a second request.
export function usePublicProperty(id: string | undefined, enabled = true) {
  return useQuery<PublicProperty>({
    queryKey: [`/api/public/properties/${id}`],
    enabled: !!id && enabled,
  });
}
