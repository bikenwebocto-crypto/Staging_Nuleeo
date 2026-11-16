// Pure derivations for the Tenants & leases page: per-row lease state, the
// property label shown in the table, and the "Filter by property" grouping.
import type { OwnerProperty, OwnerTenant } from "@/lib/ownerQueries";

export const EXPIRING_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

export type LeaseState = "overdue" | "expiring" | "paid" | "pending" | "awaiting" | "ended";

// Tenancies that belong on the roster (ended/declined ones live in Agreements).
export function isOnRoster(t: OwnerTenant): boolean {
  return t.status === "active" || t.status === "pending" || t.status === "invited";
}

export function daysUntil(iso: string | null | undefined, today: Date): number | null {
  if (!iso) return null;
  const d = Date.parse(iso.slice(0, 10));
  if (Number.isNaN(d)) return null;
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((d - t) / DAY_MS);
}

// Precedence: overdue beats expiring beats paid — the owner should act on the
// most urgent thing first.
export function leaseState(t: OwnerTenant, today: Date): LeaseState {
  if (t.status === "expired" || t.status === "declined") return "ended";
  if (t.status !== "active") return "awaiting";
  if (t.paymentStatus === "overdue") return "overdue";
  const left = daysUntil(t.leaseEnd, today);
  if (left !== null && left <= EXPIRING_WINDOW_DAYS) return "expiring";
  if (t.paymentStatus === "paid") return "paid";
  return "pending";
}

// "Limassol Heights · A3" for a unit, else the property's own name/address.
export function propertyLabel(t: OwnerTenant, byId: Map<string, OwnerProperty>): string {
  const p = byId.get(t.propertyId);
  const parent = t.parentPropertyId ? byId.get(t.parentPropertyId) : undefined;
  if (parent) {
    const unit = p?.unitLabel || p?.name || t.unitLabel || "Unit";
    return `${parent.name || parent.address} · ${unit}`;
  }
  return t.propertyName || p?.name || t.propertyAddress || "—";
}

export function relativeLogin(iso: string | null | undefined, today: Date): string {
  const days = iso ? -(daysUntil(iso, today) ?? 0) : null;
  if (days === null) return "never";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 31) return `${Math.floor(days / 7)} weeks ago`;
  return "over a month ago";
}

// ── Filter by property ─────────────────────────────────────────────────

export type PropertyFilter =
  | { kind: "all" }
  | { kind: "project"; id: string; label: string }
  | { kind: "type"; type: TypeGroup; label: string }
  | { kind: "property"; id: string; label: string };

export type TypeGroup = "building" | "apartment" | "house" | "commercial" | "other";
export const TYPE_GROUPS: { id: TypeGroup; label: string }[] = [
  { id: "building", label: "All buildings" },
  { id: "apartment", label: "All apartments" },
  { id: "house", label: "All houses" },
  { id: "commercial", label: "All commercial" },
  { id: "other", label: "Other" },
];

export function typeGroupOf(p: OwnerProperty): TypeGroup {
  switch (p.propertyType) {
    case "Building":
      return "building";
    case "Apartment":
      return "apartment";
    case "House":
    case "Villa":
      return "house";
    case "Commercial":
      return "commercial";
    default:
      return "other";
  }
}

// The top-level asset a tenancy rolls up to (the building for a unit).
export function rootPropertyId(t: OwnerTenant): string {
  return t.parentPropertyId || t.propertyId;
}

export function matchesFilter(
  t: OwnerTenant,
  f: PropertyFilter,
  byId: Map<string, OwnerProperty>,
): boolean {
  if (f.kind === "all") return true;
  const root = byId.get(rootPropertyId(t));
  if (f.kind === "property") return rootPropertyId(t) === f.id || t.propertyId === f.id;
  if (!root) return false;
  if (f.kind === "project") return root.projectId === f.id;
  return typeGroupOf(root) === f.type;
}

export function ownerKey(t: OwnerTenant): string {
  return t.ownershipType === "company" && t.companyName ? `co:${t.companyName}` : "personal";
}
