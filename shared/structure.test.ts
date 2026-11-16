import { describe, expect, it } from "vitest";
import type { Agreement, Entity, Property, Tenant } from "./firestore-schema";
import { buildStructure } from "./structure";

const prop = (o: Partial<Property>): Property =>
  ({
    id: "p",
    ownerId: "o",
    address: "Addr",
    propertyValue: 0,
    acquisitionPrice: 0,
    createdAt: "",
    ...o,
  }) as Property;
const ent = (o: Partial<Entity>): Entity =>
  ({
    id: "e",
    ownerId: "o",
    name: "E",
    entityType: "COMPANY",
    status: "ACTIVE",
    source: "MANUAL",
    createdBy: "o",
    ...o,
  }) as Entity;
const ten = (id: string, name: string): Tenant =>
  ({
    id,
    name,
    email: "",
    unitId: "",
    propertyId: "",
    ownerId: "o",
    rentAmount: 0,
    status: "active",
    createdAt: "",
  }) as Tenant;
const agr = (o: Partial<Agreement>): Agreement =>
  ({
    id: "a",
    tenantId: "t",
    unitId: "",
    ownerId: "o",
    agreementValue: 0,
    startDate: "",
    endDate: "",
    createdAt: "",
    status: "active",
    ...o,
  }) as Agreement;

describe("buildStructure", () => {
  const input = {
    entities: [
      ent({ id: "co", name: "Thoma Holdings", entityType: "COMPANY" }),
      ent({ id: "me", name: "Thanos", entityType: "PERSONAL" }),
    ],
    properties: [
      prop({
        id: "apt",
        name: "Apt 14B",
        entityId: "co",
        propertyType: "Apartment",
        propertyValue: 400_000,
      }),
      prop({
        id: "bld",
        name: "Heights",
        entityId: "co",
        propertyType: "Building",
        propertyValue: 1_000_000,
      }),
      prop({ id: "u1", parentPropertyId: "bld", unitLabel: "A1" }),
      prop({ id: "u2", parentPropertyId: "bld", unitLabel: "A2" }),
      prop({
        id: "villa",
        name: "Villa",
        entityId: "me",
        propertyUse: "owner_occupied",
        propertyValue: 300_000,
      }),
      prop({ id: "loose", name: "Loose", propertyValue: 100_000 }),
      prop({ id: "gone", entityId: "co", status: "inactive", propertyValue: 9_999_999 }),
    ],
    tenants: [ten("t1", "Maria"), ten("t2", "Andreas")],
    agreements: [
      agr({ id: "a1", tenantId: "t1", propertyId: "apt", monthlyRent: 2000 }),
      agr({ id: "a2", tenantId: "t2", propertyId: "u1", monthlyRent: 1000 }),
      agr({ id: "a3", tenantId: "t2", propertyId: "u2", status: "expired", monthlyRent: 900 }),
    ],
    projects: [],
  };
  const out = buildStructure(input);

  it("groups top-level properties under their entity, companies first", () => {
    expect(out.owners.map((o) => o.id)).toEqual(["co", "me", "unassigned"]);
    expect(out.owners[0].properties.map((p) => p.id)).toEqual(["bld", "apt"]);
  });

  it("nests building units and names the current tenant", () => {
    const bld = out.owners[0].properties[0];
    expect(bld.subtitle).toBe("2 units · 1 let");
    expect(bld.units).toEqual([
      { id: "u1", label: "Unit A1", tenantName: "Andreas" },
      { id: "u2", label: "Unit A2", tenantName: null },
    ]);
    expect(out.owners[0].properties[1].subtitle).toBe("Occupied · Maria");
  });

  it("hides inactive properties and computes the summary", () => {
    expect(out.totalValue).toBe(1_800_000);
    expect(out.summary).toMatchObject({
      owners: 2,
      companies: 1,
      properties: 4,
      units: 5, // 2 building units + apt + villa + loose
      activeTenancies: 2,
      occupancyPct: 50, // 2 let of 4 rentable (villa is owner-occupied)
      companyOwnedValue: 1_400_000,
      personallyOwnedValue: 300_000,
    });
    // (2000+1000)*12 / (400k+1M) = 2.57%
    expect(out.summary.averageYieldPct).toBe(2.6);
  });

  it("returns an empty structure for no data", () => {
    const e = buildStructure({
      properties: [],
      entities: [],
      agreements: [],
      tenants: [],
      projects: [],
    });
    expect(e.owners).toEqual([]);
    expect(e.summary.occupancyPct).toBe(0);
  });
});
