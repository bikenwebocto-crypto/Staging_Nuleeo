// Property CRUD + transfer. Owner-only mutations; reads also accept
// invitee (portfolio-access-contact) credentials.
//
// All cap-sensitive writes (POST + transfer) re-read the cap inside a
// Firestore transaction so two concurrent writes can't both pass an
// otherwise-OK pre-check and put the owner over their plan's cap.

import type { Express } from "express";
import { bucket, db } from "../firebase";
import { FieldValue } from "firebase-admin/firestore";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { logWarn } from "../services/log";
import { resolveUnitCap } from "../services/planLimits";
import { restoreInactiveAfterCapFreed } from "../services/planReconcile";
import { extractFirebaseStoragePath, isOwnedStoragePath } from "../services/storagePath";
import { isPublicHttpsUrl } from "../services/safeRedirect";
import { sanitizeText } from "../services/unicodeSanitize";
import { hasPortfolioPrivilege } from "../services/portfolioPrivilege";
import { ensurePortfolio } from "../services/portfolioBanking";
import { propertyHasActiveTenancy } from "../services/occupancy";
import { prepaidRentActivityRow } from "../services/prepaidActivity";
import { reqStr } from "../util";
import {
  COL,
  type Agreement,
  type DevelopmentStatus,
  type DocumentRecord,
  type EnergyClass,
  type OccupancyStatus,
  type OwnershipType,
  type PortfolioPrivilegeKey,
  type Property,
  type PropertyType,
  type PropertyUse,
  type Tenant,
  type TitleDeedsStatus,
  type Transaction,
  type Unit,
  type User,
} from "../../shared/firestore-schema";

// Runtime allowlists for the union types on Property. Shared between
// create + patch to keep them in lockstep.
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

// Property free-text fields (address, name, addressNumber, …) are display
// strings that land in admin lists, the briefing PDF, and the Ask-Olio prompt,
// so run them through the Unicode sanitizer (NFKC + strip bidi/zero-width
// controls) — the same hygiene firstName/lastName already get. sanitizeText
// applies the length cap after stripping.
const str = (v: unknown, max = 200) =>
  typeof v === "string" ? sanitizeText(v.trim(), max) : undefined;
const strReq = (v: unknown, max = 200) =>
  typeof v === "string" ? sanitizeText(v.trim(), max) : "";
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

// Bedrooms/bathrooms are counts: a non-negative integer with a sane ceiling.
// The plain `num()` allowlist would happily store -1, 2.5, or 9999 — all of
// which corrupt occupancy/listing displays and the public share view. Returns
// the validated count, or undefined for "not provided" / "invalid shape".
// Callers distinguish the two: an explicitly-provided-but-invalid value (e.g.
// -1, 2.5, 9999) is rejected with a 400 via `isInvalidCount` below; a real 0
// is a legitimate count (studio / no separate bathroom) and is preserved.
const MAX_ROOM_COUNT = 50;
const countNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_ROOM_COUNT ? v : undefined;
// True when the field was provided (not undefined) but isn't a valid count.
// Lets the handler 400 on garbage rather than silently dropping it.
const isInvalidCount = (v: unknown): boolean => v !== undefined && countNum(v) === undefined;

// Coordinate range check. Both optional — undefined passes. A provided value
// must be finite and within geographic bounds (a typo otherwise drops the pin
// in the ocean or breaks the map embed). Shared between create + patch.
const isValidLatLng = (lat: number | undefined, lng: number | undefined): boolean => {
  if (lat !== undefined && (!Number.isFinite(lat) || lat < -90 || lat > 90)) return false;
  if (lng !== undefined && (!Number.isFinite(lng) || lng < -180 || lng > 180)) return false;
  return true;
};
// Floor area is stored as a string. Empty / absent passes (optional); a
// provided value must parse to a positive number.
const isValidSqm = (v: unknown): boolean => {
  if (typeof v !== "string" || v.trim() === "") return true;
  const n = Number(v.trim());
  return Number.isFinite(n) && n > 0;
};

// Caller must own the property OR hold a portfolio-access grant whose
// role is granted `privilege` in the portfolio matrix. Returns the
// loaded property when allowed, or null when forbidden (callers send
// 403/404).
//
// IMPORTANT: pass the privilege that matches what the endpoint
// actually returns — e.g. "finance.viewHistory" for the rent/payment
// ledger, "property.view" for plain property details. A blanket "any
// active grant" check would let a low-tier contact (e.g. legal, which
// the matrix denies finance.viewHistory) read data the matrix forbids.
// hasPortfolioPrivilege resolves the owner case to ["owner"], which is
// granted every privilege, so self-reads keep working.
//
// Phase 4: grant/tenancy resolution is keyed SOLELY by the stamped
// portfolioId, so the property's own stamp is threaded through — without it
// a granted contact or tenant would fail closed.
async function loadReadablePropertyOrNull(
  propertyId: string,
  callerUid: string,
  privilege: PortfolioPrivilegeKey,
): Promise<Property | null> {
  const snap = await db().collection(COL.properties).doc(propertyId).get();
  if (!snap.exists) return null;
  const property = snap.data() as Property;
  const allowed = await hasPortfolioPrivilege(
    callerUid,
    property.ownerId,
    privilege,
    property.portfolioId ?? null,
  );
  if (!allowed) return null;
  return property;
}

export function registerPropertyRoutes(app: Express): void {
  // Create a Property doc with all the descriptors collected by
  // AddPropertyDrawer. The route trusts the requesting user as the
  // owner (no admin override).
  app.post("/api/properties", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      // Resolve the cap up front so we can show an early 402 before doing
      // the body-validation work. The AUTHORITATIVE cap check happens
      // again inside the runTransaction below — a concurrent POST that
      // races between this point and the write would otherwise both pass
      // and both create properties.
      const capInfo = await resolveUnitCap(uid);
      if (capInfo.cap !== null && capInfo.used >= capInfo.cap) {
        return res.status(402).json({
          error: "Upgrade required",
          privilege: "units.unlimited",
          plan: capInfo.plan,
          cap: capInfo.cap,
          used: capInfo.used,
          message: `Your current plan allows up to ${capInfo.cap} ${
            capInfo.cap === 1 ? "unit" : "units"
          }. Upgrade to add more.`,
        });
      }

      const address = strReq(body.address, 300);
      const propertyValue = num(body.propertyValue) ?? 0;
      const acquisitionPrice = num(body.acquisitionPrice) ?? 0;

      if (!address) return res.status(400).json({ error: "address is required" });
      if (propertyValue <= 0)
        return res.status(400).json({ error: "propertyValue must be positive" });
      // Reject obviously-bad room counts up front (negative, fractional, or
      // absurdly large) rather than silently dropping them via num(). A real 0
      // (studio / no separate bath) is valid and falls through to countNum.
      if (isInvalidCount(body.bedrooms))
        return res.status(400).json({
          error: `bedrooms must be a whole number between 0 and ${MAX_ROOM_COUNT}`,
        });
      if (isInvalidCount(body.baths))
        return res.status(400).json({
          error: `baths must be a whole number between 0 and ${MAX_ROOM_COUNT}`,
        });
      // Parking is a count like bedrooms/baths — plain num() accepted -1 / 2.5 /
      // 9999, all of which corrupt the listing + public-share view.
      if (isInvalidCount(body.parking))
        return res.status(400).json({
          error: `parking must be a whole number between 0 and ${MAX_ROOM_COUNT}`,
        });
      // Coordinates must be in range — a typo / crafted value otherwise drops a
      // pin in the ocean (or breaks the map embed). Optional; only validate when
      // provided.
      if (!isValidLatLng(num(body.lat), num(body.lng)))
        return res.status(400).json({ error: "lat must be -90..90 and lng -180..180" });
      // Floor area is a positive number (stored as a string). Reject negative /
      // zero / non-numeric so the m² display + per-m² maths stay sane.
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
      const propertyUse = PROPERTY_USES.includes(body.propertyUse as PropertyUse)
        ? (body.propertyUse as PropertyUse)
        : undefined;
      const occupancyStatus = OCCUPANCY_STATUSES.includes(body.occupancyStatus as OccupancyStatus)
        ? (body.occupancyStatus as OccupancyStatus)
        : undefined;

      // Stamp the stable portfolio id alongside ownerId so the record is keyed
      // to the portfolio (which survives an owner transfer). Resolved BEFORE the
      // cap transaction below — ensurePortfolio runs its own transaction and
      // can't nest inside another one.
      const portfolio = await ensurePortfolio(uid);

      const ref = db().collection(COL.properties).doc();
      const now = new Date().toISOString();
      const property: Property = {
        id: ref.id,
        ownerId: uid,
        portfolioId: portfolio.id,
        address,
        propertyValue,
        acquisitionPrice,
        createdAt: now,
        // image URL is validated at write time: only https on a public
        // host. Without this guard, the briefing service downloads the
        // URL server-side (for the PDF embed) — an attacker could set
        // image="http://169.254.169.254/..." or localhost to read
        // cloud-metadata / internal services via the response.
        ...(str(body.name, 200) ? { name: str(body.name, 200)! } : {}),
        ...(() => {
          const raw = strReq(body.image, 1000);
          return raw && isPublicHttpsUrl(raw) ? { image: raw } : {};
        })(),
        ...(num(body.lat) !== undefined ? { lat: num(body.lat)! } : {}),
        ...(num(body.lng) !== undefined ? { lng: num(body.lng)! } : {}),
        ...(propertyType ? { propertyType } : {}),
        ...(str(body.buildingName) ? { buildingName: str(body.buildingName)! } : {}),
        ...(str(body.floor, 50) ? { floor: str(body.floor, 50)! } : {}),
        ...(str(body.sqm, 20) ? { sqm: str(body.sqm, 20)! } : {}),
        ...(countNum(body.bedrooms) !== undefined ? { bedrooms: countNum(body.bedrooms)! } : {}),
        ...(countNum(body.baths) !== undefined ? { baths: countNum(body.baths)! } : {}),
        ...(str(body.builtYear, 10) ? { builtYear: str(body.builtYear, 10)! } : {}),
        ...(energyClass ? { energyClass } : {}),
        ...(str(body.addressNumber, 20) ? { addressNumber: str(body.addressNumber, 20)! } : {}),
        ...(str(body.city, 100) ? { city: str(body.city, 100)! } : {}),
        ...(str(body.postalCode, 20) ? { postalCode: str(body.postalCode, 20)! } : {}),
        ...(str(body.country, 100) ? { country: str(body.country, 100)! } : {}),
        ...(countNum(body.parking) !== undefined ? { parking: countNum(body.parking)! } : {}),
        ...(bool(body.elevator) !== undefined ? { elevator: bool(body.elevator)! } : {}),
        ...(bool(body.heating) !== undefined ? { heating: bool(body.heating)! } : {}),
        ...(bool(body.cooling) !== undefined ? { cooling: bool(body.cooling)! } : {}),
        ...(bool(body.solarPanels) !== undefined ? { solarPanels: bool(body.solarPanels)! } : {}),
        ...(bool(body.storageUnit) !== undefined ? { storageUnit: bool(body.storageUnit)! } : {}),
        ...(ownershipType ? { ownershipType } : {}),
        ...(str(body.companyName) ? { companyName: str(body.companyName)! } : {}),
        ...(titleDeedsStatus ? { titleDeedsStatus } : {}),
        ...(developmentStatus ? { developmentStatus } : {}),
        ...(propertyUse ? { propertyUse } : {}),
        // Current status only applies to a rented-out property — don't store one
        // alongside a hold/invest or owner-occupied use.
        ...(occupancyStatus && propertyUse === "rent" ? { occupancyStatus } : {}),
        ...(str(body.acquisitionYear, 10)
          ? { acquisitionYear: str(body.acquisitionYear, 10)! }
          : {}),
        ...(str(body.developmentYear, 10)
          ? { developmentYear: str(body.developmentYear, 10)! }
          : {}),
        ...(num(body.rentPrice) !== undefined ? { rentPrice: num(body.rentPrice)! } : {}),
      };

      // Atomic cap-check + write. Two concurrent POSTs both pass the
      // pre-check above; without this, both write and the owner exceeds
      // their plan's cap. The transaction reads the where-query inside
      // the transactional snapshot and Firestore retries the closure on
      // contention — the retry sees the other writer's property and
      // bails with capExceeded=true.
      const capCheck = await db().runTransaction(async (t) => {
        if (capInfo.cap === null) {
          t.set(ref, property);
          return { exceeded: false, used: 0 };
        }
        // Re-count inside the txn with the SAME semantics as resolveUnitCap
        // (the pre-check): key on the stable portfolioId — NOT ownerId, which
        // diverges after an owner transfer — and exclude soft-deactivated
        // (status "inactive") properties, which a plan downgrade must not let
        // consume a slot. Counting raw-by-ownerId-including-inactive falsely
        // 402'd downgraded owners who were legitimately under their active cap.
        const q = await t.get(
          db().collection(COL.properties).where("portfolioId", "==", portfolio.id),
        );
        const activeCount = q.docs.filter(
          (d) => (d.data() as Property).status !== "inactive",
        ).length;
        if (activeCount >= capInfo.cap) return { exceeded: true, used: activeCount };
        t.set(ref, property);
        return { exceeded: false, used: activeCount + 1 };
      });

      if (capCheck.exceeded) {
        return res.status(402).json({
          error: "Upgrade required",
          privilege: "units.unlimited",
          plan: capInfo.plan,
          cap: capInfo.cap,
          // The actual active count read inside the txn — not just `cap` — so it
          // matches the pre-check's `used` instead of contradicting it.
          used: capCheck.used,
          message: `Your current plan allows up to ${capInfo.cap} ${
            capInfo.cap === 1 ? "unit" : "units"
          }. Upgrade to add more.`,
        });
      }

      res.status(201).json(property);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to create property") });
    }
  });

  app.get("/api/properties/:id", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const id = reqStr(req.params.id);
    try {
      const property = await loadReadablePropertyOrNull(id, uid, "property.view");
      if (!property) {
        // Don't distinguish 404 vs 403 to non-owners — the property id
        // is opaque, so leaking existence would be enumeration help.
        return res.status(404).json({ error: "Property not found" });
      }

      const [unitSnap, activeTenantsSnap] = await Promise.all([
        db().collection(COL.units).where("propertyId", "==", id).get(),
        db()
          .collection(COL.tenants)
          .where("propertyId", "==", id)
          .where("status", "==", "active")
          .get(),
      ]);
      const units = unitSnap.docs.map((d) => d.data() as Unit);
      const activeTenants = activeTenantsSnap.docs.map((d) => d.data() as Tenant);

      // Occupancy + rent derive from ACTIVE tenancies (Unit.currentTenantId is
      // never written; owner-created properties have no Unit doc, so the old
      // unit-only calc reported €0 / not-occupied for every owner property).
      // Occupancy is purely an active-tenancy signal. Dropped the old
      // `units.some(u => u.currentTenantId)` fallback: Unit.currentTenantId
      // has no production writer (grep-confirmed), so it was always false for
      // owner-created props and pure noise for admin units. `activeTenants` is
      // already the `status == "active"` snapshot — the canonical signal from
      // services/occupancy.ts.
      const occupied = activeTenants.length > 0;
      // Current rent reflects the ACTIVE tenancy (the charged rent) and is €0
      // when vacant. An admin-set Unit.rentAmount is only an expected figure —
      // showing it on a VACANT unit was "phantom rent" the dashboard summary
      // (which reads tenancies) reported as €0, so detail and summary disagreed.
      // Prefer the tenant's rent; fall back to the unit's only when occupied.
      const unitRent = units.reduce((s, u) => s + (u.rentAmount ?? 0), 0);
      const tenancyRent = activeTenants.reduce((s, t) => s + (t.rentAmount ?? 0), 0);
      const rentAmount = occupied ? tenancyRent || unitRent : 0;

      res.json({
        ...property,
        units,
        unitCount: units.length,
        rentAmount,
        occupied,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load property") });
    }
  });

  // Public, UNAUTHENTICATED read for shareable property links. Anyone
  // holding the (opaque, random) property id can open this — it backs
  // the logged-out /properties/:id view on the app subdomain.
  //
  // Fields are WHITELISTED, not blacklisted: only the explicitly-listed
  // public-safe descriptors are returned, so any sensitive field added
  // to Property later (or any field already on the doc) can never
  // silently leak here. Deliberately omitted: ownerId, all financials
  // (propertyValue, acquisitionPrice, rentPrice, acquisitionYear,
  // developmentYear), ownership/company, title deeds, tenant data, units,
  // documents, and transactions.
  app.get("/api/public/properties/:id", async (req, res) => {
    const id = reqStr(req.params.id);
    try {
      const snap = await db().collection(COL.properties).doc(id).get();
      if (!snap.exists) {
        return res.status(404).json({ error: "Property not found" });
      }
      const p = snap.data() as Property;
      res.json({
        id: p.id,
        name: p.name,
        address: p.address,
        addressNumber: p.addressNumber,
        city: p.city,
        country: p.country,
        postalCode: p.postalCode,
        image: p.image,
        lat: p.lat,
        lng: p.lng,
        propertyType: p.propertyType,
        buildingName: p.buildingName,
        floor: p.floor,
        sqm: p.sqm,
        bedrooms: p.bedrooms,
        baths: p.baths,
        builtYear: p.builtYear,
        energyClass: p.energyClass,
        developmentStatus: p.developmentStatus,
        propertyUse: p.propertyUse,
        occupancyStatus: p.occupancyStatus,
        parking: p.parking,
        elevator: p.elevator,
        heating: p.heating,
        cooling: p.cooling,
        solarPanels: p.solarPanels,
        storageUnit: p.storageUnit,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load property") });
    }
  });

  app.get("/api/properties/:id/transactions", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const id = reqStr(req.params.id);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    try {
      // Returning the rent/payment ledger requires finance.viewHistory —
      // the same matrix gate GET /api/owner/transactions enforces. A
      // legal contact (finance.viewHistory=false) must not read it here.
      const property = await loadReadablePropertyOrNull(id, uid, "finance.viewHistory");
      if (!property) {
        return res.status(404).json({ error: "Property not found" });
      }

      // Prepaid rent (Agreement.prepaidRents) never lands in the ledger, so we
      // also pull this property's agreements and synthesize a read-only income
      // row per prepaid lease, merged before the sort/slice so this per-property
      // feed reconciles with the portfolio-level GET /api/owner/transactions.
      const [txSnap, agSnap] = await Promise.all([
        db()
          .collection(COL.transactions)
          .where("propertyId", "==", id)
          .orderBy("timestamp", "desc")
          .limit(limit)
          .get(),
        db().collection(COL.agreements).where("propertyId", "==", id).get(),
      ]);
      const prepaidRows = agSnap.docs
        .map((d) => prepaidRentActivityRow(d.data() as Agreement))
        .filter((t): t is Transaction => t !== null);
      const txns = [...txSnap.docs.map((d) => d.data() as Transaction), ...prepaidRows]
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
        .slice(0, limit);
      res.json(txns);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load property transactions") });
    }
  });

  // Edit an existing property. Only the owner can mutate; everything
  // else is optional and only persisted when provided so partial
  // updates don't wipe unspecified fields.
  app.patch("/api/properties/:id", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const id = reqStr(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      const ref = db().collection(COL.properties).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Property not found" });
      const existing = snap.data() as Property;
      if (existing.ownerId !== uid) return res.status(403).json({ error: "Forbidden" });

      // Same field guards as POST so a direct PATCH can't slip past them.
      if (isInvalidCount(body.parking))
        return res.status(400).json({
          error: `parking must be a whole number between 0 and ${MAX_ROOM_COUNT}`,
        });
      if (!isValidLatLng(num(body.lat), num(body.lng)))
        return res.status(400).json({ error: "lat must be -90..90 and lng -180..180" });
      if (!isValidSqm(body.sqm))
        return res.status(400).json({ error: "sqm must be a positive number" });

      const updates: Record<string, unknown> = {};
      const setIfDefined = (key: keyof Property, value: unknown) => {
        if (value !== undefined) updates[key as string] = value;
      };

      const address = str(body.address, 300);
      if (address) updates.address = address;
      setIfDefined("name", str(body.name, 200));
      // Numeric guards — reject negative or non-finite financial values
      // explicitly rather than silently dropping them. Without this, a
      // fat-fingered "-1200" in rent or a typo'd 0 in propertyValue
      // would silently store / silently fail, and the user thinks
      // their save worked. 400 on garbage; explicit branch on each field.
      const nonNegNumOrNull = (v: unknown): number | null | undefined => {
        if (v === null) return null;
        if (v === undefined) return undefined;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
        return v;
      };
      if (body.propertyValue !== undefined) {
        const pv = nonNegNumOrNull(body.propertyValue);
        if (pv === undefined || pv === null || pv <= 0) {
          return res.status(400).json({ error: "propertyValue must be a positive number" });
        }
        updates.propertyValue = pv;
      }
      if (body.acquisitionPrice !== undefined) {
        const ap = nonNegNumOrNull(body.acquisitionPrice);
        if (ap === undefined) {
          return res.status(400).json({ error: "acquisitionPrice must be a non-negative number" });
        }
        updates.acquisitionPrice = ap;
      }
      // image URL validated against SSRF (https + public host only).
      {
        const raw = str(body.image, 1000);
        if (raw !== undefined && (raw === "" || isPublicHttpsUrl(raw))) {
          // Allow explicit empty string to clear the image; reject any
          // other unsafe URL silently rather than 400-ing the whole patch.
          setIfDefined("image", raw);
        }
      }
      setIfDefined("lat", num(body.lat));
      setIfDefined("lng", num(body.lng));
      if (PROPERTY_TYPES.includes(body.propertyType as PropertyType))
        updates.propertyType = body.propertyType;
      setIfDefined("buildingName", str(body.buildingName));
      setIfDefined("floor", str(body.floor, 50));
      setIfDefined("sqm", str(body.sqm, 20));
      // Same count guard as POST: 400 on negative/fractional/huge, preserve a
      // real 0, leave the field untouched when not provided. Using num() here
      // would silently store -1 / 2.5 / 9999.
      if (isInvalidCount(body.bedrooms))
        return res.status(400).json({
          error: `bedrooms must be a whole number between 0 and ${MAX_ROOM_COUNT}`,
        });
      if (isInvalidCount(body.baths))
        return res.status(400).json({
          error: `baths must be a whole number between 0 and ${MAX_ROOM_COUNT}`,
        });
      setIfDefined("bedrooms", countNum(body.bedrooms));
      setIfDefined("baths", countNum(body.baths));
      setIfDefined("builtYear", str(body.builtYear, 10));
      if (ENERGY_CLASSES.includes(body.energyClass as EnergyClass))
        updates.energyClass = body.energyClass;
      setIfDefined("addressNumber", str(body.addressNumber, 20));
      setIfDefined("city", str(body.city, 100));
      setIfDefined("postalCode", str(body.postalCode, 20));
      setIfDefined("country", str(body.country, 100));
      setIfDefined("parking", countNum(body.parking));
      setIfDefined("elevator", bool(body.elevator));
      setIfDefined("heating", bool(body.heating));
      setIfDefined("cooling", bool(body.cooling));
      setIfDefined("solarPanels", bool(body.solarPanels));
      setIfDefined("storageUnit", bool(body.storageUnit));
      if (OWNERSHIP_TYPES.includes(body.ownershipType as OwnershipType))
        updates.ownershipType = body.ownershipType;
      setIfDefined("companyName", str(body.companyName));
      if (TITLE_STATUSES.includes(body.titleDeedsStatus as TitleDeedsStatus))
        updates.titleDeedsStatus = body.titleDeedsStatus;
      if (DEVELOPMENT_STATUSES.includes(body.developmentStatus as DevelopmentStatus))
        updates.developmentStatus = body.developmentStatus;
      if (PROPERTY_USES.includes(body.propertyUse as PropertyUse))
        updates.propertyUse = body.propertyUse;
      if (OCCUPANCY_STATUSES.includes(body.occupancyStatus as OccupancyStatus))
        updates.occupancyStatus = body.occupancyStatus;
      // Current status only applies to a rented-out property. If the caller
      // switches the use to hold/invest or owner-occupied, drop any stored status
      // so the doc can't keep a contradictory one left over from a prior edit.
      if (updates.propertyUse === "hold" || updates.propertyUse === "owner_occupied") {
        updates.occupancyStatus = FieldValue.delete();
      }
      setIfDefined("acquisitionYear", str(body.acquisitionYear, 10));
      setIfDefined("developmentYear", str(body.developmentYear, 10));
      setIfDefined("rentPrice", num(body.rentPrice));

      if (Object.keys(updates).length === 0)
        return res.status(400).json({ error: "No valid fields to update" });

      await ref.update(updates);
      const after = await ref.get();
      res.json(after.data() as Property);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to update property") });
    }
  });

  // Hard-delete a property. Refused if any unit is occupied — owner
  // must terminate the lease first so we don't orphan tenants/
  // transactions.
  app.delete("/api/properties/:id", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const id = reqStr(req.params.id);
    try {
      const ref = db().collection(COL.properties).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Property not found" });
      const existing = snap.data() as Property;
      if (existing.ownerId !== uid) return res.status(403).json({ error: "Forbidden" });

      const unitSnap = await db().collection(COL.units).where("propertyId", "==", id).get();
      // Occupancy MUST derive from active tenancies, not Unit.currentTenantId
      // (never written; owner-created props have no Unit doc, so the old
      // `unitSnap.some(currentTenantId)` check was always false and let an
      // owner delete a property out from under a live lease). See
      // services/occupancy.ts.
      if (await propertyHasActiveTenancy(id))
        return res.status(409).json({
          error: "Cannot delete a property with an active tenant. Terminate the lease first.",
        });

      // CASCADE — without this, deleting a property left:
      //   - DocumentRecord rows under documents where propertyId == id
      //     (still listed in queries by other endpoints scoped on
      //     propertyId, but the parent is gone)
      //   - Cloud Storage objects under documents/{uid}/{propertyId}/...
      //     and properties/{uid}/... (signed-URL tokens stay valid for
      //     anyone who already has the URL until the file is deleted)
      //   - Pending tenant rows + expired agreement rows
      // Loop tenants by propertyId so the tenancy chain breaks cleanly;
      // transactions intentionally STAY with the previous owner as
      // financial history (consistent with the property-transfer policy).
      const docsSnap = await db().collection(COL.documents).where("propertyId", "==", id).get();
      const tenantsSnap = await db().collection(COL.tenants).where("propertyId", "==", id).get();
      // Agreements MUST be part of the cascade — without this, deleting a
      // property left its lease rows orphaned (pointing at a now-dead
      // propertyId), invisible to both owner and tenant reads (which bail on
      // `if (!property)`) yet still scanned by the rent crons. The active-
      // tenancy guard above already blocked deletes under a live lease, so
      // everything reaching here is non-active (pending/declined/expired/
      // terminated) and safe to remove with the tenancy chain.
      const agreementsSnap = await db()
        .collection(COL.agreements)
        .where("propertyId", "==", id)
        .get();

      // Delete storage objects best-effort. A failure here shouldn't
      // block the property delete itself — the worst case is orphaned
      // bytes (cheap to GC later via a bucket lifecycle rule); the
      // worst case for SKIPPING the delete is leaking the photos/docs
      // via signed URL forever, so we try.
      const b = bucket();
      const storagePaths: string[] = [];
      for (const d of docsSnap.docs) {
        const docData = d.data() as DocumentRecord;
        if (docData.storagePath) storagePaths.push(docData.storagePath);
      }
      // Signed-lease PDFs live on Agreement.signedLeaseDocument.storagePath
      // (under documents/{uid}/{propertyId}/agreements/…), NOT as DocumentRecord
      // rows — so the docs loop above misses them. Collect them off the
      // agreements we're about to delete so the property delete doesn't orphan
      // the signed lease in the bucket. These paths are documents/{uid}/… and so
      // pass the isOwnedStoragePath filter below.
      for (const a of agreementsSnap.docs) {
        const sp = (a.data() as Agreement).signedLeaseDocument?.storagePath;
        if (sp) storagePaths.push(sp);
      }
      // Property photo: stored as a firebasestorage download URL on
      // `property.image`. Extract the storage path from the URL so we
      // can delete the specific object (the upload-url endpoint mints
      // photos under `properties/{uid}/{ts}-{uuid}.{ext}` — flat under
      // the uid, NOT scoped by propertyId — so prefix-listing won't
      // help).
      if (existing.image) {
        const path = extractFirebaseStoragePath(existing.image);
        if (path) storagePaths.push(path);
      }
      // Unit photos (same shape, optional field on Unit).
      for (const u of unitSnap.docs) {
        const unit = u.data() as Unit;
        const uImage = (unit as { image?: string }).image;
        if (typeof uImage === "string" && uImage.length > 0) {
          const path = extractFirebaseStoragePath(uImage);
          if (path) storagePaths.push(path);
        }
      }
      // SECURITY: only delete objects that live under THIS owner's storage
      // prefix. property.image / unit.image are client-supplied URLs (stored
      // after only an https + public-host check), so a crafted
      // firebasestorage URL could aim extractFirebaseStoragePath at another
      // user's object path and destroy their photo/doc on cascade. Every
      // legitimately-owned object is keyed under properties/{uid}/ or
      // documents/{uid}/ — reject anything else. Worst case for a rejected
      // path is an orphaned object (GC'd by the bucket lifecycle rule), never
      // another user's data.
      const safePaths = storagePaths.filter((p) => {
        const owned = isOwnedStoragePath(p, uid);
        if (!owned) {
          logWarn("property_delete.storage-path-rejected", {
            storagePath: p,
            uid,
          });
        }
        return owned;
      });
      await Promise.all(
        safePaths.map((p) =>
          b
            .file(p)
            .delete()
            .catch((err) => {
              logWarn("property_delete.storage-failed", {
                storagePath: p,
                err: String(err).slice(0, 200),
              });
            }),
        ),
      );

      const batch = db().batch();
      unitSnap.docs.forEach((d) => batch.delete(d.ref));
      docsSnap.docs.forEach((d) => batch.delete(d.ref));
      tenantsSnap.docs.forEach((d) => batch.delete(d.ref));
      agreementsSnap.docs.forEach((d) => batch.delete(d.ref));
      batch.delete(ref);
      await batch.commit();

      // Deleting a property frees a cap slot — if the owner has properties that
      // a prior plan-downgrade soft-deactivated, bring back as many as now fit
      // (most-recently-deactivated first; leases within the 30-day grace resume
      // with their original schedule). Best-effort: a restore hiccup must not
      // fail the delete the caller asked for.
      let restored: {
        propertiesRestored: number;
        agreementsResumed: number;
        agreementsTerminated: number;
      } | null = null;
      try {
        const r = await restoreInactiveAfterCapFreed(uid);
        if (r.propertiesRestored > 0 || r.agreementsResumed > 0) restored = r;
      } catch (err) {
        logWarn("property_delete.restore-failed", { uid, err: String(err).slice(0, 200) });
      }

      res.json({
        ok: true,
        cascaded: {
          units: unitSnap.size,
          documents: docsSnap.size,
          tenants: tenantsSnap.size,
          agreements: agreementsSnap.size,
          storageObjects: safePaths.length,
        },
        ...(restored ? { restored } : {}),
      });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to delete property") });
    }
  });

  // Transfer ownership to another Olio user (identified by email).
  // MVP: the recipient must already have an Olio account, and the
  // transfer happens immediately. A pending/accept flow can be layered
  // on later.
  app.post("/api/properties/:id/transfer", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const id = reqStr(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const recipientEmail =
      typeof body.recipientEmail === "string" ? body.recipientEmail.trim().toLowerCase() : "";
    if (!recipientEmail) return res.status(400).json({ error: "recipientEmail is required" });

    try {
      const ref = db().collection(COL.properties).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Property not found" });
      const existing = snap.data() as Property;
      if (existing.ownerId !== uid) return res.status(403).json({ error: "Forbidden" });

      // Block transferring a soft-deactivated property: it's hidden from the
      // source owner's own UI (status "inactive"), and its inactive status +
      // 30-day purge clock — tied to the PREVIOUS owner's plan downgrade — would
      // silently carry to the recipient and purge their docs on someone else's
      // schedule. Restore it (re-upgrade / free cap) before transferring.
      if (existing.status === "inactive")
        return res.status(409).json({
          error: "This property is paused on your plan. Restore it before transferring.",
        });

      // Vacant-only transfer: refuse while a live lease exists. Derived from
      // active tenancies — Unit.currentTenantId is never written, so the old
      // unit-based check always passed and allowed a tenanted transfer, which
      // left the tenancy / agreement / ledger / chat pointing at the OLD owner
      // (split-brain ownership; rent kept routing to the prior owner's Connect
      // account). Blocking active-tenancy transfers keeps the documented
      // "documents/transactions/tenants stay with the previous owner" model
      // safe, since only vacant properties can move.
      if (await propertyHasActiveTenancy(id))
        return res.status(409).json({
          error: "Cannot transfer a rented property. Terminate the lease first.",
        });

      // Also block while an invite is still outstanding: the transfer flips
      // ONLY the Property doc, so a linked Tenant + Agreement left in
      // pending/invited (status "pending_tenant") would keep the OLD ownerId
      // and split-brain the moment the tenant approves (rent would route to the
      // prior owner). Make the owner cancel the invite before transferring.
      const tenancySnap = await db().collection(COL.tenants).where("propertyId", "==", id).get();
      const hasPendingInvite = tenancySnap.docs.some((d) => {
        const status = (d.data() as Tenant).status;
        return status === "pending" || status === "invited";
      });
      if (hasPendingInvite)
        return res.status(409).json({
          error: "This property has a pending tenant invite. Cancel it before transferring.",
        });

      const userSnap = await db()
        .collection(COL.users)
        .where("email", "==", recipientEmail)
        .limit(1)
        .get();
      if (userSnap.empty)
        return res.status(404).json({
          error: "No Olio user found with that email. Ask them to sign up first.",
        });
      const recipient = userSnap.docs[0].data() as User;
      if (recipient.id === uid)
        return res.status(400).json({ error: "You already own this property." });

      // Plan-cap enforcement on the RECIPIENT side. Without this, an
      // attacker could create unlimited burner accounts at Starter (cap=2),
      // fill each with 2 properties, then transfer them all onto one paid
      // account — bypassing the cap on the destination. The transfer is
      // wrapped in a transaction so the cap read + the ownerId flip happen
      // atomically (defends against the same TOCTOU shape the POST
      // /api/properties endpoint already defends against).
      const recipientCap = await resolveUnitCap(recipient.id);
      if (recipientCap.cap !== null && recipientCap.used >= recipientCap.cap) {
        return res.status(402).json({
          error:
            "Recipient is at their plan's unit cap. They need to upgrade before they can accept the transfer.",
          plan: recipientCap.plan,
          cap: recipientCap.cap,
          used: recipientCap.used,
        });
      }

      // The property moves to the RECIPIENT's portfolio along with ownerId —
      // portfolioId is the stable key, so leaving the old one in place would
      // strand the property in the previous owner's portfolio. Resolved
      // BEFORE the transaction below: ensurePortfolio runs its own
      // transaction internally and can't nest inside this one. Get-or-create
      // is deterministic per owner, so resolving early introduces no TOCTOU
      // hazard beyond the cap one the transaction already guards.
      const recipientPortfolio = await ensurePortfolio(recipient.id);

      // Intentional: documents, transactions, and tenant rows stay
      // with the previous owner. They were uploaded/recorded under
      // that owner's identity (storage paths are keyed by ownerId;
      // tenant agreements are contracts between the prior owner and
      // the tenant), and migrating them would mean copying personal
      // records across users. The new owner starts with a clean
      // property. The UI sets this expectation in TransferPropertyDrawer.
      const capExceeded = await db().runTransaction(async (t) => {
        if (recipientCap.cap === null) {
          t.update(ref, { ownerId: recipient.id, portfolioId: recipientPortfolio.id });
          return false;
        }
        // Same semantics as resolveUnitCap (the pre-check above): count the
        // recipient's CURRENT properties by stable portfolioId and exclude
        // soft-deactivated (inactive) ones, so a downgraded recipient's hidden
        // properties don't falsely block a valid transfer with a 402.
        const q = await t.get(
          db().collection(COL.properties).where("portfolioId", "==", recipientPortfolio.id),
        );
        const activeCount = q.docs.filter(
          (d) => (d.data() as Property).status !== "inactive",
        ).length;
        if (activeCount >= recipientCap.cap) return true;
        t.update(ref, { ownerId: recipient.id, portfolioId: recipientPortfolio.id });
        return false;
      });

      if (capExceeded) {
        return res.status(402).json({
          error:
            "Recipient is at their plan's unit cap. They need to upgrade before they can accept the transfer.",
          plan: recipientCap.plan,
          cap: recipientCap.cap,
        });
      }

      res.json({ ok: true, newOwnerId: recipient.id });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to transfer property") });
    }
  });
}
