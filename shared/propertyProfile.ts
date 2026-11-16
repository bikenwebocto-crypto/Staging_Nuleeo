// Property profile ("Complete profile" wizard) — shared model + completion
// rules. Imported by the server (authoritative: recalculated on every profile
// PATCH and on GET for legacy rows) and the client (wizard stepper / labels).
//
// Single-source rule: fields that already live top-level on Property (sqm,
// bedrooms, baths, floor, builtYear, energyClass, parking, storageUnit,
// titleDeedsStatus, ownershipType/companyName/entityId, propertyUse) are NOT
// duplicated here — the wizard writes them in place. `profile` only holds the
// new data that has no existing home.

export const PROFILE_SECTIONS = [
  "details",
  "ownership",
  "financing",
  "use",
  "costs",
  "documents",
] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

export const PROFILE_SECTION_LABELS: Record<ProfileSection, string> = {
  details: "Details",
  ownership: "Ownership",
  financing: "Financing",
  use: "Use",
  costs: "Running costs",
  documents: "Documents",
};

export type Furnished = "furnished" | "part" | "unfurnished";
export type RentalUse = "long_term" | "short_term" | "not_rented";
export type RateType = "fixed" | "variable";
export type UtilityPaidBy = "owner" | "tenant";

export const PROFILE_DOC_TYPES = [
  "title_deed",
  "purchase_contract",
  "energy_certificate",
  "insurance_policy",
  "building_permit",
  "floor_plan",
] as const;
export type ProfileDocType = (typeof PROFILE_DOC_TYPES)[number];

export const PROFILE_DOC_LABELS: Record<ProfileDocType, string> = {
  title_deed: "Title deed",
  purchase_contract: "Purchase contract",
  energy_certificate: "Energy certificate",
  insurance_policy: "Insurance policy",
  building_permit: "Building permits",
  floor_plan: "Floor plans",
};

export interface ProfileOwner {
  type: "individual" | "company";
  entityId?: string;
  name: string;
  sharePct: number;
}

export interface ProfileUtility {
  provider: string;
  // Last 4 digits ONLY — the full account number is never stored.
  accountLast4: string;
  paidBy: UtilityPaidBy;
  status: "linked" | "pending";
}

export interface ProfileDocSlot {
  documentId: string;
  name: string;
  uploadedAt: string;
}

export interface PropertyProfile {
  details?: {
    verandaSqm?: number;
    furnished?: Furnished;
    energyExpiry?: string; // YYYY-MM-DD
    titleDeedReference?: string;
  };
  ownership?: { owners: ProfileOwner[] };
  financing?: {
    hasLoan: boolean;
    lender?: string;
    balance?: number;
    ratePct?: number;
    rateType?: RateType;
    monthlyPayment?: number;
    endDate?: string; // YYYY-MM
  };
  use?: RentalUse;
  costs?: {
    propertyTaxYearly?: number;
    municipalYearly?: number;
    commonMonthly?: number;
    insurance?: { provider?: string; premiumYearly?: number; renewalDate?: string };
    utilities?: ProfileUtility[];
  };
  documents?: Partial<Record<ProfileDocType, ProfileDocSlot>>;
}

// The slice of Property the completion rules read. Kept structural so both
// the server Property and the client OwnerProperty satisfy it.
export interface ProfileInput {
  sqm?: string;
  bedrooms?: number;
  builtYear?: string;
  titleDeedsStatus?: string;
  propertyUse?: string;
  profile?: PropertyProfile;
}

const isSet = (v: unknown) => v !== undefined && v !== null && v !== "";

// Legacy propertyUse → wizard use. hold and owner_occupied both mean "no
// tenant", which the wizard calls not_rented.
export function resolveRentalUse(p: ProfileInput): RentalUse | undefined {
  if (p.profile?.use) return p.profile.use;
  if (p.propertyUse === "rent") return "long_term";
  if (p.propertyUse === "hold" || p.propertyUse === "owner_occupied") return "not_rented";
  return undefined;
}

export function ownerShareTotal(owners: ProfileOwner[] | undefined): number {
  return Math.round((owners ?? []).reduce((s, o) => s + (o.sharePct || 0), 0) * 100) / 100;
}

// `hasTenancy` = the property has at least one active/pending agreement; the
// caller supplies it because it lives in another collection.
export function computeProfileSteps(
  p: ProfileInput,
  hasTenancy: boolean,
): Record<ProfileSection, boolean> {
  const f = p.profile?.financing;
  const use = resolveRentalUse(p);
  const docs = p.profile?.documents ?? {};
  return {
    details: isSet(p.sqm) && isSet(p.bedrooms) && isSet(p.builtYear),
    ownership: ownerShareTotal(p.profile?.ownership?.owners) === 100 && isSet(p.titleDeedsStatus),
    // Requires an explicit answer — an untouched step is not "no loan".
    financing:
      !!f &&
      (f.hasLoan === false ||
        (isSet(f.lender) &&
          isSet(f.balance) &&
          isSet(f.ratePct) &&
          isSet(f.rateType) &&
          isSet(f.monthlyPayment) &&
          isSet(f.endDate))),
    use: !!use && (use !== "long_term" || hasTenancy),
    costs:
      isSet(p.profile?.costs?.propertyTaxYearly) && isSet(p.profile?.costs?.insurance?.provider),
    documents: !!docs.title_deed && !!docs.purchase_contract,
  };
}

export function computeProfileCompletion(steps: Record<ProfileSection, boolean>): number {
  const done = PROFILE_SECTIONS.filter((s) => steps[s]).length;
  return Math.round((done / PROFILE_SECTIONS.length) * 100);
}

// Unit labels for Add building: "A1" × 3 → A1, A2, A3; "101" × 2 → 101, 102;
// a label with no trailing number is treated as a prefix ("Unit" → Unit 1…).
// Leading zeros are kept ("A01" → A01…A10). Shared so the client preview and
// the server's bulk create always agree.
export const MAX_BUILDING_UNITS = 100;
export function unitLabels(first: string, count: number): string[] {
  const f = first.trim() || "1";
  const n = Math.max(0, Math.min(MAX_BUILDING_UNITS, Math.floor(count)));
  const m = /^(.*?)(\d+)$/.exec(f);
  if (!m) return Array.from({ length: n }, (_, i) => `${f} ${i + 1}`);
  const [, prefix, digits] = m;
  const start = Number(digits);
  return Array.from(
    { length: n },
    (_, i) => `${prefix}${String(start + i).padStart(digits.length, "0")}`,
  );
}
