// Tenant-side surface for the rented-units app shell:
//   • dashboard reads (units, activity, agreements)
//   • offline rent payment log (tenant) + verify (owner side)
//   • Stripe Checkout flow (checkout → finalize)
//
// All endpoints scope by `userId === uid` on the tenancy doc — there
// is no `?ownerId=` here; tenants only ever see their own rentals.

import type { Express } from "express";
import { createHash } from "node:crypto";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { requireFeature } from "../services/featureFlags";
import { isStripeConfigured, stripe } from "../stripe";
import { errMsg } from "../services/errMsg";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { notifyUser } from "../services/push";
import { signReadUrl } from "../services/signedReadUrl";
import { isSafeRedirectUrl } from "../services/safeRedirect";
import { computeRentCommission } from "../services/commission";
import { recordRentTransactionFromSession } from "../services/rentTransaction";
import { advanceAgreementForPayment, monthsPerPeriod } from "../services/rentCycle";
import { ensurePortfolio, getPortfolio, loadPortfolioBanking } from "../services/portfolioBanking";
import { nextIncreaseDateOnOrAfter } from "../services/leaseDates";
import { prepaidRentActivityRow } from "../services/prepaidActivity";
import { reqStr } from "../util";
import { logWarn } from "../services/log";
import { isRealizedRent } from "../../shared/realizedRent";
import { derivePaymentStatus } from "../../shared/paymentStatus";
import {
  COL,
  type Agreement,
  type PaymentFrequency,
  type Property,
  type Tenant,
  type Transaction,
  type TxPaymentMethod,
  type Unit,
  type User,
} from "../../shared/firestore-schema";

// Runtime allowlist for the offline-payment method enum. Stays local
// to this module (no other endpoint accepts an offline payment shape).
const OFFLINE_PAYMENT_METHODS: TxPaymentMethod[] = ["bank_transfer", "cash", "check", "other"];

// Load the active tenancy + its (optional) unit, owner, and property.
// Used by both payment flows. Returns null when no active tenancy
// exists for the (uid, unitId) pair, or when the owner is missing —
// callers send 404.
//
// `unit` is intentionally optional: owner-created properties have NO
// separate Unit doc (the tenancy reuses `propertyId` as `unitId`), so
// `units/{tenant.unitId}` usually misses. That is the normal shape for
// the owner flow, not a failure — requiring the Unit doc here is what
// made checkout/log 404 with "Active tenancy not found" even though the
// tenant's dashboard (which falls back to the tenancy doc) showed the
// lease fine. Only the OWNER is hard-required (we need their Connect
// account for direct charges); rent amount falls back to the tenancy
// doc and the receipt label to the property address.
async function loadActiveTenancy(uid: string, unitId: string) {
  const snap = await db()
    .collection(COL.tenants)
    .where("userId", "==", uid)
    .where("unitId", "==", unitId)
    .where("status", "==", "active")
    .limit(1)
    .get();
  if (snap.empty) return null;
  const tenant = snap.docs[0].data() as Tenant;
  const [unitDoc, ownerDoc, propertyDoc, banking] = await Promise.all([
    db().collection(COL.units).doc(tenant.unitId).get(),
    db().collection(COL.users).doc(tenant.ownerId).get(),
    db().collection(COL.properties).doc(tenant.propertyId).get(),
    // Banking (IBAN + Connect) belongs to the owner's PORTFOLIO now, not their
    // user doc — resolved by ownerId (with a legacy fallback). Card checkout
    // and the offline IBAN display read it off ctx.banking.
    loadPortfolioBanking(tenant.ownerId),
  ]);
  if (!ownerDoc.exists) return null;
  return {
    tenant,
    unit: unitDoc.exists ? (unitDoc.data() as Unit) : null,
    owner: ownerDoc.data() as User,
    property: propertyDoc.exists ? (propertyDoc.data() as Property) : null,
    banking,
  };
}

export function registerTenantRoutes(app: Express): void {
  // ── Tenant dashboard reads ────────────────────────────────────────

  // Units the signed-in user is currently renting. Joins tenants →
  // units → properties so the client gets a single shaped payload.
  app.get("/api/tenant/units", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    try {
      const tenantSnaps = await db()
        .collection(COL.tenants)
        .where("userId", "==", uid)
        .where("status", "==", "active")
        .get();

      if (tenantSnaps.empty) return res.json([]);

      const tenants = tenantSnaps.docs.map((d) => d.data() as Tenant);

      // Batch-load referenced units and properties in parallel to
      // avoid N+1 latency.
      const unitIds = Array.from(new Set(tenants.map((t) => t.unitId)));
      const propertyIds = Array.from(new Set(tenants.map((t) => t.propertyId)));

      const [unitDocs, propertyDocs] = await Promise.all([
        Promise.all(unitIds.map((id) => db().collection(COL.units).doc(id).get())),
        Promise.all(propertyIds.map((id) => db().collection(COL.properties).doc(id).get())),
      ]);

      const units = new Map<string, Unit>();
      unitDocs.forEach((s) => s.exists && units.set(s.id, s.data() as Unit));
      const properties = new Map<string, Property>();
      propertyDocs.forEach((s) => s.exists && properties.set(s.id, s.data() as Property));

      // Load the active agreement for each tenancy so the client knows the
      // lease's billing cadence. The offline-payment drawer uses this to
      // prefill/charge a WHOLE period (quarterly = 3×, yearly = 12×), matching
      // what the card-checkout endpoint charges server-side. `Agreement.tenantId`
      // is the tenancy doc id (=== Tenant.id). Firestore "in" caps at 30.
      const tenantIds = tenants.map((t) => t.id);
      const agChunks: string[][] = [];
      for (let i = 0; i < tenantIds.length; i += 30) {
        agChunks.push(tenantIds.slice(i, i + 30));
      }
      const agreementSnapshots = await Promise.all(
        agChunks.map((c) => db().collection(COL.agreements).where("tenantId", "in", c).get()),
      );
      const freqByTenancy = new Map<string, PaymentFrequency>();
      agreementSnapshots
        .flatMap((s) => s.docs.map((d) => d.data() as Agreement))
        .filter((a) => a.status === "active")
        .forEach((a) => {
          if (a.paymentFrequency) freqByTenancy.set(a.tenantId, a.paymentFrequency);
        });

      // Realized-rent index per tenancy so the tenant's pill is DERIVED from the
      // ledger exactly like the owner's (server/routes/portfolio.ts) — same
      // shared predicate, so the same rent never shows "overdue" to the owner
      // and nothing to the tenant. Previously the tenant read a raw
      // Unit.paymentStatus that no rent code ever updates (permanently
      // "pending" for owner-created props).
      // `in` on tenantId only (single-field auto-index); filter to rent +
      // realized in memory. Adding a second equality (category) would force a
      // composite index and could 500 in prod for the index-less query.
      const rentTxSnapshots = await Promise.all(
        agChunks.map((c) => db().collection(COL.transactions).where("tenantId", "in", c).get()),
      );
      const tenanciesWithPaidRent = new Set<string>();
      const paidPeriodsByTenancy = new Map<string, Set<string>>();
      rentTxSnapshots
        .flatMap((s) => s.docs.map((d) => d.data() as Transaction))
        .forEach((tx) => {
          if (tx.category !== "rent" || !isRealizedRent(tx) || !tx.tenantId) return;
          tenanciesWithPaidRent.add(tx.tenantId);
          if (tx.rentPeriod) {
            const set = paidPeriodsByTenancy.get(tx.tenantId) ?? new Set<string>();
            set.add(tx.rentPeriod.slice(0, 10));
            paidPeriodsByTenancy.set(tx.tenantId, set);
          }
        });
      const today = new Date().toISOString().slice(0, 10);

      const payload = tenants
        .map((t) => {
          const unit = units.get(t.unitId);
          const property = properties.get(t.propertyId);
          // Owner-created properties have no separate Unit doc (the tenancy
          // reuses propertyId as unitId), so `unit` is usually undefined.
          // Only `property` is required; unit-derived fields fall back to the
          // tenancy doc. Requiring a unit here used to hide a just-approved
          // owner-created lease from the tenant's dashboard entirely.
          if (!property) return null;
          // Prefer the tenancy's advanced due date (mirrored from the agreement
          // by advanceAgreementForPayment) over the never-advanced
          // Unit.nextPaymentDate, so tenant and owner read the SAME next-due date.
          const nextPaymentDate = t.nextPayment ?? unit?.nextPaymentDate ?? null;
          const due = (nextPaymentDate ?? "").slice(0, 10);
          return {
            tenantId: t.id,
            unitId: t.unitId,
            propertyId: property.id,
            name: property.address,
            unitLabel: unit?.label ?? "",
            rentAmount: unit?.rentAmount ?? t.rentAmount,
            nextPaymentDate,
            paymentStatus:
              t.status === "active"
                ? derivePaymentStatus({
                    nextDue: due,
                    today,
                    currentCyclePaid: !!due && (paidPeriodsByTenancy.get(t.id)?.has(due) ?? false),
                    hasSettledHistory: tenanciesWithPaidRent.has(t.id),
                  })
                : "pending",
            image: property.image ?? null,
            // Billing cadence from the active agreement (null when missing/
            // legacy → client treats as monthly). Lets the offline-payment
            // drawer prefill the whole-period amount like card checkout does.
            paymentFrequency: freqByTenancy.get(t.id) ?? null,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      res.json(payload);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load units") });
    }
  });

  // GET /api/tenant/outstanding — ended tenancies of the signed-in user that
  // still carry an unpaid closing balance, so the dashboard can show a "final
  // balance due" prompt. The owner records the actual settlement; this is the
  // tenant's visibility into what they still owe. Joins property names.
  app.get("/api/tenant/outstanding", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    try {
      const tenantSnaps = await db().collection(COL.tenants).where("userId", "==", uid).get();
      const owing = tenantSnaps.docs
        .map((d) => d.data() as Tenant)
        .filter((t) => (t.outstandingBalance ?? 0) > 0);
      if (owing.length === 0) return res.json([]);
      const propertyIds = Array.from(new Set(owing.map((t) => t.propertyId)));
      const propertyRefs = propertyIds.map((id) => db().collection(COL.properties).doc(id));
      const propertyDocs = propertyRefs.length ? await db().getAll(...propertyRefs) : [];
      const addressById = new Map<string, string>();
      propertyDocs.forEach(
        (s) => s.exists && addressById.set(s.id, (s.data() as Property).address),
      );
      res.json(
        owing.map((t) => ({
          tenantId: t.id,
          propertyName: addressById.get(t.propertyId) ?? "your former rental",
          amount: t.outstandingBalance ?? 0,
        })),
      );
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load outstanding balance") });
    }
  });

  // Recent activity (rent payments, maintenance tickets) for EVERY tenancy of
  // the signed-in user — ALL statuses, no filter (the query at `where userId ==`
  // below is deliberately unscoped by status). This is load-bearing: an
  // ex-tenant must keep full read access to the payment history from a lease
  // that has since expired, terminated, or been suspended by a plan downgrade.
  // Do NOT add a status filter here. Merged and sorted newest-first.
  app.get("/api/tenant/activity", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    try {
      const tenantSnaps = await db().collection(COL.tenants).where("userId", "==", uid).get();

      if (tenantSnaps.empty) return res.json([]);

      const tenants = tenantSnaps.docs.map((d) => d.data() as Tenant);
      const tenantIds = tenants.map((t) => t.id);
      const propertyNameById = new Map<string, string>();

      // Firestore `in` clause caps at 30 values; chunk to be safe for
      // large portfolios.
      const chunks: string[][] = [];
      for (let i = 0; i < tenantIds.length; i += 30) {
        chunks.push(tenantIds.slice(i, i + 30));
      }

      const [txSnapshots, agSnapshots, propertySnaps] = await Promise.all([
        Promise.all(
          chunks.map((c) =>
            db()
              .collection(COL.transactions)
              .where("tenantId", "in", c)
              .orderBy("timestamp", "desc")
              .limit(limit)
              .get(),
          ),
        ),
        // Prepaid rent (Agreement.prepaidRents) never lands in the ledger, so
        // pull each tenancy's agreements too and synthesize a read-only row per
        // prepaid lease, merged into `all` below before the final sort/slice.
        Promise.all(
          chunks.map((c) => db().collection(COL.agreements).where("tenantId", "in", c).get()),
        ),
        (async () => {
          const refs = Array.from(new Set(tenants.map((t) => t.propertyId))).map((id) =>
            db().collection(COL.properties).doc(id),
          );
          return refs.length ? await db().getAll(...refs) : [];
        })(),
      ]);

      propertySnaps.forEach(
        (s) => s.exists && propertyNameById.set(s.id, (s.data() as Property).address),
      );
      const tenantToProperty = new Map(tenants.map((t) => [t.id, t.propertyId]));

      const all: (Transaction & { unitName: string })[] = [];
      txSnapshots.forEach((snap) =>
        snap.docs.forEach((d) => {
          const tx = d.data() as Transaction;
          const propId = tx.tenantId ? tenantToProperty.get(tx.tenantId) : tx.propertyId;
          all.push({
            ...tx,
            unitName: (propId && propertyNameById.get(propId)) ?? "",
          });
        }),
      );

      agSnapshots.forEach((snap) =>
        snap.docs.forEach((d) => {
          const row = prepaidRentActivityRow(d.data() as Agreement);
          if (!row) return;
          const propId = row.tenantId ? tenantToProperty.get(row.tenantId) : row.propertyId;
          all.push({
            ...row,
            unitName: (propId && propertyNameById.get(propId)) ?? "",
          });
        }),
      );

      all.sort((a, b) => {
        const ta = new Date(a.timestamp).getTime();
        const tb = new Date(b.timestamp).getTime();
        return tb - ta;
      });

      res.json(all.slice(0, limit));
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load activity") });
    }
  });

  // Every active/expired lease where the signed-in user is the
  // tenant. Joins agreements → tenant → unit → property → owner so
  // the client renders a single shaped payload (no follow-up fetches).
  app.get("/api/tenant/agreements", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    try {
      const tenantSnaps = await db().collection(COL.tenants).where("userId", "==", uid).get();

      if (tenantSnaps.empty) return res.json([]);

      const tenants = tenantSnaps.docs.map((d) => d.data() as Tenant);
      const tenantIds = tenants.map((t) => t.id);

      // Firestore "in" queries cap at 30 values.
      const chunks: string[][] = [];
      for (let i = 0; i < tenantIds.length; i += 30) {
        chunks.push(tenantIds.slice(i, i + 30));
      }

      const agreementSnapshots = await Promise.all(
        chunks.map((c) => db().collection(COL.agreements).where("tenantId", "in", c).get()),
      );
      const agreements = agreementSnapshots
        .flatMap((s) => s.docs.map((d) => d.data() as Agreement))
        .filter((a) => a.status !== "draft");

      if (agreements.length === 0) return res.json([]);

      const unitIds = Array.from(new Set(agreements.map((a) => a.unitId)));
      const propertyIds = Array.from(new Set(agreements.map((a) => a.propertyId)));
      const ownerIds = Array.from(new Set(agreements.map((a) => a.ownerId)));

      const unitRefs = unitIds.map((id) => db().collection(COL.units).doc(id));
      const propertyRefs = propertyIds.map((id) => db().collection(COL.properties).doc(id));
      const ownerRefs = ownerIds.map((id) => db().collection(COL.users).doc(id));
      const [unitDocs, propertyDocs, ownerDocs] = await Promise.all([
        unitRefs.length ? db().getAll(...unitRefs) : Promise.resolve([]),
        propertyRefs.length ? db().getAll(...propertyRefs) : Promise.resolve([]),
        ownerRefs.length ? db().getAll(...ownerRefs) : Promise.resolve([]),
      ]);

      const units = new Map<string, Unit>();
      unitDocs.forEach((s) => s.exists && units.set(s.id, s.data() as Unit));
      const properties = new Map<string, Property>();
      propertyDocs.forEach((s) => s.exists && properties.set(s.id, s.data() as Property));
      const owners = new Map<string, User>();
      ownerDocs.forEach((s) => s.exists && owners.set(s.id, s.data() as User));

      const ownerLabel = (owner?: User, fallback = "—") => {
        if (!owner) return fallback;
        const name = `${owner.firstName ?? ""} ${owner.lastName ?? ""}`.trim();
        return name || owner.email || fallback;
      };

      const payload = agreements
        .map((a) => {
          const unit = units.get(a.unitId);
          const property = properties.get(a.propertyId);
          // Owner-created properties have no separate Unit doc — the agreement
          // reuses propertyId as unitId (see POST /api/owner/agreements), so
          // `unit` is usually undefined. Only `property` is required; every
          // unit-derived field falls back below. Requiring a unit here used to
          // silently drop these agreements from the tenant's list entirely.
          if (!property) return null;
          const owner = owners.get(a.ownerId);
          const monthlyRent = a.monthlyRent ?? unit?.rentAmount ?? 0;
          // A lease counts as electronically signed only once the tenant has
          // accepted it (acceptedAt, set in the respond endpoint). Pending or
          // declined leases are NOT signed — never fall back to createdAt or
          // the owner-entered signatureDate here, which used to print a bogus
          // "Signed electronically" line on agreements awaiting approval.
          // Legacy leases created directly as active never ran through the
          // in-app approval flow, so for those keep the owner-recorded signedAt.
          const isSignedStatus =
            a.status === "active" || a.status === "expired" || a.status === "terminated";
          const signedAt = a.acceptedAt ?? (isSignedStatus ? (a.signedAt ?? null) : null);
          return {
            id: a.id,
            status: a.status,
            leaseType:
              a.leaseType ??
              (property.propertyType === "Commercial" ? "Commercial Lease" : "Residential Lease"),
            address: unit?.label ? `${unit.label}, ${property.address}` : property.address,
            landlord: ownerLabel(owner),
            monthlyRent,
            deposit: a.deposit ?? monthlyRent * 2,
            startDate: a.startDate,
            endDate: a.endDate,
            noticePeriodMonths: a.noticePeriodMonths ?? null,
            // Payment day isn't collected directly — fall back to the day of
            // month of the owner-chosen next payment date so existing leases
            // (which never stored paymentDayOfMonth) show a real day not "—".
            paymentDayOfMonth:
              a.paymentDayOfMonth ??
              (a.nextPaymentDate && !Number.isNaN(Date.parse(a.nextPaymentDate))
                ? new Date(a.nextPaymentDate).getUTCDate()
                : null),
            // Owner-entered lease terms (set in AddTenantDrawer). Surfaced so
            // the tenant's agreement view + PDF show the full set of terms the
            // tenant is agreeing to, not just rent/deposit/dates.
            paymentFrequency: a.paymentFrequency ?? null,
            rentalDurationMonths: a.rentalDurationMonths ?? null,
            rentFreePeriodMonths: a.rentFreePeriodMonths ?? null,
            prepaidRents: a.prepaidRents ?? null,
            autoRenewal: a.autoRenewal ?? null,
            indexation: a.indexation ?? null,
            termsAndConditions: a.termsAndConditions ?? null,
            signedAt,
            // Fresh signed URL minted below from signedLeaseDocument.storagePath;
            // falls back to the legacy documentUrl when no attachment exists. The
            // tenant query is already scoped to this caller's tenancies, so a
            // minted URL only ever reaches the lease's own tenant.
            documentUrl: a.documentUrl ?? null,
            documentName: a.signedLeaseDocument?.name ?? null,
            documentSize: a.signedLeaseDocument?.size ?? null,
            documentUploadedAt: a.signedLeaseDocument?.uploadedAt ?? null,
            agreementValue: a.agreementValue,

            propertyId: property.id,
            unitId: a.unitId,
            image: property.image ?? null,
            propertyType: property.propertyType ?? null,
            buildingName: property.buildingName ?? null,
            floor: property.floor ?? null,
            sqm: property.sqm ?? null,
            builtYear: property.builtYear ?? null,
            energyClass: property.energyClass ?? null,
            city: property.city ?? null,
            postalCode: property.postalCode ?? null,
            country: property.country ?? null,
            parking: property.parking ?? null,
            elevator: property.elevator ?? null,
            heating: property.heating ?? null,
            cooling: property.cooling ?? null,
            solarPanels: property.solarPanels ?? null,
            storageUnit: property.storageUnit ?? null,
            ownershipType: property.ownershipType ?? null,
            companyName: property.companyName ?? null,
            titleDeedsStatus: property.titleDeedsStatus ?? null,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => (a.startDate < b.startDate ? 1 : -1));

      // Mint a fresh, short-lived signed read URL for each lease with an
      // uploaded signed-lease PDF so the tenant can view + download their own
      // signed copy (M-23: storagePath is durable, the URL is signed per-read).
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

  // GET /api/tenant/payment-details/:unitId — the owner's saved
  // bank-transfer (IBAN) details for a unit the signed-in tenant
  // actively rents, so the offline-payment drawer can show the tenant
  // exactly where to send a bank transfer. Returns `{ bankDetails: null }`
  // when the owner hasn't saved any — the client then tells the tenant to
  // ask the owner for it.
  //
  // Scoped through loadActiveTenancy (userId === uid + status active +
  // matching unitId), so a tenant only ever sees the IBAN of an owner they
  // currently rent from. We return only holder/iban/swift — what's needed
  // to make the transfer — never any other owner profile field.
  app.get("/api/tenant/payment-details/:unitId", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const unitId = reqStr(req.params.unitId);
    if (!unitId) return res.status(400).json({ error: "unitId is required" });
    try {
      const ctx = await loadActiveTenancy(uid, unitId);
      if (!ctx) return res.status(404).json({ error: "Active tenancy not found" });
      const bd = ctx.banking.bankDetails;
      // Only surface details once a real IBAN exists. A half-saved record
      // (holder but no IBAN) is treated as "not set" so the tenant gets the
      // "ask the owner" prompt rather than an unusable, IBAN-less card.
      const bankDetails = bd?.iban
        ? { holder: bd.holder ?? "", iban: bd.iban, swift: bd.swift ?? "" }
        : null;
      res.json({ bankDetails });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load payment details") });
    }
  });

  // ── Offline payment log + owner verify ────────────────────────────

  // Record a rent payment that happened off-platform (cash, bank
  // transfer, etc). Writes a transaction with status="pending" until
  // the owner verifies it.
  app.post("/api/tenant/payment/log", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    // 60/day per user — a tenant logs one offline payment per rent
    // cycle (~1 per month). 60 covers their full year + retries
    // without enabling row-spam.
    const limit = await rateLimit(`tenant-pay-log:${uid}`, 60, 24 * 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many payment entries today. Try again tomorrow.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const unitId = typeof body.unitId === "string" ? body.unitId : "";
    const amount = typeof body.amount === "number" && body.amount > 0 ? body.amount : 0;
    const method = OFFLINE_PAYMENT_METHODS.includes(body.method as TxPaymentMethod)
      ? (body.method as TxPaymentMethod)
      : null;
    const paidAtIso =
      typeof body.paidAt === "string" && !isNaN(new Date(body.paidAt).getTime())
        ? new Date(body.paidAt).toISOString()
        : new Date().toISOString();
    const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : "";
    // proofUrl must be a real http(s) URL — block javascript:/data:/
    // etc schemes that would XSS if this string is ever rendered as
    // an anchor href, and cap the length so it can't bloat the doc.
    const rawProofUrl =
      typeof body.proofUrl === "string" ? body.proofUrl.trim().slice(0, 2000) : "";
    const proofUrl = rawProofUrl && /^https?:\/\//i.test(rawProofUrl) ? rawProofUrl : undefined;

    if (!unitId) return res.status(400).json({ error: "unitId is required" });
    if (!amount) return res.status(400).json({ error: "amount must be > 0" });
    if (!method) return res.status(400).json({ error: "method is required (offline)" });

    const ctx = await loadActiveTenancy(uid, unitId);
    if (!ctx) return res.status(404).json({ error: "Active tenancy not found" });

    // Read the active agreement once — for BOTH the cycle this payment covers
    // AND the billing frequency. Mirrors the card path (~771): owner-created
    // leases have no Unit doc, so rent falls back to the tenancy doc.
    let agreement: Agreement | null = null;
    try {
      const agSnap = await db()
        .collection(COL.agreements)
        .where("tenantId", "==", ctx.tenant.id)
        .where("status", "==", "active")
        .limit(1)
        .get();
      if (!agSnap.empty) agreement = agSnap.docs[0].data() as Agreement;
    } catch {
      // Non-fatal — fall back to current-cycle advancement at verify time.
    }
    // Tag the cycle this payment covers so verification can advance the
    // agreement idempotently (see Transaction.rentPeriod). The agreement's
    // current due date is the cycle the tenant is paying, even if the owner
    // verifies it days later. Without a tag, verification falls back to the
    // current cycle.
    const rentPeriod: string | undefined = agreement?.nextPaymentDate?.slice(0, 10);

    // Full-period clamp (BL-9). On owner verify, advanceAgreementForPayment
    // rolls the cycle clock forward a WHOLE billing period (quarterly = 3
    // months, yearly = 12) regardless of how much was logged — it has no
    // notion of partial advancement. So a quarterly/yearly tenant logging one
    // month (or €1) would jump the whole period and skip the rest of the
    // quarter/year's reminders, systematically under-collecting. We reject any
    // log short of the full-period amount rather than recording a payment that
    // would silently over-advance the cycle — the same invariant the card path
    // enforces by always charging rent × monthsPerPeriod. An exact full-period
    // log is unaffected and works unchanged. Integer cents, mirroring the card
    // path at ~771-772. When no agreement/rent is resolvable we skip the clamp
    // (legacy data → preserve the prior always-record behavior).
    const monthlyRent = ctx.unit?.rentAmount ?? ctx.tenant.rentAmount ?? 0;
    const periods = monthsPerPeriod(agreement?.paymentFrequency);
    const fullPeriodCents = Math.round(monthlyRent * periods * 100);
    const loggedCents = Math.round(amount * 100);
    if (fullPeriodCents > 0 && loggedCents < fullPeriodCents) {
      return res.status(400).json({
        error:
          periods > 1
            ? `This lease is billed every ${periods} months. Log the full period amount (${new Intl.NumberFormat(
                "en-IE",
                { style: "currency", currency: "EUR" },
              ).format(monthlyRent * periods)}); partial payments aren't supported yet.`
            : `Amount is short of the rent due (${new Intl.NumberFormat("en-IE", {
                style: "currency",
                currency: "EUR",
              }).format(monthlyRent * periods)}). Partial payments aren't supported yet.`,
      });
    }

    // Deterministic doc id so a double-submit (tenant clicks Record
    // on tab A, network is slow, switches to tab B and clicks again)
    // creates ONE pending row, not two for the same payment. Keyed on
    // (tenant, unit, paidAt-day, method, amount) — same day + same
    // amount + same method = same logical payment. Different amounts
    // or different methods produce distinct ids and both go through.
    const offlineDedupeKey = `${ctx.tenant.id}_${ctx.tenant.unitId}_${paidAtIso.slice(0, 10)}_${method}_${loggedCents}`;
    const offlineDedupeHash = createHash("sha256")
      .update(offlineDedupeKey)
      .digest("hex")
      .slice(0, 24);
    const ref = db().collection(COL.transactions).doc(`offline_${offlineDedupeHash}`);

    // Phase-1 portfolio re-key: stamp the LANDLORD's stable portfolio doc id
    // on the transaction at creation (reads still key off ownerId). The
    // record belongs to the owner, so resolve by ctx.tenant.ownerId — never
    // the calling tenant.
    const pf = await ensurePortfolio(ctx.tenant.ownerId);

    const tx: Transaction = {
      id: ref.id,
      propertyId: ctx.tenant.propertyId,
      unitId: ctx.tenant.unitId,
      tenantId: ctx.tenant.id,
      // Bind this rent payment to its lease so it stays attributable after the
      // agreement expires/terminates. The active agreement was already read
      // above (for rentPeriod) — no extra query.
      ...(agreement?.id ? { agreementId: agreement.id } : {}),
      ownerId: ctx.tenant.ownerId,
      portfolioId: pf.id,
      name: "Rent Payment",
      amount,
      currency: "EUR",
      // Owner income (keyed on ownerId) — must match the card path in
      // recordRentTransactionFromSession and the income-based net/yield/
      // admin-revenue readers. See that file for the full rationale.
      type: "income",
      category: "rent",
      status: "pending",
      timestamp: paidAtIso,
      paymentMethod: method,
      ...(rentPeriod ? { rentPeriod } : {}),
      ...(proofUrl ? { proofUrl } : {}),
      ...(notes ? { notes } : {}),
    };
    // Atomic: if a duplicate fired in the same dedup window, the
    // second caller no-ops and we don't double-notify the landlord.
    let logAlreadyExisted = false;
    await db().runTransaction(async (t) => {
      const existing = await t.get(ref);
      if (existing.exists) {
        logAlreadyExisted = true;
        return;
      }
      t.set(ref, tx);
    });
    if (logAlreadyExisted) {
      return res.status(200).json({ ...tx, deduped: true });
    }

    // Notify the landlord that the tenant logged a payment. Awaited
    // so the push completes before the function instance can be
    // recycled, but any failure is swallowed inside notifyUser —
    // never breaks the tx write.
    const tenantName =
      `${req.user!.profile?.firstName ?? ""} ${req.user!.profile?.lastName ?? ""}`.trim() ||
      "Your tenant";
    const amountStr = new Intl.NumberFormat("en-IE", {
      style: "currency",
      currency: "EUR",
    }).format(amount);
    const methodLabel = method.replace(/_/g, " ");
    await notifyUser({
      externalUserId: ctx.tenant.ownerId,
      category: "rentPayments",
      title: "Rent payment logged",
      message: `${tenantName} logged a ${amountStr} ${methodLabel} rent payment. Verify in your dashboard.`,
      url: "https://app.oliowallet.com/owner",
    });

    res.status(201).json(tx);
  });

  // POST /api/owner/payment/verify/:id — owner-side confirmation that
  // an offline rent payment actually arrived. Flips the transaction
  // from "pending" → "completed" and notifies the tenant that their
  // landlord confirmed receipt. Idempotent on subsequent calls.
  //
  // Lives in this module (not server/routes/finance.ts) because it is
  // the lifecycle complement to the tenant's payment/log endpoint
  // above — keeping them together makes the offline-rent flow legible
  // in one file.
  app.post("/api/owner/payment/verify/:id", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const txId = reqStr(req.params.id);
    try {
      const ref = db().collection(COL.transactions).doc(txId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ error: "Transaction not found" });
      }
      const tx = snap.data() as Transaction;
      // Phase-4 re-key ownership gate: the verifier is whoever currently
      // holds the transaction's PORTFOLIO (the stable key that survives an
      // owner transfer). Every rent tx is portfolio-stamped (backfill
      // verified), so the gate keys SOLELY on tx.portfolioId — the legacy
      // tx.ownerId equality is gone; an unstamped row is unverifiable by
      // construction.
      let callerOwnsTx = false;
      if (tx.portfolioId) {
        const callerPortfolio = await getPortfolio(uid);
        callerOwnsTx = !!callerPortfolio && callerPortfolio.id === tx.portfolioId;
      }
      if (!callerOwnsTx) {
        return res.status(403).json({ error: "Not your transaction" });
      }
      if (tx.category !== "rent") {
        return res.status(400).json({ error: "Only rent transactions can be verified here" });
      }
      if (tx.status === "completed") {
        // Already verified — return current state without re-notifying.
        return res.json(tx);
      }

      // Per-cycle double-book guard. Two distinct pending offline logs for the
      // SAME lease + cycle (the offline dedupe id keys on amount, so an exact
      // log and an over-payment produce two rows), or an offline log for a
      // cycle a card payment already settled, would otherwise BOTH be flipped
      // to completed income and double-count that cycle's realized rent in an
      // append-only ledger. Before completing, refuse if a completed rent
      // payment already exists for this tenancy + cycle. Only cycle-tagged rows
      // are guarded (legacy rows without rentPeriod fall through unchanged); the
      // tenantId + rentPeriod query is equality-only, so no composite index.
      if (tx.rentPeriod && tx.tenantId) {
        const cycleSnap = await db()
          .collection(COL.transactions)
          .where("tenantId", "==", tx.tenantId)
          .where("rentPeriod", "==", tx.rentPeriod)
          .get();
        const cycleAlreadyPaid = cycleSnap.docs.some((d) => {
          if (d.id === txId) return false;
          const other = d.data() as Transaction;
          return other.category === "rent" && other.status === "completed";
        });
        if (cycleAlreadyPaid) {
          return res.status(409).json({
            error: "A rent payment for this cycle has already been verified.",
            code: "cycle_already_paid",
          });
        }
      }

      const verifiedAt = new Date().toISOString();
      await ref.set({ status: "completed", verifiedAt }, { merge: true });
      const updated = {
        ...tx,
        status: "completed" as const,
        verifiedAt,
      };

      // Roll the rent cycle forward via the shared helper — frequency-aware
      // (quarterly/yearly leases advance a whole period, not one month) and
      // idempotent per cycle. Passing tx.rentPeriod means two part-payments
      // for the same month, or a card + offline payment for one cycle, can't
      // double-advance and skip a month of reminders. Without this whole
      // step, offline rent would stay pinned to its first due date forever.
      // Best-effort: a bookkeeping error must not fail the verification the
      // owner just performed; the next cron run catches up, and it's logged
      // (parity with the Stripe path) so a stuck cycle is observable.
      // `tx.category === "rent"` is already guaranteed above.
      if (tx.tenantId) {
        try {
          await advanceAgreementForPayment({
            tenantId: tx.tenantId,
            paidCycle: tx.rentPeriod,
          });
        } catch (err) {
          logWarn("rent_tx.offline-verify.advance-failed", {
            txId,
            tenantId: tx.tenantId,
            err: String(err).slice(0, 200),
          });
        }
      }

      // Notify the tenant. We push to their User.id, looked up via
      // the tenancy doc since `tx.tenantId` points at the tenancy,
      // not the user.
      if (tx.tenantId) {
        try {
          const tenancySnap = await db().collection(COL.tenants).doc(tx.tenantId).get();
          if (tenancySnap.exists) {
            const tenancy = tenancySnap.data() as Tenant;
            if (tenancy.userId) {
              const amountStr = new Intl.NumberFormat("en-IE", {
                style: "currency",
                currency: tx.currency || "EUR",
              }).format(tx.amount ?? 0);
              await notifyUser({
                externalUserId: tenancy.userId,
                category: "rentPayments",
                title: "Rent payment confirmed",
                message: `Your landlord confirmed receipt of your ${amountStr} rent payment.`,
                url: "https://app.oliowallet.com/tenant",
              });
            }
          }
        } catch {
          // Non-fatal — verify succeeded; the push is best-effort.
        }
      }

      res.json(updated);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to verify payment") });
    }
  });

  // GET /api/owner/payments/pending — offline rent payments a tenant
  // logged that still need THIS owner's confirmation. Feeds the header
  // notification bell so the "Confirm" decision sits next to lease
  // approvals and portfolio invites, and the Activity page's inline
  // confirm button.
  //
  // Scoped to the caller's OWN pending rent, NOT ?ownerId=-scoped: the verify
  // endpoint above only accepts the current portfolio holder, so a granted
  // contact viewing another portfolio couldn't confirm anyway.
  //
  // Phase-4 re-key: the query keys SOLELY off the caller's STABLE portfolio
  // id (self-scope → ensurePortfolio, guaranteed non-null) — every row is
  // portfolio-stamped, so the Phase-2 legacy ownerId leg and its dedupe-merge
  // are gone. Two equality filters with no orderBy — served from single-field
  // indexes (zigzag merge), no composite index to manage. Offline rent is the
  // only thing that ever sits in "pending", so the in-memory category filter
  // is just a guard; the pending set is tiny, so we sort in memory.
  app.get("/api/owner/payments/pending", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    try {
      const portfolio = await ensurePortfolio(uid);
      const pfSnap = await db()
        .collection(COL.transactions)
        .where("portfolioId", "==", portfolio.id)
        .where("status", "==", "pending")
        .get();
      const txs = pfSnap.docs
        .map((d) => d.data() as Transaction)
        .filter((t) => t.category === "rent");
      if (txs.length === 0) return res.json([]);

      // Join property addresses + the tenant's real name. Tenant.name holds
      // the invite email and is never updated, so the display name comes from
      // the linked User account (via tenancy.userId) — the same resolution the
      // offline-log push uses above.
      const propertyIds = Array.from(
        new Set(txs.map((t) => t.propertyId).filter((x): x is string => !!x)),
      );
      const tenantIds = Array.from(
        new Set(txs.map((t) => t.tenantId).filter((x): x is string => !!x)),
      );
      const propertyRefs = propertyIds.map((id) => db().collection(COL.properties).doc(id));
      const tenancyRefs = tenantIds.map((id) => db().collection(COL.tenants).doc(id));
      const [propertyDocs, tenancyDocs] = await Promise.all([
        propertyRefs.length ? db().getAll(...propertyRefs) : Promise.resolve([]),
        tenancyRefs.length ? db().getAll(...tenancyRefs) : Promise.resolve([]),
      ]);
      const addressById = new Map<string, string>();
      propertyDocs.forEach(
        (s) => s.exists && addressById.set(s.id, (s.data() as Property).address),
      );
      const tenancyById = new Map<string, Tenant>();
      tenancyDocs.forEach((s) => s.exists && tenancyById.set(s.id, s.data() as Tenant));

      const userIds = Array.from(
        new Set(
          Array.from(tenancyById.values())
            .map((t) => t.userId)
            .filter((x): x is string => !!x),
        ),
      );
      const userRefs = userIds.map((id) => db().collection(COL.users).doc(id));
      const userDocs = userRefs.length ? await db().getAll(...userRefs) : [];
      const userById = new Map<string, User>();
      userDocs.forEach((s) => s.exists && userById.set(s.id, s.data() as User));

      const tenantNameFor = (tenantId?: string): string => {
        const tenancy = tenantId ? tenancyById.get(tenantId) : undefined;
        const user = tenancy?.userId ? userById.get(tenancy.userId) : undefined;
        const name = `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim();
        return name || user?.email || "Your tenant";
      };

      const payload = txs
        .map((t) => ({
          id: t.id,
          amount: t.amount,
          currency: t.currency || "EUR",
          paymentMethod: t.paymentMethod ?? null,
          timestamp: t.timestamp,
          propertyId: t.propertyId ?? null,
          propertyAddress: t.propertyId ? (addressById.get(t.propertyId) ?? null) : null,
          tenantId: t.tenantId ?? null,
          tenantName: tenantNameFor(t.tenantId),
          proofUrl: t.proofUrl ?? null,
          notes: t.notes ?? null,
        }))
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
      res.json(payload);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load pending payments") });
    }
  });

  // ── Stripe Checkout flow ──────────────────────────────────────────

  // Create a Stripe Checkout Session that routes funds to the
  // landlord's Connect account. Tenant is redirected to Stripe; on
  // return we finalize via the /finalize route below (no webhook
  // required for the MVP).
  app.post(
    "/api/tenant/payment/checkout",
    requireAuth,
    requireFeature("rentCheckout"),
    async (req, res) => {
      const { uid } = req.user!;
      // Per-user hourly cap. Each call creates a Stripe Checkout
      // session (an API call to Stripe) — a UI loop or attacker
      // hammering this endpoint would burn Stripe API quota. 30/hour
      // is well above any legitimate retry pattern (the tenant might
      // restart checkout a few times if they hit card issues).
      const limit = await rateLimit(`checkout:${uid}`, 30, 60 * 60);
      if (!limit.allowed) {
        res.set("Retry-After", String(limit.retryAfterSeconds));
        return res.status(429).json({
          error: "Too many checkout attempts. Try again in a bit.",
          retryAfterSeconds: limit.retryAfterSeconds,
        });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const unitId = typeof body.unitId === "string" ? body.unitId : "";
      const successUrl = typeof body.successUrl === "string" ? body.successUrl : "";
      const cancelUrl = typeof body.cancelUrl === "string" ? body.cancelUrl : "";
      if (!unitId) return res.status(400).json({ error: "unitId is required" });
      if (!successUrl || !cancelUrl)
        return res.status(400).json({ error: "successUrl and cancelUrl are required" });
      // Open-redirect guard: Stripe Checkout will redirect the user to
      // these URLs after payment. Without an allowlist an attacker
      // could craft a checkout link that lands the victim at evil.com/
      // phishing post-payment, styled like an Olio confirmation.
      if (!isSafeRedirectUrl(successUrl) || !isSafeRedirectUrl(cancelUrl)) {
        return res.status(400).json({
          error: "successUrl and cancelUrl must point at an Olio domain",
        });
      }

      if (!isStripeConfigured()) {
        return res.status(503).json({
          error: "Card payments are not yet available — STRIPE_SECRET_KEY is unset.",
        });
      }

      const ctx = await loadActiveTenancy(uid, unitId);
      if (!ctx) return res.status(404).json({ error: "Active tenancy not found" });

      if (!ctx.banking.connectAccountId || !ctx.banking.connectChargesEnabled) {
        return res.status(503).json({
          error:
            "Your landlord hasn't finished setting up card payments yet. Use 'Record offline payment' for now.",
        });
      }

      // Owner-created leases have no Unit doc, so the rent amount lives on
      // the tenancy doc; fall back to it when the unit is absent.
      const monthlyRent = ctx.unit?.rentAmount ?? ctx.tenant.rentAmount ?? 0;

      // Read the active agreement once — for BOTH the billing frequency and the
      // cycle this payment covers. A quarterly/yearly lease must be charged the
      // WHOLE period (3 / 12 months), not one month: the cycle clock advances a
      // full period on payment (advanceAgreementForPayment), so charging one
      // month systematically under-collected. Frequency missing/legacy → monthly.
      let agreement: Agreement | null = null;
      try {
        const agSnap = await db()
          .collection(COL.agreements)
          .where("tenantId", "==", ctx.tenant.id)
          .where("status", "==", "active")
          .limit(1)
          .get();
        if (!agSnap.empty) agreement = agSnap.docs[0].data() as Agreement;
      } catch {
        // Non-fatal — default to a single-month charge + current-cycle advance.
      }
      const periods = monthsPerPeriod(agreement?.paymentFrequency);
      const amountCents = Math.round(monthlyRent * periods * 100);
      if (!amountCents) return res.status(400).json({ error: "No rent amount set for this lease" });
      // The cycle this checkout pays for (the agreement's current due date),
      // carried in session metadata so finalize/webhook advance idempotently.
      const rentPeriod = agreement?.nextPaymentDate?.slice(0, 10);

      // Compute the platform commission from the per-plan matrix
      // configured by admins in /admin/settings → Payments. 0 (the
      // default) skips the application_fee_amount field entirely so we
      // never accidentally charge non-zero before an admin opts in.
      const fee = await computeRentCommission(ctx.tenant.ownerId, amountCents);

      // Idempotency key — stable per (tenant, unit, amount, CYCLE, day). A
      // retry within 24h returns the same Checkout Session URL instead of
      // creating a duplicate. Keying on the rent cycle (not just the day) means
      // a tenant who pays the current cycle and then pre-pays the NEXT cycle the
      // same day for the same amount gets a fresh session for the second cycle
      // instead of colliding on a reused key. Falls back to the day when the
      // lease has no due date (legacy/edge).
      const idemDay = new Date().toISOString().slice(0, 10);
      const idempotencyKey = `rent:${ctx.tenant.id}:${ctx.tenant.unitId}:${amountCents}:${rentPeriod ?? idemDay}`;

      // Phase-1 portfolio re-key: carry the LANDLORD's stable portfolio doc id
      // in the session metadata so the finalize/webhook recorder
      // (recordRentTransactionFromSession) can stamp the Transaction without a
      // second lookup.
      const pf = await ensurePortfolio(ctx.tenant.ownerId);

      try {
        const session = await stripe().checkout.sessions.create(
          {
            mode: "payment",
            success_url: `${successUrl}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: cancelUrl,
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: "eur",
                  unit_amount: amountCents,
                  product_data: {
                    // Receipt line: unit label if there is a Unit doc, else the
                    // property address (owner-created leases have no unit). The
                    // period suffix makes a multi-month (quarterly/yearly) charge
                    // legible on the Stripe receipt.
                    name: `Rent${periods > 1 ? ` (${periods} months)` : ""} — ${
                      ctx.unit?.label ??
                      ctx.property?.name ??
                      ctx.property?.address ??
                      "your rental"
                    }`,
                  },
                },
              },
            ],
            // Direct charge: the session/charge is created ON the owner's
            // connected account (stripeAccount in the request options below),
            // so the OWNER is the merchant of record and bears chargeback
            // liability. Olio's commission is pulled off the top via
            // application_fee_amount — NO transfer_data (that belongs to the
            // destination-charge model where the platform is liable).
            ...(fee.feeCents > 0
              ? { payment_intent_data: { application_fee_amount: fee.feeCents } }
              : {}),
            metadata: {
              tenantId: ctx.tenant.id,
              unitId: ctx.tenant.unitId,
              propertyId: ctx.tenant.propertyId,
              ownerId: ctx.tenant.ownerId,
              portfolioId: pf.id,
              payerUid: uid,
              purpose: "rent",
              applicationFeeCents: String(fee.feeCents),
              ownerPlan: fee.plan,
              ...(rentPeriod ? { rentPeriod } : {}),
              // Bind the resulting Transaction to its lease (read by
              // recordRentTransactionFromSession). The active agreement was
              // already loaded above for the period/frequency.
              ...(agreement?.id ? { agreementId: agreement.id } : {}),
            },
          },
          { idempotencyKey, stripeAccount: ctx.banking.connectAccountId },
        );
        res.json({ url: session.url, sessionId: session.id });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Stripe checkout failed") });
      }
    },
  );

  // Called by the dashboard when the user lands back from Stripe.
  // Verifies the session is paid, then writes a completed transaction
  // (idempotent on session_id).
  app.post("/api/tenant/payment/finalize", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const unitId = typeof body.unitId === "string" ? body.unitId : "";
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
    if (!unitId) return res.status(400).json({ error: "unitId is required" });
    if (!isStripeConfigured()) return res.status(503).json({ error: "Stripe is not configured" });

    // Re-load the tenancy FIRST. This re-validates the caller↔unit link and
    // gives us both the connectAccountId (for the Stripe-Account header on the
    // cold path) and the tenancy id we use to authorize the idempotent return
    // below. Direct charges live on the OWNER's connected account, so the
    // session can only be retrieved in that account's context.
    const ctx = await loadActiveTenancy(uid, unitId);
    if (!ctx?.banking.connectAccountId)
      return res.status(404).json({ error: "Active tenancy not found" });

    // Idempotency — if we've already recorded this session, return the
    // existing tx. SECURITY: only when it belongs to THIS caller's tenancy.
    // Stripe session ids are not secret (they ride in the success_url query
    // string, browser history and referrer) and this route is requireAuth
    // only, so without this ownership binding any authenticated user could
    // read another tenant's rent record (ownerId, amount, application fee,
    // owner net, plan tier) just by replaying their session id — the
    // cold-path payerUid check never runs on this cached branch.
    const existing = await db()
      .collection(COL.transactions)
      .where("stripeSessionId", "==", sessionId)
      .limit(1)
      .get();
    if (!existing.empty) {
      const tx = existing.docs[0].data() as Transaction;
      if (tx.tenantId !== ctx.tenant.id) {
        return res.status(403).json({ error: "Session belongs to a different user" });
      }
      return res.json(tx);
    }

    let session;
    try {
      // Expand the PaymentIntent so the recorder can use the
      // authoritative application_fee_amount (what Stripe actually
      // charged) rather than trusting session.metadata.
      session = await stripe().checkout.sessions.retrieve(
        sessionId,
        { expand: ["payment_intent"] },
        { stripeAccount: ctx.banking.connectAccountId },
      );
    } catch (err: unknown) {
      return res.status(400).json({ error: errMsg(err, "Invalid session") });
    }

    if (session.payment_status !== "paid") {
      return res.status(409).json({
        error: `Payment not completed (status: ${session.payment_status})`,
      });
    }
    if (session.metadata?.payerUid !== uid) {
      return res.status(403).json({ error: "Session belongs to a different user" });
    }

    const { tx, created } = await recordRentTransactionFromSession(session);
    res.status(created ? 201 : 200).json(tx);
  });

  // ── Lease approval (tenant accept / decline) ──────────────────────

  // POST /api/tenant/agreements/:id/respond — the tenant approves or
  // declines a lease their landlord created. An owner-created agreement
  // lands in status "pending_tenant" (see POST /api/owner/agreements);
  // this is where it becomes "active" (tenant accepted) or "declined".
  // The tenancy doc's status is moved in lockstep so the owner's tenant
  // list and the tenant's dashboard agree.
  //
  // Ownership: the caller must be the linked tenant — we load the
  // agreement, then its tenancy doc, and require tenancy.userId === uid.
  // Idempotent: re-POSTing the same action that already took effect
  // returns 200 without re-notifying; the opposite action on an already
  // -resolved lease is a 409 (can't decline a lease you already accepted).
  app.post("/api/tenant/agreements/:id/respond", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const agreementId = reqStr(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = body.action === "approve" || body.action === "decline" ? body.action : null;
    if (!action) {
      return res.status(400).json({ error: 'action must be "approve" or "decline"' });
    }

    try {
      const agreementRef = db().collection(COL.agreements).doc(agreementId);
      const agreementSnap = await agreementRef.get();
      if (!agreementSnap.exists) {
        return res.status(404).json({ error: "Agreement not found" });
      }
      const agreement = agreementSnap.data() as Agreement;

      // The agreement points at a tenancy doc; that doc carries the
      // linked tenant's User.id. Authorize off the tenancy, not the
      // agreement (which only stores ownerId).
      const tenantRef = db().collection(COL.tenants).doc(agreement.tenantId);
      const tenantSnap = await tenantRef.get();
      if (!tenantSnap.exists) {
        return res.status(404).json({ error: "Tenancy not found" });
      }
      const tenancy = tenantSnap.data() as Tenant;
      if (tenancy.userId !== uid) {
        return res.status(403).json({ error: "Not your agreement" });
      }

      const targetAgreementStatus = action === "approve" ? "active" : "declined";

      // Idempotency: if it's already in the state this action would
      // produce, return the current shape without re-writing/notifying.
      if (agreement.status === targetAgreementStatus) {
        return res.json({ id: agreementId, status: agreement.status });
      }
      // Only a pending lease can be responded to. Anything else
      // (already active, declined, expired, terminated, suspended) is a conflict.
      if (agreement.status !== "pending_tenant") {
        return res.status(409).json({
          error: `This lease can no longer be ${action}d (status: ${agreement.status}).`,
        });
      }

      // A plan downgrade can soft-deactivate the property while a lease is still
      // pending the tenant's approval. Approving would create an ACTIVE lease on
      // a hidden property (and the 30-day sweep only terminates suspended
      // leases, so it'd linger). Block approval until the owner restores the
      // property; declining is always allowed.
      if (action === "approve") {
        // Defense-in-depth against tenancy resurrection: if the owner already
        // ENDED this tenancy (the only way to cancel a pending invite is
        // /tenants/:id/end), refuse approval — otherwise approving a stale
        // pending_tenant agreement would bring the ended tenancy back to life
        // and could win the occupancy race against a newer invite. The end
        // handler now also closes pending agreements, so this mainly guards any
        // agreement left pending on an already-ended tenancy (pre-fix data).
        if (tenancy.status === "expired" || tenancy.status === "declined") {
          return res.status(409).json({
            error: "This invitation is no longer valid — the landlord has cancelled it.",
          });
        }
        const propSnap = await db().collection(COL.properties).doc(agreement.propertyId).get();
        if ((propSnap.data() as Property | undefined)?.status === "inactive") {
          return res.status(409).json({
            error:
              "This property is paused on the owner's current plan. The lease can't be accepted until they restore it.",
          });
        }
      }

      const now = new Date().toISOString();
      const targetTenancyStatus = action === "approve" ? "active" : "declined";

      // On approval, re-anchor the indexation clock to activation: the
      // first increase was seeded at CREATION (while pending_tenant), so a
      // lease approved after that date already passed would otherwise have
      // the sweep apply an increase immediately, with no prenotice. Rolling
      // forward to the next not-yet-passed step (no retroactive application)
      // restores the notify-then-apply guarantee.
      const agreementPatch: Record<string, unknown> = {
        status: targetAgreementStatus,
        ...(action === "approve" ? { acceptedAt: now } : { declinedAt: now }),
      };
      if (action === "approve" && agreement.indexation) {
        const reseeded = nextIncreaseDateOnOrAfter(agreement, now.slice(0, 10));
        if (reseeded) {
          agreementPatch.indexation = {
            ...agreement.indexation,
            nextIncreaseDate: reseeded,
          };
        }
      }

      // Move agreement + tenancy together so the two never disagree. On
      // approval, re-check occupancy INSIDE the txn: two pending invites on the
      // same property could otherwise both flip to active in a race (the
      // create-side guard is a pre-check and can't see a concurrent approval).
      // Block if any OTHER tenancy on this property is already active.
      let blockedByOccupancy = false;
      await db().runTransaction(async (t) => {
        if (action === "approve") {
          const activeSnap = await t.get(
            db()
              .collection(COL.tenants)
              .where("propertyId", "==", agreement.propertyId)
              .where("status", "==", "active"),
          );
          if (activeSnap.docs.some((d) => d.id !== agreement.tenantId)) {
            blockedByOccupancy = true;
            return;
          }
        }
        t.set(agreementRef, agreementPatch, { merge: true });
        t.set(tenantRef, { status: targetTenancyStatus }, { merge: true });
      });
      if (blockedByOccupancy) {
        return res.status(409).json({
          error:
            "This property already has an active lease, so this one can't be accepted. Please contact your landlord.",
        });
      }

      // Tell the landlord. Best-effort — a push hiccup must not undo
      // the tenant's decision (already committed above).
      const tenantName =
        `${req.user!.profile?.firstName ?? ""} ${req.user!.profile?.lastName ?? ""}`.trim() ||
        tenancy.name ||
        "Your tenant";
      await notifyUser({
        externalUserId: agreement.ownerId,
        category: "propertyActivity",
        title: action === "approve" ? "Lease accepted" : "Lease declined",
        message:
          action === "approve"
            ? `${tenantName} accepted the lease. It's now active.`
            : `${tenantName} declined the lease you sent.`,
        url: "https://app.oliowallet.com/owner",
      });

      res.json({ id: agreementId, status: targetAgreementStatus });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to respond to agreement") });
    }
  });
}
