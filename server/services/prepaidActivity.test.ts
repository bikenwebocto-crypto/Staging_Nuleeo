import { describe, it, expect } from "vitest";
import { prepaidRentActivityRow } from "./prepaidActivity";
import type { Agreement } from "../../shared/firestore-schema";

// Minimal valid Agreement with sensible defaults; override per case.
function mkAgreement(overrides: Partial<Agreement> = {}): Agreement {
  return {
    id: "agr_1",
    tenantId: "agr_1",
    unitId: "prop_1",
    propertyId: "prop_1",
    ownerId: "owner_1",
    portfolioId: "pf_1",
    agreementValue: 18000,
    startDate: "2026-01-15",
    endDate: "2027-01-15",
    status: "active",
    createdAt: "2026-01-10T08:30:00.000Z",
    monthlyRent: 1500,
    prepaidRents: 3,
    ...overrides,
  };
}

describe("prepaidRentActivityRow", () => {
  it("synthesizes an income row for a prepaid active lease", () => {
    const row = prepaidRentActivityRow(mkAgreement());
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      id: "prepaid_agr_1",
      propertyId: "prop_1",
      unitId: "prop_1",
      tenantId: "agr_1",
      // The synthetic row carries its lease id so prepaid money stays
      // attributable to its agreement like every other rent row.
      agreementId: "agr_1",
      ownerId: "owner_1",
      portfolioId: "pf_1",
      name: "Prepaid rent · 3 months",
      amount: 4500, // 1500 × 3
      currency: "EUR",
      type: "income",
      category: "rent",
      status: "completed",
      source: "prepaid",
    });
  });

  it("anchors the timestamp to noon UTC on the lease date (no day rollback)", () => {
    // signatureDate wins over startDate; noon UTC so it never displays as the
    // previous day in Cyprus (UTC+2/3).
    const row = prepaidRentActivityRow(
      mkAgreement({ signatureDate: "2026-02-01", startDate: "2026-01-15" }),
    );
    expect(row?.timestamp).toBe("2026-02-01T12:00:00.000Z");
  });

  it("falls back to startDate, then createdAt, for the date anchor", () => {
    expect(prepaidRentActivityRow(mkAgreement({ signatureDate: undefined }))?.timestamp).toBe(
      "2026-01-15T12:00:00.000Z",
    );
    const noDates = prepaidRentActivityRow(
      mkAgreement({ signatureDate: undefined, startDate: "" }),
    );
    expect(noDates?.timestamp).toBe("2026-01-10T08:30:00.000Z");
  });

  it("singularizes the label for one prepaid month", () => {
    expect(prepaidRentActivityRow(mkAgreement({ prepaidRents: 1 }))?.name).toBe(
      "Prepaid rent · 1 month",
    );
  });

  it("floors fractional prepaid months", () => {
    const row = prepaidRentActivityRow(mkAgreement({ prepaidRents: 2.9 }));
    expect(row?.name).toBe("Prepaid rent · 2 months");
    expect(row?.amount).toBe(3000);
  });

  it("uses the FROZEN prepaidRentAmount, not the (now-indexed) live rent", () => {
    // Lease prepaid 3mo at €1,000 = €3,000; rent later indexed up to €1,050.
    // The historical prepaid row must still report the frozen €3,000.
    const row = prepaidRentActivityRow(
      mkAgreement({ prepaidRents: 3, monthlyRent: 1050, prepaidRentAmount: 3000 }),
    );
    expect(row?.amount).toBe(3000);
    expect(row?.name).toBe("Prepaid rent · 3 months");
  });

  it("falls back to live rent × months for legacy leases without a snapshot", () => {
    const row = prepaidRentActivityRow(
      mkAgreement({ prepaidRents: 3, monthlyRent: 1500, prepaidRentAmount: undefined }),
    );
    expect(row?.amount).toBe(4500); // 1500 × 3
  });

  it("returns null when there is no prepaid rent", () => {
    expect(prepaidRentActivityRow(mkAgreement({ prepaidRents: 0 }))).toBeNull();
    expect(prepaidRentActivityRow(mkAgreement({ prepaidRents: undefined }))).toBeNull();
    expect(prepaidRentActivityRow(mkAgreement({ prepaidRents: -1 }))).toBeNull();
  });

  it("returns null when monthly rent is missing or non-positive", () => {
    expect(prepaidRentActivityRow(mkAgreement({ monthlyRent: undefined }))).toBeNull();
    expect(prepaidRentActivityRow(mkAgreement({ monthlyRent: 0 }))).toBeNull();
  });

  it("omits the row for leases that haven't taken effect", () => {
    for (const status of ["draft", "pending_tenant", "declined"] as const) {
      expect(prepaidRentActivityRow(mkAgreement({ status }))).toBeNull();
    }
  });

  it("keeps the historical row on past leases", () => {
    for (const status of ["active", "expired", "terminated"] as const) {
      expect(prepaidRentActivityRow(mkAgreement({ status }))).not.toBeNull();
    }
  });

  it("keeps the row visible while a lease is suspended (plan-downgrade hold)", () => {
    // Activity must NOT be hidden by deactivation — a suspended lease still
    // surfaces its prepaid money in both the owner's and tenant's feed.
    expect(prepaidRentActivityRow(mkAgreement({ status: "suspended" }))).not.toBeNull();
  });

  it("omits portfolioId when the agreement has none (legacy)", () => {
    const row = prepaidRentActivityRow(mkAgreement({ portfolioId: undefined }));
    expect(row).not.toBeNull();
    expect("portfolioId" in (row as object)).toBe(false);
  });
});
