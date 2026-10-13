// Single source of truth for "is this transaction realized income?" — the
// predicate every money-AGGREGATION (income-summing) site must route through.
//
// Why this exists: offline rent is written `status: "pending"` until the owner
// verifies it (see server/routes/tenant.ts), card rent + verified offline +
// manual entries are `status: "completed"` (rentTransaction.ts / finance.ts).
// Without a shared gate, summing `type === "income"` blindly inflated owner
// income / net / yield (briefing) by counting unverified pending offline rent
// as if it had landed. This predicate is the one place that rule lives.
//
// Framework-agnostic on purpose: NO firebase / express / react imports, so the
// Express server and both React clients import the exact same logic.

// Structural shape — we only need type + status, so callers can pass any
// Transaction-like row (server Transaction, client OwnerTransaction, a test
// stub) without importing the full firestore-schema interface here.
export interface RealizedRentTx {
  type?: string;
  // Optional because legacy rows predate the `status` field; we treat a
  // missing status as realized (see rule below).
  status?: string;
}

// Realized rent income = an income row whose money has actually landed.
//
// Rule: type === "income" AND status is NOT one of the unsettled states
// ("pending", "failed"). We deny-list the unsettled states rather than
// allow-list "completed" so that:
//   • PENDING offline rent (awaiting owner verification) is EXCLUDED — the bug
//     this predicate fixes.
//   • FAILED transactions are EXCLUDED.
//   • LEGACY / no-status income rows are still INCLUDED (older completed rows
//     that predate the status field must not silently drop out of totals).
//   • A future settled status (e.g. "verified") wouldn't be accidentally
//     dropped the way a strict status === "completed" allow-list would.
const UNSETTLED_STATUSES = new Set(["pending", "failed"]);

export function isRealizedRent(tx: RealizedRentTx): boolean {
  if (tx.type !== "income") return false;
  return !UNSETTLED_STATUSES.has(tx.status ?? "");
}

// Net realized amount for a rent row — the gross `amount` (major units) MINUS
// any cardholder refund stamped on the row by the charge.refunded webhook
// (`refundedAmountCents`, in cents; absent => 0). Use this — NOT a bare
// `amount` — at every income-AGGREGATION site so owner yield / realized-income
// figures don't keep counting money that was refunded. The row's original
// `amount` is deliberately left as-booked for display (historical accounting);
// only the SUMS net the refund. Returns >= 0.
export function netRealizedRentAmount(tx: {
  amount?: number | string | null;
  refundedAmountCents?: number | null;
}): number {
  const gross = Math.abs(Number(tx.amount) || 0);
  const refunded = Math.max(0, Number(tx.refundedAmountCents) || 0) / 100;
  return Math.max(0, gross - refunded);
}
