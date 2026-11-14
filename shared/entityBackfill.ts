// Pure planner for script/backfillPropertyEntities.ts: decides, for every
// property, which Entity it should link to and which entities must be created.
// No I/O, so the classification rules are unit-tested (entityBackfill.test.ts).
//
// Rules:
//   - A property that already has an entityId is preserved untouched.
//   - ownershipType "company" + non-empty companyName → COMPANY entity keyed by
//     (ownerId, normalized companyName). One entity per key, reused by every
//     property of that owner/company.
//   - ownershipType "individual" + NO companyName → the owner's PERSONAL entity.
//   - Anything else is ambiguous and skipped with a reason (missing owner,
//     missing ownershipType, company without a name, individual WITH a company
//     name). Nothing is guessed.
//   - Existing entities are reused before anything is created: a COMPANY by
//     the same owner + normalized (legacyCompanyName ?? name), the PERSONAL
//     entity by owner. Two or more candidates is ambiguous → skip.
//   - New entity ids come from `idFor`, which the script makes deterministic,
//     so a re-run after a partial commit converges on the same docs.

import type { Entity, LegalEntityType as EntityType, OwnershipType } from "./firestore-schema";

export interface BackfillProperty {
  id: string;
  ownerId?: string;
  ownershipType?: OwnershipType | string;
  companyName?: string;
  entityId?: string;
}

export type SkipReason =
  | "no_owner"
  | "no_ownership_type"
  | "company_without_name"
  | "individual_with_company_name"
  | "unknown_ownership_type"
  | "multiple_matching_entities";

export interface PlannedLink {
  propertyId: string;
  entityId: string;
  // true = an entity that already exists in Firestore; false = created by this plan.
  existingEntity: boolean;
}

export interface BackfillPlan {
  creates: Entity[];
  links: PlannedLink[];
  preserved: { propertyId: string; entityId: string }[];
  skipped: { propertyId: string; ownerId?: string; reason: SkipReason }[];
  // Same normalized company spelled differently (case/whitespace) by one owner;
  // grouped into one entity, reported so a human can confirm.
  spellingVariants: { ownerId: string; key: string; spellings: string[] }[];
}

export const MIGRATION_ACTOR = "migration:backfillPropertyEntities";

// Case- and whitespace-insensitive company key.
export function normalizeCompanyName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

type Classified =
  | { kind: "COMPANY"; ownerId: string; key: string; name: string }
  | { kind: "PERSONAL"; ownerId: string }
  | { kind: "skip"; reason: SkipReason };

export function classifyProperty(p: BackfillProperty): Classified {
  if (!p.ownerId) return { kind: "skip", reason: "no_owner" };
  const name = p.companyName ? cleanName(p.companyName) : "";
  if (p.ownershipType === "company") {
    if (!name) return { kind: "skip", reason: "company_without_name" };
    return { kind: "COMPANY", ownerId: p.ownerId, key: normalizeCompanyName(name), name };
  }
  if (p.ownershipType === "individual") {
    if (name) return { kind: "skip", reason: "individual_with_company_name" };
    return { kind: "PERSONAL", ownerId: p.ownerId };
  }
  if (p.ownershipType === undefined || p.ownershipType === null || p.ownershipType === "") {
    return { kind: "skip", reason: "no_ownership_type" };
  }
  return { kind: "skip", reason: "unknown_ownership_type" };
}

export function planEntityBackfill(input: {
  properties: BackfillProperty[];
  existingEntities: Entity[];
  idFor: (ownerId: string, entityType: EntityType, key: string) => string;
  nowIso: string;
}): BackfillPlan {
  const { properties, existingEntities, idFor, nowIso } = input;
  const plan: BackfillPlan = {
    creates: [],
    links: [],
    preserved: [],
    skipped: [],
    spellingVariants: [],
  };

  // Index existing entities by owner + type + key.
  const existingByKey = new Map<string, Entity[]>();
  const keyOf = (ownerId: string, type: EntityType, key: string) =>
    `${ownerId}\u0000${type}\u0000${key}`;
  for (const e of existingEntities) {
    const key =
      e.entityType === "PERSONAL" ? "" : normalizeCompanyName(e.legacyCompanyName ?? e.name);
    const k = keyOf(e.ownerId, e.entityType, key);
    existingByKey.set(k, [...(existingByKey.get(k) ?? []), e]);
  }

  const created = new Map<string, Entity>();
  const spellings = new Map<string, { ownerId: string; key: string; set: Set<string> }>();

  // Deterministic order so the first-seen spelling (used as the name) is stable.
  const ordered = [...properties].sort((a, b) => a.id.localeCompare(b.id));

  for (const p of ordered) {
    if (p.entityId) {
      plan.preserved.push({ propertyId: p.id, entityId: p.entityId });
      continue;
    }
    const c = classifyProperty(p);
    if (c.kind === "skip") {
      plan.skipped.push({ propertyId: p.id, ownerId: p.ownerId, reason: c.reason });
      continue;
    }
    const key = c.kind === "COMPANY" ? c.key : "";
    const k = keyOf(c.ownerId, c.kind, key);

    if (c.kind === "COMPANY") {
      const s = spellings.get(k) ?? { ownerId: c.ownerId, key, set: new Set<string>() };
      s.set.add(c.name);
      spellings.set(k, s);
    }

    const existing = existingByKey.get(k) ?? [];
    if (existing.length > 1) {
      plan.skipped.push({
        propertyId: p.id,
        ownerId: c.ownerId,
        reason: "multiple_matching_entities",
      });
      continue;
    }
    if (existing.length === 1) {
      plan.links.push({ propertyId: p.id, entityId: existing[0].id, existingEntity: true });
      continue;
    }

    let entity = created.get(k);
    if (!entity) {
      entity = {
        id: idFor(c.ownerId, c.kind, key),
        ownerId: c.ownerId,
        createdBy: MIGRATION_ACTOR,
        name: c.kind === "COMPANY" ? c.name : "Personal",
        entityType: c.kind,
        status: "ACTIVE",
        source: "MIGRATED",
        ...(c.kind === "COMPANY" ? { legacyCompanyName: c.name } : {}),
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      created.set(k, entity);
      plan.creates.push(entity);
    }
    plan.links.push({ propertyId: p.id, entityId: entity.id, existingEntity: false });
  }

  for (const s of spellings.values()) {
    if (s.set.size > 1) {
      plan.spellingVariants.push({ ownerId: s.ownerId, key: s.key, spellings: [...s.set].sort() });
    }
  }
  return plan;
}
