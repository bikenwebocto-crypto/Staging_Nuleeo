// Entity (company / personal holding) API contract + pure input validation,
// shared by server/routes/entities.ts and the client create dialog.

import {
  LEGAL_ENTITY_TYPES,
  ENTITY_STATUSES,
  type Entity,
  type EntityStatus,
  type LegalEntityType,
} from "./firestore-schema";

export const ENTITY_FIELD_MAX = {
  name: 80,
  legalName: 120,
  registrationNumber: 40,
  vatNumber: 20,
  sector: 60,
  address: 200,
} as const;

export const ENTITY_TYPE_LABEL: Record<LegalEntityType, string> = {
  COMPANY: "Company",
  PERSONAL: "Personal",
};

export const ENTITY_STATUS_LABEL: Record<EntityStatus, string> = {
  SETTING_UP: "Setting up",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
};

export interface EntityInput {
  entityType: LegalEntityType;
  name: string;
  legalName?: string;
  registrationNumber?: string;
  vatNumber?: string;
  sector?: string;
  address?: string;
  incorporationDate?: string;
  status: EntityStatus;
}

export interface EntityListResponse {
  entities: Entity[];
  // false once the owner already has a PERSONAL entity (max one).
  canCreatePersonal: boolean;
}

type TextField = keyof typeof ENTITY_FIELD_MAX;
const OPTIONAL_TEXT: Exclude<TextField, "name">[] = [
  "legalName",
  "registrationNumber",
  "vatNumber",
  "sector",
  "address",
];

// `clean` lets the server plug in its unicode sanitizer; the client passes trim.
export function validateEntityInput(
  body: unknown,
  todayIso: string,
  clean: (s: string, max: number) => string = (s) => s,
): { ok: true; value: EntityInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!(LEGAL_ENTITY_TYPES as readonly unknown[]).includes(b.entityType)) {
    return { ok: false, error: "entityType must be COMPANY or PERSONAL" };
  }
  const entityType = b.entityType as LegalEntityType;
  const text = (k: TextField) =>
    typeof b[k] === "string" ? clean(b[k] as string, ENTITY_FIELD_MAX[k] + 1).trim() : "";

  const name = text("name") || (entityType === "PERSONAL" ? "Personal" : "");
  if (!name) return { ok: false, error: "Name is required" };
  if (name.length > ENTITY_FIELD_MAX.name) {
    return { ok: false, error: `Name must be ${ENTITY_FIELD_MAX.name} characters or fewer` };
  }

  const value: EntityInput = {
    entityType,
    name,
    status: entityType === "PERSONAL" ? "ACTIVE" : "SETTING_UP",
  };
  for (const k of OPTIONAL_TEXT) {
    const v = text(k);
    if (!v) continue;
    if (v.length > ENTITY_FIELD_MAX[k]) {
      return { ok: false, error: `${k} must be ${ENTITY_FIELD_MAX[k]} characters or fewer` };
    }
    value[k] = v;
  }

  if (b.status !== undefined && b.status !== "") {
    if (!(ENTITY_STATUSES as readonly unknown[]).includes(b.status)) {
      return { ok: false, error: "status must be SETTING_UP, ACTIVE or INACTIVE" };
    }
    value.status = b.status as EntityStatus;
  }

  if (typeof b.incorporationDate === "string" && b.incorporationDate) {
    const d = b.incorporationDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
      return { ok: false, error: "incorporationDate must be a valid date (YYYY-MM-DD)" };
    }
    if (d > todayIso.slice(0, 10)) {
      return { ok: false, error: "incorporationDate cannot be in the future" };
    }
    value.incorporationDate = d;
  }
  return { ok: true, value };
}
