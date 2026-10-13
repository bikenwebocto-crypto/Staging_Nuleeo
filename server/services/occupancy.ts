// Single source of truth for "is this property occupied?".
//
// Why this exists: owner-created properties have NO `Unit` doc at all, and NO
// code path ever writes `Unit.currentTenantId` (grep confirms — it has no
// production writer). So any occupancy/rent figure derived from Unit docs reads
// 0/vacant the moment an owner adds a tenant. The canonical signal is an ACTIVE
// tenancy (a `tenants` row with status === "active"), matching the occupancy
// math in /api/owner/summary (server/routes/portfolio.ts). A "pending" invite
// generates no revenue and does NOT count as occupied.
//
// Use `propertyHasActiveTenancy` for single-property guards (delete/transfer)
// and `occupiedPropertyIds` to build a batch set from an already-loaded
// tenancies array (admin dashboards, plan-reconcile, audiences).

import { db } from "../firebase";
import { COL, type Tenant, type TenantStatus } from "../../shared/firestore-schema";

// Statuses that mean a tenancy currently occupies its property. Active only —
// pending/invited/declined/expired do not. Kept here so every caller agrees.
export const OCCUPYING_STATUSES: ReadonlySet<TenantStatus> = new Set<TenantStatus>(["active"]);

// True iff the property has at least one ACTIVE tenancy. The correct
// replacement for `units.some(u => u.currentTenantId)` everywhere.
export async function propertyHasActiveTenancy(propertyId: string): Promise<boolean> {
  const snap = await db()
    .collection(COL.tenants)
    .where("propertyId", "==", propertyId)
    .where("status", "==", "active")
    .limit(1)
    .get();
  return !snap.empty;
}

// Build the set of occupied propertyIds from an already-loaded tenancies array
// (avoids N per-property queries in batch contexts). Counts a property as
// occupied iff it has ≥1 active tenancy.
export function occupiedPropertyIds(
  tenancies: ReadonlyArray<Pick<Tenant, "propertyId" | "status">>,
): Set<string> {
  const out = new Set<string>();
  for (const t of tenancies) {
    if (t.propertyId && OCCUPYING_STATUSES.has(t.status)) out.add(t.propertyId);
  }
  return out;
}
