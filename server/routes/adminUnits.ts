// Admin units mutations: PATCH /api/admin/units/:id and POST
// /api/admin/units. The outer gate is properties.editAny;
// finance.viewAll is required (server-enforced) to edit the financial
// fields rentAmount/propertyValue/acquisitionPrice/rentPrice. The UI
// hides those inputs from non-finance admins but server-side
// enforcement here closes the bypass.

import type { Express, RequestHandler } from "express";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { reqStr } from "../util";
import { logWarn } from "../services/log";
import { isPublicHttpsUrl } from "../services/safeRedirect";
import { hasPlatformPrivilege, resolvePlatformRole } from "../services/platformPrivilege";
import { ensurePortfolio } from "../services/portfolioBanking";
import { resolveUnitCap } from "../services/planLimits";
import { applyRentChange, findActiveAgreementIdForUnit } from "../services/rentChange";
import {
  COL,
  type DevelopmentStatus,
  type EnergyClass,
  type OccupancyStatus,
  type OwnershipType,
  type PlatformPrivilegeKey,
  type Property,
  type PropertyType,
  type PropertyUse,
  type Role,
  type TitleDeedsStatus,
  type Unit,
} from "../../shared/firestore-schema";

const FINANCIAL_FIELDS = ["rentAmount", "propertyValue", "acquisitionPrice", "rentPrice"] as const;

// Enum allowlists — kept in lockstep with the owner path (server/routes/
// properties.ts) so admin- and owner-created properties share one shape.
const PROPERTY_TYPES: PropertyType[] = ["Apartment", "House", "Villa", "Commercial", "Plot"];
const ENERGY_CLASSES: EnergyClass[] = ["A+", "A", "B", "C", "D", "E", "F", "G", "F-G", "N/A"];
const OWNERSHIP_TYPES: OwnershipType[] = ["individual", "company"];
const TITLE_STATUSES: TitleDeedsStatus[] = ["issued", "pending"];
const DEVELOPMENT_STATUSES: DevelopmentStatus[] = [
  "off_plan",
  "under_construction",
  "fully_developed",
];
const PROPERTY_USES: PropertyUse[] = ["hold", "rent", "owner_occupied"];
const OCCUPANCY_STATUSES: OccupancyStatus[] = ["rented", "vacant", "owner_occupied"];

// Count / coordinate / area validators — mirror server/routes/properties.ts so
// the admin path rejects the same negative / fractional / out-of-range values.
const MAX_ROOM_COUNT = 50;
const countNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_ROOM_COUNT ? v : undefined;
const isInvalidCount = (v: unknown): boolean => v !== undefined && countNum(v) === undefined;
const isValidLatLng = (lat: number | undefined, lng: number | undefined): boolean => {
  if (lat !== undefined && (!Number.isFinite(lat) || lat < -90 || lat > 90)) return false;
  if (lng !== undefined && (!Number.isFinite(lng) || lng < -180 || lng > 180)) return false;
  return true;
};
const isValidSqm = (v: unknown): boolean => {
  if (typeof v !== "string" || v.trim() === "") return true;
  const n = Number(v.trim());
  return Number.isFinite(n) && n > 0;
};

export interface AdminUnitsDeps {
  requireRole: (...roles: Role[]) => RequestHandler;
  requirePlatformPrivilege: (p: PlatformPrivilegeKey) => RequestHandler;
}

export function registerAdminUnitsRoutes(
  app: Express,
  { requireRole, requirePlatformPrivilege }: AdminUnitsDeps,
): void {
  // PATCH /api/admin/units/:id — update unit fields and (optionally)
  // the associated property's address / propertyValue / acquisitionPrice.
  app.patch(
    "/api/admin/units/:id",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("properties.editAny"),
    async (req, res) => {
      try {
        // The id may be a Unit.id OR a Property.id (for owner-created
        // properties that never spawned a Unit row). Resolve both.
        const unitRef = db().collection(COL.units).doc(reqStr(req.params.id));
        const unitSnap = await unitRef.get();
        const unit = unitSnap.exists ? (unitSnap.data() as Unit) : null;
        const propertyId = unit?.propertyId ?? reqStr(req.params.id);
        const propRef = db().collection(COL.properties).doc(propertyId);
        const propSnap = await propRef.get();
        if (!unit && !propSnap.exists) return res.status(404).json({ error: "Unit not found" });
        const body = (req.body ?? {}) as Record<string, unknown>;

        // Financial fields require finance.viewAll on top of
        // properties.editAny. The UI hides these inputs from non-
        // finance admins, but we enforce server-side too so a crafted
        // request can't bypass.
        const canFin = await hasPlatformPrivilege(req.user?.profile, "finance.viewAll");
        if (!canFin) {
          for (const k of FINANCIAL_FIELDS) {
            if (k in body) {
              return res.status(403).json({
                error: `Editing ${k} requires the finance.viewAll privilege.`,
              });
            }
          }
        }

        const unitPatch: Record<string, unknown> = {};
        // rentAmount is deliberately NOT in this direct-write list (L-9):
        // for an OCCUPIED unit applyRentChange below is the SOLE writer of
        // rent across Unit + Agreement + Tenant. If we also wrote it here, a
        // transient applyRentChange failure would leave Unit.rentAmount
        // committed while the agreement/tenant lag. The vacant-unit case
        // (no active agreement) writes the unit's rent directly in the rent
        // block below.
        const unitFields: Array<keyof Unit> = [
          "label",
          "paymentStatus",
          "nextPaymentDate",
          "leaseEnd",
        ];
        for (const k of unitFields) {
          if (k in body) unitPatch[k as string] = body[k as string];
        }
        if (
          unitPatch.paymentStatus &&
          !["paid", "pending", "overdue"].includes(unitPatch.paymentStatus as string)
        )
          return res.status(400).json({ error: "invalid paymentStatus" });

        const propPatch: Record<string, unknown> = {};
        const propFields: Array<keyof Property> = [
          "name",
          "address",
          "addressNumber",
          "propertyValue",
          "acquisitionPrice",
          "image",
          "city",
          "country",
          "postalCode",
          "lat",
          "lng",
          "propertyType",
          "buildingName",
          "floor",
          "sqm",
          "builtYear",
          "energyClass",
          "parking",
          "elevator",
          "heating",
          "cooling",
          "solarPanels",
          "storageUnit",
          "ownershipType",
          "companyName",
          "titleDeedsStatus",
          "developmentStatus",
          "propertyUse",
          "occupancyStatus",
          "acquisitionYear",
          "developmentYear",
          "rentPrice",
        ];
        for (const k of propFields) {
          if (k in body) propPatch[k as string] = body[k as string];
        }
        // SSRF guard: image flows through fetchImageAsDataUrl in the
        // briefing service. Block RFC1918/loopback/cloud-metadata at
        // write time so a hostile admin can't read internal services
        // by setting image="https://169.254.169.254/...".
        // Allow an empty string to CLEAR the image (mirrors the owner PATCH);
        // reject only a non-empty, non-public-https URL (SSRF guard).
        if (
          typeof propPatch.image === "string" &&
          propPatch.image !== "" &&
          !isPublicHttpsUrl(propPatch.image as string)
        ) {
          return res.status(400).json({ error: "image must be a public https URL" });
        }
        // Validate enum-shaped fields server-side so a malformed admin
        // payload can't corrupt a property doc.
        if (
          propPatch.propertyType !== undefined &&
          !["Apartment", "House", "Villa", "Commercial", "Plot"].includes(
            propPatch.propertyType as string,
          )
        )
          return res.status(400).json({ error: "invalid propertyType" });
        if (
          propPatch.energyClass !== undefined &&
          !ENERGY_CLASSES.includes(propPatch.energyClass as EnergyClass)
        )
          return res.status(400).json({ error: "invalid energyClass" });
        if (
          propPatch.ownershipType !== undefined &&
          !["individual", "company"].includes(propPatch.ownershipType as string)
        )
          return res.status(400).json({ error: "invalid ownershipType" });
        if (
          propPatch.titleDeedsStatus !== undefined &&
          !["issued", "pending"].includes(propPatch.titleDeedsStatus as string)
        )
          return res.status(400).json({ error: "invalid titleDeedsStatus" });
        if (
          propPatch.developmentStatus !== undefined &&
          !["off_plan", "under_construction", "fully_developed"].includes(
            propPatch.developmentStatus as string,
          )
        )
          return res.status(400).json({ error: "invalid developmentStatus" });
        if (
          propPatch.propertyUse !== undefined &&
          !PROPERTY_USES.includes(propPatch.propertyUse as PropertyUse)
        )
          return res.status(400).json({ error: "invalid propertyUse" });
        if (
          propPatch.occupancyStatus !== undefined &&
          !OCCUPANCY_STATUSES.includes(propPatch.occupancyStatus as OccupancyStatus)
        )
          return res.status(400).json({ error: "invalid occupancyStatus" });

        const writes: Promise<unknown>[] = [];
        // Only touch the unit doc if one exists — don't auto-create
        // one for property-only rows.
        if (unit && Object.keys(unitPatch).length > 0)
          writes.push(unitRef.set(unitPatch, { merge: true }));
        if (Object.keys(propPatch).length > 0) writes.push(propRef.set(propPatch, { merge: true }));
        await Promise.all(writes);

        // A rent change must propagate to the tenancy + agreement, not just
        // the Unit doc — otherwise revenue/occupancy (read from tenancies)
        // and the lease terms drift. Route it through the single writer so
        // all three docs stay in step. applyRentChange is the SOLE writer of
        // rent for an OCCUPIED unit (it writes Unit + Agreement + Tenant in
        // one atomic batch), so we no longer pre-write Unit.rentAmount above
        // (L-9). For a VACANT unit there's no agreement to route through, so
        // the unit's own rentAmount edit is written directly here.
        if ("rentAmount" in body && canFin) {
          const newRent = body.rentAmount;
          if (typeof newRent === "number" && Number.isFinite(newRent)) {
            try {
              const agreementId = await findActiveAgreementIdForUnit(reqStr(req.params.id));
              if (agreementId) {
                await applyRentChange(agreementId, newRent);
              } else if (unit) {
                // Vacant unit: no active agreement to sync through, but the
                // admin's rent edit still has to persist on the Unit doc.
                await unitRef.set({ rentAmount: newRent }, { merge: true });
              }
            } catch (syncErr: unknown) {
              logWarn("admin_units.rent-sync-failed", {
                unitId: req.params.id,
                error: errMsg(syncErr, "rent sync failed"),
              });
            }
          }
        }

        const [updatedUnit, updatedProp] = await Promise.all([
          unit ? unitRef.get() : Promise.resolve(null),
          propRef.get(),
        ]);
        res.json({
          unit: updatedUnit?.data() ?? null,
          property: updatedProp.data(),
        });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to update unit") });
      }
    },
  );

  // POST /api/admin/units — admin creates a property + matching unit
  // on behalf of an owner. The owner-facing POST /api/properties only
  // creates a Property and uses the caller's uid as ownerId; this
  // admin variant accepts an ownerId and provisions both the parent
  // Property and a starter Unit so the unit shows up in admin
  // listings immediately.
  app.post(
    "/api/admin/units",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("properties.editAny"),
    async (req, res) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const str = (v: unknown, max = 200) =>
          typeof v === "string" ? v.trim().slice(0, max) : "";
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

        // Same finance.viewAll gate as PATCH /api/admin/units/:id. A
        // properties.editAny-only admin can create units but can't
        // set financial fields without finance privilege.
        const canFin = await hasPlatformPrivilege(req.user?.profile, "finance.viewAll");
        if (!canFin) {
          for (const k of FINANCIAL_FIELDS) {
            if (k in body) {
              return res.status(403).json({
                error: `Setting ${k} requires the finance.viewAll privilege.`,
              });
            }
          }
        }

        const ownerId = str(body.ownerId, 128);
        const address = str(body.address, 300);
        if (!ownerId) return res.status(400).json({ error: "ownerId is required" });
        if (!address) return res.status(400).json({ error: "address is required" });

        const ownerSnap = await db().collection(COL.users).doc(ownerId).get();
        if (!ownerSnap.exists) return res.status(404).json({ error: "Owner not found" });

        // Plan-cap enforcement, mirroring POST /api/properties. Admin-created
        // properties DO count against the owner via resolveUnitCap (keyed on
        // their portfolioId), so creating past the cap would silently push the
        // owner over their tier and block their OWN future creates. Refuse with
        // a 402 unless a superadmin deliberately overrides (overrideCap:true) —
        // e.g. a comped/support exception. A non-superadmin's flag is ignored.
        const isSuperadmin = resolvePlatformRole(req.user?.profile) === "superadmin";
        const overrideCap = body.overrideCap === true && isSuperadmin;
        if (!overrideCap) {
          const capInfo = await resolveUnitCap(ownerId);
          if (capInfo.cap !== null && capInfo.used >= capInfo.cap) {
            return res.status(402).json({
              error: `This owner is at their plan's unit cap (${capInfo.used}/${capInfo.cap} on ${capInfo.plan}). A superadmin can override.`,
              code: "owner_at_cap",
              plan: capInfo.plan,
              cap: capInfo.cap,
              used: capInfo.used,
            });
          }
        }

        // Same numeric guards as the owner path so the two creation surfaces
        // can't diverge (admin previously accepted -1 / 2.5 / 9999 counts and
        // out-of-range coordinates the owner route rejects).
        if (isInvalidCount(body.bedrooms))
          return res.status(400).json({
            error: `bedrooms must be a whole number between 0 and ${MAX_ROOM_COUNT}`,
          });
        if (isInvalidCount(body.baths))
          return res.status(400).json({
            error: `baths must be a whole number between 0 and ${MAX_ROOM_COUNT}`,
          });
        if (isInvalidCount(body.parking))
          return res.status(400).json({
            error: `parking must be a whole number between 0 and ${MAX_ROOM_COUNT}`,
          });
        if (!isValidLatLng(num(body.lat), num(body.lng)))
          return res.status(400).json({ error: "lat must be -90..90 and lng -180..180" });
        if (!isValidSqm(body.sqm))
          return res.status(400).json({ error: "sqm must be a positive number" });

        const propertyType = PROPERTY_TYPES.includes(body.propertyType as PropertyType)
          ? (body.propertyType as PropertyType)
          : undefined;
        const energyClass = ENERGY_CLASSES.includes(body.energyClass as EnergyClass)
          ? (body.energyClass as EnergyClass)
          : undefined;
        const ownershipType = OWNERSHIP_TYPES.includes(body.ownershipType as OwnershipType)
          ? (body.ownershipType as OwnershipType)
          : undefined;
        const titleDeedsStatus = TITLE_STATUSES.includes(body.titleDeedsStatus as TitleDeedsStatus)
          ? (body.titleDeedsStatus as TitleDeedsStatus)
          : undefined;
        const developmentStatus = DEVELOPMENT_STATUSES.includes(
          body.developmentStatus as DevelopmentStatus,
        )
          ? (body.developmentStatus as DevelopmentStatus)
          : undefined;
        // Admin registers rentable units, so default the use to "rent" (an
        // explicit valid value still wins). Without this the property lands with
        // propertyUse undefined — the add-tenant guard then treats it as legacy
        // "allow through" and dashboards can't classify it as a rental.
        const propertyUse = PROPERTY_USES.includes(body.propertyUse as PropertyUse)
          ? (body.propertyUse as PropertyUse)
          : "rent";
        const occupancyStatus = OCCUPANCY_STATUSES.includes(body.occupancyStatus as OccupancyStatus)
          ? (body.occupancyStatus as OccupancyStatus)
          : undefined;

        const now = new Date().toISOString();
        // Stamp the stable portfolio key alongside ownerId (portfolio re-key
        // Phase 1) — the admin supplies the OWNER, so it's their portfolio.
        const ownerPortfolio = await ensurePortfolio(ownerId);
        const propRef = db().collection(COL.properties).doc();
        const property: Property = {
          id: propRef.id,
          ownerId,
          portfolioId: ownerPortfolio.id,
          address,
          propertyValue: num(body.propertyValue) ?? 0,
          acquisitionPrice: num(body.acquisitionPrice) ?? 0,
          createdAt: now,
          propertyUse,
          // image URL is validated at write time: only https on a
          // public host. Without this guard, the briefing service
          // downloads the URL server-side (for the PDF embed) — an
          // attacker could set image="http://169.254.169.254/..." or
          // localhost to read cloud-metadata / internal services via
          // the response.
          ...(() => {
            const raw = str(body.image, 1000);
            return raw && isPublicHttpsUrl(raw) ? { image: raw } : {};
          })(),
          ...(str(body.name, 200) ? { name: str(body.name, 200) } : {}),
          ...(propertyType ? { propertyType } : {}),
          ...(str(body.sqm, 20) ? { sqm: str(body.sqm, 20) } : {}),
          ...(countNum(body.bedrooms) !== undefined ? { bedrooms: countNum(body.bedrooms) } : {}),
          ...(countNum(body.baths) !== undefined ? { baths: countNum(body.baths) } : {}),
          ...(countNum(body.parking) !== undefined ? { parking: countNum(body.parking) } : {}),
          ...(str(body.builtYear, 10) ? { builtYear: str(body.builtYear, 10) } : {}),
          ...(energyClass ? { energyClass } : {}),
          ...(str(body.addressNumber, 20) ? { addressNumber: str(body.addressNumber, 20) } : {}),
          ...(str(body.buildingName) ? { buildingName: str(body.buildingName) } : {}),
          ...(str(body.floor, 50) ? { floor: str(body.floor, 50) } : {}),
          ...(str(body.city, 100) ? { city: str(body.city, 100) } : {}),
          ...(str(body.postalCode, 20) ? { postalCode: str(body.postalCode, 20) } : {}),
          ...(str(body.country, 100) ? { country: str(body.country, 100) } : {}),
          ...(num(body.lat) !== undefined ? { lat: num(body.lat)! } : {}),
          ...(num(body.lng) !== undefined ? { lng: num(body.lng)! } : {}),
          ...(typeof body.elevator === "boolean" ? { elevator: body.elevator } : {}),
          ...(typeof body.heating === "boolean" ? { heating: body.heating } : {}),
          ...(typeof body.cooling === "boolean" ? { cooling: body.cooling } : {}),
          ...(typeof body.solarPanels === "boolean" ? { solarPanels: body.solarPanels } : {}),
          ...(typeof body.storageUnit === "boolean" ? { storageUnit: body.storageUnit } : {}),
          ...(ownershipType ? { ownershipType } : {}),
          ...(str(body.companyName) ? { companyName: str(body.companyName) } : {}),
          ...(titleDeedsStatus ? { titleDeedsStatus } : {}),
          ...(developmentStatus ? { developmentStatus } : {}),
          // Current status only applies to a rented-out property.
          ...(occupancyStatus && propertyUse === "rent" ? { occupancyStatus } : {}),
          ...(str(body.acquisitionYear, 10)
            ? { acquisitionYear: str(body.acquisitionYear, 10) }
            : {}),
          ...(str(body.developmentYear, 10)
            ? { developmentYear: str(body.developmentYear, 10) }
            : {}),
        };

        // Reuse the property id as the unit doc id (unitId === propertyId).
        // Owner-created properties follow this convention everywhere: the
        // add-tenant path sets unitId = propertyId (portfolio.ts) and the rent-
        // charge path resolves the Unit via doc(tenant.unitId). A random auto-id
        // here would produce an orphan Unit no owner/tenant code path can reach.
        const unitRef = db().collection(COL.units).doc(propRef.id);
        const unit: Unit = {
          id: unitRef.id,
          propertyId: propRef.id,
          rentAmount: num(body.rentAmount) ?? 0,
          paymentStatus: "pending",
          createdAt: now,
          ...(str(body.label, 50) ? { label: str(body.label, 50) } : {}),
        };

        // Resolve the cap once more for the in-transaction recount. The
        // pre-check above (resolveUnitCap) fast-fails the common case, but it's
        // NON-transactional: two concurrent admin creates for the same owner can
        // both pass it and both write, pushing the owner over their tier. So we
        // re-count INSIDE the write transaction with the SAME semantics as the
        // owner path (POST /api/properties) — key on the stable portfolioId, not
        // ownerId, and exclude soft-deactivated ("inactive") properties, which a
        // plan downgrade must not let consume a slot. A superadmin override skips
        // the recount entirely (capInfo would be unlimited or deliberately
        // bypassed). Firestore retries the closure on contention, so the retry
        // sees the other writer's property and bails.
        const capForTxn = overrideCap ? null : (await resolveUnitCap(ownerId)).cap;

        // Write Property + Unit atomically so a failure can't leave a Property
        // without its matching Unit (the old Promise.all could half-complete).
        // The cap recount reads the portfolio's property query INSIDE the txn
        // (all reads before writes, per Firestore rules) so the count reflects
        // any concurrent create the pre-check missed.
        await db().runTransaction(async (t) => {
          if (capForTxn !== null) {
            const q = await t.get(
              db().collection(COL.properties).where("portfolioId", "==", ownerPortfolio.id),
            );
            const activeCount = q.docs.filter(
              (d) => (d.data() as Property).status !== "inactive",
            ).length;
            if (activeCount >= capForTxn) {
              // Mapped by the caller's catch to the same 402 owner_at_cap as the
              // pre-check. Throwing rolls back the transaction so nothing writes.
              throw new Error("owner_at_cap");
            }
          }
          t.set(propRef, property);
          t.set(unitRef, unit);
        });
        res.status(201).json({ property, unit });
      } catch (err: unknown) {
        // The in-transaction cap recount throws "owner_at_cap" when a concurrent
        // create slipped past the pre-check — map it to the SAME 402 the pre-
        // check returns so the two surfaces are indistinguishable to the client.
        if (err instanceof Error && err.message === "owner_at_cap") {
          const capInfo = await resolveUnitCap(
            reqStr((req.body as { ownerId?: unknown })?.ownerId),
          );
          return res.status(402).json({
            error: `This owner is at their plan's unit cap (${capInfo.used}/${capInfo.cap} on ${capInfo.plan}). A superadmin can override.`,
            code: "owner_at_cap",
            plan: capInfo.plan,
            cap: capInfo.cap,
            used: capInfo.used,
          });
        }
        res.status(500).json({ error: errMsg(err, "Failed to create unit") });
      }
    },
  );
}
