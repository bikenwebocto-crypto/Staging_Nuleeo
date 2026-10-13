import { queryClient } from "@ui/lib/queryClient";

// Map each in-app route to the API queries that page mounts. Used to:
//   1. Warm the cache as soon as the user is authenticated, so the first
//      navigation never shows a data-loading flash.
//   2. Prefetch on hover over a sidebar link, so even routes we didn't pre-warm
//      have data ready by the time the click registers.
//
// Keys must match the queryKey the page's useQuery actually uses (see
// tenantQueries.ts / ownerQueries.ts). When you add a new page or query,
// add the mapping here too.
const PATH_QUERIES: Record<string, ReadonlyArray<readonly string[]>> = {
  // Tenant pages
  "/tenant": [["/api/tenant/units"], ["/api/tenant/activity"]],
  "/tenant/agreements": [["/api/tenant/agreements"]],
  "/tenant/activity": [["/api/tenant/activity"]],

  // Owner pages
  "/owner": [["/api/owner/properties"], ["/api/owner/transactions"], ["/api/owner/summary"]],
  "/owner/agreements": [["/api/owner/agreements"]],
  "/owner/activity": [["/api/owner/transactions"]],
  "/properties": [["/api/owner/properties"]],
  "/tenants": [["/api/owner/tenants"]],
  // Olio Insights (portfolio analytics), formerly /analytics. Uses the windowed
  // transactions query (date window, not the 25-row activity feed).
  "/insights": [["/api/owner/summary"], ["/api/owner/transactions?sinceDays=370"]],
};

const TENANT_KEYS: ReadonlyArray<readonly string[]> = [
  ["/api/tenant/units"],
  ["/api/tenant/activity"],
  ["/api/tenant/agreements"],
];
const OWNER_KEYS: ReadonlyArray<readonly string[]> = [
  ["/api/owner/properties"],
  ["/api/owner/transactions"],
  ["/api/owner/agreements"],
  ["/api/owner/tenants"],
  ["/api/owner/summary"],
];

function prefetchKeys(keys: ReadonlyArray<readonly string[]>) {
  for (const key of keys) {
    queryClient.prefetchQuery({ queryKey: [...key] }).catch(() => {
      // Swallow — the live useQuery on the page surfaces real errors.
    });
  }
}

// Fire on hover over a nav link. Cheap to call repeatedly: react-query
// dedupes in-flight requests and skips refetching cached queries (staleTime: Infinity).
export function prefetchForPath(path: string): void {
  const keys = PATH_QUERIES[path];
  if (keys) prefetchKeys(keys);
}

// Fire once after auth resolves. Pre-warms every endpoint the user's role uses.
export function prefetchForRole(role: "owner" | "tenant"): void {
  prefetchKeys(role === "owner" ? OWNER_KEYS : TENANT_KEYS);
}
