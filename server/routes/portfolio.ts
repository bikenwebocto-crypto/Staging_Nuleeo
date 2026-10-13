// Owner-side portfolio dashboard endpoints. Reads resolve their scope via
// resolveOwnerScope so a legacy/legal/financial contact reading a granted
// portfolio gets the owner's data, not their own. The scoped LIST/AGGREGATE
// queries key off scope.portfolioId — the STABLE Portfolio doc id (Phase-2
// re-key; survives an owner transfer) — while doc-level ownership checks stay
// on the maintained ownerId field. Mutations (agreement creation, tenancy
// termination) are owner-self only.

import type { Express, RequestHandler, Response } from "express";
import { randomUUID, createHash } from "node:crypto";
import { auth, bucket, db, storageBucketName } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { logError, logWarn } from "../services/log";
import { notifyUser } from "../services/push";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { signReadUrl } from "../services/signedReadUrl";
import { DOCUMENT_PREFIX } from "../services/storageTypes";
import { applyRentChange } from "../services/rentChange";
import { advanceMonths, computeArrears } from "../services/rentCycle";
import { nextIncreaseDateOnOrAfter } from "../services/leaseDates";
import { authorizePortfolioRead, resolveOwnerScope } from "../services/ownerScope";
import { ensurePortfolio, loadPortfolioBanking } from "../services/portfolioBanking";
import { occupiedPropertyIds } from "../services/occupancy";
import { reqStr } from "../util";
import { sendTenantAgreementInviteEmail } from "../services/transactionalEmail";
import {
  COL,
  MAX_INDEXATION_RATE_PCT,
  type Agreement,
  type AgreementIndexation,
  type AutoRenewalMode,
  type CpiIndexationType,
  type DocumentRecord,
  type OwnerPlanPrivilegeKey,
  type PaymentFrequency,
  type Property,
  type Tenant,
  type Transaction,
  type Unit,
  type User,
} from "../../shared/firestore-schema";
import { isRealizedRent } from "../../shared/realizedRent";
import { derivePaymentStatus } from "../../shared/paymentStatus";

export interface PortfolioDeps {
  requireOwnerPlanPrivilege: (p: OwnerPlanPrivilegeKey) => RequestHandler;
}

export function registerPortfolioRoutes(
  app: Express,
  { requireOwnerPlanPrivilege }: PortfolioDeps,
): void {
  // ── Reads ────────────────────────────────────────────────────────

  app.get("/api/owner/properties", requireAuth, async (req, res) => {
    const scope = await resolveOwnerScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const authz = await authorizePortfolioRead(req.user!.uid, scope, "property.view");
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    // Phase-2 portfolio re-key: scoped list queries key off the STABLE
    // portfolio doc id (survives an owner transfer), not the owner uid. A
    // null portfolioId means the resolved owner has no portfolio — and
    // therefore no data by construction (every create path stamps it) — so
    // we return the empty response without querying.
    const { portfolioId } = scope;
    try {
      if (!portfolioId) return res.json([]);
      const snap = await db()
        .collection(COL.properties)
        .where("portfolioId", "==", portfolioId)
        .get();
      // Hide plan-downgrade soft-deactivated properties from the owner. Their
      // data (and crucially their transaction history) is retained and still
      // surfaces in the Activity feed — only the management view hides them.
      // Absent status ⇒ active. (Owner-created props carry the inactive flag on
      // the Property itself, since they have no Unit doc.)
      const properties = snap.docs
        .map((d) => d.data() as Property)
        .filter((p) => p.status !== "inactive");

      if (properties.length === 0) return res.json([]);

      // Join units (1+ per property) so the client can render rent +
      // occupancy without a follow-up fetch. Firestore's `in` clause
      // tops out at 30 values so we chunk.
      const propertyIds = properties.map((p) => p.id);
      const unitChunks: string[][] = [];
      for (let i = 0; i < propertyIds.length; i += 30) {
        unitChunks.push(propertyIds.slice(i, i + 30));
      }
      const unitSnaps = await Promise.all(
        unitChunks.map((c) => db().collection(COL.units).where("propertyId", "in", c).get()),
      );
      const unitsByProperty = new Map<string, Unit[]>();
      unitSnaps.forEach((s) =>
        s.docs.forEach((d) => {
          const u = d.data() as Unit;
          // Skip soft-deactivated units so unitCount + rent reflect only active
          // ones (multi-unit properties can have a mix; owner-created props have
          // no Unit docs at all).
          if (u.status === "inactive") return;
          const arr = unitsByProperty.get(u.propertyId) ?? [];
          arr.push(u);
          unitsByProperty.set(u.propertyId, arr);
        }),
      );

      // Occupancy + rent come from active tenancies, not Unit docs: owner-
      // created properties never get a Unit row (the agreement reuses
      // propertyId as unitId), so a unit-only calc shows every owner
      // property as vacant/€0 the moment a tenant is added. Active
      // tenancies are the real source and exist for both creation paths.
      const tenantSnap = await db()
        .collection(COL.tenants)
        .where("portfolioId", "==", portfolioId)
        .get();
      const activeTenantByProperty = new Map<string, Tenant>();
      // A "pending"/"invited" tenancy is one the owner created but the tenant
      // hasn't approved yet. It generates no revenue, so it stays OUT of the
      // active-only occupancy/summary math — but it IS a real tenant lined up,
      // so we surface it as a distinct "pending" state. Otherwise the list and
      // dashboard show an "Add tenant" CTA right after the owner added one,
      // making the invite look like it never happened.
      const pendingTenantByProperty = new Map<string, Tenant>();
      const allTenancies: Tenant[] = [];
      tenantSnap.docs.forEach((d) => {
        const t = d.data() as Tenant;
        allTenancies.push(t);
        if (t.status === "active" && !activeTenantByProperty.has(t.propertyId)) {
          activeTenantByProperty.set(t.propertyId, t);
        }
        if (
          (t.status === "pending" || t.status === "invited") &&
          !pendingTenantByProperty.has(t.propertyId)
        ) {
          pendingTenantByProperty.set(t.propertyId, t);
        }
      });
      // Canonical occupancy set: derived purely from active tenancies via the
      // shared helper. Dropped the old `units.some(u => u.currentTenantId)`
      // fallback — Unit.currentTenantId has no production writer, so it was
      // always false for owner props and noise for admin units. See
      // services/occupancy.ts.
      const occupiedIds = occupiedPropertyIds(allTenancies);

      const payload = properties
        .map((p) => {
          const units = unitsByProperty.get(p.id) ?? [];
          const activeTenant = activeTenantByProperty.get(p.id);
          const pendingTenant = pendingTenantByProperty.get(p.id);
          // `occupied` stays active-only so revenue/occupancy analytics that
          // read it are unaffected. `tenancyState` is the three-way display
          // signal: occupied (live lease) → pending (invite awaiting approval)
          // → vacant (neither).
          const occupied = occupiedIds.has(p.id);
          const unitRent = units.reduce((s, u) => s + (u.rentAmount ?? 0), 0);
          // Current rent = the ACTIVE tenancy's charged rent, €0 when vacant. An
          // admin-set Unit.rentAmount is only an expected figure: surfacing it on
          // a vacant unit showed "phantom rent" the summary (tenancy-derived)
          // reported as €0, so list and summary disagreed. Prefer the tenant's
          // rent; fall back to the unit's only when occupied.
          const rentAmount = occupied ? (activeTenant?.rentAmount ?? unitRent) : 0;
          const tenancyState: "occupied" | "pending" | "vacant" = occupied
            ? "occupied"
            : pendingTenant
              ? "pending"
              : "vacant";
          return {
            ...p,
            unitCount: units.length,
            rentAmount,
            occupied,
            tenancyState,
            tenantName: activeTenant?.name ?? pendingTenant?.name ?? (occupied ? "Occupied" : null),
          };
        })
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

      res.json(payload);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load properties") });
    }
  });

  app.get("/api/owner/agreements", requireAuth, async (req, res) => {
    const scope = await resolveOwnerScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const authz = await authorizePortfolioRead(req.user!.uid, scope, "agreement.view");
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    // ownerId still keys the owner's USER doc below (display name); the list
    // query itself is keyed by the stable portfolio id (Phase-2 re-key) —
    // null portfolio → no data by construction.
    const { ownerId, portfolioId } = scope;
    try {
      if (!portfolioId) return res.json([]);
      const snap = await db()
        .collection(COL.agreements)
        .where("portfolioId", "==", portfolioId)
        .get();
      const agreements = snap.docs
        .map((d) => d.data() as Agreement)
        // Hide "draft" (never surfaced) and "suspended" (plan-downgrade hold) —
        // a suspended lease is paused and its property is hidden, so it drops
        // out of the owner's lease list. Its transactions still show in Activity.
        .filter((a) => a.status !== "draft" && a.status !== "suspended");

      if (agreements.length === 0) return res.json([]);

      const tenantIds = Array.from(new Set(agreements.map((a) => a.tenantId)));
      const propertyIds = Array.from(new Set(agreements.map((a) => a.propertyId)));
      const unitIds = Array.from(new Set(agreements.map((a) => a.unitId)));

      // One batched read per collection — was N round-trips per id.
      const tenantRefs = tenantIds.map((id) => db().collection(COL.tenants).doc(id));
      const propertyRefs = propertyIds.map((id) => db().collection(COL.properties).doc(id));
      const unitRefs = unitIds.map((id) => db().collection(COL.units).doc(id));
      const [tenantDocs, propertyDocs, unitDocs, ownerDoc] = await Promise.all([
        tenantRefs.length ? db().getAll(...tenantRefs) : Promise.resolve([]),
        propertyRefs.length ? db().getAll(...propertyRefs) : Promise.resolve([]),
        unitRefs.length ? db().getAll(...unitRefs) : Promise.resolve([]),
        db().collection(COL.users).doc(ownerId).get(),
      ]);

      const ownerUser = ownerDoc.exists ? (ownerDoc.data() as User) : null;
      // Mirror the tenant endpoint's ownerLabel() fallback so a name-less
      // owner shows their email as the landlord on BOTH personas' documents
      // (not email for the tenant but a bare "—" for the owner).
      const ownerName = ownerUser
        ? `${ownerUser.firstName ?? ""} ${ownerUser.lastName ?? ""}`.trim() || ownerUser.email || ""
        : "";

      const tenantsById = new Map<string, Tenant>();
      tenantDocs.forEach((s) => s.exists && tenantsById.set(s.id, s.data() as Tenant));
      // Tenant docs only carry name + email. The phone number — and the
      // tenant's real first/last name once they've registered — live on the
      // linked User account (Tenant.name is seeded to the invite email at
      // creation and never updated on signup). Batch-read those Users so the
      // owner sees full contact details, not just the invite email, on the
      // agreement list + modal. Invited-but-not-yet-registered tenants have no
      // userId and simply resolve to no phone.
      const tenantUserIds = Array.from(
        new Set(
          Array.from(tenantsById.values())
            .map((t) => t.userId)
            .filter((id): id is string => !!id),
        ),
      );
      const tenantUserDocs = tenantUserIds.length
        ? await db().getAll(...tenantUserIds.map((id) => db().collection(COL.users).doc(id)))
        : [];
      const tenantUsersById = new Map<string, User>();
      tenantUserDocs.forEach((s) => s.exists && tenantUsersById.set(s.id, s.data() as User));
      const propertiesById = new Map<string, Property>();
      propertyDocs.forEach((s) => s.exists && propertiesById.set(s.id, s.data() as Property));
      const unitsById = new Map<string, Unit>();
      unitDocs.forEach((s) => s.exists && unitsById.set(s.id, s.data() as Unit));

      const payload = agreements
        .map((a) => {
          const tenant = tenantsById.get(a.tenantId);
          const tenantUser = tenant?.userId ? tenantUsersById.get(tenant.userId) : undefined;
          // Prefer the registered tenant's real name over the placeholder
          // (Tenant.name is the invite email until they sign up); fall back to
          // that placeholder, then "—".
          const tenantFullName = tenantUser
            ? `${tenantUser.firstName ?? ""} ${tenantUser.lastName ?? ""}`.trim()
            : "";
          const property = propertiesById.get(a.propertyId);
          const unit = unitsById.get(a.unitId);
          if (!property) return null;
          // Drop leases whose property/unit was soft-deactivated — hidden from
          // the owner's management views (activity history is unaffected).
          if (property.status === "inactive" || unit?.status === "inactive") return null;
          const monthlyRent = a.monthlyRent ?? unit?.rentAmount ?? tenant?.rentAmount ?? 0;
          // A lease counts as electronically signed only once the tenant has
          // accepted it (acceptedAt). Pending/declined leases are NOT signed —
          // mirror the tenant endpoint so the shared agreement document renders
          // the same signature state for both personas.
          const isSignedStatus =
            a.status === "active" || a.status === "expired" || a.status === "terminated";
          const signedAt = a.acceptedAt ?? (isSignedStatus ? (a.signedAt ?? null) : null);
          return {
            id: a.id,
            status: a.status,
            leaseType:
              a.leaseType ??
              (property.propertyType === "Commercial" ? "Commercial Lease" : "Residential Lease"),
            tenantId: a.tenantId,
            tenantName: tenantFullName || tenant?.name || "—",
            tenantEmail: tenant?.email ?? tenantUser?.email ?? "",
            tenantPhone: tenantUser?.phone ?? null,
            // The tenant's linked User.id, or null until they accept their
            // invite. The agreement drawer uses this to gate the "Message
            // tenant" button — there's no chattable counterpart until sign-up.
            tenantUserId: tenant?.userId ?? null,
            owner: ownerName,
            propertyId: property.id,
            unitId: a.unitId,
            address: unit?.label ? `${unit.label}, ${property.address}` : property.address,
            propertyImage: property.image ?? null,
            monthlyRent,
            deposit: a.deposit ?? monthlyRent * 2,
            agreementValue: a.agreementValue,
            startDate: a.startDate,
            endDate: a.endDate,
            signedAt,
            // Fresh signed URL minted below from signedLeaseDocument.storagePath;
            // falls back to the legacy documentUrl when no attachment exists.
            documentUrl: a.documentUrl ?? null,
            documentName: a.signedLeaseDocument?.name ?? null,
            documentSize: a.signedLeaseDocument?.size ?? null,
            documentUploadedAt: a.signedLeaseDocument?.uploadedAt ?? null,
            // Payment day isn't collected directly — fall back to the day of
            // month of the owner-chosen next payment date so existing leases
            // (which never stored paymentDayOfMonth) show a real day not "—".
            paymentDayOfMonth:
              a.paymentDayOfMonth ??
              (a.nextPaymentDate && !Number.isNaN(Date.parse(a.nextPaymentDate))
                ? new Date(a.nextPaymentDate).getUTCDate()
                : null),
            noticePeriodMonths: a.noticePeriodMonths ?? null,
            // Owner-entered lease terms (set in AddTenantDrawer). Surfaced so
            // the owner's agreement view + PDF match the tenant's exactly.
            paymentFrequency: a.paymentFrequency ?? null,
            rentalDurationMonths: a.rentalDurationMonths ?? null,
            rentFreePeriodMonths: a.rentFreePeriodMonths ?? null,
            prepaidRents: a.prepaidRents ?? null,
            autoRenewal: a.autoRenewal ?? null,
            indexation: a.indexation ?? null,
            termsAndConditions: a.termsAndConditions ?? null,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => (a.startDate < b.startDate ? 1 : -1));

      // Mint a fresh, short-lived signed read URL for each lease that has an
      // uploaded signed-lease PDF (M-23: storagePath is the durable truth, the
      // URL is signed per-read and never persisted). Only the agreements that
      // actually carry an attachment incur a signing round-trip.
      const docPathById = new Map<string, string>();
      agreements.forEach((a) => {
        if (a.signedLeaseDocument?.storagePath)
          docPathById.set(a.id, a.signedLeaseDocument.storagePath);
      });
      const signedPayload = docPathById.size
        ? await Promise.all(
            payload.map(async (p) => {
              const sp = docPathById.get(p.id);
              if (!sp) return p;
              const url = await signReadUrl(sp);
              return url ? { ...p, documentUrl: url } : p;
            }),
          )
        : payload;

      res.json(signedPayload);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load agreements") });
    }
  });

  app.get("/api/owner/tenants", requireAuth, async (req, res) => {
    const scope = await resolveOwnerScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const authz = await authorizePortfolioRead(req.user!.uid, scope, "tenant.view");
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    // Phase-2 re-key: tenancy roster + the rent ledger below both key off the
    // stable portfolio id. Null portfolio → no data by construction.
    const { portfolioId } = scope;
    try {
      if (!portfolioId) return res.json([]);
      const snap = await db().collection(COL.tenants).where("portfolioId", "==", portfolioId).get();
      const tenants = snap.docs.map((d) => d.data() as Tenant);

      if (tenants.length === 0) return res.json([]);

      const propertyIds = Array.from(new Set(tenants.map((t) => t.propertyId)));
      const unitIds = Array.from(new Set(tenants.map((t) => t.unitId)));
      // Real name + phone live on the linked User, not the Tenant doc
      // (Tenant.name is the invite email until they sign up). Same join as
      // GET /api/owner/agreements.
      const userIds = Array.from(
        new Set(tenants.map((t) => t.userId).filter((id): id is string => !!id)),
      );

      // Batch via getAll — was a fan-out of N reads per id.
      const propertyRefs = propertyIds.map((id) => db().collection(COL.properties).doc(id));
      const unitRefs = unitIds.map((id) => db().collection(COL.units).doc(id));
      const userRefs = userIds.map((id) => db().collection(COL.users).doc(id));
      const [propertyDocs, unitDocs, userDocs] = await Promise.all([
        propertyRefs.length ? db().getAll(...propertyRefs) : Promise.resolve([]),
        unitRefs.length ? db().getAll(...unitRefs) : Promise.resolve([]),
        userRefs.length ? db().getAll(...userRefs) : Promise.resolve([]),
      ]);
      const propertiesById = new Map<string, Property>();
      propertyDocs.forEach((s) => s.exists && propertiesById.set(s.id, s.data() as Property));
      const unitsById = new Map<string, Unit>();
      unitDocs.forEach((s) => s.exists && unitsById.set(s.id, s.data() as Unit));
      const usersById = new Map<string, User>();
      userDocs.forEach((s) => s.exists && usersById.set(s.id, s.data() as User));

      // Payment status per tenancy is DERIVED from the rent ledger, not
      // Unit.paymentStatus (never written for owner-created properties — they
      // have no Unit doc, so the tile was permanently null). Rule: overdue when
      // the current due date has passed; else paid if any rent has been
      // collected for the tenancy; else pending. Only meaningful for an active
      // tenancy. Two equality filters need no composite index.
      const today = new Date().toISOString().slice(0, 10);
      const rentTxSnap = await db()
        .collection(COL.transactions)
        .where("portfolioId", "==", portfolioId)
        .where("category", "==", "rent")
        .get();
      // Per-tenancy realized-rent index. `tenanciesWithPaidRent` = ever settled
      // (paid-up vs brand-new); `paidPeriodsByTenancy` = which specific cycles
      // are settled, so the pill resets each period (a payment advancing
      // nextPayment leaves the new cycle un-settled = pending, not "paid
      // forever"). Only realized rent counts — unverified pending offline rent
      // must not flip the tile (same shared predicate as the income sites).
      const tenanciesWithPaidRent = new Set<string>();
      const paidPeriodsByTenancy = new Map<string, Set<string>>();
      rentTxSnap.docs.forEach((d) => {
        const tx = d.data() as Transaction;
        if (!isRealizedRent(tx) || !tx.tenantId) return;
        tenanciesWithPaidRent.add(tx.tenantId);
        if (tx.rentPeriod) {
          const set = paidPeriodsByTenancy.get(tx.tenantId) ?? new Set<string>();
          set.add(tx.rentPeriod.slice(0, 10));
          paidPeriodsByTenancy.set(tx.tenantId, set);
        }
      });
      // Derive the pill from the shared cycle-aware predicate (owner, tenant and
      // admin all route through it). NOTE: the old admin Unit.paymentStatus
      // override is intentionally gone — it could silently mask the real ledger
      // state with no audit trail; the ledger is now the single source.
      const derivePaymentStatusForTenancy = (t: Tenant): "paid" | "pending" | "overdue" | null => {
        if (t.status !== "active") return null;
        const due = (t.nextPayment ?? "").slice(0, 10);
        return derivePaymentStatus({
          nextDue: due,
          today,
          currentCyclePaid: !!due && (paidPeriodsByTenancy.get(t.id)?.has(due) ?? false),
          hasSettledHistory: tenanciesWithPaidRent.has(t.id),
        });
      };

      const payload = tenants
        // Hide tenancies whose property/unit was soft-deactivated — they belong
        // to a hidden property. Their payment history is untouched and still
        // shows in Activity; only this management roster hides them.
        .filter((t) => {
          const property = propertiesById.get(t.propertyId);
          const unit = unitsById.get(t.unitId);
          return property?.status !== "inactive" && unit?.status !== "inactive";
        })
        .map((t) => {
          const property = propertiesById.get(t.propertyId);
          const unit = unitsById.get(t.unitId);
          const user = t.userId ? usersById.get(t.userId) : undefined;
          // Prefer the registered tenant's real name over the email placeholder.
          const fullName = user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() : "";
          return {
            id: t.id,
            userId: t.userId ?? null,
            name: fullName || t.name,
            email: t.email ?? user?.email ?? "",
            phone: user?.phone ?? null,
            status: t.status,
            rentAmount: t.rentAmount ?? unit?.rentAmount ?? 0,
            nextPayment: t.nextPayment ?? unit?.nextPaymentDate ?? null,
            paymentStatus: derivePaymentStatusForTenancy(t),
            outstandingBalance: t.outstandingBalance ?? 0,
            propertyId: t.propertyId,
            propertyAddress: property?.address ?? null,
            propertyImage: property?.image ?? null,
            unitId: t.unitId,
            unitLabel: unit?.label ?? null,
            createdAt: t.createdAt,
          };
        })
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

      res.json(payload);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load tenants") });
    }
  });

  app.get("/api/owner/summary", requireAuth, async (req, res) => {
    const scope = await resolveOwnerScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const authz = await authorizePortfolioRead(req.user!.uid, scope, "analytics.viewPortfolio");
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    // Phase-2 re-key: the aggregate sweeps key off the stable portfolio id.
    // Null portfolio → no data by construction → zeroed summary, no queries.
    const { portfolioId } = scope;
    try {
      const ZERO_SUMMARY = {
        unitCount: 0,
        portfolioValue: 0,
        monthlyRevenue: 0,
        occupancyRate: 0,
        equityInvested: 0,
      };
      if (!portfolioId) return res.json(ZERO_SUMMARY);
      const propertySnap = await db()
        .collection(COL.properties)
        .where("portfolioId", "==", portfolioId)
        .get();
      // Exclude plan-downgrade soft-deactivated properties from EVERY dashboard
      // aggregate (value, equity, unit count, revenue, occupancy) so a hidden
      // property doesn't keep inflating the owner's numbers. Absent ⇒ active.
      const properties = propertySnap.docs
        .map((d) => d.data() as Property)
        .filter((p) => p.status !== "inactive");
      const activePropertyIds = new Set(properties.map((p) => p.id));

      if (properties.length === 0) {
        return res.json(ZERO_SUMMARY);
      }

      const propertyIds = properties.map((p) => p.id);
      const unitChunks: string[][] = [];
      for (let i = 0; i < propertyIds.length; i += 30) {
        unitChunks.push(propertyIds.slice(i, i + 30));
      }
      const unitSnaps = await Promise.all(
        unitChunks.map((c) => db().collection(COL.units).where("propertyId", "in", c).get()),
      );
      const units = unitSnaps
        .flatMap((s) => s.docs.map((d) => d.data() as Unit))
        .filter((u) => u.status !== "inactive");

      const portfolioValue = properties.reduce((s, p) => s + (p.propertyValue ?? 0), 0);
      const equityInvested = properties.reduce(
        (s, p) => s + (p.acquisitionPrice || (p.propertyValue ?? 0) * 0.8),
        0,
      );

      // Revenue + occupancy come from the active tenancies, NOT from Unit
      // docs. Owner-created properties never get a separate Unit row (the
      // agreement reuses propertyId as unitId), and no flow ever writes
      // Unit.currentTenantId — so a unit-based calc reads 0/vacant the
      // moment an owner adds a tenant. Active tenancies exist for both
      // owner- and admin-created properties, so they're the real source.
      const tenantSnap = await db()
        .collection(COL.tenants)
        .where("portfolioId", "==", portfolioId)
        .get();
      const activeTenancies = tenantSnap.docs
        .map((d) => d.data() as Tenant)
        // Active tenancies on a still-active property only. A suspended lease's
        // tenancy stays status "active" (so resume is clean), so without the
        // property-id intersection a hidden property's rent would keep counting
        // toward the owner's revenue/occupancy.
        .filter((t) => t.status === "active" && activePropertyIds.has(t.propertyId));

      const monthlyRevenue = activeTenancies.reduce((s, t) => s + (t.rentAmount ?? 0), 0);
      // One occupied slot per active tenancy's unit (unitId === propertyId
      // for owner-created props). Denominator is the unit count when admin
      // units exist, else the property count.
      const occupiedUnitIds = new Set(activeTenancies.map((t) => t.unitId));
      const occupancyDenominator = units.length || properties.length;
      const occupancyRate = occupancyDenominator
        ? Math.min(100, Math.round((occupiedUnitIds.size / occupancyDenominator) * 100))
        : 0;

      res.json({
        unitCount: units.length || properties.length,
        portfolioValue,
        monthlyRevenue,
        occupancyRate,
        equityInvested,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load summary") });
    }
  });

  // ── Mutations ─────────────────────────────────────────────────────

  // POST /api/owner/agreements — create a Tenant + Agreement for one
  // of the caller's own properties. Backs the AddTenantDrawer
  // ("Add Agreement") on the user app. Gated on tenants.invite so the
  // paywall the UI shows is also real at the edge.
  //
  // If the target email already has a Firebase Auth account, no invite
  // link is generated and the existing user is linked to the new
  // Tenant doc. Otherwise we DO NOT pre-create accounts on arbitrary
  // emails (that path used to let an owner take over a victim's email
  // via a returned password-reset link); the tenancy is stored with
  // userId=null + status="invited" and /api/me auto-links it when the
  // real tenant signs up.
  app.post(
    "/api/owner/agreements",
    requireAuth,
    // The endpoint creates a Tenant doc AND an Agreement doc, so it
    // requires both privileges. tenants.invite is checked first (it's
    // the user-facing label on the button); contracts.create is the
    // underlying document-creation capability. Defaults match, but an
    // admin who narrows either matrix column blocks this endpoint
    // accordingly.
    requireOwnerPlanPrivilege("tenants.invite"),
    requireOwnerPlanPrivilege("contracts.create"),
    async (req, res) => {
      const { uid: callerUid } = req.user!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

      const tenantEmail = str(body.tenantEmail).toLowerCase();
      const propertyId = str(body.propertyId);
      const rentAmount = num(body.rentAmount) ?? 0;
      const deposit = num(body.deposit) ?? 0;
      const startDate = str(body.startDate);
      const signatureDate = str(body.signatureDate) || undefined;
      const nextPaymentDate = str(body.nextPaymentDate) || undefined;
      // The day of the month rent falls due. The form doesn't collect it
      // separately, so derive it from the day component of the owner-chosen
      // next payment date — this is what the agreement document shows.
      const paymentDayOfMonth =
        nextPaymentDate && !Number.isNaN(Date.parse(nextPaymentDate))
          ? new Date(nextPaymentDate).getUTCDate()
          : undefined;
      const prepaidRents = num(body.prepaidRents);
      const rentFreePeriodMonths = num(body.rentFreePeriodMonths);
      // Push the first *chargeable* due date past BOTH the prepaid window (rent
      // already paid up front) AND the rent-free window (months granted free),
      // so the rent-reminder cron doesn't dun the tenant during either. The two
      // offsets STACK (e.g. 3 prepaid + 2 rent-free → first due 5 months out).
      // (Values are in months; advancing by months also lands on the right
      // boundary for quarterly/yearly leases when each is a whole number of
      // periods.) Negative/fractional values are rejected by the validation
      // block below; the max/floor here is belt-and-braces. Applied once here at
      // creation; the PATCH edit
      // endpoint never writes nextPaymentDate/prepaidRents, so this offset is
      // not re-applied (no double-count).
      const freeMonthsOffset =
        Math.max(0, Math.floor(prepaidRents ?? 0)) +
        Math.max(0, Math.floor(rentFreePeriodMonths ?? 0));
      const effectiveNextPaymentDate =
        nextPaymentDate && freeMonthsOffset > 0
          ? advanceMonths(nextPaymentDate, freeMonthsOffset)
          : nextPaymentDate;
      const rentalDurationMonths = num(body.rentalDurationMonths) ?? 12;
      const noticePeriodMonths = num(body.noticePeriodMonths);
      const fixedRenewalMonths = num(body.fixedRenewalMonths);
      const ownerIndexation = num(body.ownerIndexation);
      const indexationDelay = num(body.indexationDelay);
      // Free-text clauses. Generous cap (str defaults to 200) so a full
      // page of conditions survives; empty string → undefined so we don't
      // persist a blank field.
      const termsAndConditions = str(body.termsAndConditions, 20000) || undefined;

      const FREQS: PaymentFrequency[] = ["monthly", "quarterly", "yearly"];
      const paymentFrequency: PaymentFrequency = FREQS.includes(
        body.paymentFrequency as PaymentFrequency,
      )
        ? (body.paymentFrequency as PaymentFrequency)
        : "monthly";
      const indexationFrequency: PaymentFrequency = FREQS.includes(
        body.indexationFrequency as PaymentFrequency,
      )
        ? (body.indexationFrequency as PaymentFrequency)
        : "yearly";
      const AUTO_RENEW: AutoRenewalMode[] = ["none", "auto", "fixed"];
      const autoRenewal: AutoRenewalMode = AUTO_RENEW.includes(body.autoRenewal as AutoRenewalMode)
        ? (body.autoRenewal as AutoRenewalMode)
        : "none";
      const CPI_TYPES: CpiIndexationType[] = ["fixed", "cpi", "custom"];
      const cpiType: CpiIndexationType | undefined = CPI_TYPES.includes(
        body.cpiType as CpiIndexationType,
      )
        ? (body.cpiType as CpiIndexationType)
        : undefined;

      // Validate up front so we don't half-create.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tenantEmail)) {
        return res.status(400).json({ error: "valid tenantEmail is required" });
      }
      if (!propertyId) {
        return res.status(400).json({ error: "propertyId is required" });
      }
      if (rentAmount <= 0) {
        return res.status(400).json({ error: "rentAmount must be positive" });
      }
      if (!startDate || Number.isNaN(Date.parse(startDate))) {
        return res.status(400).json({ error: "startDate is required (YYYY-MM-DD)" });
      }
      // Bound the indexation rate so the daily sweep can't auto-apply a
      // runaway compound increase from a typo or a crafted request. The
      // client is UI-only; this is the real gate. See MAX_INDEXATION_RATE_PCT.
      if (
        ownerIndexation !== undefined &&
        (ownerIndexation < 0 || ownerIndexation > MAX_INDEXATION_RATE_PCT)
      ) {
        return res.status(400).json({
          error: `Indexation rate must be between 0 and ${MAX_INDEXATION_RATE_PCT}%`,
        });
      }
      // Non-negative deposit — mirror the PATCH-edit guard so a direct POST
      // can't persist a negative deposit into the lease/PDF.
      if (deposit < 0) {
        return res.status(400).json({ error: "Deposit can't be negative" });
      }
      // Lease term must be a sane positive whole number of months. The client
      // <select> caps the choice, but the server is the real gate: a direct POST
      // with a negative or fractional value would otherwise produce an endDate
      // BEFORE startDate (advanceMonths below) and a corrupted agreementValue.
      // Mirrors the PATCH guard's "end date must be after start date" invariant.
      if (
        !Number.isInteger(rentalDurationMonths) ||
        rentalDurationMonths < 1 ||
        rentalDurationMonths > 600
      ) {
        return res.status(400).json({
          error: "Lease duration must be a whole number of months between 1 and 600",
        });
      }
      // Bound the lease's month-count fields. The client caps these via <select>,
      // but a direct POST must not persist negatives / fractions / absurd values:
      // a huge prepaid pushes the first due date decades out, a negative is
      // silently stored on the lease + PDF. Each is a whole number of months
      // within the lease term — same posture as the deposit / indexation guards.
      const monthFields: Array<[string, number | undefined]> = [
        ["prepaidRents", prepaidRents],
        ["rentFreePeriodMonths", rentFreePeriodMonths],
        ["noticePeriodMonths", noticePeriodMonths],
        ["indexationDelay", indexationDelay],
      ];
      for (const [label, val] of monthFields) {
        if (
          val !== undefined &&
          (!Number.isInteger(val) || val < 0 || val > rentalDurationMonths)
        ) {
          return res.status(400).json({
            error: `${label} must be a whole number of months between 0 and the lease term (${rentalDurationMonths}).`,
          });
        }
      }
      // Fixed-renewal term (months each renewal extends the lease). Not bounded
      // by the lease term — a 12-month lease can renew in 3-month steps.
      if (
        fixedRenewalMonths !== undefined &&
        (!Number.isInteger(fixedRenewalMonths) ||
          fixedRenewalMonths < 1 ||
          fixedRenewalMonths > 600)
      ) {
        return res.status(400).json({
          error: "fixedRenewalMonths must be a whole number of months between 1 and 600",
        });
      }
      // The first payment can't fall before the lease starts.
      if (
        nextPaymentDate &&
        (Number.isNaN(Date.parse(nextPaymentDate)) ||
          Date.parse(nextPaymentDate) < Date.parse(startDate))
      ) {
        return res
          .status(400)
          .json({ error: "First payment date can't be before the lease start date." });
      }
      // A provided signing date must be a real date.
      if (signatureDate && Number.isNaN(Date.parse(signatureDate))) {
        return res.status(400).json({ error: "signatureDate must be a valid date (YYYY-MM-DD)." });
      }
      // Prepaid / rent-free months only make sense with a first-payment date to
      // offset from. Without one, freeMonthsOffset has nothing to advance, so the
      // synthetic prepaid income row gets no cycle offset and could double-count
      // against a later real payment, and the reminder cron has no schedule to
      // skip past. The shipping client always sends nextPaymentDate; this is the
      // server-side contract a direct POST must also honor.
      if (((prepaidRents ?? 0) > 0 || (rentFreePeriodMonths ?? 0) > 0) && !nextPaymentDate) {
        return res.status(400).json({
          error: "A first payment date is required when prepaid or rent-free months are set.",
        });
      }

      try {
        // Block agreement creation only if the owner has NO way to
        // accept rent yet. Two payout paths qualify:
        //   1. Stripe Connect with charges enabled (card payments via
        //      platform).
        //   2. Direct IBAN on the profile (bank transfer; tenants pay
        //      out-of-band, no platform commission).
        // We gate on connectChargesEnabled (not just connectAccountId)
        // so a half-onboarded Connect account doesn't count. 412 + code
        // lets the client surface the Banking prompt.
        // Banking lives on the owner's portfolio now — agreement creation is
        // owner-self only (mutating, no ?ownerId=), so resolve by the caller.
        const banking = await loadPortfolioBanking(req.user!.uid);
        const hasStripeConnect = !!banking.connectAccountId && !!banking.connectChargesEnabled;
        const hasIbanPayout = !!banking.bankDetails?.iban;
        if (!hasStripeConnect && !hasIbanPayout) {
          return res.status(412).json({
            error: "Add a payout method before creating an agreement so your tenant can pay rent.",
            code: "no_payment_method",
          });
        }

        // Confirm the property belongs to the caller before creating
        // anything tied to it. Cross-portfolio tenant creation isn't
        // supported here.
        const propRef = db().collection(COL.properties).doc(propertyId);
        const propSnap = await propRef.get();
        if (!propSnap.exists) {
          return res.status(404).json({ error: "Property not found" });
        }
        const property = propSnap.data() as Property;
        if (property.ownerId !== callerUid) {
          return res.status(403).json({ error: "Not your property" });
        }
        // A plan downgrade can soft-deactivate (status "inactive") a property
        // while keeping its data. Creating a lease on it would strand an
        // invisible tenancy on a hidden property. Mirror the tenant-side
        // approval guard: block until the owner re-upgrades / frees a slot.
        if (property.status === "inactive") {
          return res.status(409).json({
            error:
              "This property is paused under your current plan. Re-upgrade or free a slot before adding a tenant.",
          });
        }
        // A held or owner-occupied property has no tenant to assign. The client
        // hides these from the tenant picker; enforce it here too so a direct
        // API call can't attach a tenant to a non-rentable property. Legacy
        // props with no declared use are still allowed through.
        if (property.propertyUse === "hold" || property.propertyUse === "owner_occupied") {
          return res
            .status(400)
            .json({ error: "This property isn't set up for renting, so it can't have a tenant." });
        }

        // One user can't be both sides of the same agreement.
        try {
          const existingAuth = await auth().getUserByEmail(tenantEmail);
          if (existingAuth.uid === callerUid) {
            return res.status(400).json({ error: "You can't add yourself as a tenant" });
          }
        } catch (err: unknown) {
          const e = err as { code?: string };
          if (e?.code !== "auth/user-not-found") throw err;
        }

        // Resolve the tenant's Firebase Auth account: ONLY link if one
        // already exists for this email. We DO NOT pre-create accounts
        // on arbitrary emails — that path used to return a password-
        // reset link to the OWNER, who could then take over the
        // victim's email entirely. If the tenant doesn't have an Olio
        // account yet, the tenancy is stored with userId=null +
        // status="invited". When the real tenant signs up at
        // app.oliowallet.com, /api/me auto-links pending tenancies by
        // email — see the linking block at the top of that handler.
        let tenantUid: string | undefined;
        try {
          const existing = await auth().getUserByEmail(tenantEmail);
          tenantUid = existing.uid;
        } catch (err: unknown) {
          const e = err as { code?: string };
          if (e?.code !== "auth/user-not-found") throw err;
          // Leave tenantUid undefined. No Firebase Auth account is
          // created for the victim's email — they keep full control of
          // signup.
        }

        // Compute the agreement's endDate from startDate + duration.
        // We approximate by adding calendar months; good enough for
        // surfacing in the UI and matches what the owner explicitly
        // chose.
        // Use the shared month-end-clamping helper, not a naive setUTCMonth
        // (which overflows: 2025-01-31 + 1mo → Mar 03 instead of Feb 28).
        const endDate = advanceMonths(startDate, rentalDurationMonths);

        // Total rent across the lease window (rent × months).
        const agreementValue = rentAmount * Math.max(1, Math.floor(rentalDurationMonths));

        const now = new Date().toISOString();
        // Deterministic doc ids derived from a stable key (owner +
        // property + tenant email + startDate) so a double-submit by
        // the same form (slow network → user clicks Save twice, or
        // two tabs open) creates ONE pair of docs, not two duplicates.
        // The transaction below treats existence as a no-op and
        // returns the existing rows.
        const dedupeKey = `${callerUid}_${propertyId}_${tenantEmail}_${startDate}`;
        const dedupeHash = createHash("sha256").update(dedupeKey).digest("hex").slice(0, 24);
        const tenantRef = db().collection(COL.tenants).doc(`agr_${dedupeHash}`);
        const agreementRef = db().collection(COL.agreements).doc(`agr_${dedupeHash}`);

        // Guard against double-occupancy: a property can hold only one live
        // tenancy at a time. Refuse to create a second one when the property
        // already has an active tenant OR an outstanding (pending/invited)
        // invite. The deterministic dedupe id means re-submitting the SAME
        // invite is idempotent (handled by the transaction below), so exclude
        // our own dedupe doc from the check. The race-proof gate lives in POST
        // /api/tenant/agreements/:id/respond (re-checked inside its txn); this
        // is the early, friendly 409 for the common "owner adds a 2nd tenant".
        const BLOCKING_TENANCY_STATUSES = ["active", "pending", "invited"];
        const existingTenancies = await db()
          .collection(COL.tenants)
          .where("propertyId", "==", propertyId)
          .get();
        const hasBlockingTenancy = existingTenancies.docs.some(
          (d) =>
            d.id !== tenantRef.id &&
            BLOCKING_TENANCY_STATUSES.includes((d.data() as Tenant).status),
        );
        if (hasBlockingTenancy) {
          return res.status(409).json({
            error:
              "This property already has a tenant or a pending invite. End the current tenancy or cancel the invite before adding another.",
          });
        }

        // Owner-created properties don't always have a separate Unit
        // row, so we reuse the propertyId as unitId. Matches the
        // convention noted in the admin users-list endpoint.
        const unitId = propertyId;

        // Stamp the stable portfolio id on both records so they're keyed to
        // the portfolio (which survives an owner transfer). Resolved BEFORE
        // the create transaction below — ensurePortfolio runs its own
        // transaction and can't nest inside another one.
        const portfolio = await ensurePortfolio(callerUid);

        const tenantDoc: Tenant = {
          id: tenantRef.id,
          userId: tenantUid,
          name: tenantEmail,
          email: tenantEmail,
          unitId,
          propertyId,
          ownerId: callerUid,
          portfolioId: portfolio.id,
          rentAmount,
          status: tenantUid ? "pending" : "invited",
          ...(effectiveNextPaymentDate ? { nextPayment: effectiveNextPaymentDate } : {}),
          createdAt: now,
        };

        const indexation: AgreementIndexation | undefined = cpiType
          ? {
              type: cpiType,
              ...(ownerIndexation !== undefined ? { rate: ownerIndexation } : {}),
              ...(indexationDelay !== undefined ? { delayMonths: indexationDelay } : {}),
              frequency: indexationFrequency,
              // Seed the auto-application tracking so the indexation sweep can
              // pick this lease up. baseRent anchors the audit trail; the
              // first effective date is anchor(signing) + delayMonths, rolled
              // to the next not-yet-passed step for backdated leases.
              baseRent: rentAmount,
              appliedSteps: 0,
            }
          : undefined;

        const agreementDoc: Agreement = {
          id: agreementRef.id,
          tenantId: tenantRef.id,
          unitId,
          propertyId,
          ownerId: callerUid,
          portfolioId: portfolio.id,
          agreementValue,
          startDate,
          endDate,
          // Awaiting the tenant's in-app approval. The tenant flips this to
          // "active" (or "declined") via POST /api/tenant/agreements/:id/respond.
          // Both owner + tenant agreement reads show every status except the
          // reserved "draft", so this lease is visible to both sides at once —
          // previously it was created as "draft" and silently hidden everywhere.
          status: "pending_tenant",
          createdAt: now,
          ...(signatureDate ? { signatureDate, signedAt: signatureDate } : {}),
          ...(effectiveNextPaymentDate ? { nextPaymentDate: effectiveNextPaymentDate } : {}),
          ...(paymentDayOfMonth !== undefined ? { paymentDayOfMonth } : {}),
          ...(prepaidRents !== undefined ? { prepaidRents } : {}),
          // Freeze the prepaid total at the rate paid up front so the synthetic
          // activity row doesn't retroactively inflate after a later indexation.
          ...(prepaidRents && prepaidRents > 0
            ? { prepaidRentAmount: Math.round(rentAmount * prepaidRents) }
            : {}),
          ...(rentFreePeriodMonths !== undefined ? { rentFreePeriodMonths } : {}),
          paymentFrequency,
          rentalDurationMonths,
          ...(noticePeriodMonths !== undefined ? { noticePeriodMonths } : {}),
          autoRenewal,
          // Only meaningful for "fixed" renewals — the term each renewal adds.
          ...(autoRenewal === "fixed" && fixedRenewalMonths !== undefined
            ? { fixedRenewalMonths }
            : {}),
          monthlyRent: rentAmount,
          deposit,
          ...(indexation ? { indexation } : {}),
          ...(termsAndConditions ? { termsAndConditions } : {}),
        };

        // Now the agreement (with its signing/start dates) exists, derive the
        // first increase date. Done here rather than inline so it reuses the
        // exact anchor precedence the sweep + migration use. Only seed when the
        // clause will actually index — a fixed/custom clause with no positive
        // rate is a no-op the sweep skips, so seeding it just renders a phantom
        // "Next Increase" the engine never acts on (CPI / rate-less custom DO
        // index — the owner is flagged to set rent by hand).
        if (agreementDoc.indexation) {
          const i = agreementDoc.indexation;
          const willIndex =
            i.type === "cpi" || i.type === "custom" || (typeof i.rate === "number" && i.rate > 0);
          if (willIndex) {
            const seeded = nextIncreaseDateOnOrAfter(agreementDoc, now);
            if (seeded) i.nextIncreaseDate = seeded;
          }
        }

        // Atomic create-or-no-op via transaction. Two near-simultaneous
        // submits (slow network → double-click; two tabs open) both
        // hit the existence check first; the loser sees the winner's
        // tenant doc and skips the write (idempotent). The unique
        // deterministic doc id (derived above from owner+property+
        // email+startDate) makes this work without collision risk.
        let alreadyExisted = false;
        let blockedByOccupancy = false;
        await db().runTransaction(async (t) => {
          const existing = await t.get(tenantRef);
          if (existing.exists) {
            alreadyExisted = true;
            return;
          }
          // Race-proof double-occupancy gate. The pre-check above is a friendly
          // early 409, but two concurrent invites for the SAME property with
          // DIFFERENT emails have different dedupe ids, so neither pre-check sees
          // the other's not-yet-committed tenancy. Re-read the property's
          // tenancies inside the txn: if a blocking one exists (or a racing
          // sibling commits first), Firestore's query-conflict detection aborts +
          // retries the loser, which then sees the winner and bails. (All reads
          // precede writes, as Firestore requires.)
          const blockingSnap = await t.get(
            db().collection(COL.tenants).where("propertyId", "==", propertyId),
          );
          if (
            blockingSnap.docs.some(
              (d) =>
                d.id !== tenantRef.id &&
                BLOCKING_TENANCY_STATUSES.includes((d.data() as Tenant).status),
            )
          ) {
            blockedByOccupancy = true;
            return;
          }
          t.set(tenantRef, tenantDoc);
          t.set(agreementRef, agreementDoc);
        });
        if (blockedByOccupancy) {
          return res.status(409).json({
            error:
              "This property already has a tenant or a pending invite. End the current tenancy or cancel the invite before adding another.",
          });
        }

        // Notify the tenant that their landlord sent them a lease that's
        // awaiting their approval. The lease lands in status
        // "pending_tenant"; the tenant approves/declines it in-app — from
        // the header bell or the Agreements page — via POST
        // /api/tenant/agreements/:id/respond. Gate both channels on first-
        // create — a double-submit shouldn't double-notify the tenant.
        if (!alreadyExisted) {
          const propertyLabel = property.address || "a new property";
          const ownerName =
            [req.user!.profile?.firstName ?? "", req.user!.profile?.lastName ?? ""]
              .join(" ")
              .trim() ||
            req.user!.email ||
            "Your landlord";

          // OneSignal push reaches existing tenants only — the invite-
          // link case (tenantUid undefined) silently skips because
          // there's no subscription to push to. Deep-links straight to the
          // agreements list where the approve/decline buttons live.
          if (tenantUid) {
            await notifyUser({
              externalUserId: tenantUid,
              category: "propertyActivity",
              title: "New lease to review",
              message: `${ownerName} sent you a lease for ${propertyLabel}. Open Olio to approve or decline it.`,
              url: "https://app.oliowallet.com/tenant/agreements",
            });
          }

          // Transactional email reaches both cases: existing tenants
          // get it as a second channel; new emails (no Olio account
          // yet) get it as the ONLY channel, with copy that points
          // them at signup. No credentialed link is included — the
          // recipient self-serves at app.oliowallet.com and /api/me
          // auto-links the pending tenancy by email match. Best-
          // effort: Resend hiccups don't break the agreement write.
          await sendTenantAgreementInviteEmail({
            email: tenantEmail,
            ownerName,
            propertyLabel,
            hasAccount: !!tenantUid,
          }).catch((err) => {
            logError("agreement.invite-email-failed", err, {
              tenantEmail,
              propertyId,
            });
          });
        }

        // No inviteLink in response — see security comment above. The
        // tenant either already had an account (we linked it) or will
        // sign up at app.oliowallet.com on their own and get linked by
        // /api/me via email match.
        res.status(201).json({
          inviteLink: null,
          tenantId: tenantRef.id,
          agreementId: agreementRef.id,
        });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to create agreement") });
      }
    },
  );

  // PATCH /api/owner/agreements/:id — edit the core lease terms (monthly
  // rent, deposit, start/end dates) of an existing agreement. Owner-self
  // only, same posture as tenancy termination: granted contacts can read a
  // portfolio but can't mutate it. Recomputes the derived term + total value
  // from the resolved dates, and keeps the linked tenant doc's rentAmount in
  // sync — the owner dashboard derives monthly revenue + occupancy from
  // active tenancies, not from the agreement doc.
  app.patch(
    "/api/owner/agreements/:id",
    requireAuth,
    // Same capability that gates agreement creation. An owner who can create
    // a lease can edit it; a plan without "Agreements" can do neither.
    requireOwnerPlanPrivilege("contracts.create"),
    async (req, res) => {
      const { uid } = req.user!;
      const id = reqStr(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      const str = (v: unknown, max = 40) =>
        typeof v === "string" ? v.trim().slice(0, max) : undefined;

      const monthlyRent = num(body.monthlyRent);
      const deposit = num(body.deposit);
      const startDate = str(body.startDate);
      const endDate = str(body.endDate);

      // Every field is optional (partial update) but must be sane when sent.
      if (monthlyRent !== undefined && monthlyRent <= 0) {
        return res.status(400).json({ error: "Monthly rent must be positive" });
      }
      if (deposit !== undefined && deposit < 0) {
        return res.status(400).json({ error: "Deposit can't be negative" });
      }
      if (startDate !== undefined && Number.isNaN(Date.parse(startDate))) {
        return res.status(400).json({ error: "Invalid start date" });
      }
      if (endDate !== undefined && Number.isNaN(Date.parse(endDate))) {
        return res.status(400).json({ error: "Invalid end date" });
      }

      try {
        const ref = db().collection(COL.agreements).doc(id);
        const snap = await ref.get();
        if (!snap.exists) {
          return res.status(404).json({ error: "Agreement not found" });
        }
        const agreement = snap.data() as Agreement;
        if (agreement.ownerId !== uid) {
          return res.status(403).json({ error: "Not your agreement" });
        }
        // Closed leases are historical records — don't let their terms be
        // rewritten after the fact.
        if (
          agreement.status === "expired" ||
          agreement.status === "terminated" ||
          agreement.status === "declined"
        ) {
          return res.status(409).json({ error: "This agreement is closed and can't be edited." });
        }

        // Resolve the effective dates (new value, else the stored one) so we
        // can validate ordering and recompute the term off a complete pair.
        const nextStart = startDate ?? agreement.startDate;
        const nextEnd = endDate ?? agreement.endDate;
        if (nextStart && nextEnd && Date.parse(nextEnd) <= Date.parse(nextStart)) {
          return res.status(400).json({ error: "End date must be after the start date" });
        }

        const nextRent = monthlyRent ?? agreement.monthlyRent ?? 0;
        // Term in whole months between the two dates (≈30.44 days/mo),
        // floored at 1 — mirrors the modal's own duration display.
        const months =
          nextStart && nextEnd
            ? Math.max(
                1,
                Math.round(
                  (Date.parse(nextEnd) - Date.parse(nextStart)) / (1000 * 60 * 60 * 24 * 30.44),
                ),
              )
            : (agreement.rentalDurationMonths ?? 12);

        // Re-anchor the indexation clock when the start date moved and no
        // increase has been applied yet. Without this, correcting startDate
        // left nextIncreaseDate pinned to the old anchor (for leases with no
        // signatureDate, where the anchor IS startDate), so the sweep would
        // prenotice/apply on a date no longer matching the lease. Never moved
        // once steps have applied (no retroactive change).
        let indexationPatch: Partial<Agreement> = {};
        if (startDate !== undefined && agreement.indexation && !agreement.indexation.appliedSteps) {
          const updatedForSeed = {
            ...agreement,
            startDate: nextStart,
            endDate: nextEnd,
            rentalDurationMonths: months,
          } as Agreement;
          const reseeded = nextIncreaseDateOnOrAfter(
            updatedForSeed,
            new Date().toISOString().slice(0, 10),
          );
          if (reseeded && reseeded !== agreement.indexation.nextIncreaseDate?.slice(0, 10)) {
            indexationPatch = {
              indexation: { ...agreement.indexation, nextIncreaseDate: reseeded },
            };
          }
        }

        // Route the rent change through the single writer so the charged
        // field (Unit/Tenant.rentAmount) stays in step with the agreement —
        // see server/services/rentChange.ts. Date/term/deposit edits ride
        // along in the same batch. Pass monthsOverride ONLY when the lease dates
        // actually changed: that redefines the term, so agreementValue is
        // recomputed fresh (newRent × new term). A rent-only edit (dates
        // untouched) omits it, so the writer BLENDS the rate delta over the
        // remaining months instead of overstating the contract value.
        const datesChanged = startDate !== undefined || endDate !== undefined;
        const { mergedAgreementPatch } = await applyRentChange(id, nextRent, {
          monthsOverride: datesChanged ? months : undefined,
          extraAgreementPatch: {
            ...(deposit !== undefined ? { deposit } : {}),
            ...(startDate !== undefined ? { startDate } : {}),
            ...(endDate !== undefined ? { endDate } : {}),
            rentalDurationMonths: months,
            ...indexationPatch,
          },
        });

        // Tell the tenant their lease terms changed. applyRentChange just
        // rewrote the charged rent (Tenant/Unit.rentAmount) — without this the
        // tenant's actual rent could move with no notice. Use the rent-increase
        // category when rent actually went up (so a tenant who muted general
        // activity still gets the legally-relevant notice); otherwise general
        // property activity. Best-effort + gated on a linked tenant (invite-
        // only tenancies have no User.id), mirroring the move-out push.
        try {
          const tenantSnap = await db().collection(COL.tenants).doc(agreement.tenantId).get();
          const tenantUserId = tenantSnap.exists ? (tenantSnap.data() as Tenant).userId : undefined;
          if (tenantUserId) {
            const rentRaised = monthlyRent !== undefined && nextRent > (agreement.monthlyRent ?? 0);
            const rentStr = new Intl.NumberFormat("en-IE", {
              style: "currency",
              currency: "EUR",
            }).format(nextRent);
            await notifyUser({
              externalUserId: tenantUserId,
              category: rentRaised ? "rentIncrease" : "propertyActivity",
              title: rentRaised ? "Your rent has changed" : "Your lease was updated",
              message: rentRaised
                ? `Your landlord set your monthly rent to ${rentStr}. Open Olio to review.`
                : "Your landlord updated your lease terms. Open Olio to review the details.",
              url: "https://app.oliowallet.com/tenant",
            });
          }
        } catch (err) {
          logWarn("agreement_edit.notify-failed", { err: String(err).slice(0, 200) });
        }

        res.json({ ...agreement, ...mergedAgreementPatch });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to update agreement") });
      }
    },
  );

  // ── Signed-lease document (the physical/signed PDF for one lease) ──────
  //
  // Three-step signed-URL gateway (upload-url → browser PUT → finalize),
  // mirroring server/routes/documents.ts but scoped to a single agreement and
  // PDF-only. The owner uploads the actual signed lease; both the owner and the
  // lease's tenant can then view + download it (the agreement read endpoints
  // mint a fresh signed URL from the stored path). Owner-self only and gated on
  // `contracts.create` — the same capability that lets an owner create/edit the
  // lease lets them attach its signed copy. Download is never plan-gated: it
  // rides the agreement reads, which only require ownership / tenancy.

  // 25 MB — enough for a scanned multi-page signed lease; matches documents.ts.
  const MAX_LEASE_DOC_BYTES = 25 * 1024 * 1024;

  // Load an agreement and confirm the caller owns it. Returns the agreement +
  // its ref, or sends the appropriate error and returns null.
  const loadOwnedAgreement = async (
    id: string,
    uid: string,
    res: Response,
  ): Promise<{ agreement: Agreement; ref: FirebaseFirestore.DocumentReference } | null> => {
    const ref = db().collection(COL.agreements).doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      res.status(404).json({ error: "Agreement not found" });
      return null;
    }
    const agreement = snap.data() as Agreement;
    if (agreement.ownerId !== uid) {
      res.status(403).json({ error: "Not your agreement" });
      return null;
    }
    return { agreement, ref };
  };

  app.post(
    "/api/owner/agreements/:id/document/upload-url",
    requireAuth,
    requireOwnerPlanPrivilege("contracts.create"),
    async (req, res) => {
      const { uid } = req.user!;
      const limit = await rateLimit(`agr-doc-url:${uid}`, 120, 60 * 60);
      if (!limit.allowed) {
        res.set("Retry-After", String(limit.retryAfterSeconds));
        return res.status(429).json({
          error: "Too many upload attempts. Try again shortly.",
          retryAfterSeconds: limit.retryAfterSeconds,
        });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const contentType = typeof body.contentType === "string" ? body.contentType : "";
      if (contentType !== "application/pdf") {
        return res.status(400).json({ error: "The signed lease must be a PDF." });
      }
      try {
        const owned = await loadOwnedAgreement(reqStr(req.params.id), uid, res);
        if (!owned) return;
        const { agreement } = owned;
        const objectPath = `${DOCUMENT_PREFIX}/${uid}/${agreement.propertyId}/agreements/${agreement.id}/${Date.now()}-${randomUUID()}.pdf`;
        const file = bucket().file(objectPath);
        const [uploadUrl] = await file.createResumableUpload({
          metadata: { contentType },
          origin: (req.headers.origin as string | undefined) ?? undefined,
        });
        res.json({ uploadUrl, objectPath, contentType });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to issue upload URL") });
      }
    },
  );

  app.post(
    "/api/owner/agreements/:id/document/finalize",
    requireAuth,
    requireOwnerPlanPrivilege("contracts.create"),
    async (req, res) => {
      const { uid } = req.user!;
      const limit = await rateLimit(`agr-doc-finalize:${uid}`, 120, 60 * 60);
      if (!limit.allowed) {
        res.set("Retry-After", String(limit.retryAfterSeconds));
        return res.status(429).json({
          error: "Too many uploads. Try again shortly.",
          retryAfterSeconds: limit.retryAfterSeconds,
        });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const objectPath = typeof body.objectPath === "string" ? body.objectPath : "";
      const displayName =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim().slice(0, 200)
          : "Signed lease.pdf";

      try {
        const owned = await loadOwnedAgreement(reqStr(req.params.id), uid, res);
        if (!owned) return;
        const { agreement, ref } = owned;

        // Confine the object to this agreement's folder so a forged objectPath
        // can't graft someone else's storage onto the lease.
        const expectedPrefix = `${DOCUMENT_PREFIX}/${uid}/${agreement.propertyId}/agreements/${agreement.id}/`;
        if (!objectPath.startsWith(expectedPrefix)) {
          return res.status(400).json({ error: "Invalid object path" });
        }

        const file = bucket().file(objectPath);
        const [exists] = await file.exists();
        if (!exists) {
          return res.status(404).json({ error: "Upload not found. Try uploading again." });
        }
        const [metadata] = await file.getMetadata();
        const size = Number(metadata.size ?? 0);
        if (size > MAX_LEASE_DOC_BYTES) {
          await file.delete().catch(() => undefined);
          return res
            .status(413)
            .json({ error: "File exceeds 25 MB. Compress or split the document." });
        }
        const contentType = String(metadata.contentType ?? "");
        if (contentType !== "application/pdf") {
          await file.delete().catch(() => undefined);
          return res.status(400).json({ error: "The signed lease must be a PDF." });
        }

        const now = new Date().toISOString();
        const signedLeaseDocument = {
          storagePath: objectPath,
          name: displayName,
          contentType,
          size,
          uploadedAt: now,
          uploadedBy: uid,
        };
        await ref.set({ signedLeaseDocument }, { merge: true });

        // Replace semantics: drop the previously attached object (if any and
        // different) so swapping the signed copy doesn't orphan storage.
        const prev = agreement.signedLeaseDocument?.storagePath;
        if (prev && prev !== objectPath) {
          await bucket()
            .file(prev)
            .delete()
            .catch(() => undefined);
        }

        // Notify the lease's tenant that the signed copy is available. Gated on
        // a linked User.id (invite-only tenancies have none), mirroring the
        // documents-route + move-out pushes.
        try {
          const tenantSnap = await db().collection(COL.tenants).doc(agreement.tenantId).get();
          const tenancy = tenantSnap.exists ? (tenantSnap.data() as Tenant) : null;
          if (tenancy?.userId && tenancy.ownerId === uid) {
            await notifyUser({
              externalUserId: tenancy.userId,
              category: "documents",
              title: "Signed lease available",
              message: "Your landlord uploaded the signed lease. Open Olio to view or download it.",
              url: "https://app.oliowallet.com/tenant/agreements",
            });
          }
        } catch (err) {
          logWarn("agreement_doc.notify-failed", { err: String(err).slice(0, 200) });
        }

        const documentUrl = await signReadUrl(objectPath);
        res.status(201).json({
          documentUrl,
          documentName: displayName,
          documentSize: size,
          documentUploadedAt: now,
        });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to attach the signed lease") });
      }
    },
  );

  app.delete(
    "/api/owner/agreements/:id/document",
    requireAuth,
    requireOwnerPlanPrivilege("contracts.create"),
    async (req, res) => {
      const { uid } = req.user!;
      try {
        const owned = await loadOwnedAgreement(reqStr(req.params.id), uid, res);
        if (!owned) return;
        const { agreement, ref } = owned;
        const storagePath = agreement.signedLeaseDocument?.storagePath;
        await ref.set({ signedLeaseDocument: null }, { merge: true });
        if (storagePath) {
          await bucket()
            .file(storagePath)
            .delete()
            .catch(() => undefined);
        }
        res.status(204).end();
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to remove the signed lease") });
      }
    },
  );

  // POST /api/owner/tenants/:id/end — end (move-out) a tenancy. Flips
  // the tenant doc status to "expired" and, if there's an attached
  // active agreement, marks it terminated. Notifies the tenant under
  // `propertyActivity`. Idempotent: a second call on an already-
  // expired tenancy returns the current state without re-notifying.
  app.post("/api/owner/tenants/:id/end", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const tenancyId = reqStr(req.params.id);
    try {
      const ref = db().collection(COL.tenants).doc(tenancyId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ error: "Tenancy not found" });
      }
      const tenancy = snap.data() as Tenant;
      if (tenancy.ownerId !== uid) {
        return res.status(403).json({ error: "Not your tenancy" });
      }
      if (tenancy.status === "expired") {
        return res.json(tenancy);
      }

      const now = new Date().toISOString();
      const today = now.slice(0, 10);

      // Close EVERY non-terminal agreement tied to this tenancy so the owner's
      // analytics + the tenant's "current lease" UI reflect reality. Read FIRST
      // so we can compute any unpaid arrear before nulling the schedule (cycles
      // already due through today — an early move-out doesn't bill the tenant
      // for months after they leave). We query by tenancy and branch in memory:
      //   • active / suspended → terminate + capture arrears (a suspended lease
      //     still preserves nextPaymentDate, so its in-term arrear is real);
      //   • pending_tenant → this IS the "cancel the invite" path (there is no
      //     separate cancel endpoint). It MUST close the agreement, otherwise it
      //     stays pending_tenant and the tenant can later approve it and
      //     resurrect this ended tenancy (the respond endpoint also re-checks
      //     tenancy.status as a second guard).
      const agreementsSnap = await db()
        .collection(COL.agreements)
        .where("tenantId", "==", tenancyId)
        .get();

      let outstandingTotal = 0;
      let agreementsTouched = false;
      const batch = db().batch();
      agreementsSnap.docs.forEach((d) => {
        const ag = d.data() as Agreement;
        if (ag.status === "active" || ag.status === "suspended") {
          const arrears = computeArrears({
            nextPaymentDate: ag.nextPaymentDate,
            throughDate: today,
            monthlyRent: tenancy.rentAmount ?? ag.monthlyRent ?? 0,
            frequency: ag.paymentFrequency,
            paymentDayOfMonth: ag.paymentDayOfMonth,
          });
          outstandingTotal += arrears.amount;
          batch.set(
            d.ref,
            {
              status: "terminated",
              terminatedAt: now,
              nextPaymentDate: null,
              suspendedAt: null,
              suspendedReason: null,
              closingBalance:
                arrears.amount > 0
                  ? {
                      amount: arrears.amount,
                      cycles: arrears.cycles,
                      fromPeriod: arrears.fromPeriod,
                      reason: "termination" as const,
                      recordedAt: now,
                    }
                  : null,
            },
            { merge: true },
          );
          // Clear the never-advanced Unit schedule fields too (L-21) so a stale
          // next-payment / lease-end doesn't linger on an admin unit after end.
          if (ag.unitId) {
            batch.set(
              db().collection(COL.units).doc(ag.unitId),
              { nextPaymentDate: null, leaseEnd: null },
              { merge: true },
            );
          }
          agreementsTouched = true;
        } else if (ag.status === "pending_tenant") {
          // Cancel the unaccepted invite — no schedule, so no arrears.
          batch.set(d.ref, { status: "declined", declinedAt: now }, { merge: true });
          agreementsTouched = true;
        }
        // draft / expired / terminated / declined are already terminal — skip.
      });
      if (agreementsTouched) await batch.commit();

      // Clear the due date so an ended tenancy stops surfacing a phantom "next
      // payment" (L-15), and record any preserved arrear so the ex-tenant can
      // still settle it and the owner can still see it.
      await ref.set(
        {
          status: "expired",
          endedAt: now,
          nextPayment: null,
          outstandingBalance: outstandingTotal,
        },
        { merge: true },
      );

      // Revoke the ex-tenant's access to any documents the owner
      // attached to this tenancy. firebaseStorageDownloadTokens stay
      // valid forever — an ex-tenant who saved a doc URL (or whose
      // device cache retains it) keeps fetching after move-out.
      // Rotate the token on each doc + write the new URL back to the
      // DocumentRecord so the owner's UI still works. Old URLs 403.
      try {
        const tenantDocsSnap = await db()
          .collection(COL.documents)
          .where("tenantId", "==", tenancyId)
          .get();
        if (!tenantDocsSnap.empty) {
          const b = bucket();
          for (const d of tenantDocsSnap.docs) {
            const doc = d.data() as DocumentRecord;
            if (!doc.storagePath) continue;
            try {
              const newToken = randomUUID();
              await b.file(doc.storagePath).setMetadata({
                metadata: { firebaseStorageDownloadTokens: newToken },
              });
              const newUrl = `https://firebasestorage.googleapis.com/v0/b/${storageBucketName}/o/${encodeURIComponent(doc.storagePath)}?alt=media&token=${newToken}`;
              await d.ref.set({ downloadURL: newUrl, tenantId: null }, { merge: true });
            } catch (err) {
              logWarn("tenancy_end.token-rotation-failed", {
                documentId: doc.id,
                err: String(err).slice(0, 200),
              });
            }
          }
        }
      } catch (err) {
        logWarn("tenancy_end.token-rotation-skipped", {
          err: String(err).slice(0, 200),
        });
      }

      // Push the tenant. Only when there's a real User.id to address
      // — the invited-but-never-signed-up case silently skips.
      if (tenancy.userId) {
        await notifyUser({
          externalUserId: tenancy.userId,
          category: "propertyActivity",
          title: "Your tenancy has ended",
          message: "Your landlord marked your tenancy as ended. Reach out if this was a mistake.",
          url: "https://app.oliowallet.com/tenant",
        });
      }

      const updated = {
        ...tenancy,
        status: "expired" as const,
        endedAt: now,
        outstandingBalance: outstandingTotal,
      };
      res.json(updated);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to end tenancy") });
    }
  });

  // POST /api/owner/tenants/:id/settle-balance — record that an ended tenancy's
  // outstanding closing balance has been paid (the ex-tenant settled it with the
  // owner off-platform / directly). Books the money as realized rent income so
  // it lands in the ledger and reports, then clears the arrear on the tenancy
  // and its closed agreement(s). Idempotent: a tenancy with nothing outstanding
  // returns unchanged. This is the collection path for the "keep arrears
  // collectible" rule — owner-confirmed, fully reconciled.
  app.post("/api/owner/tenants/:id/settle-balance", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const tenancyId = reqStr(req.params.id);
    try {
      const ref = db().collection(COL.tenants).doc(tenancyId);
      const now = new Date().toISOString();

      // Atomic + idempotent. The old code read outstandingBalance, then wrote an
      // auto-id income row in a plain BATCH — so two concurrent settle requests
      // (double-click, two tabs, a retried slow request) each booked a DISTINCT
      // "Final balance settlement" income row for the same arrear, permanently
      // inflating realized rent (the ledger is append-only; settlement rows have
      // no manual-edit path). Now the whole read→guard→write runs in ONE
      // transaction and the income row uses a DETERMINISTIC id derived from the
      // tenancy + the outstanding amount: a racing second caller re-reads
      // outstanding=0 (the winner committed) and bails, and even under an
      // unusual ordering its t.set hits the already-existing settlement doc and
      // no-ops. Mirrors the offline-payment writer (tenant.ts).
      const outcome = await db().runTransaction(async (t) => {
        const snap = await t.get(ref);
        if (!snap.exists) return { code: 404 as const };
        const tenancy = snap.data() as Tenant;
        if (tenancy.ownerId !== uid) return { code: 403 as const };
        const outstanding = tenancy.outstandingBalance ?? 0;
        if (outstanding <= 0) return { code: 200 as const, tenancy, settled: false };

        // Deterministic settlement id — the same arrear always maps here, so a
        // duplicate write is a no-op rather than a new row.
        const settleHash = createHash("sha256")
          .update(`${tenancyId}_${outstanding}`)
          .digest("hex")
          .slice(0, 24);
        const txRef = db().collection(COL.transactions).doc(`settle_${settleHash}`);

        // All reads must precede writes in a Firestore transaction.
        const [txExisting, agSnap] = await Promise.all([
          t.get(txRef),
          t.get(db().collection(COL.agreements).where("tenantId", "==", tenancyId)),
        ]);
        const withBalance = agSnap.docs.filter(
          (d) => ((d.data() as Agreement).closingBalance?.amount ?? 0) > 0,
        );

        // Always clear the arrear on the tenancy + its agreement(s) (idempotent).
        t.set(ref, { outstandingBalance: 0 }, { merge: true });
        withBalance.forEach((d) => t.set(d.ref, { closingBalance: null }, { merge: true }));

        // Book the income row exactly once.
        if (txExisting.exists) {
          return { code: 200 as const, tenancy, settled: false, deduped: true };
        }
        const tx: Transaction = {
          id: txRef.id,
          propertyId: tenancy.propertyId,
          unitId: tenancy.unitId,
          tenantId: tenancy.id,
          ...(withBalance[0]?.id ? { agreementId: withBalance[0].id } : {}),
          ownerId: uid,
          ...(tenancy.portfolioId ? { portfolioId: tenancy.portfolioId } : {}),
          name: "Final balance settlement",
          amount: outstanding,
          currency: "EUR",
          type: "income",
          category: "rent",
          status: "completed",
          timestamp: now,
          createdAt: now,
        };
        t.set(txRef, tx);
        return { code: 200 as const, tenancy, settled: true };
      });

      if (outcome.code === 404) return res.status(404).json({ error: "Tenancy not found" });
      if (outcome.code === 403) return res.status(403).json({ error: "Not your tenancy" });

      // Notify only on a real, first-time settlement (never on a no-op/deduped
      // race) so the ex-tenant isn't pinged twice.
      if (outcome.settled && outcome.tenancy.userId) {
        await notifyUser({
          externalUserId: outcome.tenancy.userId,
          category: "rentPayments",
          title: "Balance settled",
          message: "Your final rent balance has been marked settled. Thank you.",
          url: "https://app.oliowallet.com/tenant",
        });
      }
      res.json({ ...outcome.tenancy, outstandingBalance: 0 });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to settle balance") });
    }
  });
}
