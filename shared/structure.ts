// Ownership structure (Owner → Property → Unit → Tenant) for the owner
// "Structure" page. Pure + framework-free so the server builds it and tests
// cover it without Firestore. Input rows are already scoped to ONE portfolio
// (properties/agreements/tenants) and its owner (entities) by the route.

import type {
  Agreement,
  Entity,
  LegalEntityType,
  Project,
  Property,
  Tenant,
} from "./firestore-schema";

export interface StructureUnit {
  id: string;
  label: string;
  tenantName: string | null;
}

export interface StructureProperty {
  id: string;
  name: string;
  // "Occupied · Maria K", "10 units · 9 let", "Owner-occupied", "Vacant"…
  subtitle: string;
  kind: "building" | "commercial" | "house" | "apartment" | "other";
  value: number;
  projectName: string | null;
  unitCount: number;
  letCount: number;
  // Building only: its units (let ones carry the tenant name).
  units: StructureUnit[];
}

export interface StructureOwner {
  // Entity id, or "unassigned" for properties not yet linked to an entity.
  id: string;
  name: string;
  entityType: LegalEntityType | "UNASSIGNED";
  value: number;
  properties: StructureProperty[];
}

export interface StructureSummary {
  owners: number;
  companies: number;
  properties: number;
  units: number;
  activeTenancies: number;
  occupancyPct: number; // 0–100, of rentable units
  companyOwnedValue: number;
  personallyOwnedValue: number;
  averageYieldPct: number; // annual active rent / value of the properties earning it
}

export interface StructureResponse {
  totalValue: number;
  owners: StructureOwner[];
  summary: StructureSummary;
}

export interface StructureInput {
  properties: Property[];
  entities: Entity[];
  agreements: Agreement[];
  tenants: Tenant[];
  projects: Project[];
}

const isActive = <T extends { status?: string }>(x: T) => x.status !== "inactive";

function propertyKind(p: Property, hasUnits: boolean): StructureProperty["kind"] {
  if (hasUnits || p.propertyType === "Building") return "building";
  if (p.propertyType === "Commercial") return "commercial";
  if (p.propertyType === "House" || p.propertyType === "Villa") return "house";
  if (p.propertyType === "Apartment") return "apartment";
  return "other";
}

export function buildStructure(input: StructureInput): StructureResponse {
  const properties = input.properties.filter(isActive);
  const tenantsById = new Map(input.tenants.map((t) => [t.id, t]));
  const projectsById = new Map(input.projects.map((p) => [p.id, p.name]));

  // Current tenant per property = its ACTIVE agreement's tenant.
  const activeAgreements = input.agreements.filter((a) => a.status === "active");
  const tenantByProperty = new Map<string, string>();
  const rentByProperty = new Map<string, number>();
  for (const a of activeAgreements) {
    const t = tenantsById.get(a.tenantId);
    tenantByProperty.set(a.propertyId, t?.name ?? "Tenant");
    rentByProperty.set(
      a.propertyId,
      (rentByProperty.get(a.propertyId) ?? 0) + (a.monthlyRent ?? 0),
    );
  }

  const childrenOf = new Map<string, Property[]>();
  for (const p of properties) {
    if (!p.parentPropertyId) continue;
    const list = childrenOf.get(p.parentPropertyId) ?? [];
    list.push(p);
    childrenOf.set(p.parentPropertyId, list);
  }
  const ids = new Set(properties.map((p) => p.id));
  // Top level = not a unit, or a unit whose building is gone/hidden.
  const topLevel = properties.filter((p) => !p.parentPropertyId || !ids.has(p.parentPropertyId));

  let units = 0;
  let rentable = 0;
  let let_ = 0;
  let earningValue = 0;
  let annualRent = 0;

  const toNode = (p: Property): StructureProperty => {
    const children = (childrenOf.get(p.id) ?? []).sort((a, b) =>
      (a.unitLabel ?? "").localeCompare(b.unitLabel ?? "", undefined, { numeric: true }),
    );
    const kind = propertyKind(p, children.length > 0);
    const name = p.name || p.buildingName || p.address;
    const projectName = p.projectId ? (projectsById.get(p.projectId) ?? null) : null;

    if (kind === "building") {
      const unitRows: StructureUnit[] = children.map((c) => ({
        id: c.id,
        label: c.unitLabel ? `Unit ${c.unitLabel}` : c.name || c.address,
        tenantName: tenantByProperty.get(c.id) ?? null,
      }));
      const letCount = unitRows.filter((u) => u.tenantName).length;
      units += children.length;
      rentable += children.filter((c) => c.propertyUse !== "owner_occupied").length;
      let_ += letCount;
      const rent = children.reduce((s, c) => s + (rentByProperty.get(c.id) ?? 0), 0);
      if (rent > 0) {
        annualRent += rent * 12;
        earningValue += p.propertyValue || 0;
      }
      return {
        id: p.id,
        name,
        subtitle: `${children.length} unit${children.length === 1 ? "" : "s"} · ${letCount} let`,
        kind,
        value: p.propertyValue || 0,
        projectName,
        unitCount: children.length,
        letCount,
        units: unitRows,
      };
    }

    const tenant = tenantByProperty.get(p.id) ?? null;
    const ownerOccupied = p.propertyUse === "owner_occupied";
    units += 1;
    if (!ownerOccupied) rentable += 1;
    if (tenant) let_ += 1;
    const rent = rentByProperty.get(p.id) ?? 0;
    if (rent > 0) {
      annualRent += rent * 12;
      earningValue += p.propertyValue || 0;
    }
    const typeLabel = p.propertyType && p.propertyType !== "Other" ? p.propertyType : null;
    const subtitle = ownerOccupied
      ? "Owner-occupied"
      : tenant
        ? kind === "commercial"
          ? `Commercial · ${tenant}`
          : `Occupied · ${tenant}`
        : [typeLabel, p.propertyUse === "hold" ? "Held" : "Vacant"].filter(Boolean).join(" · ");
    return {
      id: p.id,
      name,
      subtitle,
      kind,
      value: p.propertyValue || 0,
      projectName,
      unitCount: 1,
      letCount: tenant ? 1 : 0,
      units: [],
    };
  };

  const entitiesById = new Map(input.entities.map((e) => [e.id, e]));
  const groups = new Map<string, StructureOwner>();
  for (const p of topLevel) {
    const e = p.entityId ? entitiesById.get(p.entityId) : undefined;
    const key = e?.id ?? "unassigned";
    let g = groups.get(key);
    if (!g) {
      g = {
        id: key,
        name: e?.name ?? "Unassigned",
        entityType: e?.entityType ?? "UNASSIGNED",
        value: 0,
        properties: [],
      };
      groups.set(key, g);
    }
    const node = toNode(p);
    g.properties.push(node);
    g.value += node.value;
  }

  // Companies first (largest value), then personal, then unassigned.
  const order = { COMPANY: 0, PERSONAL: 1, UNASSIGNED: 2 } as const;
  const owners = Array.from(groups.values())
    .map((g) => ({ ...g, properties: g.properties.sort((a, b) => b.value - a.value) }))
    .sort((a, b) => order[a.entityType] - order[b.entityType] || b.value - a.value);

  const sumBy = (t: StructureOwner["entityType"]) =>
    owners.filter((o) => o.entityType === t).reduce((s, o) => s + o.value, 0);
  const round1 = (n: number) => Math.round(n * 10) / 10;

  return {
    totalValue: owners.reduce((s, o) => s + o.value, 0),
    owners,
    summary: {
      owners: owners.filter((o) => o.entityType !== "UNASSIGNED").length,
      companies: owners.filter((o) => o.entityType === "COMPANY").length,
      properties: topLevel.length,
      units,
      activeTenancies: activeAgreements.filter((a) => ids.has(a.propertyId)).length,
      occupancyPct: rentable ? Math.round((let_ / rentable) * 100) : 0,
      companyOwnedValue: sumBy("COMPANY"),
      personallyOwnedValue: sumBy("PERSONAL"),
      averageYieldPct: earningValue ? round1((annualRent / earningValue) * 100) : 0,
    },
  };
}
