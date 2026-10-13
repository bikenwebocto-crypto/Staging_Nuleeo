// Shared rent-cycle advancement — the single source of truth for moving an
// agreement's nextPaymentDate forward when rent is paid/verified. Used by
// every rent-collection path (Stripe card capture and offline-payment
// verification) so the rent-reminder cron stays in sync no matter how rent
// arrives, and so the math (frequency, idempotency) lives in exactly one
// place instead of being copy-pasted per call site.

import { db } from "../firebase";
import { COL, type Agreement, type PaymentFrequency } from "../../shared/firestore-schema";

// Advance a YYYY-MM-DD date by `n` whole months, clamping the day so
// month-end dates roll over correctly: Jan 31 +1 -> Feb 28/29 (not Mar 3),
// Aug 31 +1 -> Sep 30. UTC-safe — the same convention the rent-reminder cron
// compares against. Accepts pure dates or ISO timestamps; returns YYYY-MM-DD.
// A naive setUTCMonth would overflow into the following month for any
// 29/30/31-day input, so we pin to day 1, advance, then clamp.
//
// `anchorDay` (optional) re-anchors the result to a STABLE day-of-month rather
// than chaining off the input's (already-clamped) day. Without it, a lease due
// on the 31st permanently ratchets earlier — Jan 31 -> Feb 28 clamps, then
// Feb 28 -> Mar 28 (not back to Mar 31) and it stays on the 28th forever. Pass
// the lease's `paymentDayOfMonth` so February clamps to the 28th but March
// recovers to the 31st. Ignored when out of the 1–31 range.
export function advanceMonths(iso: string, n: number, anchorDay?: number | null): string {
  const dateOnly = iso.slice(0, 10);
  const d = new Date(`${dateOnly}T00:00:00Z`);
  if (isNaN(d.getTime())) return iso;
  const anchored =
    typeof anchorDay === "number" && anchorDay >= 1 && anchorDay <= 31
      ? Math.floor(anchorDay)
      : d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDayOfTarget = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(anchored, lastDayOfTarget));
  return d.toISOString().slice(0, 10);
}

// Number of months in one billing period. Defaults to monthly when the
// frequency is missing (legacy agreements) or unrecognized.
export function monthsPerPeriod(frequency?: PaymentFrequency | null): number {
  return frequency === "yearly" ? 12 : frequency === "quarterly" ? 3 : 1;
}

// Advance one whole billing period for the given payment frequency — so a
// quarterly lease jumps three months and a yearly lease twelve, not one.
// `anchorDay` (optional) keeps the due-day stable across month-end clamps —
// pass the lease's paymentDayOfMonth (see advanceMonths).
export function advanceByFrequency(
  iso: string,
  frequency?: PaymentFrequency | null,
  anchorDay?: number | null,
): string {
  return advanceMonths(iso, monthsPerPeriod(frequency), anchorDay);
}

// Count the unpaid in-term billing cycles when a lease closes, and the total
// still owed. nextPaymentDate is the NEXT unpaid cycle (payments advance it), so
// every cycle due date d with nextPaymentDate ≤ d ≤ throughDate is an unpaid
// obligation. Used to preserve a collectible arrear at close: expiry counts
// through the lease's endDate; an early termination counts through today (the
// tenant isn't billed for months after move-out). Each cycle's amount =
// monthlyRent × months-per-period (monthlyRent is the PER-MONTH rent). A lease
// settled past `throughDate` has nextPaymentDate beyond it → zero owed.
export function computeArrears(opts: {
  nextPaymentDate?: string | null;
  throughDate: string;
  monthlyRent: number;
  frequency?: PaymentFrequency | null;
  paymentDayOfMonth?: number | null;
}): { amount: number; cycles: number; fromPeriod: string } {
  const next = opts.nextPaymentDate?.slice(0, 10);
  const through = opts.throughDate.slice(0, 10);
  if (!next || opts.monthlyRent <= 0) return { amount: 0, cycles: 0, fromPeriod: through };
  const perPeriod = opts.monthlyRent * monthsPerPeriod(opts.frequency);
  let d = next;
  let cycles = 0;
  let guard = 0;
  while (d <= through && guard < 600) {
    cycles += 1;
    d = advanceByFrequency(d, opts.frequency, opts.paymentDayOfMonth);
    guard += 1;
  }
  return { amount: cycles * perPeriod, cycles, fromPeriod: next };
}

// Move the live agreement for a tenancy to its next due date after a rent
// payment lands. Two correctness guarantees:
//   - Frequency-aware: quarterly/yearly leases advance a whole period, not a
//     single month, so reminders fire on the real schedule.
//   - Idempotent per cycle: when `paidCycle` is supplied (the due date the
//     payment covers — see Transaction.rentPeriod), we only advance if the
//     agreement is still sitting on that cycle. A second payment for an
//     already-advanced cycle (split offline transfers, or card + offline for
//     the same period) is a no-op, so we never skip a month of reminders.
//     Legacy payments without a cycle tag fall back to "current cycle",
//     preserving the prior always-advance behavior for them.
// "Live" means status "active" OR "suspended": a tenancy stays "active" while
// its landlord's plan is temporarily suspended (planReconcile leaves the Tenant
// active, only the Agreement → "suspended"), so an offline rent payment can
// still be logged + verified during that window. If we only advanced "active"
// agreements the cycle would stall, leaving a stale nextPaymentDate that the
// rent-reminder cron false-overdue-nudges the moment the owner re-upgrades.
// Advancing the suspended agreement keeps the schedule correct so resume is
// clean. "active" is preferred when both somehow exist (defensive).
// Also keeps the tenancy's display field (Tenant.nextPayment) in sync, since
// portfolio.ts writes both at creation and the tenant dashboard reads it.
// Wrapped in a transaction so the guard + advance are atomic (see body).
// Callers wrap in their own try/catch: a contention/transaction failure throws
// after Firestore's automatic retries, which the callers log and let the next
// cron run heal — better than double-advancing.
export async function advanceAgreementForPayment(opts: {
  tenantId: string; // tenancy doc id (Transaction.tenantId === Agreement.tenantId)
  paidCycle?: string; // YYYY-MM-DD the payment covers; omit to use the current cycle
}): Promise<{ advanced: boolean; from?: string; to?: string }> {
  const { tenantId, paidCycle } = opts;
  const dbi = db();
  // Query by tenancy only (one equality filter — rides the automatic index, no
  // composite needed) and pick the live agreement in memory. We can't push a
  // `status in [active, suspended]` filter cheaply, and a tenancy holds at most
  // one non-terminal agreement, so the in-memory select is exact.
  const query = dbi.collection(COL.agreements).where("tenantId", "==", tenantId);

  // runTransaction makes the read -> idempotency-guard -> advance ATOMIC.
  // Without it, the guard reads nextPaymentDate and the batch writes it with a
  // window in between, so two rent payments landing close together (a card
  // finalize racing its own webhook, or a card + offline payment for adjacent
  // cycles) could each read a stale "current" before the other committed —
  // advancing an already-paid cycle twice (skipping a month) or no-opping a
  // second cycle's payment against the stale date. Inside the transaction
  // Firestore serializes the conflicting writes to the agreement (retrying the
  // closure on contention), so the guard always sees committed state and the
  // cycle advances exactly once per paid period. Matches the runTransaction
  // pattern already used for the unit-cap and ensurePortfolio checks.
  return await dbi.runTransaction(async (t) => {
    const snap = await t.get(query);
    if (snap.empty) return { advanced: false };

    // Prefer an active agreement; fall back to a suspended one (rent paid
    // during a plan-suspension window). Terminated/expired/pending are skipped.
    const ag =
      snap.docs.find((d) => (d.data() as Agreement).status === "active") ??
      snap.docs.find((d) => (d.data() as Agreement).status === "suspended");
    if (!ag) return { advanced: false };
    const data = ag.data() as Agreement;
    if (!data.nextPaymentDate) return { advanced: false };

    const current = data.nextPaymentDate.slice(0, 10);
    // Idempotency guard: skip if this payment isn't for the cycle the agreement
    // currently owes (another payment already rolled it forward).
    if (paidCycle && paidCycle.slice(0, 10) !== current) {
      return { advanced: false, from: current };
    }

    // Re-anchor to the lease's stable paymentDayOfMonth so an end-of-month due
    // date doesn't permanently ratchet earlier after a February clamp.
    const next = advanceByFrequency(
      data.nextPaymentDate,
      data.paymentFrequency,
      data.paymentDayOfMonth,
    );
    // Advance the agreement (cron source of truth) and mirror the tenancy
    // display field (Tenant.nextPayment, read by both dashboards) in the same
    // transaction so they can never silently desync. set+merge on the tenancy
    // avoids aborting if that doc is missing.
    t.update(ag.ref, { nextPaymentDate: next });
    t.set(dbi.collection(COL.tenants).doc(tenantId), { nextPayment: next }, { merge: true });
    return { advanced: true, from: current, to: next };
  });
}
