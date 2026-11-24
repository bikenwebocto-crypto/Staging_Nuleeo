// Ledger rules shared by the server and both clients. Pure — no I/O.
//
// Backward compatibility: existing Firestore rows predate `source`,
// `viewKind`, `workspaceId` and `reconciliation`. Nothing is backfilled;
// instead every reader derives those values through the resolvers below, so a
// legacy row and a freshly-stamped row classify identically.

import type {
  BankMovementInput,
  ReconciliationStatus,
  Transaction,
  TransactionSource,
  TransactionViewKind,
} from "./firestore-schema";
import { businessWorkspaceId, realEstateWorkspaceId } from "./workspaces";

type TxLike = Pick<Transaction, "id" | "type" | "category" | "status"> &
  Partial<
    Pick<
      Transaction,
      | "source"
      | "stripeSessionId"
      | "stripePaymentIntentId"
      | "reconciliation"
      | "classification"
      | "viewKind"
      | "amount"
      | "timestamp"
      | "externalReferences"
      | "portfolioId"
      | "ownerId"
      | "entityId"
      | "workspaceId"
    >
  >;

// Reliable source for ANY row, stamped or legacy. Legacy inference uses the
// deterministic doc-id prefixes the writers have always used.
export function resolveTransactionSource(tx: TxLike): TransactionSource {
  if (tx.source) return tx.source;
  const id = tx.id ?? "";
  if (tx.stripeSessionId || id.startsWith("stripe_") || id.startsWith("offline_")) return "rent";
  if (id.startsWith("settle_")) return "settlement";
  if (id.startsWith("prepaid_")) return "prepaid";
  if (tx.type === "neutral" && tx.category === "maintenance") return "maintenance_report";
  if (tx.category === "rent" && tx.type === "income") return "rent";
  // Unknown legacy row: treat as system-generated (immutable), never "manual"
  // — the manual edit window must not open on rows we can't prove are manual.
  return "rent";
}

export function resolveViewKind(tx: TxLike): TransactionViewKind {
  if (tx.viewKind) return tx.viewKind;
  const s = resolveTransactionSource(tx);
  return s === "rent" || s === "settlement" || s === "subscription" || s === "prepaid"
    ? "payment"
    : "ledger";
}

// Reconciliation is independent of payment status. Legacy/unstamped money
// rows are "unreconciled"; neutral rows (maintenance reports, refund links)
// have nothing to match.
export function resolveReconciliationStatus(tx: TxLike): ReconciliationStatus {
  if (tx.reconciliation?.status) return tx.reconciliation.status;
  if (tx.type === "neutral" && resolveTransactionSource(tx) !== "bank_import") {
    return "not_applicable";
  }
  return "unreconciled";
}

export function workspaceIdFor(args: {
  portfolioId?: string | null;
  entityId?: string | null;
  ownerId?: string | null;
}): string | undefined {
  if (args.entityId && args.ownerId) return businessWorkspaceId(args.ownerId);
  if (args.portfolioId) return realEstateWorkspaceId(args.portfolioId);
  return undefined;
}

export function resolveWorkspaceId(tx: TxLike): string | undefined {
  return tx.workspaceId ?? workspaceIdFor(tx);
}

// An imported row is NOT verified ledger activity until the owner approves it.
export function isAwaitingReview(tx: TxLike): boolean {
  return (
    resolveTransactionSource(tx) === "bank_import" &&
    tx.status === "pending" &&
    (!tx.classification || tx.classification.status === "suggested")
  );
}

export function isVerifiedLedgerActivity(tx: TxLike): boolean {
  if (tx.status !== "completed" && tx.status !== "resolved") return false;
  return !isAwaitingReview(tx);
}

// ── Bank-import duplicate detection ───────────────────────────────────────

// Stable key for a bank line when the bank gives no movement id: same account,
// same day, same signed cents, same normalised description → same line.
export function bankMovementKey(m: BankMovementInput, bankAccountId: string): string {
  if (m.movementId) return `${bankAccountId}|id|${m.movementId}`;
  const day = new Date(m.date).toISOString().slice(0, 10);
  const cents = Math.round(m.amount * 100);
  const desc = m.description.trim().toLowerCase().replace(/\s+/g, " ");
  return `${bankAccountId}|${day}|${cents}|${desc}`;
}

export const DUPLICATE_DATE_WINDOW_DAYS = 3;

// Does an already-recorded transaction (Stripe/offline rent, manual entry…)
// plausibly correspond to this bank line? Same direction, same absolute
// amount to the cent, activity date within ±3 days, not failed, not itself a
// bank import, and not already matched to a different movement.
export function isDuplicateCandidate(tx: TxLike, m: BankMovementInput): boolean {
  if (tx.status === "failed") return false;
  const src = resolveTransactionSource(tx);
  if (src === "bank_import" || src === "refund" || src === "maintenance_report") return false;
  if (tx.type === "neutral") return false;
  const recStatus = resolveReconciliationStatus(tx);
  if (recStatus === "matched" || recStatus === "excluded") return false;
  const direction = m.amount >= 0 ? "income" : "expense";
  if (tx.type !== direction) return false;
  if (Math.round(Math.abs(Number(tx.amount) || 0) * 100) !== Math.round(Math.abs(m.amount) * 100)) {
    return false;
  }
  if (!tx.timestamp) return false;
  const diffDays =
    Math.abs(new Date(tx.timestamp).getTime() - new Date(m.date).getTime()) / 86_400_000;
  return diffDays <= DUPLICATE_DATE_WINDOW_DAYS;
}

// Best candidate = closest activity date; already-suggested rows lose to
// unreconciled ones so two bank lines don't pile onto one payment.
export function pickDuplicateCandidate<T extends TxLike>(
  txs: T[],
  m: BankMovementInput,
  exclude: Set<string> = new Set(),
): T | null {
  const target = new Date(m.date).getTime();
  const ranked = txs
    .filter((t) => !exclude.has(t.id) && isDuplicateCandidate(t, m))
    .sort((a, b) => {
      const sa = resolveReconciliationStatus(a) === "suggested" ? 1 : 0;
      const sb = resolveReconciliationStatus(b) === "suggested" ? 1 : 0;
      if (sa !== sb) return sa - sb;
      return (
        Math.abs(new Date(a.timestamp!).getTime() - target) -
        Math.abs(new Date(b.timestamp!).getTime() - target)
      );
    });
  return ranked[0] ?? null;
}
