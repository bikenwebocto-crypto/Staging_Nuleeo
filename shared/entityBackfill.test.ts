import { describe, expect, it } from "vitest";
import type { Entity } from "./firestore-schema";
import {
  classifyProperty,
  normalizeCompanyName,
  planEntityBackfill,
  type BackfillProperty,
} from "./entityBackfill";

const idFor = (ownerId: string, type: string, key: string) => `ent:${ownerId}:${type}:${key}`;
const NOW = "2026-11-12T00:00:00.000Z";
const plan = (properties: BackfillProperty[], existingEntities: Entity[] = []) =>
  planEntityBackfill({ properties, existingEntities, idFor, nowIso: NOW });

const entity = (over: Partial<Entity>): Entity => ({
  id: "e1",
  ownerId: "u1",
  createdBy: "u1",
  name: "Acme Ltd",
  entityType: "COMPANY",
  status: "ACTIVE",
  source: "MANUAL",
  createdAt: NOW,
  ...over,
});

describe("normalizeCompanyName", () => {
  it("ignores case and extra whitespace", () => {
    expect(normalizeCompanyName("  Acme   LTD ")).toBe("acme ltd");
  });
});

describe("classifyProperty", () => {
  it.each([
    [{ id: "p", ownershipType: "company", companyName: "A" }, "no_owner"],
    [{ id: "p", ownerId: "u", companyName: "A" }, "no_ownership_type"],
    [{ id: "p", ownerId: "u" }, "no_ownership_type"],
    [
      { id: "p", ownerId: "u", ownershipType: "company", companyName: "  " },
      "company_without_name",
    ],
    [
      { id: "p", ownerId: "u", ownershipType: "individual", companyName: "A" },
      "individual_with_company_name",
    ],
    [{ id: "p", ownerId: "u", ownershipType: "trust" }, "unknown_ownership_type"],
  ])("skips ambiguous %j", (p, reason) => {
    expect(classifyProperty(p as BackfillProperty)).toEqual({ kind: "skip", reason });
  });
});

describe("planEntityBackfill", () => {
  it("creates one company entity per owner/company and reuses it", () => {
    const r = plan([
      { id: "p1", ownerId: "u1", ownershipType: "company", companyName: "Acme Ltd" },
      { id: "p2", ownerId: "u1", ownershipType: "company", companyName: "acme  ltd" },
      { id: "p3", ownerId: "u2", ownershipType: "company", companyName: "Acme Ltd" },
    ]);
    expect(r.creates).toHaveLength(2);
    expect(r.creates[0]).toMatchObject({
      ownerId: "u1",
      name: "Acme Ltd",
      legacyCompanyName: "Acme Ltd",
      entityType: "COMPANY",
      source: "MIGRATED",
      status: "ACTIVE",
    });
    expect(r.links.map((l) => l.entityId)).toEqual([
      "ent:u1:COMPANY:acme ltd",
      "ent:u1:COMPANY:acme ltd",
      "ent:u2:COMPANY:acme ltd",
    ]);
    expect(r.spellingVariants).toEqual([
      { ownerId: "u1", key: "acme ltd", spellings: ["Acme Ltd", "acme ltd"] },
    ]);
  });

  it("creates a PERSONAL entity only for clearly individual properties", () => {
    const r = plan([
      { id: "p1", ownerId: "u1", ownershipType: "individual" },
      { id: "p2", ownerId: "u1", ownershipType: "individual" },
      { id: "p3", ownerId: "u1" },
    ]);
    expect(r.creates).toEqual([
      expect.objectContaining({ entityType: "PERSONAL", name: "Personal" }),
    ]);
    expect(r.links).toHaveLength(2);
    expect(r.skipped).toEqual([{ propertyId: "p3", ownerId: "u1", reason: "no_ownership_type" }]);
  });

  it("preserves existing entityId values", () => {
    const r = plan([
      { id: "p1", ownerId: "u1", ownershipType: "company", companyName: "X", entityId: "keep" },
    ]);
    expect(r.preserved).toEqual([{ propertyId: "p1", entityId: "keep" }]);
    expect(r.creates).toHaveLength(0);
    expect(r.links).toHaveLength(0);
  });

  it("reuses existing entities (re-run / manual) instead of creating", () => {
    const r = plan(
      [
        { id: "p1", ownerId: "u1", ownershipType: "company", companyName: "ACME LTD" },
        { id: "p2", ownerId: "u1", ownershipType: "individual" },
      ],
      [entity({ id: "manual" }), entity({ id: "pers", entityType: "PERSONAL", name: "Me" })],
    );
    expect(r.creates).toHaveLength(0);
    expect(r.links).toEqual([
      { propertyId: "p1", entityId: "manual", existingEntity: true },
      { propertyId: "p2", entityId: "pers", existingEntity: true },
    ]);
  });

  it("skips when several existing entities match", () => {
    const r = plan(
      [{ id: "p1", ownerId: "u1", ownershipType: "company", companyName: "Acme Ltd" }],
      [entity({ id: "a" }), entity({ id: "b", name: "x", legacyCompanyName: "acme ltd" })],
    );
    expect(r.skipped).toEqual([
      { propertyId: "p1", ownerId: "u1", reason: "multiple_matching_entities" },
    ]);
  });

  it("is idempotent: a second plan over the result does nothing new", () => {
    const props: BackfillProperty[] = [
      { id: "p1", ownerId: "u1", ownershipType: "company", companyName: "Acme" },
    ];
    const first = plan(props);
    const linked = props.map((p) => ({ ...p, entityId: first.links[0].entityId }));
    const second = plan(linked, first.creates);
    expect(second.creates).toHaveLength(0);
    expect(second.links).toHaveLength(0);
    expect(second.preserved).toHaveLength(1);
  });
});
