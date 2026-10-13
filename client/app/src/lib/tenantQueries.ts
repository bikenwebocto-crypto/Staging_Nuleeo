import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@ui/lib/useAuth";
import { apiRequest } from "@ui/lib/queryClient";
import type {
  AgreementIndexation,
  AgreementStatus,
  AutoRenewalMode,
  EnergyClass,
  LeaseType,
  OwnershipType,
  PaymentFrequency,
  PropertyType,
  TitleDeedsStatus,
  Transaction,
} from "@shared/firestore-schema";

export interface TenantRentedUnit {
  tenantId: string;
  unitId: string;
  propertyId: string;
  name: string;
  unitLabel: string;
  rentAmount: number;
  nextPaymentDate: string | null;
  paymentStatus: "paid" | "pending" | "overdue";
  image: string | null;
  // Lease billing cadence, so the offline-payment drawer can charge a whole
  // period (quarterly/yearly) like card checkout. null/missing → monthly.
  paymentFrequency?: PaymentFrequency | null;
}

// Months in one billing period. Mirrors server/services/rentCycle.ts
// monthsPerPeriod (which is server-only): quarterly = 3, yearly = 12, else 1
// (monthly / missing / legacy). Keep the two in sync.
export function monthsPerPeriod(frequency?: PaymentFrequency | null): number {
  return frequency === "yearly" ? 12 : frequency === "quarterly" ? 3 : 1;
}

export type TenantActivity = Transaction & { unitName: string };

// The owner's saved bank-transfer (IBAN) details for a rented unit, so the
// offline-payment drawer can show the tenant where to send a bank transfer.
export interface OwnerBankDetails {
  holder: string;
  iban: string;
  swift: string;
}

// Lazily fetch the owner's IBAN for one rented unit. `bankDetails` is null
// when the owner hasn't saved any (the drawer then prompts the tenant to ask
// for it). Pass a null unitId to keep the query idle — only mount/enable this
// when the tenant actually picks "Bank transfer" so an IBAN isn't fetched
// (or cached) for every dashboard visit.
export function useOwnerBankDetails(unitId: string | null) {
  const { firebaseUser } = useAuth();
  return useQuery<{ bankDetails: OwnerBankDetails | null }>({
    queryKey: ["/api/tenant/payment-details", unitId],
    enabled: !!firebaseUser && !!unitId,
  });
}

export function useTenantUnits() {
  const { firebaseUser } = useAuth();
  return useQuery<TenantRentedUnit[]>({
    queryKey: ["/api/tenant/units"],
    enabled: !!firebaseUser,
  });
}

export function useTenantActivity() {
  const { firebaseUser } = useAuth();
  return useQuery<TenantActivity[]>({
    queryKey: ["/api/tenant/activity"],
    enabled: !!firebaseUser,
  });
}

// Unpaid rent left on an ended lease (one row per former tenancy that still
// owes). Surfaced as a "final balance due" prompt; the owner records the
// actual settlement.
export interface TenantOutstanding {
  tenantId: string;
  propertyName: string;
  amount: number;
}

export function useTenantOutstanding() {
  const { firebaseUser } = useAuth();
  return useQuery<TenantOutstanding[]>({
    queryKey: ["/api/tenant/outstanding"],
    enabled: !!firebaseUser,
  });
}

// Tenant-relative display type for a transaction. The ledger stores collected
// rent as the OWNER's income (type:"income", keyed on ownerId); from the
// TENANT's side rent and every other charge is an expense, and maintenance
// items are informational ("In Progress"). A tenant never sees income. Shared
// by the Activity page and the dashboard preview so they can't drift — the
// dashboard previously rendered raw tx.type, so a tenant's rent showed as a
// green "+income".
export function tenantActivityDisplayType(
  tx: Pick<Transaction, "category">,
): "expense" | "neutral" {
  return tx.category === "maintenance" ? "neutral" : "expense";
}

export interface TenantAgreement {
  id: string;
  status: AgreementStatus;
  leaseType: LeaseType;
  address: string;
  landlord: string;
  monthlyRent: number;
  deposit: number;
  startDate: string;
  endDate: string;
  noticePeriodMonths: number | null;
  paymentDayOfMonth: number | null;
  // Owner-entered lease terms surfaced on the agreement view + PDF.
  paymentFrequency: PaymentFrequency | null;
  rentalDurationMonths: number | null;
  rentFreePeriodMonths: number | null;
  prepaidRents: number | null;
  autoRenewal: AutoRenewalMode | null;
  indexation: AgreementIndexation | null;
  termsAndConditions: string | null;
  signedAt: string | null;
  // The owner-uploaded signed/physical lease PDF the tenant can view + download.
  // documentUrl is a fresh, short-lived signed URL (null when none attached);
  // the rest is display metadata.
  documentUrl: string | null;
  documentName: string | null;
  documentSize: number | null;
  documentUploadedAt: string | null;
  agreementValue: number;

  propertyId: string;
  unitId: string;
  image: string | null;
  propertyType: PropertyType | null;
  buildingName: string | null;
  floor: string | null;
  sqm: string | null;
  builtYear: string | null;
  energyClass: EnergyClass | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  parking: number | null;
  elevator: boolean | null;
  heating: boolean | null;
  cooling: boolean | null;
  solarPanels: boolean | null;
  storageUnit: boolean | null;
  ownershipType: OwnershipType | null;
  companyName: string | null;
  titleDeedsStatus: TitleDeedsStatus | null;
}

export function useTenantAgreements() {
  const { firebaseUser } = useAuth();
  return useQuery<TenantAgreement[]>({
    queryKey: ["/api/tenant/agreements"],
    enabled: !!firebaseUser,
    // This feeds the header notification bell, so it can't use the app-wide
    // "fetch once, never refresh" default. Poll while the tab is open and
    // refresh on focus so a lease an owner just sent shows up within ~a
    // minute (and instantly when the tenant returns to the tab) — no reload.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

// Approve or decline a lease the landlord created (status "pending_tenant").
// On success the agreement flips to "active"/"declined" server-side; we
// refetch agreements so the card re-renders without its action buttons.
export function useRespondToAgreement() {
  const qc = useQueryClient();
  return useMutation<
    { id: string; status: AgreementStatus },
    Error,
    { id: string; action: "approve" | "decline" }
  >({
    mutationFn: async ({ id, action }) => {
      const res = await apiRequest("POST", `/api/tenant/agreements/${id}/respond`, { action });
      return (await res.json()) as { id: string; status: AgreementStatus };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/tenant/agreements"] });
      // Approving creates an active tenancy → the dashboard's units list
      // and activity feed should pick it up too.
      qc.invalidateQueries({ queryKey: ["/api/tenant/units"] });
    },
  });
}
