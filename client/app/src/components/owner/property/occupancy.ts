import type { AgreementStatus } from "@shared/firestore-schema";

// Minimal agreement shape the history needs — a subset of OwnerAgreement so
// this stays a pure, easily-tested function.
export interface OccupancyAgreement {
  id: string;
  propertyId: string;
  tenantId: string;
  tenantName: string;
  status: AgreementStatus;
  monthlyRent: number;
  startDate: string;
  endDate: string;
  terminatedAt?: string | null;
  expiredAt?: string | null;
}

export interface OccupancyRecord {
  agreementId: string;
  tenantName: string;
  status: AgreementStatus;
  startDate: string;
  // null = still occupying ("Present").
  endDate: string | null;
  monthlyRent: number;
  isCurrent: boolean;
}

// Statuses that represent a real (or imminent) occupancy. "declined" leases
// never started, and "draft"/"suspended" are already filtered by the API.
const OCCUPANCY_STATUSES: ReadonlySet<AgreementStatus> = new Set([
  "active",
  "pending_tenant",
  "expired",
  "terminated",
]);

function endOf(a: OccupancyAgreement): string | null {
  if (a.status === "active" || a.status === "pending_tenant") return null;
  // Terminated leases end early — the stamped close date beats the planned end.
  if (a.status === "terminated") return a.terminatedAt || a.endDate || null;
  if (a.status === "expired") return a.expiredAt || a.endDate || null;
  return a.endDate || null;
}

function time(iso: string | undefined | null): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * Occupancy history for one property, built from its retained agreement
 * records (each lease is its own document, so past tenancies are never
 * overwritten). Newest start date first.
 */
export function buildOccupancyHistory(
  agreements: OccupancyAgreement[],
  propertyId: string | undefined,
): OccupancyRecord[] {
  if (!propertyId) return [];
  return agreements
    .filter((a) => a.propertyId === propertyId && OCCUPANCY_STATUSES.has(a.status))
    .map((a) => ({
      agreementId: a.id,
      tenantName: a.tenantName,
      status: a.status,
      startDate: a.startDate,
      endDate: endOf(a),
      monthlyRent: a.monthlyRent,
      isCurrent: a.status === "active",
    }))
    .sort((x, y) => time(y.startDate) - time(x.startDate));
}

export const OCCUPANCY_STATUS_LABEL: Record<AgreementStatus, string> = {
  active: "Current",
  pending_tenant: "Pending",
  expired: "Completed",
  terminated: "Terminated",
  declined: "Declined",
  draft: "Draft",
  suspended: "Suspended",
};
