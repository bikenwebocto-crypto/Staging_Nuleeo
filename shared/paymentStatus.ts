// Single source of truth for a tenancy's CURRENT-cycle rent status pill
// (paid / pending / overdue). The owner roster, the tenant dashboard, and the
// admin Units page all derive their pill from THIS predicate, so the same rent
// reads identically on every surface (previously each surface computed its own
// — or read a stale Unit.paymentStatus field that no rent code ever updated).
//
// Framework-agnostic on purpose: NO firebase / express / react imports, so the
// Express server and both React clients import the exact same logic — same
// rationale as shared/realizedRent.ts.

export type DerivedPaymentStatus = "paid" | "pending" | "overdue";

export interface PaymentStatusInput {
  // The current cycle's due date (Agreement.nextPaymentDate, mirrored to
  // Tenant.nextPayment). YYYY-MM-DD or full ISO; null/empty when the lease has
  // no live schedule (ended/expired) — caller usually treats that as "no pill".
  nextDue?: string | null;
  // "Today" as YYYY-MM-DD. Date-only strings are compared lexically, so the
  // caller just needs a YYYY-MM-DD slice in the relevant zone.
  today: string;
  // True when the CURRENT cycle (the one at `nextDue`) is already settled — a
  // realized rent Transaction tagged `rentPeriod === nextDue`, or a prepaid
  // window that covers it. This is what makes the pill RESET each cycle: paying
  // advances `nextDue` to the next unpaid cycle, which is no longer settled.
  currentCyclePaid: boolean;
  // True when the tenancy has EVER settled rent (any realized rent, or prepaid
  // up front). Distinguishes a paid-up tenancy whose next due date sits in the
  // future ("paid") from a brand-new lease still awaiting its first payment
  // ("pending"). Without this, a never-paid new lease would read "paid" simply
  // because its first due date hasn't arrived yet.
  hasSettledHistory: boolean;
}

// Resolve the pill for the current cycle. Order matters:
//   1. current cycle explicitly settled        → "paid"
//   2. past the due date and not settled        → "overdue"
//   3. due today / future, tenancy is paid-up   → "paid"
//   4. due today / future, never settled        → "pending"
// Because (1) keys on the SPECIFIC cycle at `nextDue`, the status naturally
// resets every period instead of sticking on "paid" forever after one payment.
export function derivePaymentStatus(input: PaymentStatusInput): DerivedPaymentStatus {
  const due = (input.nextDue ?? "").slice(0, 10);
  if (input.currentCyclePaid) return "paid";
  if (!due) return "pending";
  if (input.today > due) return "overdue";
  return input.hasSettledHistory ? "paid" : "pending";
}
