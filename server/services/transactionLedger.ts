// Server helpers for the transaction ledger: audit trail writes.
//
// Audit entries live in COL.transactionAudit (top-level, keyed by an auto id,
// queried by transactionId). Writes are best-effort when called outside a
// Firestore transaction: an audit hiccup must never fail a payment write or a
// Stripe webhook (a 5xx forces replays).

import type { Transaction as FsTransaction } from "firebase-admin/firestore";
import { db } from "../firebase";
import { logWarn } from "./log";
import {
  COL,
  type TransactionAuditAction,
  type TransactionAuditEntry,
} from "../../shared/firestore-schema";

export interface AuditInput {
  transactionId: string;
  action: TransactionAuditAction;
  actorId: string;
  actorType: TransactionAuditEntry["actorType"];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

function buildEntry(input: AuditInput, id: string): TransactionAuditEntry {
  return {
    id,
    transactionId: input.transactionId,
    action: input.action,
    actorId: input.actorId,
    actorType: input.actorType,
    createdAt: new Date().toISOString(),
    ...(input.before ? { before: input.before } : {}),
    ...(input.after ? { after: input.after } : {}),
  };
}

// Inside a Firestore transaction: atomic with the ledger write.
export function auditInTransaction(t: FsTransaction, input: AuditInput): void {
  const ref = db().collection(COL.transactionAudit).doc();
  t.set(ref, buildEntry(input, ref.id));
}

// Standalone, best-effort.
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const ref = db().collection(COL.transactionAudit).doc();
    await ref.set(buildEntry(input, ref.id));
  } catch (err) {
    logWarn("tx_audit.write-failed", {
      transactionId: input.transactionId,
      action: input.action,
      err: String(err).slice(0, 200),
    });
  }
}
