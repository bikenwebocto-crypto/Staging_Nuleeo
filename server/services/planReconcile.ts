// Plan-downgrade reconciliation. Fires from the Stripe webhook on
// `customer.subscription.updated` when the owner's plan tier actually
// drops (Pro → Growth, etc.). Plans are annual, so the renewal-time
// downgrade is when this matters — Stripe enacts the new plan at
// renewal, sends the event, we react.
//
// Policy (per product owner — NOTHING IS DELETED on a downgrade):
//   1. New plan's unit cap < current ACTIVE property count → SOFT-DEACTIVATE
//      the excess. Vacant first; then occupied. Deactivation flips the
//      property + its units to status "inactive" (hidden from the owner) and
//      its agreements to "suspended" (paused, NOT terminated — nextPaymentDate
//      is preserved). The tenancy, agreements, documents and the entire
//      transaction ledger are RETAINED.
//   2. New plan loses the `rent.collectStripe` privilege → SUSPEND every
//      remaining active agreement (rent can no longer be Stripe-collected) —
//      again paused, not terminated.
//
// A 30-day grace then runs (sweepInactiveUnits cron): a re-upgrade — or
// freeing cap by deleting other properties — within the window RESUMES the
// lease as if nothing happened (preserved schedule). After 30 days the sweep
// purges only the unit's documents and the lease is terminated; the unit /
// agreement / tenant / activity all live on (admin-visible). Activity stays
// visible to BOTH the owner and the tenant the entire time.
//
// Both downgrade pieces happen inside ONE reconcile call so the side effects
// are coherent.

import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase";
import { logError, logWarn } from "./log";
import {
  COL,
  CONFIG_DOC_PLAN_LABELS,
  CONFIG_DOC_PRIVILEGES,
  DEFAULT_PLAN_LABELS,
  DEFAULT_PRIVILEGES_CONFIG,
  type Agreement,
  type OwnerPlanKey,
  type PlanLabelsConfig,
  type PrivilegesConfig,
  type Property,
  type Tenant,
} from "../../shared/firestore-schema";
import { notifyUser } from "./push";
import { occupiedPropertyIds } from "./occupancy";
import { getPortfolio } from "./portfolioBanking";
import { resolveOwnerPlan } from "./commission";
import { nextIncreaseDateOnOrAfter } from "./leaseDates";

// Phase-4 portfolio re-key: the owner-scoped enforcement sweeps key SOLELY
// off the STABLE portfolio doc id (stamped on every row at creation;
// survives an owner transfer) — the Phase-2 legacy ownerId fallback is gone.
// The portfolio is REQUIRED: a downgrade target with no portfolio doc has no
// properties/tenants/agreements by construction, so reconcile no-ops for
// them (logged, never silently swept by a stale uid key).

// The soft-deactivation grace window. A re-upgrade (or cap freed by deleting
// other properties) within this many days resumes the lease untouched; after
// it the sweepInactiveUnits cron purges documents + terminates the lease.
export const GRACE_DAYS = 30;
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

// Internal ordering — used to detect downgrades (newRank < oldRank).
// Exported so the test suite can pin the real comparator instead of
// re-implementing it (a divergent copy would give the shipped logic
// zero coverage).
export const PLAN_RANK: Record<OwnerPlanKey, number> = {
  basic: 1,
  advance: 2,
  pro: 3,
  business: 4,
};

// Decide which properties to deactivate first on a cap downgrade.
//   - Vacant before occupied (user policy: don't hide a live tenancy
//     while a vacant property survives).
//   - Within each group, newest first (older = more established → keep).
// Occupancy is supplied as a Set of property ids (derived from ACTIVE
// tenancies — see services/occupancy.ts). Exported so the test suite
// exercises the real ordering used by reconcileAfterPlanChange.
export function orderForDeletion(properties: Property[], occupiedSet: Set<string>): Property[] {
  const byCreatedDesc = (a: Property, b: Property) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  const vacant = properties.filter((p) => !occupiedSet.has(p.id)).sort(byCreatedDesc);
  const occupied = properties.filter((p) => occupiedSet.has(p.id)).sort(byCreatedDesc);
  return [...vacant, ...occupied];
}

// A property counts as ACTIVE for cap purposes unless explicitly inactive.
// Absent status (legacy docs) ⇒ active.
function isActiveProperty(p: Property): boolean {
  return p.status !== "inactive";
}

// The heart of the 30-day grace policy, extracted pure so it's unit-tested
// directly (the surrounding cascade is Firestore-bound). Given when a lease was
// suspended and whether the restoring plan can collect rent:
//   • past the 30-day window → "terminate" (lease is dead; recreate to continue);
//   • within the window + rent collection allowed → "resume" (as if nothing
//     happened — schedule preserved);
//   • within the window but rent collection still lost → "hold" (property comes
//     back, but the lease stays paused until the privilege returns).
// A missing suspendedAt is treated as out-of-window (→ terminate), matching the
// ledger's "can't prove it's recent → default to the safe path" convention.
export function restoreDecision(
  suspendedAt: string | undefined,
  now: string,
  rentCollectAllowed: boolean,
): "resume" | "hold" | "terminate" {
  const suspendedMs = suspendedAt ? new Date(suspendedAt).getTime() : NaN;
  const withinGrace =
    Number.isFinite(suspendedMs) && new Date(now).getTime() - suspendedMs <= GRACE_MS;
  if (!withinGrace) return "terminate";
  return rentCollectAllowed ? "resume" : "hold";
}

export interface ReconcileResult {
  uid: string;
  oldPlan: OwnerPlanKey;
  newPlan: OwnerPlanKey;
  newCap: number | null;
  beforeCount: number;
  vacantDeactivated: number;
  occupiedDeactivated: number;
  agreementsSuspended: number;
  rentCollectLost: boolean;
}

export interface RestoreResult {
  uid: string;
  oldPlan: OwnerPlanKey;
  newPlan: OwnerPlanKey;
  propertiesRestored: number;
  agreementsResumed: number;
  agreementsTerminated: number;
}

async function loadCaps(): Promise<Record<OwnerPlanKey, number | null>> {
  const snap = await db().collection(COL.config).doc(CONFIG_DOC_PLAN_LABELS).get();
  const stored = snap.exists ? (snap.data() as Partial<PlanLabelsConfig>) : {};
  const plans = { ...DEFAULT_PLAN_LABELS.plans, ...(stored.plans ?? {}) };
  return {
    basic: plans.basic?.unitCap ?? DEFAULT_PLAN_LABELS.plans.basic.unitCap,
    advance: plans.advance?.unitCap ?? DEFAULT_PLAN_LABELS.plans.advance.unitCap,
    pro: plans.pro?.unitCap ?? DEFAULT_PLAN_LABELS.plans.pro.unitCap,
    business: plans.business?.unitCap ?? DEFAULT_PLAN_LABELS.plans.business.unitCap,
  };
}

async function hasRentCollectOnPlan(plan: OwnerPlanKey): Promise<boolean> {
  const snap = await db().collection(COL.config).doc(CONFIG_DOC_PRIVILEGES).get();
  const stored = snap.exists ? (snap.data() as Partial<PrivilegesConfig>) : {};
  const ownerPlan = {
    ...DEFAULT_PRIVILEGES_CONFIG.ownerPlan,
    ...(stored.ownerPlan ?? {}),
  };
  const grant = ownerPlan["rent.collectStripe"];
  return Boolean(grant?.[plan]);
}

// Whether the plan is granted the `units.unlimited` privilege. The read-side
// gate (resolveUnitCap, services/planLimits.ts) treats this grant as cap=null
// (unlimited), so reconcile MUST honour it too — otherwise a downgrade INTO a
// tier that has units.unlimited granted would soft-deactivate properties the
// gate considers uncapped. Reads config/privileges the same way as
// hasRentCollectOnPlan (and resolveUnitCap). Benign under defaults:
// units.unlimited is granted only to `business`, which already has a null cap.
async function hasUnlimitedUnitsOnPlan(plan: OwnerPlanKey): Promise<boolean> {
  const snap = await db().collection(COL.config).doc(CONFIG_DOC_PRIVILEGES).get();
  const stored = snap.exists ? (snap.data() as Partial<PrivilegesConfig>) : {};
  const ownerPlan = {
    ...DEFAULT_PRIVILEGES_CONFIG.ownerPlan,
    ...(stored.ownerPlan ?? {}),
  };
  const grant = ownerPlan["units.unlimited"];
  return Boolean(grant?.[plan]);
}

// Pure decision: the plan's EFFECTIVE unit cap given its labelled cap and
// whether `units.unlimited` is granted — exactly as the read-side gate
// (resolveUnitCap) decides. A grant overrides the labelled cap to null
// (unlimited). Exported so the test suite pins the real rule instead of
// re-implementing it. The async wrapper below supplies the grant from config.
export function effectiveCap(labelledCap: number | null, unlimitedGranted: boolean): number | null {
  return unlimitedGranted ? null : labelledCap;
}

// The plan's EFFECTIVE unit cap, resolved exactly as the read-side gate does.
// Keeps reconcile/restore and resolveUnitCap from disagreeing about whether a
// tier is capped.
async function effectiveCapForPlan(
  caps: Record<OwnerPlanKey, number | null>,
  plan: OwnerPlanKey,
): Promise<number | null> {
  return effectiveCap(caps[plan], await hasUnlimitedUnitsOnPlan(plan));
}

// SOFT-DEACTIVATE one property and everything under it — the non-destructive
// replacement for the old deletePropertyCascade. NOTHING is deleted: the
// property + its units flip to "inactive" (hidden from the owner) and its
// active agreements flip to "suspended" with nextPaymentDate PRESERVED so a
// within-grace restore resumes the original schedule. The tenancy is left
// "active" (its owner-facing revenue/occupancy is excluded at the read layer
// via the property's inactive status) so resume is a clean status flip back.
// No storage touched here — document purge is deferred to the 30-day sweep.
async function deactivatePropertyCascade(
  propertyId: string,
  reason: "planDowngrade" | "rentCollectLost",
  now: string,
): Promise<void> {
  const dbi = db();
  const [unitSnap, agreementsSnap] = await Promise.all([
    dbi.collection(COL.units).where("propertyId", "==", propertyId).get(),
    dbi.collection(COL.agreements).where("propertyId", "==", propertyId).get(),
  ]);

  const batch = dbi.batch();
  // Clear any stale docsPurgedAt from a PRIOR purge→restore cycle: the sweep's
  // idempotency guard skips any property that carries a docsPurgedAt, so a
  // property purged once, restored, then re-deactivated would never have its
  // NEW documents/lease purged. Each fresh deactivation must start a clean
  // 30-day window, so we drop the old stamp here (and on restore).
  batch.set(
    dbi.collection(COL.properties).doc(propertyId),
    { status: "inactive", deactivatedAt: now, docsPurgedAt: FieldValue.delete() },
    { merge: true },
  );
  // Owner-created properties have no Unit doc at all (unitId === propertyId), so
  // this loop is a no-op for them — the Property.status flip above carries it.
  unitSnap.docs.forEach((d) =>
    batch.set(
      d.ref,
      { status: "inactive", deactivatedAt: now, docsPurgedAt: FieldValue.delete() },
      { merge: true },
    ),
  );
  // Only "active" leases are suspended. A "pending_tenant" lease (owner invited,
  // tenant hasn't accepted) is intentionally left untouched: it carries no
  // payment schedule to preserve, it's already hidden from the owner (the
  // agreements read drops inactive-property leases), and the tenant respond
  // endpoint blocks ACCEPTING a lease on an inactive property — so it simply
  // waits for the property to be restored. Declined/expired/terminated are
  // terminal and irrelevant.
  agreementsSnap.docs.forEach((d) => {
    if ((d.data() as Agreement).status === "active") {
      batch.set(
        d.ref,
        { status: "suspended", suspendedAt: now, suspendedReason: reason },
        { merge: true },
      );
    }
  });
  await batch.commit();
}

// Suspend every STILL-active agreement for this owner — used when the new plan
// loses rent.collectStripe (every Stripe-collected tenancy has to pause). The
// property stays active/visible (the owner can still manage it); only the lease
// is paused. nextPaymentDate is PRESERVED so a re-upgrade resumes the schedule.
async function suspendRemainingAgreements(
  portfolioId: string,
  now: string,
): Promise<{ agreementsSuspended: number; tenantsNotified: number }> {
  const dbi = db();

  const agreementsSnap = await dbi
    .collection(COL.agreements)
    .where("portfolioId", "==", portfolioId)
    .where("status", "==", "active")
    .get();
  if (agreementsSnap.empty) {
    return { agreementsSuspended: 0, tenantsNotified: 0 };
  }

  const tenantIds = Array.from(
    new Set(agreementsSnap.docs.map((d) => (d.data() as Agreement).tenantId)),
  );
  const tenantDocs = await Promise.all(
    tenantIds.map((id) => dbi.collection(COL.tenants).doc(id).get()),
  );
  const tenantsByDocId = new Map<string, Tenant>();
  tenantDocs.forEach((s) => {
    if (s.exists) tenantsByDocId.set(s.id, s.data() as Tenant);
  });

  // Suspend (not terminate) — preserve nextPaymentDate + leave the tenancy
  // "active" so a re-upgrade resumes cleanly.
  const batch = dbi.batch();
  agreementsSnap.docs.forEach((d) => {
    batch.set(
      d.ref,
      { status: "suspended", suspendedAt: now, suspendedReason: "rentCollectLost" },
      { merge: true },
    );
  });
  await batch.commit();

  // Notify each tenant. Their landlord's plan change isn't their fault —
  // surface a clear "rent collection is paused" message.
  let tenantsNotified = 0;
  for (const tenant of Array.from(tenantsByDocId.values())) {
    if (!tenant.userId) continue;
    try {
      await notifyUser({
        externalUserId: tenant.userId,
        category: "propertyActivity",
        title: "Rent collection paused",
        message:
          "Your landlord's Olio plan can no longer collect rent through the app. Your tenancy is paused — they have 30 days to restore it before it ends.",
        url: "https://app.oliowallet.com/tenant",
      });
      tenantsNotified += 1;
    } catch (err) {
      logWarn("plan_reconcile.tenant-notify-failed", {
        uid: tenant.userId,
        err: String(err).slice(0, 200),
      });
    }
  }
  return { agreementsSuspended: agreementsSnap.size, tenantsNotified };
}

export async function reconcileAfterPlanChange(
  uid: string,
  oldPlan: OwnerPlanKey,
  newPlan: OwnerPlanKey,
): Promise<ReconcileResult | null> {
  // Only act on actual downgrades. Upgrades + lateral changes (basic→basic)
  // need no cleanup — they just unlock more, never restrict. (Re-upgrade
  // restoration is reactivateAfterPlanUpgrade, called separately.)
  if (PLAN_RANK[newPlan] >= PLAN_RANK[oldPlan]) {
    return null;
  }

  const dbi = db();
  const now = new Date().toISOString();

  // Resolve the new plan's cap + rent.collectStripe status concurrently. The
  // cap is the EFFECTIVE cap (units.unlimited grant ⇒ null), matching the read-
  // side gate so a downgrade into an uncapped-by-privilege tier never deactivates.
  const [caps, rentCollectAllowed] = await Promise.all([loadCaps(), hasRentCollectOnPlan(newPlan)]);
  const newCap = await effectiveCapForPlan(caps, newPlan);

  // Sweeps key SOLELY off the stable portfolio id (Phase 4) — an owner with no
  // portfolio has no stamped rows, so reconcile is a logged no-op.
  const portfolio = await getPortfolio(uid);
  if (!portfolio) {
    logWarn("plan_reconcile.no-portfolio", { uid, oldPlan, newPlan });
    return null;
  }
  const portfolioId = portfolio.id;
  const propsSnap = await dbi
    .collection(COL.properties)
    .where("portfolioId", "==", portfolioId)
    .get();
  // Occupancy MUST derive from ACTIVE tenancies, not Unit.currentTenantId
  // (never written; owner-created properties have no Unit doc). Two equality
  // filters need no composite index.
  const activeTenantsSnap = await dbi
    .collection(COL.tenants)
    .where("portfolioId", "==", portfolioId)
    .where("status", "==", "active")
    .get();
  const occupiedSet = occupiedPropertyIds(activeTenantsSnap.docs.map((d) => d.data() as Tenant));

  // Only ALREADY-ACTIVE properties count toward the cap and are eligible for
  // deactivation — never re-deactivate something a prior downgrade already hid.
  const activeProperties = propsSnap.docs.map((d) => d.data() as Property).filter(isActiveProperty);
  const beforeCount = activeProperties.length;

  // business (highest rank) has a null cap, so newCap is never null on a real
  // downgrade — defensive coverage anyway.
  let excess = 0;
  if (newCap !== null && beforeCount > newCap) {
    excess = beforeCount - newCap;
  }

  let vacantDeactivated = 0;
  let occupiedDeactivated = 0;
  if (excess > 0) {
    const ordered = orderForDeletion(activeProperties, occupiedSet);
    const toDeactivate = ordered.slice(0, excess);

    for (const p of toDeactivate) {
      const wasOccupied = occupiedSet.has(p.id);
      try {
        await deactivatePropertyCascade(p.id, "planDowngrade", now);
        if (wasOccupied) {
          occupiedDeactivated += 1;
        } else {
          vacantDeactivated += 1;
        }
      } catch (err) {
        logError("plan_reconcile.deactivate-failed", err, {
          propertyId: p.id,
          ownerUid: uid,
        });
      }
    }
  }

  // Rent-collect loss → suspend ALL remaining active agreements. Properties
  // deactivated above already had their agreements suspended by the cascade;
  // this catches the agreements that survived the deactivation pass.
  let agreementsSuspended = 0;
  const rentCollectLost = !rentCollectAllowed;
  if (rentCollectLost) {
    const result = await suspendRemainingAgreements(portfolioId, now);
    agreementsSuspended = result.agreementsSuspended;
  }

  // Notify the owner so they understand what happened — and that it's reversible
  // within 30 days.
  if (excess > 0 || rentCollectLost) {
    const parts: string[] = [];
    if (excess > 0) {
      parts.push(
        `${excess} ${excess === 1 ? "property was" : "properties were"} hidden to fit your new plan's cap`,
      );
    }
    if (rentCollectLost) {
      parts.push("rent collection through Olio has been paused");
    }
    try {
      await notifyUser({
        externalUserId: uid,
        category: "propertyActivity",
        title: "Plan renewal: portfolio changes",
        message: `${parts.join(". ")}. Re-upgrade within 30 days to restore everything exactly as it was.`,
        url: "https://app.oliowallet.com/owner",
      });
    } catch (err) {
      logWarn("plan_reconcile.owner-notify-failed", { uid, err: String(err).slice(0, 200) });
    }
  }

  return {
    uid,
    oldPlan,
    newPlan,
    newCap,
    beforeCount,
    vacantDeactivated,
    occupiedDeactivated,
    agreementsSuspended,
    rentCollectLost,
  };
}

// Reactivate one previously-deactivated property and decide the fate of each of
// its suspended leases against the 30-day grace boundary:
//   • within grace + rent collection allowed → RESUME (status active, schedule
//     preserved, indexation re-anchored so no retroactive increase fires);
//   • within grace but rent collection still lost → keep the lease suspended
//     (property is visible again, but it can't collect rent yet);
//   • past grace → TERMINATE the lease (the owner must create a fresh one) and
//     end the tenancy.
// The property + its units are always flipped back to "active" so the owner can
// see and use the slot again.
async function restorePropertyCascade(
  propertyId: string,
  now: string,
  rentCollectAllowed: boolean,
): Promise<{ resumed: number; terminated: number }> {
  const dbi = db();
  const [unitSnap, agreementsSnap] = await Promise.all([
    dbi.collection(COL.units).where("propertyId", "==", propertyId).get(),
    dbi.collection(COL.agreements).where("propertyId", "==", propertyId).get(),
  ]);

  const batch = dbi.batch();
  // Also clear docsPurgedAt (see deactivatePropertyCascade): a restored property
  // is active and out of any purge window, so the stamp must not linger to
  // exempt a future re-deactivation from the sweep.
  batch.set(
    dbi.collection(COL.properties).doc(propertyId),
    { status: "active", deactivatedAt: FieldValue.delete(), docsPurgedAt: FieldValue.delete() },
    { merge: true },
  );
  unitSnap.docs.forEach((d) =>
    batch.set(
      d.ref,
      { status: "active", deactivatedAt: FieldValue.delete(), docsPurgedAt: FieldValue.delete() },
      { merge: true },
    ),
  );

  let resumed = 0;
  let terminated = 0;
  for (const d of agreementsSnap.docs) {
    const ag = d.data() as Agreement;
    if (ag.status !== "suspended") continue;
    const decision = restoreDecision(ag.suspendedAt, now, rentCollectAllowed);

    if (decision === "resume") {
      // Resume exactly as it was — preserve nextPaymentDate, re-anchor the
      // indexation clock to "now" so the sweep doesn't apply a retroactive
      // increase with no prenotice (mirrors the tenant-approval re-anchor).
      const patch: Record<string, unknown> = {
        status: "active",
        suspendedAt: FieldValue.delete(),
        suspendedReason: FieldValue.delete(),
      };
      if (ag.indexation) {
        const reseeded = nextIncreaseDateOnOrAfter(ag, now.slice(0, 10));
        if (reseeded) {
          patch.indexation = { ...ag.indexation, nextIncreaseDate: reseeded };
        }
      }
      batch.set(d.ref, patch, { merge: true });
      resumed += 1;
    } else if (decision === "hold") {
      // Property is visible again, but the plan still can't collect rent — keep
      // the lease paused, flagged as a rent-collect hold.
      batch.set(d.ref, { suspendedReason: "rentCollectLost" }, { merge: true });
    } else {
      // Past the 30-day grace → the lease is dead. Terminate it and end the
      // tenancy; the owner must create a fresh agreement (manual, by choice).
      batch.set(
        d.ref,
        {
          status: "terminated",
          terminatedAt: now,
          nextPaymentDate: null,
          suspendedAt: FieldValue.delete(),
          suspendedReason: FieldValue.delete(),
        },
        { merge: true },
      );
      batch.set(
        dbi.collection(COL.tenants).doc(ag.tenantId),
        { status: "expired", endedAt: now, nextPayment: null },
        { merge: true },
      );
      terminated += 1;
    }
  }
  await batch.commit();
  return { resumed, terminated };
}

// Restore as much of a portfolio as the given plan allows. Two pools:
//   A) inactive properties — restore the most-recently-deactivated first, up to
//      the plan's cap;
//   B) leases suspended purely because rent.collectStripe was lost (their
//      property stayed active) — resume them once the privilege is regained.
// Shared by the re-upgrade webhook and the "freed cap by deleting a property"
// path. Idempotent: re-running with nothing to restore is a no-op.
export async function restorePortfolioWithinPlan(
  uid: string,
  plan: OwnerPlanKey,
): Promise<{
  propertiesRestored: number;
  agreementsResumed: number;
  agreementsTerminated: number;
}> {
  const dbi = db();
  const now = new Date().toISOString();

  const portfolio = await getPortfolio(uid);
  if (!portfolio) return { propertiesRestored: 0, agreementsResumed: 0, agreementsTerminated: 0 };
  const portfolioId = portfolio.id;

  const [caps, rentCollectAllowed] = await Promise.all([loadCaps(), hasRentCollectOnPlan(plan)]);
  // Effective cap (units.unlimited grant ⇒ null), consistent with the read-side
  // gate and reconcileAfterPlanChange — so restore can bring back every property
  // on an uncapped-by-privilege tier instead of stopping at the labelled cap.
  const cap = await effectiveCapForPlan(caps, plan);

  const propsSnap = await dbi
    .collection(COL.properties)
    .where("portfolioId", "==", portfolioId)
    .get();
  const all = propsSnap.docs.map((d) => d.data() as Property);
  const activeCount = all.filter(isActiveProperty).length;
  const inactive = all
    .filter((p) => p.status === "inactive")
    // Restore RESUMABLE properties before already-purged shells: a property the
    // 30-day sweep already purged (docsPurgedAt set) has no documents and a
    // terminated lease, so bringing it back as "active" just occupies a cap slot
    // with an empty property. Restore those last, and only if cap remains —
    // within each group, most-recently-deactivated first (most likely occupied).
    .sort((a, b) => {
      const ap = a.docsPurgedAt ? 1 : 0;
      const bp = b.docsPurgedAt ? 1 : 0;
      if (ap !== bp) return ap - bp;
      return (b.deactivatedAt ?? "").localeCompare(a.deactivatedAt ?? "");
    });

  // How many inactive properties can come back without breaching the cap.
  const restorable =
    cap === null ? inactive.length : Math.max(0, Math.min(inactive.length, cap - activeCount));

  let propertiesRestored = 0;
  let agreementsResumed = 0;
  let agreementsTerminated = 0;
  for (const p of inactive.slice(0, restorable)) {
    try {
      const r = await restorePropertyCascade(p.id, now, rentCollectAllowed);
      propertiesRestored += 1;
      agreementsResumed += r.resumed;
      agreementsTerminated += r.terminated;
    } catch (err) {
      logError("plan_reconcile.restore-failed", err, { propertyId: p.id, ownerUid: uid });
    }
  }

  // Pool B — leases suspended for rentCollectLost on still-active properties.
  if (rentCollectAllowed) {
    const restoredPropertyIds = new Set(inactive.slice(0, restorable).map((p) => p.id));
    const suspendedSnap = await dbi
      .collection(COL.agreements)
      .where("portfolioId", "==", portfolioId)
      .where("status", "==", "suspended")
      .get();
    for (const d of suspendedSnap.docs) {
      const ag = d.data() as Agreement;
      // Skip leases on properties we just handled via restorePropertyCascade.
      if (restoredPropertyIds.has(ag.propertyId)) continue;
      if (ag.suspendedReason !== "rentCollectLost") continue;
      // rentCollectAllowed is true in this branch, so the decision is resume
      // (within grace) or terminate (past it — left for the sweep).
      if (restoreDecision(ag.suspendedAt, now, true) !== "resume") continue;
      const patch: Record<string, unknown> = {
        status: "active",
        suspendedAt: FieldValue.delete(),
        suspendedReason: FieldValue.delete(),
      };
      if (ag.indexation) {
        const reseeded = nextIncreaseDateOnOrAfter(ag, now.slice(0, 10));
        if (reseeded) patch.indexation = { ...ag.indexation, nextIncreaseDate: reseeded };
      }
      await d.ref.set(patch, { merge: true });
      agreementsResumed += 1;
    }
  }

  return { propertiesRestored, agreementsResumed, agreementsTerminated };
}

// Re-upgrade restoration — the inverse of reconcileAfterPlanChange. Called from
// the Stripe webhook after the (no-op-on-upgrade) reconcile. Acts only on a
// genuine upgrade; restores up to the NEW plan's cap.
export async function reactivateAfterPlanUpgrade(
  uid: string,
  oldPlan: OwnerPlanKey,
  newPlan: OwnerPlanKey,
): Promise<RestoreResult | null> {
  if (PLAN_RANK[newPlan] <= PLAN_RANK[oldPlan]) return null;

  const r = await restorePortfolioWithinPlan(uid, newPlan);
  if (r.propertiesRestored === 0 && r.agreementsResumed === 0 && r.agreementsTerminated === 0) {
    return { uid, oldPlan, newPlan, ...r };
  }

  try {
    const resumedLeases = r.agreementsResumed;
    const parts: string[] = [];
    if (r.propertiesRestored > 0) {
      parts.push(
        `${r.propertiesRestored} ${r.propertiesRestored === 1 ? "property" : "properties"} restored`,
      );
    }
    if (resumedLeases > 0) {
      parts.push(`${resumedLeases} ${resumedLeases === 1 ? "lease" : "leases"} resumed`);
    }
    if (r.agreementsTerminated > 0) {
      parts.push(
        `${r.agreementsTerminated} ${
          r.agreementsTerminated === 1 ? "lease was" : "leases were"
        } past the 30-day window and ended — recreate to continue`,
      );
    }
    if (parts.length > 0) {
      await notifyUser({
        externalUserId: uid,
        category: "propertyActivity",
        title: "Plan upgrade: portfolio restored",
        message: `${parts.join(". ")}.`,
        url: "https://app.oliowallet.com/owner",
      });
    }
  } catch (err) {
    logWarn("plan_reconcile.restore-notify-failed", { uid, err: String(err).slice(0, 200) });
  }

  return { uid, oldPlan, newPlan, ...r };
}

// Convenience wrapper for the "freed cap by deleting a property" path — resolves
// the owner's CURRENT plan (no plan change) and restores within it.
export async function restoreInactiveAfterCapFreed(uid: string): Promise<{
  propertiesRestored: number;
  agreementsResumed: number;
  agreementsTerminated: number;
}> {
  const plan = await resolveOwnerPlan(uid);
  return restorePortfolioWithinPlan(uid, plan);
}
