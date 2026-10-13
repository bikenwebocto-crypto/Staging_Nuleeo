import { describe, it, expect } from "vitest";
import { indexationStrideMonths, indexationAnchor, nextIncreaseDateOnOrAfter } from "./leaseDates";
import type { Agreement, AgreementIndexation } from "../../shared/firestore-schema";

const agreement = (overrides: Partial<Agreement>): Agreement => ({
  id: "a1",
  tenantId: "t1",
  unitId: "u1",
  propertyId: "p1",
  ownerId: "o1",
  agreementValue: 12000,
  startDate: "2026-01-01",
  endDate: "2027-01-01",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const idx = (o: Partial<AgreementIndexation> = {}): AgreementIndexation => ({
  type: "fixed",
  rate: 5,
  frequency: "yearly",
  ...o,
});

describe("indexationStrideMonths", () => {
  it("defaults a missing frequency to yearly (12), unlike rent cycles", () => {
    expect(indexationStrideMonths(undefined)).toBe(12);
  });
  it("maps known frequencies", () => {
    expect(indexationStrideMonths("monthly")).toBe(1);
    expect(indexationStrideMonths("quarterly")).toBe(3);
    expect(indexationStrideMonths("yearly")).toBe(12);
  });
});

describe("indexationAnchor", () => {
  it("prefers signatureDate over signedAt/startDate", () => {
    expect(
      indexationAnchor(
        agreement({ signatureDate: "2026-05-31", signedAt: "2026-04-01", startDate: "2026-01-01" }),
      ),
    ).toBe("2026-05-31");
  });
  it("falls back to signedAt, then startDate", () => {
    expect(indexationAnchor(agreement({ signedAt: "2026-04-10", startDate: "2026-01-01" }))).toBe(
      "2026-04-10",
    );
    expect(indexationAnchor(agreement({ startDate: "2026-02-02" }))).toBe("2026-02-02");
  });
  it("slices a full ISO createdAt to a date", () => {
    // startDate cast away so the chain falls through to createdAt.
    const a = agreement({ createdAt: "2026-03-03T12:34:56.000Z" });
    (a as { startDate?: string }).startDate = undefined;
    expect(indexationAnchor(a)).toBe("2026-03-03");
  });
});

describe("nextIncreaseDateOnOrAfter", () => {
  it("returns null when there is no indexation", () => {
    expect(nextIncreaseDateOnOrAfter(agreement({}), "2026-06-07")).toBeNull();
  });

  it("returns the first step (anchor + delayMonths) when it is in the future", () => {
    // Matches the screenshot lease: signed/started 2026-05-31, +10 months.
    const a = agreement({
      signatureDate: "2026-05-31",
      indexation: idx({ delayMonths: 10 }),
    });
    // May 31 + 10 months → March (31 days) → 2027-03-31.
    expect(nextIncreaseDateOnOrAfter(a, "2026-06-07")).toBe("2027-03-31");
  });

  it("rolls a backdated lease forward to the next not-yet-passed step", () => {
    const a = agreement({
      signatureDate: "2020-01-15",
      indexation: idx({ delayMonths: 12, frequency: "yearly" }),
    });
    // First step 2021-01-15; stride 12mo; first step ≥ 2026-06-07 is 2027-01-15.
    expect(nextIncreaseDateOnOrAfter(a, "2026-06-07")).toBe("2027-01-15");
  });

  it("keeps a step that lands exactly on today", () => {
    const a = agreement({
      signatureDate: "2026-01-07",
      indexation: idx({ delayMonths: 5, frequency: "yearly" }),
    });
    expect(nextIncreaseDateOnOrAfter(a, "2026-06-07")).toBe("2026-06-07");
  });

  it("clamps month-end anchors (Jan 31 + 1 month → Feb 28)", () => {
    const a = agreement({
      signatureDate: "2026-01-31",
      indexation: idx({ delayMonths: 1, frequency: "monthly" }),
    });
    expect(nextIncreaseDateOnOrAfter(a, "2026-01-01")).toBe("2026-02-28");
  });
});
