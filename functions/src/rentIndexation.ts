// Daily rent-indexation sweep. Walks active leases that carry indexation
// terms and, when a scheduled increase comes due, applies it — bumping the
// rent the tenant is actually charged and keeping the agreement/tenancy in
// step (via the same field-sync the owner edit uses). Two things happen on a
// lease's timeline:
//   - PRENOTICE: ~PRENOTICE_DAYS_AHEAD days before an increase's effective
//     date, both parties get a heads-up push (advance notice).
//   - APPLY: on/after the effective date, the increase is applied (compound:
//     the rate is taken off the CURRENT rent) and both parties are notified.
//
// CPI leases (type "cpi", or any with no numeric rate) can't be auto-computed
// — there is no CPI feed in this app — so on the due date the OWNER is flagged
// to set the new rent by hand; no automatic bump happens.
//
// Gating:
//   - The owner must hold the `rent.autoIndex` plan privilege (Growth+ by
//     default — see DEFAULT_OWNER_PLAN_GRANTS).
//   - Each party's `notificationPrefs.rentIncrease` is honored inside
//     `notifyUser` (push is suppressed if they muted the category).
//
// Idempotency:
//   - Each (agreementId, effectiveOn, kind) tuple is recorded in
//     `rentIndexationLog`, and the rent mutation + log write commit in one
//     Firestore transaction, so a retry / cold-start replay can neither
//     double-apply an increase nor double-notify.

import { onSchedule } from "firebase-functions/v2/scheduler";
import type { SecretParam } from "firebase-functions/params";
import type { DocumentReference, DocumentSnapshot } from "firebase-admin/firestore";
import { db } from "../../server/firebase";
import { logInfo, logWarn } from "../../server/services/log";
import { notifyUser } from "../../server/services/push";
import { resolveOwnerPlan } from "../../server/services/commission";
import { computeRentChange } from "../../server/services/rentChange";
import { advanceMonths } from "../../server/services/rentCycle";
import { indexationStrideMonths } from "../../server/services/leaseDates";
import { isFeatureEnabled } from "../../server/services/featureFlags";
import {
  COL,
  DEFAULT_PRIVILEGES_CONFIG,
  MAX_INDEXATION_RATE_PCT,
  type Agreement,
  type Portfolio,
  type PrivilegesConfig,
  type Property,
  type Tenant,
} from "../../shared/firestore-schema";

// How many days before an increase's effective date both parties are warned.
const PRENOTICE_DAYS_AHEAD = 30;
const CONFIG_DOC_PRIVILEGES = "privileges";
const TENANT_URL = "https://app.oliowallet.com/tenant";
const OWNER_URL = "https://app.oliowallet.com/owner";

export function makeRentIndexationSweep(secrets: SecretParam[]) {
  return onSchedule(
    {
      region: "europe-west1",
      // 02:00 Athens — off-peak and clear of the other daily sweeps
      // (03:00 expireComplimentaryPlans, 04:00 sweepRateLimits, 09:00 reminders).
      schedule: "every day 02:00",
      timeZone: "Europe/Athens",
      // Headroom for OneSignal latency across the (rare) due leases. The
      // per-(agreement, effectiveOn, kind) log makes partial runs resumable.
      timeoutSeconds: 540,
      // notifyUser → OneSignal needs the REST key in the cron runtime.
      secrets,
    },
    async () => {
      await runRentIndexationSweep();
    },
  );
}

export async function runRentIndexationSweep(): Promise<void> {
  // Runtime kill-switch: a superadmin can disable the automatic rent-increase
  // sweep without a deploy (config/featureFlags.rentIndexation = false). Checked
  // first so a flipped flag skips the whole run rather than stopping mid-way.
  if (!(await isFeatureEnabled("rentIndexation"))) {
    logInfo("rent_indexation.skipped-feature-disabled");
    return;
  }
  // "Today" in the cron's own timezone (Athens), NOT UTC. The schedule fires
  // 02:00 Athens, which during DST (UTC+3) is 23:00 UTC the *previous* day — a
  // UTC slice(0,10) would then read yesterday and apply/prenotice steps a day
  // late. en-CA formats as YYYY-MM-DD.
  const todayIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
  }).format(new Date());
  const privileges = await loadPrivileges();

  const agreementsSnap = await db()
    .collection(COL.agreements)
    .where("status", "==", "active")
    .get();
  if (agreementsSnap.empty) {
    logInfo("rent_indexation.no-active-agreements", {});
    return;
  }

  let applied = 0;
  let prenoticed = 0;
  let cpiFlagged = 0;
  let skippedNoMatch = 0;
  let skippedPlan = 0;
  let skippedAlreadyLogged = 0;
  let skippedError = 0;

  const planCache = new Map<string, string>();
  // portfolioId → CURRENT owner uid, one direct doc get per portfolio per run.
  const portfolioOwnerCache = new Map<string, string>();

  const agreements = agreementsSnap.docs.map((d) => d.data() as Agreement);

  // ── PRE-PASS: which leases reach a prenotice/apply phase today? ────────
  // The per-agreement reads below (the prenotice idempotency log, plus the
  // tenant + property docs used to build the notifications) only ever fire for
  // leases that (a) carry indexation with a parseable next-increase date, (b)
  // fall in the apply or prenotice window, and (c) have a positive rate or are
  // CPI. Compute that set once with the SAME predicate the loop uses so the
  // batched pre-fetch reads nothing for the (typically large) majority that
  // are not yet due. Agreements failing this predicate counted as
  // skippedNoMatch in the old per-iteration form — preserve that exactly.
  const candidates = agreements.filter((agreement) => {
    const idx = agreement.indexation;
    const effectiveOn = idx?.nextIncreaseDate?.slice(0, 10) ?? null;
    if (!idx || !effectiveOn) return false;
    const daysUntil = daysBetweenIso(todayIso, effectiveOn);
    const phase =
      daysUntil <= 0 ? "apply" : daysUntil <= PRENOTICE_DAYS_AHEAD ? "prenotice" : "none";
    if (phase === "none") return false;
    const isCpi = idx.type === "cpi" || (idx.type === "custom" && typeof idx.rate !== "number");
    const hasPositiveRate = typeof idx.rate === "number" && idx.rate > 0;
    return isCpi || hasPositiveRate;
  });
  skippedNoMatch += agreements.length - candidates.length;

  // ── BATCH PRE-FETCH (candidates only) ─────────────────────────────────
  // Replaces the old N+1 fan-out of a prenotice logRef.get() + a tenant.get()
  // + a property.get() PER agreement with a few batched round-trips, read from
  // in-memory maps inside the loop. Faithful to the original reads: the
  // prenotice log checked here (keyed by the lease's CURRENT effectiveOn) is
  // never written during THIS sweep for that same date — a deferral writes a
  // prenotice for a FUTURE deferredOn, and the atomic apply/prenotice writes
  // are guarded by their own in-transaction reads (left untouched below). So a
  // pre-loop snapshot returns what each live read would have.
  const prenoticeLogRefs = candidates.map((a) => {
    const effectiveOn = a.indexation!.nextIncreaseDate!.slice(0, 10);
    return db().collection(COL.rentIndexationLog).doc(`${a.id}_${effectiveOn}_prenotice`);
  });
  const tenantIds = Array.from(new Set(candidates.map((a) => a.tenantId)));
  const propertyIds = Array.from(new Set(candidates.map((a) => a.propertyId)));
  const tenantRefs = tenantIds.map((id) => db().collection(COL.tenants).doc(id));
  const propertyRefs = propertyIds.map((id) => db().collection(COL.properties).doc(id));

  const [prenoticeSnaps, tenantSnaps, propertySnaps] = await Promise.all([
    getAllChunked(prenoticeLogRefs),
    getAllChunked(tenantRefs),
    getAllChunked(propertyRefs),
  ]);

  const prenoticeLogExists = new Set<string>();
  prenoticeSnaps.forEach((s) => s.exists && prenoticeLogExists.add(s.id));
  const tenantUidById = new Map<string, string>();
  tenantSnaps.forEach((s) => {
    if (!s.exists) return;
    const uid = (s.data() as Tenant).userId;
    if (uid) tenantUidById.set(s.id, uid);
  });
  // Mirror loadPropertyAddress: snapshot address, falling back to the same
  // "Your property" placeholder when missing/empty.
  const propertyNameById = new Map<string, string>();
  propertySnaps.forEach((s) => {
    const addr = s.exists ? (s.data() as Property).address : "";
    propertyNameById.set(s.id, addr || "Your property");
  });
  const propertyNameFor = (propertyId: string) =>
    propertyNameById.get(propertyId) ?? "Your property";
  const tenantUidFor = (tenantId: string) => tenantUidById.get(tenantId) ?? null;

  for (const agreement of candidates) {
    // Per-agreement try/catch so one bad row can't abort the whole sweep.
    try {
      const idx = agreement.indexation!;
      const effectiveOn = idx.nextIncreaseDate!.slice(0, 10);

      // A fixed/custom indexation with no positive rate is a no-op (common for
      // placeholder/test leases). Skip entirely so we never "apply" a 0% change
      // or push a bogus "rent updated" notice. CPI is handled separately below
      // (no rate stored — the owner is flagged to set rent by hand).
      // A rate-less "custom" lease is treated like CPI: no rate to auto-apply,
      // so the owner is flagged to set the new rent by hand (rather than the
      // clock silently stalling forever, never applied and never flagged).
      const isCpi = idx.type === "cpi" || (idx.type === "custom" && typeof idx.rate !== "number");
      const daysUntil = daysBetweenIso(todayIso, effectiveOn);
      const phase: "apply" | "prenotice" = daysUntil <= 0 ? "apply" : "prenotice";

      // Plan gate (memoized per RESOLVED owner) — same shape as the reminder
      // sweep. The owner is resolved through the PORTFOLIO ONLY (Phase 4) so
      // the gate AND every owner push below follow the CURRENT owner after an
      // ownership transfer. An agreement whose portfolio can't be resolved is
      // SKIPPED (never plan-gated or pushed against a stale uid).
      const ownerUid = await resolveCurrentOwnerUid(agreement, portfolioOwnerCache);
      if (!ownerUid) {
        logWarn("rent_indexation.owner-unresolved", {
          agreementId: agreement.id,
          portfolioId: agreement.portfolioId ?? null,
        });
        skippedNoMatch += 1;
        continue;
      }
      let plan = planCache.get(ownerUid);
      if (!plan) {
        plan = await resolveOwnerPlan(ownerUid);
        planCache.set(ownerUid, plan);
      }
      const grant = privileges.ownerPlan["rent.autoIndex"];
      if (!grant || !grant[plan as keyof typeof grant]) {
        skippedPlan += 1;
        continue;
      }

      // ── PRENOTICE ───────────────────────────────────────────────────
      if (phase === "prenotice") {
        // No advance amount to announce for CPI — skip the heads-up; the
        // owner is flagged on the effective date.
        if (isCpi) {
          skippedNoMatch += 1;
          continue;
        }
        const logId = `${agreement.id}_${effectiveOn}_prenotice`;
        const logRef = db().collection(COL.rentIndexationLog).doc(logId);
        if (prenoticeLogExists.has(logId)) {
          skippedAlreadyLogged += 1;
          continue;
        }
        const oldRent = agreement.monthlyRent ?? 0;
        const newRent = compoundRent(oldRent, idx.rate as number);
        const propertyName = propertyNameFor(agreement.propertyId);
        const tenantUid = tenantUidFor(agreement.tenantId);
        if (tenantUid) {
          await notifyUser({
            externalUserId: tenantUid,
            category: "rentIncrease",
            title: "Upcoming rent change",
            message: `Your rent is scheduled to change from ${eur(oldRent)} to ${eur(newRent)} on ${effectiveOn}.`,
            url: TENANT_URL,
          });
        }
        await notifyUser({
          externalUserId: ownerUid,
          category: "rentIncrease",
          title: "Scheduled rent increase",
          message: `${propertyName}: rent will rise from ${eur(oldRent)} to ${eur(newRent)} on ${effectiveOn}.`,
          url: OWNER_URL,
        });
        await logRef.set({
          id: logId,
          agreementId: agreement.id,
          ownerId: agreement.ownerId,
          tenantId: agreement.tenantId,
          kind: "prenotice",
          effectiveOn,
          recordedOn: todayIso,
          previousRent: oldRent,
          newRent,
          indexationType: idx.type,
          ...(typeof idx.rate === "number" ? { rate: idx.rate } : {}),
        });
        prenoticed += 1;
        continue;
      }

      // ── APPLY (CPI: flag owner; fixed/custom: bump rent) ─────────────
      const kind = isCpi ? "cpi_manual" : "applied";
      const logId = `${agreement.id}_${effectiveOn}_${kind}`;
      const logRef = db().collection(COL.rentIndexationLog).doc(logId);
      const agreementRef = db().collection(COL.agreements).doc(agreement.id);
      const unitRef = db().collection(COL.units).doc(agreement.unitId);
      const stride = indexationStrideMonths(idx.frequency);
      const advancedNext = advanceMonths(effectiveOn, stride);

      // ── NOTIFY-THEN-APPLY GUARD (fixed/custom only) ──────────────────
      // Never apply an increase that was never pre-noticed. This happens when
      // the lease sat in pending_tenant through the 30-day prenotice window, or
      // delayMonths was 0 so the first step landed on the activation date.
      // Rather than bump rent un-noticed, send the prenotice now and push the
      // effective date out by the lead time; the increase applies on a later
      // run, after proper advance notice.
      if (!isCpi) {
        const wasPrenoticed = prenoticeLogExists.has(`${agreement.id}_${effectiveOn}_prenotice`);
        if (!wasPrenoticed) {
          const deferredOn = addDaysIso(todayIso, PRENOTICE_DAYS_AHEAD);
          const deferredLogRef = db()
            .collection(COL.rentIndexationLog)
            .doc(`${agreement.id}_${deferredOn}_prenotice`);
          const deferral = await db().runTransaction(async (tx) => {
            if ((await tx.get(deferredLogRef)).exists) return "already" as const;
            const agSnap = await tx.get(agreementRef);
            if (!agSnap.exists) return "gone" as const;
            const fresh = agSnap.data() as Agreement;
            const freshIdx = fresh.indexation;
            if (!freshIdx || freshIdx.nextIncreaseDate?.slice(0, 10) !== effectiveOn) {
              return "moved" as const;
            }
            const oldRent = fresh.monthlyRent ?? 0;
            const newRent = compoundRent(oldRent, freshIdx.rate as number);
            tx.set(
              agreementRef,
              { indexation: { ...freshIdx, nextIncreaseDate: deferredOn } },
              { merge: true },
            );
            tx.set(deferredLogRef, {
              id: deferredLogRef.id,
              agreementId: agreement.id,
              ownerId: agreement.ownerId,
              tenantId: agreement.tenantId,
              kind: "prenotice",
              effectiveOn: deferredOn,
              recordedOn: todayIso,
              previousRent: oldRent,
              newRent,
              indexationType: freshIdx.type,
              ...(typeof freshIdx.rate === "number" ? { rate: freshIdx.rate } : {}),
            });
            return { deferred: true as const, oldRent, newRent, deferredOn };
          });

          if (deferral === "already") {
            skippedAlreadyLogged += 1;
            continue;
          }
          if (deferral === "gone" || deferral === "moved") {
            skippedNoMatch += 1;
            continue;
          }
          const propertyName = propertyNameFor(agreement.propertyId);
          const tenantUid = tenantUidFor(agreement.tenantId);
          if (tenantUid) {
            await notifyUser({
              externalUserId: tenantUid,
              category: "rentIncrease",
              title: "Upcoming rent change",
              message: `Your rent is scheduled to change from ${eur(deferral.oldRent)} to ${eur(deferral.newRent)} on ${deferral.deferredOn}.`,
              url: TENANT_URL,
            });
          }
          await notifyUser({
            externalUserId: ownerUid,
            category: "rentIncrease",
            title: "Scheduled rent increase",
            message: `${propertyName}: rent will rise from ${eur(deferral.oldRent)} to ${eur(deferral.newRent)} on ${deferral.deferredOn}.`,
            url: OWNER_URL,
          });
          prenoticed += 1;
          continue;
        }
      }

      const outcome = await db().runTransaction(async (tx) => {
        // All reads first (logRef, agreementRef, unitRef), then writes.
        if ((await tx.get(logRef)).exists) return "already" as const;
        const agSnap = await tx.get(agreementRef);
        if (!agSnap.exists) return "gone" as const;
        const fresh = agSnap.data() as Agreement;
        const freshIdx = fresh.indexation;
        // Defend against a concurrent edit having moved the schedule out from
        // under us. Re-run will re-evaluate the fresh state.
        if (!freshIdx || freshIdx.nextIncreaseDate?.slice(0, 10) !== effectiveOn) {
          return "moved" as const;
        }
        const unitSnap = await tx.get(unitRef);

        if (kind === "cpi_manual") {
          // No automatic bump — just advance the clock so the owner is
          // re-flagged next period rather than nagged daily.
          tx.set(
            agreementRef,
            { indexation: { ...freshIdx, nextIncreaseDate: advancedNext } },
            { merge: true },
          );
          tx.set(logRef, {
            id: logId,
            agreementId: agreement.id,
            ownerId: agreement.ownerId,
            tenantId: agreement.tenantId,
            kind,
            effectiveOn,
            recordedOn: todayIso,
            indexationType: freshIdx.type,
          });
          return "cpi" as const;
        }

        // fixed / custom: compound off the freshest rent.
        const oldRent = fresh.monthlyRent ?? 0;
        const newRent = compoundRent(oldRent, freshIdx.rate as number);
        // Blend the increase over the remaining lease months (the elapsed
        // months were billed at the old rate) rather than overstating the
        // contract value as newRent × full term.
        const patches = computeRentChange(fresh, newRent, undefined, todayIso);
        const updatedIdx = {
          ...freshIdx,
          nextIncreaseDate: advancedNext,
          lastAppliedDate: todayIso,
          appliedSteps: (freshIdx.appliedSteps ?? 0) + 1,
        };
        tx.set(
          agreementRef,
          { ...patches.agreementPatch, indexation: updatedIdx },
          { merge: true },
        );
        if (fresh.tenantId) {
          tx.set(db().collection(COL.tenants).doc(fresh.tenantId), patches.tenantPatch, {
            merge: true,
          });
        }
        // Unit.rentAmount is what the charge path reads first for platform
        // units; owner-created props have no Unit doc and fall through to
        // Tenant.rentAmount (written above).
        if (unitSnap.exists) {
          tx.set(unitRef, { rentAmount: newRent }, { merge: true });
        }
        tx.set(logRef, {
          id: logId,
          agreementId: agreement.id,
          ownerId: agreement.ownerId,
          tenantId: agreement.tenantId,
          kind,
          effectiveOn,
          recordedOn: todayIso,
          previousRent: oldRent,
          newRent,
          indexationType: freshIdx.type,
          ...(typeof freshIdx.rate === "number" ? { rate: freshIdx.rate } : {}),
        });
        return { applied: true as const, oldRent, newRent };
      });

      if (outcome === "already") {
        skippedAlreadyLogged += 1;
        continue;
      }
      if (outcome === "gone" || outcome === "moved") {
        skippedNoMatch += 1;
        continue;
      }

      // Notify AFTER the transaction commits so we never push on a write that
      // didn't land.
      const propertyName = propertyNameFor(agreement.propertyId);
      const tenantUid = tenantUidFor(agreement.tenantId);

      if (outcome === "cpi") {
        await notifyUser({
          externalUserId: ownerUid,
          category: "rentIncrease",
          title: "Rent review due (CPI)",
          message: `${propertyName}: a CPI-linked rent increase is due. Set the new rent manually from the agreement.`,
          url: OWNER_URL,
        });
        cpiFlagged += 1;
        continue;
      }

      // outcome === { applied, oldRent, newRent }
      if (tenantUid) {
        await notifyUser({
          externalUserId: tenantUid,
          category: "rentIncrease",
          title: "Rent updated",
          message: `Your rent has changed from ${eur(outcome.oldRent)} to ${eur(outcome.newRent)}, effective ${effectiveOn}.`,
          url: TENANT_URL,
        });
      }
      await notifyUser({
        externalUserId: ownerUid,
        category: "rentIncrease",
        title: "Rent increase applied",
        message: `${propertyName}: rent updated to ${eur(outcome.newRent)} (was ${eur(outcome.oldRent)}).`,
        url: OWNER_URL,
      });
      applied += 1;
    } catch (err) {
      skippedError += 1;
      logWarn("rent_indexation.agreement-failed", {
        agreementId: agreement.id,
        err: String(err).slice(0, 200),
      });
    }
  }

  logInfo("rent_indexation.sweep-complete", {
    applied,
    prenoticed,
    cpiFlagged,
    skippedNoMatch,
    skippedPlan,
    skippedAlreadyLogged,
    skippedError,
    todayIso,
  });
}

// Compound step: the rate is taken off the CURRENT rent. Rounded to whole
// currency units (rents are stored as integers elsewhere). The rate is clamped
// to [0, MAX_INDEXATION_RATE_PCT] as a last-resort backstop — agreement
// creation already rejects out-of-range rates, but a legacy/imported doc with a
// bad rate must never auto-apply a runaway increase. Exported for unit tests.
export function compoundRent(currentRent: number, ratePct: number): number {
  const safeRate = Math.max(0, Math.min(ratePct, MAX_INDEXATION_RATE_PCT));
  return Math.round(currentRent * (1 + safeRate / 100));
}

// CURRENT owner of an agreement, resolved SOLELY via agreement.portfolioId →
// portfolios/{id}.ownerId (the stable key an ownership transfer rewires).
// Phase 4: every agreement is stamped, so the legacy agreement.ownerId
// fallback is gone — returns null when the stamp is missing or the portfolio
// doc can't be found, and the caller SKIPS that agreement (logged) rather
// than risk mis-targeting a push or plan gate at a stale uid.
//
// `cache` is per-run (created inside the sweep), never module-level, so a warm
// Functions instance can't serve yesterday's owner after a transfer. Only
// successful portfolio reads are cached.
async function resolveCurrentOwnerUid(
  agreement: Pick<Agreement, "portfolioId">,
  cache: Map<string, string>,
): Promise<string | null> {
  const pid = agreement.portfolioId;
  if (!pid) return null;
  const cached = cache.get(pid);
  if (cached) return cached;
  const snap = await db().collection(COL.portfolios).doc(pid).get();
  const portfolioOwner = snap.exists ? (snap.data() as Portfolio).ownerId : undefined;
  if (!portfolioOwner) return null;
  cache.set(pid, portfolioOwner);
  return portfolioOwner;
}

// Advance a YYYY-MM-DD date by whole days (UTC). Used to push an un-prenoticed
// increase out by the lead time so notice always precedes application.
function addDaysIso(iso: string, days: number): string {
  const ms = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (isNaN(ms)) return iso;
  return new Date(ms + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Whole days from `fromIso` to `toIso` (positive when `toIso` is later). Both
// are date-only "YYYY-MM-DD"; parsed as UTC midnight.
function daysBetweenIso(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  if (isNaN(from) || isNaN(to)) return Number.NaN;
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

function eur(amount: number): string {
  return amount > 0
    ? new Intl.NumberFormat("en-IE", {
        style: "currency",
        currency: "EUR",
      }).format(amount)
    : "your rent";
}

// getAll has no hard cap, but a single huge batch read is risky; chunk it.
const GETALL_CHUNK = 300;
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Batched doc reads, split into safe-sized getAll calls. Returns a flat list of
// snapshots in the same order as the input refs.
async function getAllChunked(refs: DocumentReference[]): Promise<DocumentSnapshot[]> {
  if (refs.length === 0) return [];
  const groups = await Promise.all(chunk(refs, GETALL_CHUNK).map((g) => db().getAll(...g)));
  return groups.flat();
}

async function loadPrivileges(): Promise<PrivilegesConfig> {
  const snap = await db().collection(COL.config).doc(CONFIG_DOC_PRIVILEGES).get();
  if (!snap.exists) return DEFAULT_PRIVILEGES_CONFIG;
  const stored = snap.data() as Partial<PrivilegesConfig>;
  return {
    portfolio: { ...DEFAULT_PRIVILEGES_CONFIG.portfolio, ...(stored.portfolio ?? {}) },
    platform: { ...DEFAULT_PRIVILEGES_CONFIG.platform, ...(stored.platform ?? {}) },
    ownerPlan: { ...DEFAULT_PRIVILEGES_CONFIG.ownerPlan, ...(stored.ownerPlan ?? {}) },
  };
}
