// Bank import, owner review and reconciliation for the transaction ledger.
//
// Rules enforced here (see shared/transactions.ts for the pure helpers):
//   • No duplicates. A bank line maps to a deterministic doc id, so re-importing
//     the same statement is a no-op; and a line that matches an already-recorded
//     payment (Stripe/offline rent, manual entry…) does NOT create a new row —
//     it creates a ReconciliationMatch suggestion against the existing one.
//   • Imported rows need review. They are written status:"pending",
//     type:"neutral" with the suggested type/category in `classification`, so no
//     income/expense aggregate counts them until the owner approves.
//   • Reconciliation ≠ payment status. Approving/rejecting a match only touches
//     `reconciliation`; it never changes `status`.
//
// All mutations are OWNER-SELF only (same stance as the manual-edit PATCH):
// granted contacts can't rewrite financial history.

import type { Express } from "express";
import { createHash } from "node:crypto";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { reqStr } from "../util";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { getPortfolio } from "../services/portfolioBanking";
import { auditInTransaction } from "../services/transactionLedger";
import {
  COL,
  type BankMovementInput,
  type Entity,
  type Property,
  type ReconciliationMatch,
  type Transaction,
  type TransactionCategory,
  type TransactionImport,
  type TransactionType,
} from "../../shared/firestore-schema";
import {
  bankMovementKey,
  isAwaitingReview,
  pickDuplicateCandidate,
  resolveTransactionSource,
  workspaceIdFor,
} from "../../shared/transactions";

// ≤ 2 writes per row (match + candidate stamp) + 1 import doc must fit one
// 500-write Firestore batch, so the whole import commits atomically.
const MAX_IMPORT_ROWS = 240;
const REVIEW_CATEGORIES: TransactionCategory[] = [
  "rent",
  "security_deposit",
  "maintenance",
  "tax",
  "insurance",
  "utilities",
  "professional_fee",
  "mortgage",
  "fee",
  "transfer",
  "other",
];

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}

function parseMovement(raw: unknown): BankMovementInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const amount = Number(r.amount);
  const date = typeof r.date === "string" ? r.date : "";
  const description = typeof r.description === "string" ? r.description.trim().slice(0, 300) : "";
  if (!Number.isFinite(amount) || amount === 0) return null;
  if (!date || isNaN(new Date(date).getTime())) return null;
  return {
    ...(typeof r.movementId === "string" && r.movementId
      ? { movementId: r.movementId.slice(0, 200) }
      : {}),
    date: new Date(date).toISOString(),
    amount: Math.round(amount * 100) / 100,
    currency:
      typeof r.currency === "string" && /^[A-Za-z]{3}$/.test(r.currency)
        ? r.currency.toUpperCase()
        : "EUR",
    description: description || "Bank movement",
  };
}

// Build the pending, review-required ledger row for a bank line.
function importedRow(args: {
  id: string;
  m: BankMovementInput;
  movementKey: string;
  ownerId: string;
  portfolioId?: string;
  entityId?: string;
  bankAccountId: string;
  importId: string;
}): Transaction {
  const { m } = args;
  const suggestedType: TransactionType = m.amount >= 0 ? "income" : "expense";
  const now = new Date().toISOString();
  return {
    id: args.id,
    ownerId: args.ownerId,
    ...(args.portfolioId ? { portfolioId: args.portfolioId } : {}),
    ...(args.entityId ? { entityId: args.entityId } : {}),
    workspaceId: workspaceIdFor({
      portfolioId: args.portfolioId,
      entityId: args.entityId,
      ownerId: args.ownerId,
    }),
    viewKind: "ledger",
    name: m.description,
    amount: Math.abs(m.amount),
    currency: m.currency ?? "EUR",
    // Neutral until approved — see file header.
    type: "neutral",
    category: "other",
    status: "pending",
    timestamp: m.date,
    paymentMethod: "bank_transfer",
    source: "bank_import",
    importId: args.importId,
    bankAccountId: args.bankAccountId,
    classification: { status: "suggested", type: suggestedType, category: "other" },
    // The row IS the bank movement, so it's matched by construction.
    reconciliation: {
      status: "matched",
      externalMovementId: args.movementKey,
      bankAccountId: args.bankAccountId,
      matchedAmount: Math.abs(m.amount),
      currency: m.currency ?? "EUR",
      matchedAt: now,
      matchedBy: "system",
    },
    externalReferences: [{ provider: "bank", kind: "bank_movement", id: args.movementKey }],
    createdAt: now,
  };
}

export function registerTransactionReviewRoutes(app: Express): void {
  // GET /api/owner/entities/:entityId/transactions — business ledger. Business
  // rows carry entityId and no portfolioId, so they aren't in the portfolio feed.
  app.get("/api/owner/entities/:entityId/transactions", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const entityId = reqStr(req.params.entityId);
    try {
      const entSnap = await db().collection(COL.entities).doc(entityId).get();
      if (!entSnap.exists) return res.status(404).json({ error: "Business not found" });
      if ((entSnap.data() as Entity).ownerId !== uid) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const snap = await db().collection(COL.transactions).where("entityId", "==", entityId).get();
      const rows = snap.docs
        .map((d) => d.data() as Transaction)
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
      res.json(rows);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load transactions") });
    }
  });

  // GET /api/owner/transactions/:id/audit — audit trail for one row.
  app.get("/api/owner/transactions/:id/audit", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const id = reqStr(req.params.id);
    try {
      const snap = await db().collection(COL.transactions).doc(id).get();
      if (!snap.exists) return res.status(404).json({ error: "Transaction not found" });
      const tx = snap.data() as Transaction;
      const mine = await callerOwnsTx(uid, tx);
      if (!mine) return res.status(403).json({ error: "Not your transaction" });
      const audit = await db()
        .collection(COL.transactionAudit)
        .where("transactionId", "==", id)
        .get();
      res.json(
        audit.docs
          .map((d) => d.data())
          .sort((a, b) => ((a.createdAt as string) < (b.createdAt as string) ? -1 : 1)),
      );
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load audit trail") });
    }
  });

  // POST /api/owner/transactions/import
  //   { bankAccountId?, entityId?, name?, movements: BankMovementInput[] }
  // Without entityId the import targets the caller's real-estate portfolio.
  app.post("/api/owner/transactions/import", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const limit = await rateLimit(`owner-tx-import:${uid}`, 20, 24 * 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({ error: "Too many imports today. Try again tomorrow." });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawRows = Array.isArray(body.movements) ? body.movements : null;
    if (!rawRows || rawRows.length === 0) {
      return res.status(400).json({ error: "movements must be a non-empty array" });
    }
    if (rawRows.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({ error: `At most ${MAX_IMPORT_ROWS} movements per import` });
    }
    const bankAccountId =
      typeof body.bankAccountId === "string" && body.bankAccountId
        ? body.bankAccountId.slice(0, 100)
        : "default";
    const entityId = typeof body.entityId === "string" ? body.entityId : "";

    try {
      let portfolioId: string | undefined;
      if (entityId) {
        const entSnap = await db().collection(COL.entities).doc(entityId).get();
        if (!entSnap.exists) return res.status(404).json({ error: "Business not found" });
        if ((entSnap.data() as Entity).ownerId !== uid) {
          return res.status(403).json({ error: "Forbidden" });
        }
      } else {
        const pf = await getPortfolio(uid);
        if (!pf) return res.status(404).json({ error: "No portfolio to import into" });
        portfolioId = pf.id;
      }
      const scopeKey = entityId ? `entity:${entityId}` : `portfolio:${portfolioId}`;

      // Existing ledger in scope — the duplicate-candidate pool.
      const existingSnap = await db()
        .collection(COL.transactions)
        .where(entityId ? "entityId" : "portfolioId", "==", entityId || portfolioId)
        .get();
      const existing = existingSnap.docs.map((d) => d.data() as Transaction);
      const existingIds = new Set(existing.map((t) => t.id));
      // Movements already handled via a match (suggested, approved OR
      // rejected) — re-importing them must not resurrect the suggestion.
      const matchSnap = await db()
        .collection(COL.reconciliationMatches)
        .where("ownerId", "==", uid)
        .get();
      const existingMatchIds = new Set(matchSnap.docs.map((d) => d.id));

      const importRef = db().collection(COL.transactionImports).doc();
      const now = new Date().toISOString();
      let importedCount = 0;
      let duplicateCount = 0;
      let matchedCount = 0;
      let failedCount = 0;
      // Candidates already claimed in THIS import, so two identical bank lines
      // don't both attach to one payment.
      const claimed = new Set<string>();
      const seenKeys = new Set<string>();

      const batch = db().batch();
      for (const raw of rawRows) {
        const m = parseMovement(raw);
        if (!m) {
          failedCount++;
          continue;
        }
        const movementKey = bankMovementKey(m, bankAccountId);
        const docId = `bank_${hash(`${scopeKey}|${movementKey}`)}`;
        // 1. Same line already imported (this or an earlier statement).
        if (seenKeys.has(docId) || existingIds.has(docId)) {
          duplicateCount++;
          continue;
        }
        seenKeys.add(docId);
        // 2. Line already recorded by another flow → suggest a match, no new row.
        //    Also skip if an existing suggestion already covers this movement.
        const matchId = `match_${hash(`${scopeKey}|${movementKey}`)}`;
        if (existingMatchIds.has(matchId)) {
          duplicateCount++;
          continue;
        }
        const candidate = pickDuplicateCandidate(existing, m, claimed);
        if (candidate) {
          claimed.add(candidate.id);
          matchedCount++;
          const match: ReconciliationMatch = {
            id: matchId,
            ownerId: uid,
            portfolioId: portfolioId ?? "",
            transactionId: candidate.id,
            bankAccountId,
            externalMovementId: movementKey,
            importId: importRef.id,
            movement: m,
            amount: Math.abs(m.amount),
            currency: m.currency ?? "EUR",
            status: "suggested",
            confidence: 0.9,
            createdAt: now,
          };
          batch.set(db().collection(COL.reconciliationMatches).doc(matchId), match);
          batch.set(
            db().collection(COL.transactions).doc(candidate.id),
            {
              reconciliation: {
                status: "suggested",
                externalMovementId: movementKey,
                bankAccountId,
                matchedAmount: Math.abs(m.amount),
                currency: m.currency ?? "EUR",
                confidence: 0.9,
              },
            },
            { merge: true },
          );
          continue;
        }
        // 3. Genuinely new movement → pending, review-required row.
        const row = importedRow({
          id: docId,
          m,
          movementKey,
          ownerId: uid,
          portfolioId,
          entityId: entityId || undefined,
          bankAccountId,
          importId: importRef.id,
        });
        batch.set(db().collection(COL.transactions).doc(docId), row);
        importedCount++;
      }

      const importDoc: TransactionImport = {
        id: importRef.id,
        ownerId: uid,
        portfolioId: portfolioId ?? "",
        provider: "csv",
        bankAccountId,
        name:
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim().slice(0, 200)
            : `Import ${now.slice(0, 10)}`,
        status: "completed",
        rowCount: rawRows.length,
        importedCount,
        duplicateCount: duplicateCount + matchedCount,
        failedCount,
        createdAt: now,
        completedAt: now,
      };
      batch.set(importRef, { ...importDoc, ...(entityId ? { entityId } : {}) });
      await batch.commit();
      res.status(201).json({ ...importDoc, matchedCount, alreadyImportedCount: duplicateCount });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to import transactions") });
    }
  });

  // POST /api/owner/transactions/:id/review
  //   { action: "approve" | "reject", type?, category?, propertyId?, reason? }
  // Approve: copies the (optionally corrected) classification onto the row and
  // marks it completed — only now does it count as ledger activity.
  // Reject: status "failed" + reconciliation "excluded" (kept for audit, never
  // counted). Only rows awaiting review are accepted.
  app.post("/api/owner/transactions/:id/review", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const id = reqStr(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = body.action;
    if (action !== "approve" && action !== "reject") {
      return res.status(400).json({ error: "action must be approve or reject" });
    }
    try {
      const ref = db().collection(COL.transactions).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Transaction not found" });
      const tx = snap.data() as Transaction;
      if (!(await callerOwnsTx(uid, tx))) {
        return res.status(403).json({ error: "Not your transaction" });
      }
      if (resolveTransactionSource(tx) !== "bank_import" || !isAwaitingReview(tx)) {
        return res.status(409).json({ error: "This transaction is not awaiting review" });
      }
      const now = new Date().toISOString();

      if (action === "reject") {
        const reason =
          typeof body.reason === "string" && body.reason.trim()
            ? body.reason.trim().slice(0, 300)
            : "Rejected on review";
        const patch = {
          status: "failed" as const,
          reconciliation: {
            ...(tx.reconciliation ?? {}),
            status: "excluded",
            excludedReason: reason,
          },
        };
        await db().runTransaction(async (t) => {
          t.set(ref, patch, { merge: true });
          auditInTransaction(t, {
            transactionId: id,
            action: "classified",
            actorId: uid,
            actorType: "owner",
            before: { status: tx.status },
            after: { status: "failed", reason },
          });
        });
        return res.json({ ...tx, ...patch });
      }

      const suggested = tx.classification!;
      const type: TransactionType =
        body.type === "income" || body.type === "expense" ? body.type : suggested.type;
      if (type === "neutral")
        return res.status(400).json({ error: "type must be income or expense" });
      const category: TransactionCategory =
        typeof body.category === "string" &&
        REVIEW_CATEGORIES.includes(body.category as TransactionCategory)
          ? (body.category as TransactionCategory)
          : suggested.category;
      let propertyId: string | undefined;
      if (typeof body.propertyId === "string" && body.propertyId) {
        const p = await db().collection(COL.properties).doc(body.propertyId).get();
        if (!p.exists) return res.status(404).json({ error: "Property not found" });
        if ((p.data() as Property).ownerId !== uid) {
          return res.status(403).json({ error: "Forbidden" });
        }
        propertyId = body.propertyId;
      }
      const modified = type !== suggested.type || category !== suggested.category || !!propertyId;
      const patch: Partial<Transaction> = {
        type,
        category,
        status: "completed",
        verifiedAt: now,
        verifiedBy: uid,
        ...(propertyId ? { propertyId } : {}),
        classification: {
          ...suggested,
          status: modified ? "owner_modified" : "approved",
          type,
          category,
          ...(propertyId ? { propertyId } : {}),
          reviewedBy: uid,
          reviewedAt: now,
        },
      };
      await db().runTransaction(async (t) => {
        t.set(ref, patch, { merge: true });
        auditInTransaction(t, {
          transactionId: id,
          action: "classified",
          actorId: uid,
          actorType: "owner",
          before: { type: tx.type, category: tx.category, status: tx.status },
          after: { type, category, status: "completed", propertyId: propertyId ?? null },
        });
      });
      res.json({ ...tx, ...patch });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to review transaction") });
    }
  });

  // GET /api/owner/reconciliation?status=suggested — pending match suggestions.
  app.get("/api/owner/reconciliation", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const status = typeof req.query.status === "string" ? req.query.status : "suggested";
    try {
      const snap = await db()
        .collection(COL.reconciliationMatches)
        .where("ownerId", "==", uid)
        .where("status", "==", status)
        .get();
      res.json(snap.docs.map((d) => d.data()));
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load reconciliation") });
    }
  });

  // POST /api/owner/reconciliation/:matchId { action: "approve" | "reject" }
  // Approve → the existing transaction is marked reconciled (status untouched).
  // Reject  → the suggestion is dropped, the transaction returns to
  //           unreconciled, and the bank line is booked as a NEW pending import
  //           row (it was a different movement after all).
  app.post("/api/owner/reconciliation/:matchId", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const matchId = reqStr(req.params.matchId);
    const action = (req.body ?? {}).action;
    if (action !== "approve" && action !== "reject") {
      return res.status(400).json({ error: "action must be approve or reject" });
    }
    try {
      const result = await db().runTransaction(async (t) => {
        const mRef = db().collection(COL.reconciliationMatches).doc(matchId);
        const mSnap = await t.get(mRef);
        if (!mSnap.exists) return { code: 404 as const, error: "Match not found" };
        const match = mSnap.data() as ReconciliationMatch & { entityId?: string };
        if (match.ownerId !== uid) return { code: 403 as const, error: "Forbidden" };
        if (match.status !== "suggested") {
          return { code: 409 as const, error: "This match was already resolved" };
        }
        const txRef = db().collection(COL.transactions).doc(match.transactionId);
        const txSnap = await t.get(txRef);
        if (!txSnap.exists) return { code: 404 as const, error: "Transaction not found" };
        const tx = txSnap.data() as Transaction;
        const now = new Date().toISOString();

        // A new import row on reject needs its own existence check (reads first).
        const newRowId = `bank_${hash(
          `${match.portfolioId ? `portfolio:${match.portfolioId}` : `entity:${tx.entityId}`}|${match.externalMovementId}`,
        )}`;
        const newRowRef = db().collection(COL.transactions).doc(newRowId);
        const newRowSnap = action === "reject" ? await t.get(newRowRef) : null;

        t.set(
          mRef,
          {
            status: action === "approve" ? "approved" : "rejected",
            resolvedAt: now,
            resolvedBy: uid,
          },
          { merge: true },
        );
        if (action === "approve") {
          t.set(
            txRef,
            {
              reconciliation: {
                status: "matched",
                externalMovementId: match.externalMovementId,
                bankAccountId: match.bankAccountId,
                matchedAmount: match.amount,
                currency: match.currency,
                matchedAt: now,
                matchedBy: uid,
                confidence: match.confidence,
              },
              externalReferences: [
                ...(tx.externalReferences ?? []),
                { provider: "bank", kind: "bank_movement", id: match.externalMovementId },
              ],
            },
            { merge: true },
          );
        } else {
          t.set(txRef, { reconciliation: { status: "unreconciled" } }, { merge: true });
          if (match.movement && newRowSnap && !newRowSnap.exists) {
            t.set(
              newRowRef,
              importedRow({
                id: newRowId,
                m: match.movement,
                movementKey: match.externalMovementId,
                ownerId: uid,
                portfolioId: match.portfolioId || undefined,
                entityId: match.portfolioId ? undefined : tx.entityId,
                bankAccountId: match.bankAccountId,
                importId: match.importId ?? "",
              }),
            );
          }
        }
        auditInTransaction(t, {
          transactionId: tx.id,
          action: "reconciled",
          actorId: uid,
          actorType: "owner",
          before: { reconciliation: tx.reconciliation?.status ?? null },
          after: {
            reconciliation: action === "approve" ? "matched" : "unreconciled",
            matchId,
          },
        });
        return { code: 200 as const };
      });
      if (result.code !== 200) return res.status(result.code).json({ error: result.error });
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to resolve match") });
    }
  });
}

// Owner-self: the row's portfolio must be the caller's current portfolio, or —
// for business rows without a portfolio — the caller must own the row.
async function callerOwnsTx(uid: string, tx: Transaction): Promise<boolean> {
  if (tx.portfolioId) {
    const pf = await getPortfolio(uid);
    return !!pf && pf.id === tx.portfolioId;
  }
  return tx.ownerId === uid;
}
