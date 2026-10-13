import { describe, it, expect } from "vitest";
import { computeRentChange } from "./rentChange";

describe("computeRentChange", () => {
  it("recomputes agreementValue as newRent × stored term and reports previousRent", () => {
    const r = computeRentChange({ monthlyRent: 1000, rentalDurationMonths: 12 }, 1050);
    expect(r.previousRent).toBe(1000);
    expect(r.newRent).toBe(1050);
    expect(r.months).toBe(12);
    expect(r.agreementValue).toBe(12600); // 1050 × 12
    expect(r.agreementPatch).toEqual({ monthlyRent: 1050, agreementValue: 12600 });
    expect(r.tenantPatch).toEqual({ rentAmount: 1050 });
  });

  it("honors a monthsOverride (e.g. date-derived term from the owner edit)", () => {
    const r = computeRentChange({ monthlyRent: 800, rentalDurationMonths: 12 }, 800, 6);
    expect(r.months).toBe(6);
    expect(r.agreementValue).toBe(4800); // 800 × 6
  });

  it("defaults the term to 12 months when none is stored", () => {
    const r = computeRentChange({ monthlyRent: 500 }, 600);
    expect(r.months).toBe(12);
    expect(r.agreementValue).toBe(7200);
  });

  it("treats a missing monthlyRent as a previousRent of 0", () => {
    const r = computeRentChange({ rentalDurationMonths: 10 }, 1000);
    expect(r.previousRent).toBe(0);
    expect(r.agreementValue).toBe(10000);
  });

  it("floors a fractional term and never drops below 1 month", () => {
    expect(computeRentChange({ monthlyRent: 100, rentalDurationMonths: 11.9 }, 100).months).toBe(
      11,
    );
    expect(computeRentChange({ monthlyRent: 100, rentalDurationMonths: 0 }, 100).months).toBe(1);
  });

  it("BLENDS a mid-lease increase over the remaining months (term unchanged)", () => {
    // €1000/mo, 12-month lease (value €12,000), raised to €1,050 at month 6.
    const r = computeRentChange(
      { monthlyRent: 1000, rentalDurationMonths: 12, agreementValue: 12000, endDate: "2027-01-01" },
      1050,
      undefined,
      "2026-07-01",
    );
    // elapsed 6mo @ €1000 kept; remaining 6mo move to €1050 → €12,300, NOT €12,600.
    expect(r.agreementValue).toBe(12300);
  });

  it("recomputes fresh (no blend) when monthsOverride is given (owner moved the dates)", () => {
    const r = computeRentChange(
      { monthlyRent: 1000, rentalDurationMonths: 12, agreementValue: 12000, endDate: "2027-01-01" },
      1050,
      6, // explicit term → owner redefined the lease → recompute, not blend
      "2026-07-01",
    );
    expect(r.agreementValue).toBe(6300); // 1050 × 6
  });

  it("falls back to full-term when there's no endDate to blend against", () => {
    const r = computeRentChange(
      { monthlyRent: 1000, rentalDurationMonths: 12, agreementValue: 12000 },
      1050,
      undefined,
      "2026-07-01",
    );
    expect(r.agreementValue).toBe(12600); // 1050 × 12
  });

  it("clamps blended remaining to zero once the lease has ended", () => {
    const r = computeRentChange(
      { monthlyRent: 1000, rentalDurationMonths: 12, agreementValue: 12000, endDate: "2026-01-01" },
      1050,
      undefined,
      "2026-07-01", // past endDate → 0 remaining → value unchanged
    );
    expect(r.agreementValue).toBe(12000);
  });
});
