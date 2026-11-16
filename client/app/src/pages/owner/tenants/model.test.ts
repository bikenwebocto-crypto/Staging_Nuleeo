import { describe, expect, it } from "vitest";
import type { OwnerProperty, OwnerTenant } from "@/lib/ownerQueries";
import { leaseState, matchesFilter, propertyLabel, relativeLogin } from "./model";

const today = new Date(2026, 10, 16); // 16 Nov 2026

const tenant = (o: Partial<OwnerTenant> = {}): OwnerTenant =>
  ({
    id: "t1",
    userId: "u1",
    name: "Maria",
    email: "m@x.com",
    phone: null,
    status: "active",
    rentAmount: 1200,
    nextPayment: null,
    paymentStatus: "paid",
    outstandingBalance: 0,
    propertyId: "p1",
    propertyAddress: "1 Main St",
    propertyImage: null,
    unitId: "p1",
    unitLabel: null,
    createdAt: "2026-01-01",
    leaseEnd: "2027-06-01",
    ...o,
  }) as OwnerTenant;

const prop = (o: Partial<OwnerProperty>): OwnerProperty =>
  ({ id: "p1", address: "1 Main St", ...o }) as OwnerProperty;

describe("leaseState", () => {
  it("overdue beats expiring", () => {
    expect(leaseState(tenant({ paymentStatus: "overdue", leaseEnd: "2026-11-20" }), today)).toBe(
      "overdue",
    );
  });
  it("expiring within 30 days", () => {
    expect(leaseState(tenant({ leaseEnd: "2026-12-10" }), today)).toBe("expiring");
    expect(leaseState(tenant({ leaseEnd: "2027-01-10" }), today)).toBe("paid");
  });
  it("non-active tenancies await signature", () => {
    expect(leaseState(tenant({ status: "invited", paymentStatus: null }), today)).toBe("awaiting");
  });
});

describe("propertyLabel + filter", () => {
  const building = prop({
    id: "b1",
    name: "Limassol Heights",
    propertyType: "Building",
    projectId: "pr1",
  });
  const unit = prop({ id: "u3", name: "A3", unitLabel: "A3", parentPropertyId: "b1" });
  const byId = new Map([building, unit].map((p) => [p.id, p]));
  const t = tenant({ propertyId: "u3", parentPropertyId: "b1" });

  it("labels units under their building", () => {
    expect(propertyLabel(t, byId)).toBe("Limassol Heights · A3");
  });
  it("rolls units up to the building for project/type/property filters", () => {
    expect(matchesFilter(t, { kind: "project", id: "pr1", label: "" }, byId)).toBe(true);
    expect(matchesFilter(t, { kind: "type", type: "building", label: "" }, byId)).toBe(true);
    expect(matchesFilter(t, { kind: "type", type: "apartment", label: "" }, byId)).toBe(false);
    expect(matchesFilter(t, { kind: "property", id: "b1", label: "" }, byId)).toBe(true);
  });
});

describe("relativeLogin", () => {
  it("formats recency", () => {
    expect(relativeLogin("2026-11-16T08:00:00Z", today)).toBe("today");
    expect(relativeLogin("2026-11-15", today)).toBe("yesterday");
    expect(relativeLogin("2026-11-13", today)).toBe("3 days ago");
    expect(relativeLogin(null, today)).toBe("never");
  });
});
