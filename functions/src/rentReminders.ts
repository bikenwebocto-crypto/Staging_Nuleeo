// Daily rent-reminder sweep. Runs every morning and pushes the tenant
// under the `rentReminders` category in two cases:
//   - rent due in REMINDER_DAYS_AHEAD days (heads-up)
//   - rent that became OVERDUE_DAYS_BEHIND days overdue (nudge)
//
// Gating:
//   - The agreement's owner must have the `notifications.rentReminders`
//     plan privilege (basic plan is excluded by default — see
//     DEFAULT_OWNER_PLAN_GRANTS in shared/firestore-schema).
//   - The tenant's `notificationPrefs.rentReminders` must not be `false`
//     (honored automatically inside `sendPushToUser`).
//
// Idempotency:
//   - Each (agreementId, sentOn, kind) tuple is recorded in
//     `rentReminderLog`. We skip an agreement if today's reminder of that
//     kind already exists, so retries and replays won't double-push.

import { onSchedule } from "firebase-functions/v2/scheduler";
import type { SecretParam } from "firebase-functions/params";
import type { DocumentReference, DocumentSnapshot } from "firebase-admin/firestore";
import { db } from "../../server/firebase";
import { logInfo, logWarn } from "../../server/services/log";
import { notifyUser } from "../../server/services/push";
import { resolveOwnerPlan } from "../../server/services/commission";
import { monthsPerPeriod } from "../../server/services/rentCycle";
import {
  COL,
  DEFAULT_PRIVILEGES_CONFIG,
  type Agreement,
  type Portfolio,
  type PrivilegesConfig,
  type Tenant,
  type Transaction,
} from "../../shared/firestore-schema";

// Days before the due date we ping the tenant for the upcoming-rent nudge.
const REMINDER_DAYS_AHEAD = 3;
// Days after the due date we ping the tenant when rent didn't arrive on
// time. Negative values are computed as "offset from today" below.
const OVERDUE_DAYS_BEHIND = 1;
// How far before the due date a rent payment can land and still count as
// payment for *this* cycle. Tenants often pay a few days early; this window
// catches that without reaching back to the previous month's payment
// (~30 days prior), which would wrongly suppress the new cycle's nudge.
const CYCLE_PAID_LOOKBACK_DAYS = 14;

const CONFIG_DOC_PRIVILEGES = "privileges";

type ReminderKind = "upcoming" | "overdue";

export function makeRentReminderSweep(secrets: SecretParam[]) {
  return onSchedule(
    {
      region: "europe-west1",
      // 09:00 Athens — early enough to be useful, late enough not to wake
      // anyone up.
      schedule: "every day 09:00",
      timeZone: "Europe/Athens",
      // Headroom for two sequential sweeps + OneSignal API latency per
      // tenant. Per-(agreement, day, kind) idempotency log makes partial
      // runs safely resumable, but timing out mid-sweep wastes work.
      timeoutSeconds: 540,
      secrets,
    },
    async () => {
      // Two passes in one scheduled run keeps the cron simple and reuses
      // the privilege/owner-plan caches in memory across kinds.
      await runRentReminderSweep("upcoming", REMINDER_DAYS_AHEAD);
      await runRentReminderSweep("overdue", -OVERDUE_DAYS_BEHIND);
      // Garbage-collect old idempotency rows so rentReminderLog doesn't grow
      // unbounded (one row per agreement per reminder-day, forever). A row only
      // needs to live long enough to dedupe same-day retries, so anything past
      // the retention window is safe to drop.
      await gcReminderLog();
    },
  );
}

// Delete rentReminderLog rows older than the retention window. Bounded to one
// batch per daily run (the log only accrues ~a few rows per agreement per
// month, so a 500-row daily trim keeps it flat without a paginated scan).
const REMINDER_LOG_RETENTION_DAYS = 120;
async function gcReminderLog(): Promise<void> {
  const cutoff = new Date(Date.now() - REMINDER_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  try {
    const snap = await db()
      .collection(COL.rentReminderLog)
      .where("sentOn", "<", cutoff)
      .limit(500)
      .get();
    if (snap.empty) return;
    const batch = db().batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    logInfo("rent_reminders.log-gc", { deleted: snap.size, cutoff });
  } catch (err) {
    logWarn("rent_reminders.log-gc-failed", { err: String(err).slice(0, 200) });
  }
}

export async function runRentReminderSweep(kind: ReminderKind, daysOffset: number): Promise<void> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const targetDate = computeTargetDate(daysOffset);
  const targetDay = targetDate.getUTCDate();
  const targetIso = targetDate.toISOString().slice(0, 10);

  const privileges = await loadPrivileges();

  const agreementsSnap = await db()
    .collection(COL.agreements)
    .where("status", "==", "active")
    .get();
  if (agreementsSnap.empty) {
    logInfo("rent_reminders.no-active-agreements", { kind });
    return;
  }

  let pushed = 0;
  let skippedAlreadyLogged = 0;
  let skippedPlan = 0;
  let skippedNoMatch = 0;
  let skippedPaid = 0;
  let skippedError = 0;

  const planCache = new Map<string, string>();
  // portfolioId → CURRENT owner uid, one direct doc get per portfolio per run.
  const portfolioOwnerCache = new Map<string, string>();

  const agreements = agreementsSnap.docs.map((d) => d.data() as Agreement);

  // ── PRE-PASS: who matches by date? ────────────────────────────────────
  // The per-agreement reads below (idempotency log, tenant uid, and — for
  // overdue — the tenant's completed rent transactions) only ever fire for
  // agreements whose payment date lines up with today's target. Compute that
  // set once so the batched pre-fetch reads nothing for the (typically large)
  // majority that don't match. The match predicate is identical to the loop's.
  const candidates = agreements.filter((agreement) => {
    // Primary signal: agreement.nextPaymentDate (written by AddTenantDrawer
    // on every new agreement, kept fresh as payments land). Fall back to
    // paymentDayOfMonth for legacy docs that pre-date the nextPaymentDate
    // field — match the day-of-month component when the explicit date is
    // missing.
    const nextDateIso = agreement.nextPaymentDate ? agreement.nextPaymentDate.slice(0, 10) : null;
    const matchesByDate = nextDateIso === targetIso;
    const matchesByDayLegacy =
      !nextDateIso &&
      typeof agreement.paymentDayOfMonth === "number" &&
      agreement.paymentDayOfMonth === targetDay;
    return matchesByDate || matchesByDayLegacy;
  });
  // The date filter formerly ran inside the loop and bumped skippedNoMatch for
  // every miss; preserve that count exactly now that it's a pre-pass.
  skippedNoMatch += agreements.length - candidates.length;

  // ── BATCH PRE-FETCH (candidates only) ─────────────────────────────────
  // Replaces the old N+1 fan-out of one logRef.get() + one tenant.get() (+ one
  // transactions query for overdue) PER agreement with a handful of batched
  // round-trips, looked up from in-memory maps inside the loop below. The data
  // is identical to what a live read would return: each reminder log is keyed
  // by its own agreementId and never read across iterations, and the sweep
  // only ever WRITES logs (no in-loop read-after-write), so a pre-fetched
  // snapshot is faithful to the original per-iteration reads.
  const logIdsById = new Map<string, string>();
  const logRefs = candidates.map((a) => {
    const logId = `${a.id}_${todayIso}_${kind}`;
    logIdsById.set(a.id, logId);
    return db().collection(COL.rentReminderLog).doc(logId);
  });
  const tenantIds = Array.from(new Set(candidates.map((a) => a.tenantId)));
  const tenantRefs = tenantIds.map((id) => db().collection(COL.tenants).doc(id));

  const [logSnaps, tenantSnaps, txByTenant] = await Promise.all([
    getAllChunked(logRefs),
    getAllChunked(tenantRefs),
    // Only the overdue pass consults completed rent transactions. Fetch them
    // grouped by tenant via chunked `in` queries (one per ≤30 tenant ids)
    // instead of one query per agreement; same equality-only filter, so no
    // composite index is needed.
    kind === "overdue"
      ? fetchCompletedRentTxByTenant(tenantIds)
      : Promise.resolve(new Map<string, Transaction[]>()),
  ]);

  const logExists = new Set<string>();
  logSnaps.forEach((s) => s.exists && logExists.add(s.id));
  const tenantUidById = new Map<string, string>();
  tenantSnaps.forEach((s) => {
    if (!s.exists) return;
    const uid = (s.data() as Tenant).userId;
    if (uid) tenantUidById.set(s.id, uid);
  });

  for (const agreement of candidates) {
    // Each agreement is processed in its own try/catch so a single bad row
    // (malformed date, transient Firestore error, etc.) can't abort the
    // whole daily sweep and silently starve every tenant after it of their
    // reminder. A failed agreement is logged and skipped; the next run
    // retries it (the idempotency log only records successful sends).
    try {
      // Plan-gate against the portfolio's CURRENT owner (portfolio-ONLY since
      // Phase 4). After an ownership transfer the portfolio doc is the
      // operative truth; resolveOwnerPlan silently defaults to 'basic' on a
      // dead uid, so gating on a stale denorm would quietly strip every
      // tenant in the portfolio of their reminders. An agreement whose
      // portfolio can't be resolved is SKIPPED (never mis-targeted).
      const ownerUid = await resolveCurrentOwnerUid(agreement, portfolioOwnerCache);
      if (!ownerUid) {
        logWarn("rent_reminders.owner-unresolved", {
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
      const grant = privileges.ownerPlan["notifications.rentReminders"];
      if (!grant || !grant[plan as keyof typeof grant]) {
        skippedPlan += 1;
        continue;
      }

      // Idempotency includes the kind so an agreement that already received
      // today's "upcoming" reminder can still receive an "overdue" one (and
      // vice versa) when the calendar lines up.
      const logId = logIdsById.get(agreement.id) as string;
      const logRef = db().collection(COL.rentReminderLog).doc(logId);
      if (logExists.has(logId)) {
        skippedAlreadyLogged += 1;
        continue;
      }

      // Don't nag a tenant whose rent is already paid AND verified. The
      // "upcoming" heads-up always sends (it fires before payment is
      // typically made), but the "overdue" nudge is suppressed once a
      // VERIFIED payment for this cycle exists: card rent (auto-completed by
      // Stripe, which also advances nextPaymentDate so this rarely even
      // matches) or offline rent the owner has confirmed (status
      // "completed"). A logged-but-unverified offline payment ("pending")
      // still gets the overdue nudge — we take the owner's confirmation, not
      // the tenant's claim, as proof. Status/category are filtered at the DB
      // layer (equality-only, so no composite index); cycleHasRentPayment
      // then applies the per-cycle timestamp window.
      if (kind === "overdue") {
        const txs = txByTenant.get(agreement.tenantId) ?? [];
        if (cycleHasRentPayment(txs, targetIso)) {
          skippedPaid += 1;
          continue;
        }
      }

      const tenantUid = tenantUidById.get(agreement.tenantId) ?? null;
      if (!tenantUid) {
        skippedNoMatch += 1;
        continue;
      }

      // Charge the WHOLE billing period: a quarterly/yearly lease pays 3/12
      // months per cycle (the checkout charges the same, and the cycle clock
      // advances a full period), so a one-month figure would understate it.
      const amount = (agreement.monthlyRent ?? 0) * monthsPerPeriod(agreement.paymentFrequency);
      const amountStr =
        amount > 0
          ? new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(amount)
          : "Your rent";

      const payload =
        kind === "upcoming"
          ? {
              title: "Rent due soon",
              message: `${amountStr} is due on ${targetIso}.`,
            }
          : {
              title: "Rent overdue",
              message: `${amountStr} was due on ${targetIso}. Please complete payment as soon as you can.`,
            };

      await notifyUser({
        externalUserId: tenantUid,
        category: "rentReminders",
        title: payload.title,
        message: payload.message,
        url: "https://app.oliowallet.com/tenant",
      });

      await logRef.set({
        id: logId,
        agreementId: agreement.id,
        tenantUid,
        ownerId: agreement.ownerId,
        kind,
        sentOn: todayIso,
        dueOn: targetIso,
      });
      pushed += 1;
    } catch (err) {
      skippedError += 1;
      logWarn("rent_reminders.agreement-failed", {
        agreementId: agreement.id,
        kind,
        err: String(err).slice(0, 200),
      });
    }
  }

  logInfo("rent_reminders.sweep-complete", {
    kind,
    pushed,
    skippedAlreadyLogged,
    skippedPlan,
    skippedNoMatch,
    skippedPaid,
    skippedError,
    targetIso,
  });
}

// True if any of the tenancy's rent transactions count as VERIFIED payment
// for the cycle due on `dueIso`. Only "completed" qualifies: card rent is
// auto-completed by Stripe (the payment itself is the confirmation), and
// offline rent becomes "completed" only when the owner verifies receipt.
// A "pending" offline payment (tenant logged it, owner hasn't confirmed
// yet) does NOT silence the overdue nudge — the system takes the owner's
// verification, not the tenant's word, as proof of payment. "failed" is
// ignored. Matching is by a timestamp window (payment landed on or after
// dueDate − CYCLE_PAID_LOOKBACK_DAYS) because transactions carry no explicit
// cycle/period field; the window is narrow enough not to catch the previous
// month's payment (~30 days earlier).
export function cycleHasRentPayment(
  txs: Array<Pick<Transaction, "category" | "status" | "timestamp">>,
  dueIso: string,
): boolean {
  const due = new Date(`${dueIso.slice(0, 10)}T00:00:00Z`);
  if (isNaN(due.getTime())) return false;
  const cutoffMs = due.getTime() - CYCLE_PAID_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return txs.some((t) => {
    if (t.category !== "rent") return false;
    if (t.status !== "completed") return false;
    const ts = new Date(t.timestamp);
    return !isNaN(ts.getTime()) && ts.getTime() >= cutoffMs;
  });
}

function computeTargetDate(daysOffset: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + daysOffset);
  return d;
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

// Firestore caps an `in` filter at 30 values; split larger id lists.
const IN_CHUNK = 30;
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

// Batched replacement for the per-agreement transactions query: one
// `tenantId in [...]` query per ≤30 tenants (same category/status equality
// filter, so no composite index), grouped back to a per-tenant map. Tenants
// with no completed rent simply resolve to an empty array at the call site.
async function fetchCompletedRentTxByTenant(
  tenantIds: string[],
): Promise<Map<string, Transaction[]>> {
  const byTenant = new Map<string, Transaction[]>();
  if (tenantIds.length === 0) return byTenant;
  const snaps = await Promise.all(
    chunk(tenantIds, IN_CHUNK).map((ids) =>
      db()
        .collection(COL.transactions)
        .where("tenantId", "in", ids)
        .where("category", "==", "rent")
        .where("status", "==", "completed")
        .get(),
    ),
  );
  for (const snap of snaps) {
    for (const d of snap.docs) {
      const tx = d.data() as Transaction;
      if (!tx.tenantId) continue;
      const list = byTenant.get(tx.tenantId);
      if (list) list.push(tx);
      else byTenant.set(tx.tenantId, [tx]);
    }
  }
  return byTenant;
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
