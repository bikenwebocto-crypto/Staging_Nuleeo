// Business Portfolio + Add Business wizard: shared contract and pure logic.
//
// A "business" IS an Entity (COL.entities) with entityType "COMPANY" — there
// is no separate business collection. The wizard fields below are optional
// extensions of Entity, so migrated / older entities stay valid.
//
// Used by server/routes/entities.ts, the client wizard and portfolio page, and
// their tests. No I/O.

import type { Entity, EntityStatus } from "./firestore-schema";

// ── Enumerations ────────────────────────────────────────────────────────
export type BusinessType = "LIMITED_COMPANY" | "SELF_EMPLOYED" | "PARTNERSHIP";
export const BUSINESS_TYPES: readonly BusinessType[] = [
  "LIMITED_COMPANY",
  "SELF_EMPLOYED",
  "PARTNERSHIP",
];
export const BUSINESS_TYPE_LABEL: Record<BusinessType, string> = {
  LIMITED_COMPANY: "Limited company",
  SELF_EMPLOYED: "Self-employed",
  PARTNERSHIP: "Partnership",
};

export const BUSINESS_SECTORS = [
  "Advisory",
  "Design",
  "Trading",
  "Logistics",
  "Hospitality",
  "Healthcare",
  "Other",
] as const;
export type BusinessSector = (typeof BUSINESS_SECTORS)[number];

export type VatFilingPeriod = "MONTHLY" | "QUARTERLY" | "ANNUAL";
export const VAT_FILING_PERIODS: readonly VatFilingPeriod[] = ["MONTHLY", "QUARTERLY", "ANNUAL"];
export const VAT_FILING_PERIOD_LABEL: Record<VatFilingPeriod, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUAL: "Annual",
};

export type BusinessRole = "DIRECTOR" | "SHAREHOLDER" | "BOTH";
export const BUSINESS_ROLES: readonly BusinessRole[] = ["DIRECTOR", "SHAREHOLDER", "BOTH"];
export const BUSINESS_ROLE_LABEL: Record<BusinessRole, string> = {
  DIRECTOR: "Director",
  SHAREHOLDER: "Shareholder",
  BOTH: "Director & shareholder",
};

// Banking is provider-independent: we store the PREFERENCE and a status. No
// provider integration exists yet, so status is always NOT_STARTED — nothing
// is ever reported as applied/connected until a provider confirms it.
export type BankingPreference = "PAYABL_ACCOUNT" | "OPEN_BANKING" | "BOTH" | "NONE";
export const BANKING_PREFERENCES: readonly BankingPreference[] = [
  "PAYABL_ACCOUNT",
  "OPEN_BANKING",
  "BOTH",
  "NONE",
];
export const BANKING_PREFERENCE_LABEL: Record<BankingPreference, string> = {
  PAYABL_ACCOUNT: "Open a business account with payabl",
  OPEN_BANKING: "Connect an existing bank",
  BOTH: "Both",
  NONE: "Decide later",
};
export type BankingStatus = "NOT_STARTED" | "PENDING_PROVIDER" | "ACTIVE";
export const BANKING_STATUS_LABEL: Record<BankingStatus, string> = {
  NOT_STARTED: "Not started — available once banking is switched on",
  PENDING_PROVIDER: "Application with provider",
  ACTIVE: "Active",
};

// ISO-3166 alpha-2 codes offered in the wizard (validated server-side by shape).
export const BUSINESS_COUNTRIES: { code: string; name: string }[] = [
  { code: "CY", name: "Cyprus" },
  { code: "GR", name: "Greece" },
  { code: "GB", name: "United Kingdom" },
  { code: "IE", name: "Ireland" },
  { code: "MT", name: "Malta" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "PT", name: "Portugal" },
  { code: "NL", name: "Netherlands" },
  { code: "BE", name: "Belgium" },
  { code: "LU", name: "Luxembourg" },
  { code: "AT", name: "Austria" },
  { code: "BG", name: "Bulgaria" },
  { code: "RO", name: "Romania" },
  { code: "PL", name: "Poland" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "US", name: "United States" },
];

export const BUSINESS_FIELD_MAX = {
  legalName: 120,
  tradingName: 80,
  registrationNumber: 40,
  vatNumber: 20,
  accountantEmail: 254,
} as const;

// ── Wizard data ─────────────────────────────────────────────────────────
// Every field optional: this is also the DRAFT shape.
export interface BusinessWizardData {
  businessType?: BusinessType;
  legalName?: string;
  tradingName?: string;
  country?: string;
  registrationNumber?: string;
  sector?: BusinessSector;
  vatRegistered?: boolean;
  vatNumber?: string;
  vatFilingPeriod?: VatFilingPeriod;
  financialYearEnd?: string; // "MM-DD"
  role?: BusinessRole;
  sharePercent?: number;
  bankingPreference?: BankingPreference;
  accountantEmail?: string;
}

export const WIZARD_STEPS = [
  { id: 1, title: "Type & name" },
  { id: 2, title: "Activity & tax" },
  { id: 3, title: "Role & share" },
  { id: 4, title: "Money & accountant" },
] as const;
export type WizardStep = 1 | 2 | 3 | 4;

export interface BusinessDraft {
  step: WizardStep;
  data: BusinessWizardData;
  updatedAt: string;
}

export type FieldErrors = Partial<Record<keyof BusinessWizardData, string>>;

const isIn = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

// "MM-DD" with a day that exists in that month (Feb allows 29).
export function isValidYearEnd(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{2}-\d{2}$/.test(v)) return false;
  const [m, d] = v.split("-").map(Number);
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return days !== undefined && d >= 1 && d <= days;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Validates ONE step against the full data (so conditional rules can look at
// earlier answers). Returns field errors; empty object = step is valid.
export function validateWizardStep(step: WizardStep, d: BusinessWizardData): FieldErrors {
  const e: FieldErrors = {};
  const len = (k: keyof typeof BUSINESS_FIELD_MAX) => {
    const v = d[k];
    if (typeof v === "string" && v.length > BUSINESS_FIELD_MAX[k]) {
      e[k] = `Use ${BUSINESS_FIELD_MAX[k]} characters or fewer`;
    }
  };
  if (step === 1) {
    if (!isIn(BUSINESS_TYPES, d.businessType)) e.businessType = "Choose a business type";
    if (!d.legalName?.trim()) e.legalName = "Enter the legal name";
    if (!d.country || !BUSINESS_COUNTRIES.some((c) => c.code === d.country)) {
      e.country = "Choose a country";
    }
    if (d.businessType !== "SELF_EMPLOYED" && !d.registrationNumber?.trim()) {
      e.registrationNumber = "Enter the registration number";
    }
    len("legalName");
    len("tradingName");
    len("registrationNumber");
  }
  if (step === 2) {
    if (!isIn(BUSINESS_SECTORS, d.sector)) e.sector = "Choose a sector";
    if (typeof d.vatRegistered !== "boolean") e.vatRegistered = "Tell us if you're VAT registered";
    if (d.vatRegistered) {
      if (!d.vatNumber?.trim()) e.vatNumber = "Enter the VAT number";
      if (!isIn(VAT_FILING_PERIODS, d.vatFilingPeriod))
        e.vatFilingPeriod = "Choose a filing period";
      len("vatNumber");
    }
    if (!isValidYearEnd(d.financialYearEnd)) e.financialYearEnd = "Choose the financial year end";
  }
  if (step === 3) {
    if (!isIn(BUSINESS_ROLES, d.role)) e.role = "Choose your role";
    const s = d.sharePercent;
    const needsShare = d.role === "SHAREHOLDER" || d.role === "BOTH";
    if (needsShare && (typeof s !== "number" || !Number.isFinite(s) || s <= 0 || s > 100)) {
      e.sharePercent = "Enter a share between 0.01 and 100";
    } else if (
      typeof s === "number" &&
      (!Number.isFinite(s) || s < 0 || s > 100 || Math.abs(Math.round(s * 100) - s * 100) > 1e-6)
    ) {
      e.sharePercent = "Use a share between 0 and 100 (2 decimals max)";
    }
  }
  if (step === 4) {
    if (!isIn(BANKING_PREFERENCES, d.bankingPreference)) e.bankingPreference = "Choose an option";
    if (d.accountantEmail && !EMAIL_RE.test(d.accountantEmail.trim())) {
      e.accountantEmail = "Enter a valid email";
    }
    len("accountantEmail");
  }
  return e;
}

export function firstInvalidStep(d: BusinessWizardData): WizardStep | null {
  for (const s of [1, 2, 3, 4] as WizardStep[]) {
    if (Object.keys(validateWizardStep(s, d)).length) return s;
  }
  return null;
}

// Coerces untrusted JSON into wizard data, keeping only known, well-typed
// fields (used for drafts, which may be incomplete). `clean` = sanitizer.
export function sanitizeWizardData(
  raw: unknown,
  clean: (s: string, max: number) => string = (s) => s,
): BusinessWizardData {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: BusinessWizardData = {};
  const str = (k: keyof typeof BUSINESS_FIELD_MAX) => {
    if (typeof r[k] === "string") {
      const v = clean(r[k] as string, BUSINESS_FIELD_MAX[k] + 1).trim();
      if (v) out[k] = v;
    }
  };
  if (isIn(BUSINESS_TYPES, r.businessType)) out.businessType = r.businessType;
  str("legalName");
  str("tradingName");
  if (typeof r.country === "string" && /^[A-Z]{2}$/.test(r.country)) out.country = r.country;
  str("registrationNumber");
  if (isIn(BUSINESS_SECTORS, r.sector)) out.sector = r.sector;
  if (typeof r.vatRegistered === "boolean") out.vatRegistered = r.vatRegistered;
  str("vatNumber");
  if (isIn(VAT_FILING_PERIODS, r.vatFilingPeriod)) out.vatFilingPeriod = r.vatFilingPeriod;
  if (isValidYearEnd(r.financialYearEnd)) out.financialYearEnd = r.financialYearEnd;
  if (isIn(BUSINESS_ROLES, r.role)) out.role = r.role;
  if (typeof r.sharePercent === "number" && Number.isFinite(r.sharePercent)) {
    out.sharePercent = r.sharePercent;
  }
  if (isIn(BANKING_PREFERENCES, r.bankingPreference)) out.bankingPreference = r.bankingPreference;
  str("accountantEmail");
  return out;
}

// Full-submission check → the Entity fields to persist. Conditional fields
// that don't apply (VAT details when not registered, registration number for
// self-employed is optional) are dropped / kept accordingly.
export function buildBusinessEntityFields(
  d: BusinessWizardData,
):
  | { ok: true; fields: Omit<Entity, "id" | "ownerId" | "createdBy" | "source" | "createdAt"> }
  | { ok: false; step: WizardStep; errors: FieldErrors } {
  for (const s of [1, 2, 3, 4] as WizardStep[]) {
    const errors = validateWizardStep(s, d);
    if (Object.keys(errors).length) return { ok: false, step: s, errors };
  }
  const legalName = d.legalName!.trim();
  const tradingName = d.tradingName?.trim() || undefined;
  return {
    ok: true,
    fields: {
      entityType: "COMPANY",
      name: tradingName ?? legalName,
      legalName,
      ...(tradingName ? { tradingName } : {}),
      businessType: d.businessType!,
      country: d.country!,
      ...(d.registrationNumber?.trim() ? { registrationNumber: d.registrationNumber.trim() } : {}),
      sector: d.sector!,
      vatRegistered: d.vatRegistered!,
      ...(d.vatRegistered
        ? { vatNumber: d.vatNumber!.trim(), vatFilingPeriod: d.vatFilingPeriod! }
        : {}),
      financialYearEnd: d.financialYearEnd!,
      creatorRole: d.role!,
      ...(typeof d.sharePercent === "number" ? { creatorSharePercent: d.sharePercent } : {}),
      bankingPreference: d.bankingPreference!,
      bankingStatus: "NOT_STARTED",
      ...(d.accountantEmail?.trim()
        ? { accountantEmail: d.accountantEmail.trim().toLowerCase() }
        : {}),
      // Always starts SETTING_UP; activation needs conditions (e.g. a live
      // bank account) that no provider can confirm yet.
      status: "SETTING_UP",
      updatedAt: new Date().toISOString(),
    },
  };
}

// ── Edit business details ───────────────────────────────────────────────
export const EDITABLE_BUSINESS_FIELDS = [
  "businessType",
  "legalName",
  "tradingName",
  "country",
  "registrationNumber",
  "sector",
  "vatRegistered",
  "vatNumber",
  "vatFilingPeriod",
  "financialYearEnd",
  "accountantEmail",
] as const;

export function entityToWizardData(e: Entity): BusinessWizardData {
  return {
    businessType: e.businessType,
    legalName: e.legalName ?? e.name,
    tradingName: e.tradingName,
    country: e.country,
    registrationNumber: e.registrationNumber,
    sector: (BUSINESS_SECTORS as readonly string[]).includes(e.sector ?? "")
      ? (e.sector as BusinessSector)
      : undefined,
    vatRegistered: e.vatRegistered,
    vatNumber: e.vatNumber,
    vatFilingPeriod: e.vatFilingPeriod,
    financialYearEnd: e.financialYearEnd,
    accountantEmail: e.accountantEmail,
  };
}

// Applies an edit (untrusted, already-sanitized via sanitizeWizardData) over
// the stored business and re-validates the details steps (1, 2) + the
// accountant email. Returns fields to set and fields to remove.
export function buildBusinessEdit(
  existing: Entity,
  patch: BusinessWizardData,
  rawKeys: string[],
):
  | { ok: true; set: Partial<Entity>; remove: (keyof Entity)[] }
  | { ok: false; errors: FieldErrors } {
  const merged: BusinessWizardData = { ...entityToWizardData(existing) };
  for (const k of EDITABLE_BUSINESS_FIELDS) {
    if (!rawKeys.includes(k)) continue;
    (merged as Record<string, unknown>)[k] = patch[k]; // undefined clears
  }
  const errors: FieldErrors = {
    ...validateWizardStep(1, merged),
    ...validateWizardStep(2, merged),
  };
  if (merged.accountantEmail && !EMAIL_RE.test(merged.accountantEmail)) {
    errors.accountantEmail = "Enter a valid email";
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  const legalName = merged.legalName!.trim();
  const tradingName = merged.tradingName?.trim() || undefined;
  const set: Partial<Entity> = {
    businessType: merged.businessType,
    legalName,
    name: tradingName ?? legalName,
    country: merged.country,
    sector: merged.sector,
    vatRegistered: merged.vatRegistered,
    financialYearEnd: merged.financialYearEnd,
  };
  const remove: (keyof Entity)[] = [];
  const opt = (
    k: "tradingName" | "registrationNumber" | "accountantEmail",
    v: string | undefined,
  ) => {
    if (v) (set as Record<string, unknown>)[k] = v;
    else remove.push(k);
  };
  opt("tradingName", tradingName);
  opt("registrationNumber", merged.registrationNumber?.trim() || undefined);
  opt("accountantEmail", merged.accountantEmail?.trim().toLowerCase() || undefined);
  if (merged.vatRegistered) {
    set.vatNumber = merged.vatNumber!.trim();
    set.vatFilingPeriod = merged.vatFilingPeriod;
  } else {
    remove.push("vatNumber", "vatFilingPeriod");
  }
  return { ok: true, set, remove };
}

// ── Portfolio ───────────────────────────────────────────────────────────
export type OwnershipFilter = "all" | "sole" | "shared" | "unknown";
export const OWNERSHIP_FILTER_LABEL: Record<OwnershipFilter, string> = {
  all: "All owners",
  sole: "Wholly owned by you",
  shared: "Shared ownership",
  unknown: "Ownership not set",
};
export type PortfolioView = "active" | "archived";

export interface BusinessListItem {
  id: string;
  name: string;
  legalName: string | null;
  businessType: BusinessType | null;
  typeLabel: string;
  ownerLabel: string;
  ownership: Exclude<OwnershipFilter, "all">;
  status: EntityStatus;
  archived: boolean;
  createdAt: string;
}

export interface BusinessPortfolioSummary {
  totalCompanies: number;
  byType: { type: BusinessType | "OTHER"; label: string; count: number }[];
  // Financial figures are null until ledger / banking / VAT exist. The UI
  // must show "—" for null — never a made-up 0.
  revenueYtd: number | null;
  revenueLastYearSamePeriod: number | null;
  cashInBank: number | null;
  bankAccounts: number | null;
  vatThisQuarter: number | null;
  vatNextDueDate: string | null;
}

export interface BusinessPortfolioResponse {
  summary: BusinessPortfolioSummary;
  businesses: BusinessListItem[];
  counts: { active: number; archived: number };
  // Totals before search/filter, so the UI can tell "no businesses" from
  // "no search results".
  total: number;
}

export function isBusinessEntity(e: Entity): boolean {
  return e.entityType === "COMPANY";
}

export function toBusinessListItem(e: Entity): BusinessListItem {
  const share = e.creatorSharePercent;
  const ownership: BusinessListItem["ownership"] =
    typeof share !== "number" ? "unknown" : share >= 100 ? "sole" : "shared";
  const roleLabel = e.creatorRole ? BUSINESS_ROLE_LABEL[e.creatorRole] : null;
  const ownerLabel =
    typeof share === "number" ? `You · ${share}%` : roleLabel ? `You · ${roleLabel}` : "You";
  return {
    id: e.id,
    name: e.name,
    legalName: e.legalName ?? null,
    businessType: e.businessType ?? null,
    typeLabel: e.businessType ? BUSINESS_TYPE_LABEL[e.businessType] : "Company",
    ownerLabel,
    ownership,
    status: e.status,
    archived: !!e.archivedAt,
    createdAt: e.createdAt,
  };
}

export function buildBusinessPortfolio(
  entities: Entity[],
  opts: { q?: string; ownership?: OwnershipFilter; view?: PortfolioView },
): BusinessPortfolioResponse {
  const all = entities.filter(isBusinessEntity).map(toBusinessListItem);
  const active = all.filter((b) => !b.archived);
  const view = opts.view ?? "active";
  const q = opts.q?.trim().toLocaleLowerCase("en") ?? "";
  const ownership = opts.ownership ?? "all";

  const businesses = all
    .filter((b) => (view === "archived" ? b.archived : !b.archived))
    .filter((b) => ownership === "all" || b.ownership === ownership)
    .filter(
      (b) =>
        !q ||
        b.name.toLocaleLowerCase("en").includes(q) ||
        (b.legalName?.toLocaleLowerCase("en").includes(q) ?? false),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const typeCounts = new Map<BusinessType | "OTHER", number>();
  for (const b of active) {
    const t = b.businessType ?? "OTHER";
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  }
  const byType = [...BUSINESS_TYPES, "OTHER" as const]
    .filter((t) => typeCounts.has(t))
    .map((t) => ({
      type: t,
      label: t === "OTHER" ? "Other" : BUSINESS_TYPE_LABEL[t],
      count: typeCounts.get(t)!,
    }));

  return {
    summary: {
      totalCompanies: active.length,
      byType,
      revenueYtd: null,
      revenueLastYearSamePeriod: null,
      cashInBank: null,
      bankAccounts: null,
      vatThisQuarter: null,
      vatNextDueDate: null,
    },
    businesses,
    counts: { active: active.length, archived: all.length - active.length },
    total: all.length,
  };
}
