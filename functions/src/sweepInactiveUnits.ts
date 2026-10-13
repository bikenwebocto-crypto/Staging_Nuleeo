// Daily 30-day inactive-property sweep.
//
// When a plan downgrade soft-deactivates a property (status "inactive",
// services/planReconcile.ts), NOTHING is deleted for 30 days — the owner can
// re-upgrade (or free cap by deleting other properties) and resume the lease
// exactly as it was. This sweep enforces the END of that grace window: once a
// property has been inactive for GRACE_DAYS, it:
//   • DELETES the property's documents — every DocumentRecord (+ its storage
//     object) AND the signed-lease PDF on each agreement (product decision:
//     delete everything at 30 days), clearing Agreement.signedLeaseDocument;
//   • TERMINATES any still-"suspended" agreement on the property and ends its
//     tenancy (the 30-day resume window has closed — a future re-upgrade needs
//     a brand-new lease);
//   • RETAINS the Property, Unit, Tenant, Agreement docs and EVERY Transaction
//     (the activity ledger), which stay admin/platform-visible and continue to
//     appear in BOTH the owner's and the tenant's Activity feed forever;
//   • stamps Property.docsPurgedAt so re-runs skip it (idempotent).
//
// Keyed off the PROPERTY (not the Unit): owner-created properties have no Unit
// doc at all, so the Property carries the inactive flag. Multi-unit admin
// properties also flip their Unit docs, which we stamp too for symmetry.

import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, bucket } from "../../server/firebase";
import { logError, logInfo, logWarn } from "../../server/services/log";
import {
  COL,
  type Agreement,
  type DocumentRecord,
  type Property,
} from "../../shared/firestore-schema";
import { GRACE_DAYS } from "../../server/services/planReconcile";
import { isOwnedStoragePath } from "../../server/services/storagePath";

const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

// Pure eligibility predicate (unit-tested directly; the surrounding sweep is
// Firestore-bound). A property is due for the document purge once it has been
// inactive for the full grace window AND hasn't already been swept. A missing
// deactivatedAt is treated as NOT due (we can't prove the window elapsed).
export function isPropertyDueForPurge(
  p: { status?: string; deactivatedAt?: string; docsPurgedAt?: string },
  nowMs: number,
): boolean {
  if (p.status !== "inactive") return false;
  if (p.docsPurgedAt) return false;
  const deactivatedMs = p.deactivatedAt ? new Date(p.deactivatedAt).getTime() : NaN;
  // STRICT `<` so the boundary is clean against restoreDecision's inclusive
  // `<=`: a property deactivated EXACTLY 30 days ago is still in grace
  // (resumable, not purged); only strictly-past-30-days is swept. Without this
  // the two would both fire at the exact-30-day mark (resume vs purge).
  return Number.isFinite(deactivatedMs) && deactivatedMs < nowMs - GRACE_MS;
}

export async function runInactiveUnitsSweep(): Promise<void> {
  const dbi = db();
  const b = bucket();
  const now = new Date().toISOString();
  const nowMs = Date.now();

  // Inactive properties only (small set — just downgraded owners). A single
  // equality filter rides the automatic index; the 30-day + not-yet-purged
  // conditions are applied in memory (isPropertyDueForPurge) to avoid a
  // composite index and the Firestore "!=" / missing-field pitfalls.
  const snap = await dbi.collection(COL.properties).where("status", "==", "inactive").get();
  if (snap.empty) return;

  const due = snap.docs
    .map((d) => d.data() as Property)
    .filter((p) => isPropertyDueForPurge(p, nowMs));
  if (due.length === 0) return;

  let propertiesPurged = 0;
  let documentsDeleted = 0;
  let storageDeleted = 0;
  let leasesTerminated = 0;

  for (const property of due) {
    try {
      const [docsSnap, unitSnap, agreementsSnap] = await Promise.all([
        dbi.collection(COL.documents).where("propertyId", "==", property.id).get(),
        dbi.collection(COL.units).where("propertyId", "==", property.id).get(),
        dbi.collection(COL.agreements).where("propertyId", "==", property.id).get(),
      ]);

      // Collect every storage object to purge: DocumentRecord files + the
      // signed-lease PDF on each agreement. SECURITY: only delete objects under
      // THIS owner's prefix (documents/{ownerId}/…) — never trust a path that
      // isn't owned (mirrors the property-delete cascade guard).
      const storagePaths: string[] = [];
      for (const d of docsSnap.docs) {
        const sp = (d.data() as DocumentRecord).storagePath;
        if (sp) storagePaths.push(sp);
      }
      for (const a of agreementsSnap.docs) {
        const sp = (a.data() as Agreement).signedLeaseDocument?.storagePath;
        if (sp) storagePaths.push(sp);
      }
      const safePaths = storagePaths.filter((p) => {
        const owned = isOwnedStoragePath(p, property.ownerId);
        if (!owned) {
          logWarn("inactive_sweep.storage-path-rejected", {
            storagePath: p,
            propertyId: property.id,
          });
        }
        return owned;
      });
      const deleted = await Promise.all(
        safePaths.map((p) =>
          b
            .file(p)
            .delete()
            .then(() => true)
            .catch(() => false),
        ),
      );
      storageDeleted += deleted.filter(Boolean).length;

      // One batch per property: delete DocumentRecords, clear the now-dangling
      // signedLeaseDocument, terminate still-suspended leases + end tenancies,
      // stamp docsPurgedAt on the property + units. Transactions are NEVER
      // touched.
      const batch = dbi.batch();
      docsSnap.docs.forEach((d) => batch.delete(d.ref));
      documentsDeleted += docsSnap.size;

      for (const a of agreementsSnap.docs) {
        const ag = a.data() as Agreement;
        const patch: Record<string, unknown> = {};
        if (ag.signedLeaseDocument) patch.signedLeaseDocument = null;
        if (ag.status === "suspended") {
          // Grace window closed — the lease is dead. Terminate it and end the
          // tenancy; a re-upgrade now requires a fresh agreement.
          patch.status = "terminated";
          patch.terminatedAt = now;
          patch.nextPaymentDate = null;
          batch.set(
            dbi.collection(COL.tenants).doc(ag.tenantId),
            { status: "expired", endedAt: now, nextPayment: null },
            { merge: true },
          );
          leasesTerminated += 1;
        }
        if (Object.keys(patch).length > 0) batch.set(a.ref, patch, { merge: true });
      }

      batch.set(
        dbi.collection(COL.properties).doc(property.id),
        { docsPurgedAt: now },
        { merge: true },
      );
      unitSnap.docs.forEach((d) => batch.set(d.ref, { docsPurgedAt: now }, { merge: true }));

      await batch.commit();
      propertiesPurged += 1;
    } catch (err) {
      // Log and skip — the next daily run retries this property (docsPurgedAt
      // is only stamped on a clean commit, so a partial failure isn't marked
      // done).
      logError("inactive_sweep.property-failed", err, { propertyId: property.id });
    }
  }

  if (propertiesPurged > 0) {
    logInfo("inactive_sweep.done", {
      propertiesPurged,
      documentsDeleted,
      storageDeleted,
      leasesTerminated,
    });
  }
}

export function makeInactiveUnitsSweep() {
  return onSchedule(
    {
      region: "europe-west1",
      schedule: "every day 05:00",
      timeZone: "Europe/Athens",
      timeoutSeconds: 540,
    },
    async () => {
      await runInactiveUnitsSweep();
    },
  );
}
