import { describe, expect, it } from "vitest";
import { buildOccupancyHistory, type OccupancyAgreement } from "./occupancy";

const base = (over: Partial<OccupancyAgreement>): OccupancyAgreement => ({
  id: "a",
  propertyId: "p1",
  tenantId: "t",
  tenantName: "Tenant",
  status: "active",
  monthlyRent: 1000,
  startDate: "2025-01-01",
  endDate: "2026-01-01",
  ...over,
});

describe("buildOccupancyHistory", () => {
  it("marks the active agreement as current with no end date", () => {
    const [r] = buildOccupancyHistory([base({ id: "cur" })], "p1");
    expect(r).toMatchObject({ agreementId: "cur", isCurrent: true, endDate: null });
  });

  it("includes completed (expired) agreements, using expiredAt as the end", () => {
    const [r] = buildOccupancyHistory(
      [base({ status: "expired", expiredAt: "2024-06-30", endDate: "2024-07-01" })],
      "p1",
    );
    expect(r).toMatchObject({ status: "expired", isCurrent: false, endDate: "2024-06-30" });
  });

  it("uses terminatedAt for terminated agreements and keeps their status", () => {
    const [r] = buildOccupancyHistory(
      [base({ status: "terminated", terminatedAt: "2023-03-15", endDate: "2023-12-31" })],
      "p1",
    );
    expect(r).toMatchObject({ status: "terminated", endDate: "2023-03-15" });
  });

  it("lists multiple tenants newest first", () => {
    const out = buildOccupancyHistory(
      [
        base({ id: "old", status: "expired", startDate: "2021-01-01" }),
        base({ id: "new", startDate: "2025-01-01" }),
        base({ id: "mid", status: "terminated", startDate: "2023-01-01" }),
      ],
      "p1",
    );
    expect(out.map((r) => r.agreementId)).toEqual(["new", "mid", "old"]);
  });

  it("excludes other properties and declined leases", () => {
    const out = buildOccupancyHistory(
      [base({ id: "other", propertyId: "p2" }), base({ id: "dec", status: "declined" })],
      "p1",
    );
    expect(out).toEqual([]);
  });

  it("returns empty with no property id", () => {
    expect(buildOccupancyHistory([base({})], undefined)).toEqual([]);
  });
});
