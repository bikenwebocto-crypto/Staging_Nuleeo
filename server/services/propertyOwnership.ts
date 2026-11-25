// Resolves who a property is held through, so `Property.entityId` is never
// left blank or pointed at someone else's entity:
//   • individual / personal → the owner's PERSONAL entity (created on demand)
//   • company               → an existing COMPANY entity of the property owner
// Entities are always scoped to the PROPERTY owner (not the caller), so a
// portfolio grantee editing on the owner's behalf links the owner's entities.

import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase";
import {
  COL,
  type Entity,
  type OwnershipType,
  type Property,
  type User,
} from "../../shared/firestore-schema";

// The COMPANY entity a property is held through, or undefined for personally
// held / legacy properties. Real-estate rows (tenancy, lease, rent, manual
// property expenses) are stamped with this so the company's own ledger
// (GET /api/owner/entities/:entityId/transactions) includes them.
export function companyEntityIdOf(
  p: Pick<Property, "ownershipType" | "entityId"> | null | undefined,
): string | undefined {
  return p?.ownershipType === "company" && p.entityId ? p.entityId : undefined;
}

// Same, by property id. Best-effort: never throws (callers sit on money paths).
export async function resolvePropertyEntityId(
  propertyId: string | undefined | null,
): Promise<string | undefined> {
  if (!propertyId) return undefined;
  try {
    const snap = await db().collection(COL.properties).doc(propertyId).get();
    return companyEntityIdOf(snap.exists ? (snap.data() as Property) : null);
  } catch {
    return undefined;
  }
}

// Whether a property consumes a plan unit slot. Soft-deactivated properties
// don't, and neither does a Building parent: its units are the rentable
// slots, so counting the shell too would charge 11 slots for 10 units.
export function countsTowardUnitCap(p: Pick<Property, "status" | "propertyType">): boolean {
  return p.status !== "inactive" && p.propertyType !== "Building";
}

const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Returns the owner's PERSONAL entity, creating it if missing. The query +
// create run in one transaction so two concurrent property creates can't
// produce two personal entities.
export async function ensurePersonalEntity(ownerId: string, actorUid: string): Promise<Entity> {
  const col = db().collection(COL.entities);
  const q = col.where("ownerId", "==", ownerId).where("entityType", "==", "PERSONAL").limit(1);

  const existing = await q.get();
  if (!existing.empty) {
    const d = existing.docs[0];
    return { ...(d.data() as Entity), id: d.id };
  }

  const userSnap = await db().collection(COL.users).doc(ownerId).get();
  const u = userSnap.data() as Partial<User> | undefined;
  const fullName = [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim();

  return db().runTransaction(async (t) => {
    const again = await t.get(q);
    if (!again.empty) {
      const d = again.docs[0];
      return { ...(d.data() as Entity), id: d.id };
    }
    const ref = col.doc();
    const nowIso = new Date().toISOString();
    const entity: Entity = {
      id: ref.id,
      ownerId,
      createdBy: actorUid,
      name: fullName || "Personal",
      entityType: "PERSONAL",
      status: "ACTIVE",
      source: "MANUAL",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    t.create(ref, entity);
    return entity;
  });
}

// Loads an entity only if it belongs to `ownerId`; otherwise null.
export async function loadOwnedEntity(ownerId: string, entityId: unknown): Promise<Entity | null> {
  if (typeof entityId !== "string" || !ENTITY_ID_RE.test(entityId)) return null;
  const snap = await db().collection(COL.entities).doc(entityId).get();
  const e = snap.data() as Entity | undefined;
  if (!snap.exists || !e || e.ownerId !== ownerId) return null;
  return { ...e, id: snap.id };
}

export type OwnershipFields = {
  ownershipType: OwnershipType;
  entityId: string;
  // FieldValue.delete() when switching to personal, so a stale company
  // name can't linger next to a personal entity.
  companyName: string | FieldValue;
};

export type OwnershipResult = { ok: true; fields: OwnershipFields } | { ok: false; error: string };

// Turns the "Owned by" choice into the fields to store on the property.
export async function resolvePropertyOwnership(
  ownerId: string,
  actorUid: string,
  ownershipType: OwnershipType,
  entityId: unknown,
): Promise<OwnershipResult> {
  if (ownershipType === "company") {
    const entity = await loadOwnedEntity(ownerId, entityId);
    if (!entity || entity.entityType !== "COMPANY")
      return { ok: false, error: "Choose one of your companies" };
    if (entity.archivedAt) return { ok: false, error: "That company is archived" };
    return {
      ok: true,
      fields: { ownershipType: "company", entityId: entity.id, companyName: entity.name },
    };
  }
  const personal = await ensurePersonalEntity(ownerId, actorUid);
  return {
    ok: true,
    fields: {
      ownershipType: "individual",
      entityId: personal.id,
      companyName: FieldValue.delete(),
    },
  };
}
