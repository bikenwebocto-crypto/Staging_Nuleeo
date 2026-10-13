// Single writer for a rent change across the three docs that can each hold a
// rent figure: the Agreement (monthlyRent + agreementValue), the tenancy
// (Tenant.rentAmount) and — when one exists — the Unit (Unit.rentAmount).
//
// Why this exists: the amount a tenant is actually CHARGED at checkout is
// `unit?.rentAmount ?? tenant.rentAmount` (server/routes/tenant.ts), NOT
// Agreement.monthlyRent. Historically the owner agreement-edit wrote
// Agreement + Tenant (never Unit) while the admin unit-edit wrote only Unit,
// so the three values drifted. Every code path that changes rent — the owner
// edit, the admin unit edit, and the rent-indexation sweep — routes through
// here so they can never disagree.

import { db } from "../firebase";
import { COL, type Agreement } from "../../shared/firestore-schema";

export interface RentChangePatches {
  previousRent: number;
  newRent: number;
  // Lease-term TOTAL contract value. For a pure mid-lease rate change (term
  // unchanged) this is BLENDED — the elapsed months keep the old rate and only
  // the remaining months move to the new one — so it reflects the money actually
  // changing hands rather than overstating it as newRent × full term. NOT a
  // per-period charge.
  agreementValue: number;
  months: number;
  agreementPatch: Partial<Agreement>;
  tenantPatch: { rentAmount: number };
}

// Whole billing months remaining from `asOf` through the lease endDate, clamped
// to [0, term]. Counts CALENDAR months (the same unit endDate is derived in,
// advanceMonths(startDate, term)). Returns null when it can't be determined (no
// endDate / unparseable), so the caller falls back to a full-term recompute.
function remainingWholeMonths(
  agreement: Pick<Agreement, "endDate">,
  asOf: string,
  term: number,
): number | null {
  const end = (agreement.endDate ?? "").slice(0, 10);
  const from = asOf.slice(0, 10);
  if (!end || !from) return null;
  const e = new Date(`${end}T00:00:00Z`);
  const f = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(e.getTime()) || Number.isNaN(f.getTime())) return null;
  let months = (e.getUTCFullYear() - f.getUTCFullYear()) * 12 + (e.getUTCMonth() - f.getUTCMonth());
  // The final month isn't complete if the end day-of-month precedes asOf's.
  if (e.getUTCDate() < f.getUTCDate()) months -= 1;
  return Math.max(0, Math.min(term, months));
}

// Pure: derive the field patches for a rent change.
//   `monthsOverride` — a caller that changed the lease dates passes the new
//      date-derived term; otherwise the stored rentalDurationMonths is used.
//   `blendAsOf` (YYYY-MM-DD/ISO) — enables the BLENDED contract value for a pure
//      rate change on an UNCHANGED term (indexation, or an edit that left the
//      dates alone): value = prior agreementValue + (newRent − oldRent) ×
//      remaining months. Omitted → the legacy newRent × term recompute, which is
//      also used whenever the term changed or the dates/prior value are missing.
export function computeRentChange(
  agreement: Pick<Agreement, "monthlyRent" | "rentalDurationMonths" | "agreementValue" | "endDate">,
  newRent: number,
  monthsOverride?: number,
  blendAsOf?: string,
): RentChangePatches {
  const previousRent = agreement.monthlyRent ?? 0;
  const months = Math.max(1, Math.floor(monthsOverride ?? agreement.rentalDurationMonths ?? 12));

  // Blend only for a PURE rate change — signalled by NO monthsOverride
  // (indexation sweep, admin-unit rent edit). When a caller passes
  // monthsOverride it is redefining the lease term/dates (owner edit), so the
  // contract value is recomputed fresh at newRent × the new term. Blend also
  // needs the remaining months + a prior value, else it recomputes fresh.
  const remaining =
    blendAsOf && monthsOverride === undefined
      ? remainingWholeMonths(agreement, blendAsOf, months)
      : null;
  const agreementValue =
    remaining !== null && typeof agreement.agreementValue === "number"
      ? Math.round(agreement.agreementValue + (newRent - previousRent) * remaining)
      : Math.round(newRent * months);

  return {
    previousRent,
    newRent,
    agreementValue,
    months,
    agreementPatch: { monthlyRent: newRent, agreementValue },
    tenantPatch: { rentAmount: newRent },
  };
}

export interface ApplyRentChangeResult extends RentChangePatches {
  agreementId: string;
  // The full agreement patch actually written (computed fields + any caller
  // extras), so the HTTP caller can echo the updated doc back.
  mergedAgreementPatch: Partial<Agreement>;
  syncedTenant: boolean;
  syncedUnit: boolean;
}

export interface ApplyRentChangeOptions {
  // Term to use for the agreementValue recompute (e.g. date-derived months
  // from the owner edit). Defaults to the agreement's rentalDurationMonths.
  monthsOverride?: number;
  // Extra non-rent agreement fields to write in the same batch (e.g. updated
  // startDate/endDate/deposit/rentalDurationMonths from the owner edit).
  extraAgreementPatch?: Partial<Agreement>;
}

// Loads the agreement and writes the rent across Agreement + Tenant + Unit in
// one atomic batch. The Unit doc only exists for platform/admin units
// (owner-created properties use unitId === propertyId with no Unit row); when
// it does exist, writing Unit.rentAmount is what actually changes the charged
// amount, because the charge path reads it first.
export async function applyRentChange(
  agreementId: string,
  newRent: number,
  opts: ApplyRentChangeOptions = {},
): Promise<ApplyRentChangeResult> {
  const ref = db().collection(COL.agreements).doc(agreementId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error(`Agreement ${agreementId} not found`);
  }
  const agreement = snap.data() as Agreement;

  // Pass today so an edit that leaves the term unchanged blends the rate delta
  // over the remaining months instead of overstating the contract value.
  const patches = computeRentChange(
    agreement,
    newRent,
    opts.monthsOverride,
    new Date().toISOString(),
  );
  const mergedAgreementPatch: Partial<Agreement> = {
    ...patches.agreementPatch,
    ...(opts.extraAgreementPatch ?? {}),
  };

  // Resolve the Unit doc (if any) before opening the batch — batches can't read.
  let syncedUnit = false;
  let unitRef: FirebaseFirestore.DocumentReference | null = null;
  if (agreement.unitId) {
    const candidate = db().collection(COL.units).doc(agreement.unitId);
    if ((await candidate.get()).exists) {
      unitRef = candidate;
      syncedUnit = true;
    }
  }

  const batch = db().batch();
  batch.set(ref, mergedAgreementPatch, { merge: true });
  const syncedTenant = Boolean(agreement.tenantId);
  if (agreement.tenantId) {
    batch.set(db().collection(COL.tenants).doc(agreement.tenantId), patches.tenantPatch, {
      merge: true,
    });
  }
  if (unitRef) {
    batch.set(unitRef, { rentAmount: newRent }, { merge: true });
  }
  await batch.commit();

  return {
    ...patches,
    agreementId,
    mergedAgreementPatch,
    syncedTenant,
    syncedUnit,
  };
}

// Convenience for callers that start from a unit (admin unit edit): find the
// active agreement on a unit so its rent can be synced. Returns null when the
// unit is vacant (no active tenancy/agreement) — caller writes the unit alone.
export async function findActiveAgreementIdForUnit(unitId: string): Promise<string | null> {
  const snap = await db()
    .collection(COL.agreements)
    .where("unitId", "==", unitId)
    .where("status", "==", "active")
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}
