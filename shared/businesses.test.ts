import { describe, expect, it } from "vitest";
import type { Entity } from "./firestore-schema";
import {
  buildBusinessEntityFields,
  buildBusinessPortfolio,
  firstInvalidStep,
  isValidYearEnd,
  sanitizeWizardData,
  validateWizardStep,
  type BusinessWizardData,
} from "./businesses";

const COMPLETE: BusinessWizardData = {
  businessType: "LIMITED_COMPANY",
  legalName: "Acme Holdings Ltd",
  tradingName: "Acme",
  country: "CY",
  registrationNumber: "HE123",
  sector: "Advisory",
  vatRegistered: true,
  vatNumber: "CY123X",
  vatFilingPeriod: "QUARTERLY",
  financialYearEnd: "12-31",
  role: "BOTH",
  sharePercent: 60,
  bankingPreference: "PAYABL_ACCOUNT",
  accountantEmail: "Acc@Firm.com",
};

describe("validateWizardStep", () => {
  it("step 1 requires type, legal name, country and registration number", () => {
    expect(Object.keys(validateWizardStep(1, {})).sort()).toEqual(
      ["businessType", "country", "legalName", "registrationNumber"].sort(),
    );
  });

  it("step 1: self-employed does not need a registration number", () => {
    expect(
      validateWizardStep(1, { businessType: "SELF_EMPLOYED", legalName: "Jo", country: "GB" }),
    ).toEqual({});
  });

  it("step 2: VAT number + filing period only required when VAT registered", () => {
    const base = { sector: "Design" as const, financialYearEnd: "03-31" };
    expect(validateWizardStep(2, { ...base, vatRegistered: false })).toEqual({});
    expect(Object.keys(validateWizardStep(2, { ...base, vatRegistered: true })).sort()).toEqual([
      "vatFilingPeriod",
      "vatNumber",
    ]);
  });

  it("step 3: a share below 100% is allowed; shareholders need a share", () => {
    expect(validateWizardStep(3, { role: "SHAREHOLDER", sharePercent: 25.5 })).toEqual({});
    expect(validateWizardStep(3, { role: "DIRECTOR" })).toEqual({});
    expect(validateWizardStep(3, { role: "BOTH" }).sharePercent).toBeTruthy();
    expect(validateWizardStep(3, { role: "BOTH", sharePercent: 101 }).sharePercent).toBeTruthy();
    expect(validateWizardStep(3, { role: "BOTH", sharePercent: 33.333 }).sharePercent).toBeTruthy();
    expect(validateWizardStep(3, { role: "BOTH", sharePercent: 33.33 })).toEqual({});
  });

  it("step 4: banking choice required, accountant email optional but valid", () => {
    expect(validateWizardStep(4, {}).bankingPreference).toBeTruthy();
    expect(validateWizardStep(4, { bankingPreference: "NONE" })).toEqual({});
    expect(
      validateWizardStep(4, { bankingPreference: "BOTH", accountantEmail: "nope" }).accountantEmail,
    ).toBeTruthy();
  });

  it("year end must be a real MM-DD", () => {
    expect(isValidYearEnd("02-29")).toBe(true);
    expect(isValidYearEnd("04-31")).toBe(false);
    expect(isValidYearEnd("13-01")).toBe(false);
  });

  it("firstInvalidStep finds where to resume", () => {
    expect(firstInvalidStep({})).toBe(1);
    expect(firstInvalidStep({ ...COMPLETE, role: undefined })).toBe(3);
    expect(firstInvalidStep(COMPLETE)).toBeNull();
  });
});

describe("sanitizeWizardData", () => {
  it("drops unknown fields and wrong types", () => {
    expect(
      sanitizeWizardData({ businessType: "LLC", legalName: "  X  ", ownerId: "evil", sharePercent: "50", country: "cy" }),
    ).toEqual({ legalName: "X" });
  });
});

describe("buildBusinessEntityFields", () => {
  it("builds a SETTING_UP company with NOT_STARTED banking", () => {
    const r = buildBusinessEntityFields(COMPLETE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toMatchObject({
      entityType: "COMPANY",
      name: "Acme",
      legalName: "Acme Holdings Ltd",
      status: "SETTING_UP",
      bankingStatus: "NOT_STARTED",
      creatorRole: "BOTH",
      creatorSharePercent: 60,
      accountantEmail: "acc@firm.com",
    });
  });

  it("drops VAT details when not VAT registered", () => {
    const r = buildBusinessEntityFields({ ...COMPLETE, vatRegistered: false });
    expect(r.ok && "vatNumber" in r.fields).toBe(false);
  });

  it("reports the first failing step", () => {
    expect(buildBusinessEntityFields({ ...COMPLETE, sector: undefined })).toMatchObject({ ok: false, step: 2 });
  });
});

const ent = (over: Partial<Entity>): Entity => ({
  id: "e",
  ownerId: "u",
  createdBy: "u",
  name: "x",
  entityType: "COMPANY",
  status: "SETTING_UP",
  source: "MANUAL",
  createdAt: "2026-01-01",
  ...over,
});

describe("buildBusinessPortfolio", () => {
  const entities = [
    ent({ id: "a", name: "Alpha", businessType: "LIMITED_COMPANY", creatorSharePercent: 100 }),
    ent({ id: "b", name: "Beta", businessType: "PARTNERSHIP", creatorSharePercent: 50 }),
    ent({ id: "c", name: "Gamma", legalName: "Alpha Two Ltd" }),
    ent({ id: "d", name: "Old", archivedAt: "2026-02-01", businessType: "SELF_EMPLOYED" }),
    ent({ id: "p", name: "Personal", entityType: "PERSONAL" }),
  ];

  it("summarises active businesses by type and never invents money", () => {
    const r = buildBusinessPortfolio(entities, {});
    expect(r.summary.totalCompanies).toBe(3);
    expect(r.summary.byType.map((t) => [t.type, t.count])).toEqual([
      ["LIMITED_COMPANY", 1],
      ["PARTNERSHIP", 1],
      ["OTHER", 1],
    ]);
    expect(r.summary.revenueYtd).toBeNull();
    expect(r.summary.cashInBank).toBeNull();
    expect(r.summary.vatNextDueDate).toBeNull();
    expect(r.counts).toEqual({ active: 3, archived: 1 });
    expect(r.total).toBe(4); // excludes the PERSONAL entity
  });

  it("searches name and legal name, case-insensitively", () => {
    expect(buildBusinessPortfolio(entities, { q: "ALPHA" }).businesses.map((b) => b.id)).toEqual(["a", "c"]);
  });

  it("filters by ownership and archived view", () => {
    expect(buildBusinessPortfolio(entities, { ownership: "shared" }).businesses.map((b) => b.id)).toEqual(["b"]);
    expect(buildBusinessPortfolio(entities, { ownership: "unknown" }).businesses.map((b) => b.id)).toEqual(["c"]);
    expect(buildBusinessPortfolio(entities, { view: "archived" }).businesses.map((b) => b.id)).toEqual(["d"]);
  });

  it("labels owner share", () => {
    const [a, b] = buildBusinessPortfolio(entities, {}).businesses;
    expect(a.ownerLabel).toBe("You · 100%");
    expect(b.ownerLabel).toBe("You · 50%");
  });
});
