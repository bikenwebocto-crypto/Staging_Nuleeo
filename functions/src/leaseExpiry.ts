// Daily lease-expiry sweep. Walks active leases and acts when one reaches its
// endDate — the lifecycle event NOTHING in the app previously noticed. Without
// this, a lease stayed "active" forever once its term ended (until an owner
// manually clicked "End tenancy"), so a dead lease kept firing rent reminders,
// kept compounding auto-indexation, kept inflating Monthly Revenue / occupancy
// / MRR, and could still be charged — indefinitely.
//
// What happens at endDate is driven by the lease's autoRenewal setting:
//   • "auto"  → rolling month-to-month: push endDate forward one billing period
//               (caught up to today in a single run) and KEEP collecting.
//   • "fixed" → renew for another full term (rentalDurationMonths, default 12)
//               and KEEP collecting.
//   • "none"  → EXPIRE: status → "expired", stop the schedule (nextPaymentDate
//               → null), drop out of forward revenue/reminders/indexation. Any
//               unpaid in-term cycles are PRESERVED as Agreement.closingBalance
//               + Tenant.outstandingBalance so the ex-tenant can still settle
//               and the owner can still see/collect — money is never silently
//               dropped (the chosen "expire but keep arrears collectible" rule).
//
// A heads-up is also pushed ~EXPIRY_PRENOTICE_DAYS before endDate so neither
// party is surprised by the renewal/expiry.
//
// NOT plan-gated: every lease must expire on time regardless of the owner's
// tier, otherwise the revenue-inflation bug survives for basic-plan owners.
// Notifications still honor each party's prefs inside notifyUser.
//
// Idempotency: each (agreementId, endDate, kind) tuple is recorded in
// `leaseLifecycleLog`, and the status/date mutation + log write commit in one
// Firestore transaction, so a retry / cold-start replay can't double-expire,
// double-renew, or double-notify.

import { onSchedule } from "firebase-functions/v2/scheduler";
import type { SecretParam } from "firebase-functions/params";
import type { DocumentReference, DocumentSnapshot } from "firebase-admin/firestore";
import { db } from "../../server/firebase";
import { logInfo, logWarn } from "../../server/services/log";
import { notifyUser } from "../../server/services/push";
import { advanceMonths, computeArrears, monthsPerPeriod } from "../../server/services/rentCycle";
import {
  COL,
  type Agreement,
  type Portfolio,
  type Property,
  type Tenant,
} from "../../shared/firestore-schema";

// How many days before endDate both parties get a heads-up.
const EXPIRY_PRENOTICE_DAYS = 30;
// Fallback fixed-renewal term when the lease didn't record rentalDurationMonths.
const DEFAULT_FIXED_TERM_MONTHS = 12;
const TENANT_URL = "https://app.oliowallet.com/tenant";
const OWNER_URL = "https://app.oliowallet.com/owner";

export function makeLeaseExpirySweep(secrets: SecretParam[]) {
  return onSchedule(
    {
      region: "europe-west1",
      // 01:00 Athens — before the 02:00 indexation sweep, so a lease that
      // expires today is taken out of "active" before indexation would walk it.
      schedule: "every day 01:00",
      timeZone: "Europe/Athens",
      timeoutSeconds: 540,
      // notifyUser → OneSignal needs the REST key in the cron runtime.
      secrets,
    },
    async () => {
      await runLeaseExpirySweep();
    },
  );
}

export async function runLeaseExpirySweep(): Promise<void> {
  // "Today" in the cron's own timezone (Athens), NOT UTC — same reasoning as
  // the indexation/reminder sweeps (02:00 Athens is the previous UTC day during
  // DST, and a UTC slice would act a day late). en-CA → YYYY-MM-DD.
  const todayIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
  }).format(new Date());

  const agreementsSnap = await db()
    .collection(COL.agreements)
    .where("status", "==", "active")
    .get();
  if (agreementsSnap.empty) {
    logInfo("lease_expiry.no-active-agreements", {});
    return;
  }

  const agreements = agreementsSnap.docs.map((d) => d.data() as Agreement);

  // Only leases at/near their endDate matter — the same predicate the loop uses,
  // so the batched pre-fetch (tenant + property docs for notifications, and the
  // idempotency log) reads nothing for the large not-yet-due majority.
  const candidates = agreements.filter((a) => {
    const end = a.endDate?.slice(0, 10);
    if (!end) return false;
    const daysUntil = daysBetweenIso(todayIso, end);
    if (Number.isNaN(daysUntil)) return false;
    return daysUntil <= EXPIRY_PRENOTICE_DAYS; // past-due (≤0) or within the notice window
  });

  let expired = 0;
  let renewed = 0;
  let prenoticed = 0;
  let arrearsRecorded = 0;
  let skippedAlreadyLogged = 0;
  let skippedError = 0;

  // ── Batch pre-fetch (candidates only) ────────────────────────────────────
  const tenantIds = Array.from(new Set(candidates.map((a) => a.tenantId)));
  const propertyIds = Array.from(new Set(candidates.map((a) => a.propertyId)));
  const tenantRefs = tenantIds.map((id) => db().collection(COL.tenants).doc(id));
  const propertyRefs = propertyIds.map((id) => db().collection(COL.properties).doc(id));
  const [tenantSnaps, propertySnaps] = await Promise.all([
    getAllChunked(tenantRefs),
    getAllChunked(propertyRefs),
  ]);
  const tenantById = new Map<string, Tenant>();
  tenantSnaps.forEach((s) => s.exists && tenantById.set(s.id, s.data() as Tenant));
  const propertyNameById = new Map<string, string>();
  propertySnaps.forEach((s) => {
    const addr = s.exists ? (s.data() as Property).address : "";
    propertyNameById.set(s.id, addr || "your property");
  });

  // portfolioId → CURRENT owner uid, one direct doc get per portfolio per run.
  const portfolioOwnerCache = new Map<string, string>();

  for (const agreement of candidates) {
    try {
      const end = agreement.endDate!.slice(0, 10);
      const daysUntil = daysBetweenIso(todayIso, end);
      const phase: "act" | "prenotice" = daysUntil <= 0 ? "act" : "prenotice";
      const mode = agreement.autoRenewal ?? "none";
      const propertyName = propertyNameById.get(agreement.propertyId) ?? "your property";
      // Owner resolved through the PORTFOLIO so a transferred lease notifies the
      // CURRENT owner. Unresolved → still act on the lease (correctness), only
      // the owner push is skipped.
      const ownerUid = await resolveCurrentOwnerUid(agreement, portfolioOwnerCache);
      const tenant = tenantById.get(agreement.tenantId);
      const tenantUid = tenant?.userId ?? null;

      // ── PRENOTICE ──────────────────────────────────────────────────────
      if (phase === "prenotice") {
        const logId = `${agreement.id}_${end}_prenotice`;
        const wrote = await writeLogOnce(logId, {
          agreementId: agreement.id,
          ownerId: agreement.ownerId,
          tenantId: agreement.tenantId,
          kind: "prenotice",
          endDate: end,
          recordedOn: todayIso,
        });
        if (!wrote) {
          skippedAlreadyLogged += 1;
          continue;
        }
        const willRenew = mode !== "none";
        if (tenantUid) {
          await notifyUser({
            externalUserId: tenantUid,
            category: "rentReminders",
            title: willRenew ? "Lease renewing soon" : "Lease ending soon",
            message: willRenew
              ? `Your lease at ${propertyName} renews on ${end}.`
              : `Your lease at ${propertyName} ends on ${end}. Contact your landlord about next steps.`,
            url: TENANT_URL,
          });
        }
        if (ownerUid) {
          await notifyUser({
            externalUserId: ownerUid,
            category: "propertyActivity",
            title: willRenew ? "Lease renewing soon" : "Lease ending soon",
            message: `${propertyName}: the lease ${willRenew ? "auto-renews" : "ends"} on ${end}.`,
            url: OWNER_URL,
          });
        }
        prenoticed += 1;
        continue;
      }

      // ── ACT (endDate has passed) ─────────────────────────────────────────
      if (mode === "auto" || mode === "fixed") {
        // RENEW: push endDate forward and keep the lease live. Catch all the way
        // up to today in one run so a lease the cron missed for a while doesn't
        // take many days to recover.
        const stepMonths =
          mode === "auto"
            ? monthsPerPeriod(agreement.paymentFrequency)
            : // "fixed": honor the owner's chosen renewal term when recorded,
              // else fall back to the original lease term (legacy leases).
              agreement.fixedRenewalMonths && agreement.fixedRenewalMonths > 0
              ? agreement.fixedRenewalMonths
              : agreement.rentalDurationMonths && agreement.rentalDurationMonths > 0
                ? agreement.rentalDurationMonths
                : DEFAULT_FIXED_TERM_MONTHS;
        let newEnd = end;
        let guard = 0;
        do {
          newEnd = advanceMonths(newEnd, stepMonths);
          guard += 1;
        } while (newEnd <= todayIso && guard < 600);

        const logId = `${agreement.id}_${end}_renewed`;
        const agreementRef = db().collection(COL.agreements).doc(agreement.id);
        const outcome = await db().runTransaction(async (tx) => {
          if ((await tx.get(db().collection(COL.leaseLifecycleLog).doc(logId))).exists) {
            return "already" as const;
          }
          const fresh = await tx.get(agreementRef);
          if (!fresh.exists) return "gone" as const;
          const data = fresh.data() as Agreement;
          // Re-check under the transaction: skip if it's no longer active or the
          // endDate moved out from under us (a concurrent edit / a prior run).
          if (data.status !== "active" || data.endDate?.slice(0, 10) !== end) {
            return "moved" as const;
          }
          tx.set(agreementRef, { endDate: newEnd }, { merge: true });
          tx.set(db().collection(COL.leaseLifecycleLog).doc(logId), {
            id: logId,
            agreementId: agreement.id,
            ownerId: agreement.ownerId,
            tenantId: agreement.tenantId,
            kind: "renewed",
            endDate: end,
            newEndDate: newEnd,
            mode,
            recordedOn: todayIso,
          });
          return "renewed" as const;
        });
        if (outcome !== "renewed") {
          if (outcome === "already") skippedAlreadyLogged += 1;
          continue;
        }
        if (tenantUid) {
          await notifyUser({
            externalUserId: tenantUid,
            category: "rentReminders",
            title: "Lease renewed",
            message: `Your lease at ${propertyName} has renewed. New end date: ${newEnd}.`,
            url: TENANT_URL,
          });
        }
        if (ownerUid) {
          await notifyUser({
            externalUserId: ownerUid,
            category: "propertyActivity",
            title: "Lease renewed",
            message: `${propertyName}: lease ${mode === "auto" ? "rolled over" : "renewed"} to ${newEnd}.`,
            url: OWNER_URL,
          });
        }
        renewed += 1;
        continue;
      }

      // EXPIRE (autoRenewal "none"): close the lease, preserving any arrears.
      // Count unpaid cycles through the lease's endDate.
      const monthlyRent = tenant?.rentAmount ?? agreement.monthlyRent ?? 0;
      const arrears = computeArrears({
        nextPaymentDate: agreement.nextPaymentDate,
        throughDate: end,
        monthlyRent,
        frequency: agreement.paymentFrequency,
        paymentDayOfMonth: agreement.paymentDayOfMonth,
      });

      const logId = `${agreement.id}_${end}_expired`;
      const nowIso = new Date().toISOString();
      const agreementRef = db().collection(COL.agreements).doc(agreement.id);
      const tenantRef = db().collection(COL.tenants).doc(agreement.tenantId);
      const outcome = await db().runTransaction(async (tx) => {
        if ((await tx.get(db().collection(COL.leaseLifecycleLog).doc(logId))).exists) {
          return "already" as const;
        }
        const fresh = await tx.get(agreementRef);
        if (!fresh.exists) return "gone" as const;
        const data = fresh.data() as Agreement;
        if (data.status !== "active" || data.endDate?.slice(0, 10) !== end) {
          return "moved" as const;
        }
        tx.set(
          agreementRef,
          {
            status: "expired",
            expiredAt: nowIso,
            nextPaymentDate: null,
            closingBalance:
              arrears.amount > 0
                ? {
                    amount: arrears.amount,
                    cycles: arrears.cycles,
                    fromPeriod: arrears.fromPeriod,
                    reason: "expiry",
                    recordedAt: nowIso,
                  }
                : null,
          },
          { merge: true },
        );
        // Mirror onto the tenancy: end it, stop the phantom next-payment, and
        // record the collectible arrear so both surfaces can show / settle it.
        tx.set(
          tenantRef,
          {
            status: "expired",
            endedAt: nowIso,
            nextPayment: null,
            outstandingBalance: arrears.amount,
          },
          { merge: true },
        );
        tx.set(db().collection(COL.leaseLifecycleLog).doc(logId), {
          id: logId,
          agreementId: agreement.id,
          ownerId: agreement.ownerId,
          tenantId: agreement.tenantId,
          kind: "expired",
          endDate: end,
          arrearsAmount: arrears.amount,
          arrearsCycles: arrears.cycles,
          recordedOn: todayIso,
        });
        return "expired" as const;
      });
      if (outcome !== "expired") {
        if (outcome === "already") skippedAlreadyLogged += 1;
        continue;
      }
      expired += 1;
      if (arrears.amount > 0) arrearsRecorded += 1;

      // Notify AFTER commit so we never push on a write that didn't land.
      const arrearsNote =
        arrears.amount > 0
          ? ` A balance of ${eur(arrears.amount)} remains due — you can still settle it in Olio.`
          : "";
      if (tenantUid) {
        await notifyUser({
          externalUserId: tenantUid,
          category: "rentReminders",
          title: "Lease ended",
          message: `Your lease at ${propertyName} has ended.${arrearsNote}`,
          url: TENANT_URL,
        });
      }
      if (ownerUid) {
        await notifyUser({
          externalUserId: ownerUid,
          category: "propertyActivity",
          title: "Lease expired",
          message:
            arrears.amount > 0
              ? `${propertyName}: the lease ended with ${eur(arrears.amount)} still outstanding.`
              : `${propertyName}: the lease reached its end date and has been closed.`,
          url: OWNER_URL,
        });
      }
    } catch (err) {
      skippedError += 1;
      logWarn("lease_expiry.agreement-failed", {
        agreementId: agreement.id,
        err: String(err).slice(0, 200),
      });
    }
  }

  logInfo("lease_expiry.sweep-complete", {
    expired,
    renewed,
    prenoticed,
    arrearsRecorded,
    skippedAlreadyLogged,
    skippedError,
    candidates: candidates.length,
    todayIso,
  });
}

// Write an idempotency-log row only if it doesn't already exist. Returns true if
// this call wrote it, false if a prior run/retry already did. Used for the
// prenotice (no accompanying mutation to make atomic).
async function writeLogOnce(logId: string, data: Record<string, unknown>): Promise<boolean> {
  const ref = db().collection(COL.leaseLifecycleLog).doc(logId);
  return db().runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return false;
    tx.set(ref, { id: logId, ...data });
    return true;
  });
}

// CURRENT owner of an agreement, resolved via agreement.portfolioId →
// portfolios/{id}.ownerId (the stable key an ownership transfer rewires).
// Returns null when the stamp is missing or the portfolio can't be found — the
// caller still acts on the lease, only the owner push is skipped. Per-run cache.
async function resolveCurrentOwnerUid(
  agreement: Pick<Agreement, "portfolioId">,
  cache: Map<string, string>,
): Promise<string | null> {
  const pid = agreement.portfolioId;
  if (!pid) return null;
  const cached = cache.get(pid);
  if (cached) return cached;
  const snap = await db().collection(COL.portfolios).doc(pid).get();
  const owner = snap.exists ? (snap.data() as Portfolio).ownerId : undefined;
  if (!owner) return null;
  cache.set(pid, owner);
  return owner;
}

// Whole days from `fromIso` to `toIso` (positive when `toIso` is later). Both
// date-only "YYYY-MM-DD", parsed as UTC midnight.
function daysBetweenIso(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  if (isNaN(from) || isNaN(to)) return Number.NaN;
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

function eur(amount: number): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(amount);
}

// getAll has no hard cap, but a single huge batch read is risky; chunk it.
const GETALL_CHUNK = 300;
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
async function getAllChunked(refs: DocumentReference[]): Promise<DocumentSnapshot[]> {
  if (refs.length === 0) return [];
  const groups = await Promise.all(chunk(refs, GETALL_CHUNK).map((g) => db().getAll(...g)));
  return groups.flat();
}
