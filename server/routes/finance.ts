// Owner-side money endpoints: bank details (IBAN/SWIFT) + transactions
// (read the activity feed, log a manual entry).
//
// Bank-details + transactions GET are both portfolio-scoped via
// resolveOwnerScope. Banking now lives on the PORTFOLIO (not the user), so
// editing it is gated by the realtime "finance.manageBanking" privilege: the
// owner is always allowed (authorizePortfolioRead short-circuits isSelf) and a
// delegated contact (e.g. financial) needs edit permission + that privilege.

import type { Express } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { reqStr } from "../util";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { authorizePortfolioRead, resolveOwnerScope } from "../services/ownerScope";
import {
  ensurePortfolio,
  getPortfolio,
  loadPortfolioBankingById,
  writePortfolioBanking,
} from "../services/portfolioBanking";
import {
  COL,
  type Agreement,
  type Property,
  type Transaction,
  type TransactionCategory,
  type TransactionType,
} from "../../shared/firestore-schema";
import { prepaidRentActivityRow } from "../services/prepaidActivity";

const VALID_TX_TYPES: TransactionType[] = ["income", "expense", "neutral"];
const VALID_TX_CATEGORIES: TransactionCategory[] = ["rent", "maintenance", "tax", "fee", "other"];

// How long after recording a manual activity the owner may still correct it.
// The ledger is otherwise append-only (see Transaction in firestore-schema).
const MANUAL_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function registerFinanceRoutes(app: Express): void {
  // Save or clear the owner's IBAN bank details. Passing an empty body
  // removes the bankDetails object entirely (via DELETE below).
  app.put("/api/owner/bank-details", requireAuth, async (req, res) => {
    // Resolve which portfolio's banking we're editing. ?ownerId= lets a
    // delegated contact target the portfolio they manage (requireEdit); the
    // owner editing their own omits it and is always allowed below.
    const scope = await resolveOwnerScope(req, true);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const authz = await authorizePortfolioRead(req.user!.uid, scope, "finance.manageBanking");
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Length-cap each field. Real values: account holder names < 100
    // chars, IBAN max 34 chars per spec, SWIFT/BIC 8 or 11 chars.
    // Capping at 200 / 50 / 20 leaves headroom but stops Firestore-doc
    // bloat from a malicious near-1MB payload.
    const holder = typeof body.holder === "string" ? body.holder.trim().slice(0, 200) : "";
    const iban =
      typeof body.iban === "string" ? body.iban.replace(/\s+/g, "").toUpperCase().slice(0, 50) : "";
    const swift =
      typeof body.swift === "string" ? body.swift.trim().toUpperCase().slice(0, 20) : "";
    if (!holder || !iban || !swift) {
      return res.status(400).json({ error: "holder, iban and swift are all required" });
    }
    // IBAN sanity: 15-34 alphanumerics. We don't validate the country
    // checksum here — the bank API would reject a malformed one anyway
    // — but stop garbage from being saved.
    if (!/^[A-Z0-9]{15,34}$/.test(iban)) {
      return res.status(400).json({ error: "iban format invalid" });
    }
    if (!/^[A-Z0-9]{8,11}$/.test(swift)) {
      return res.status(400).json({ error: "swift format invalid" });
    }
    try {
      // Write to the ALREADY-AUTHORIZED portfolio id (scope.portfolioId), not a
      // re-derivation from ownerId — so we can't write to a different portfolio
      // than the one the privilege check approved. Self always carries a
      // non-null portfolioId; ensure only as the null safety net.
      const portfolioId = scope.portfolioId ?? (await ensurePortfolio(scope.ownerId)).id;
      await writePortfolioBanking(portfolioId, { bankDetails: { holder, iban, swift } });
      res.json({ holder, iban, swift });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to save bank details") });
    }
  });

  app.delete("/api/owner/bank-details", requireAuth, async (req, res) => {
    const scope = await resolveOwnerScope(req, true);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const authz = await authorizePortfolioRead(req.user!.uid, scope, "finance.manageBanking");
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    try {
      // Firestore: setting a field to FieldValue.delete() removes it.
      // Using an `undefined` merge wouldn't take effect, so use the
      // admin sentinel. Banking lives on the portfolio doc now — clear it on
      // the already-authorized portfolio id (not a re-derivation from ownerId).
      const portfolioId = scope.portfolioId ?? (await ensurePortfolio(scope.ownerId)).id;
      await db()
        .collection(COL.portfolios)
        .doc(portfolioId)
        .update({ bankDetails: FieldValue.delete(), updatedAt: new Date().toISOString() });
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to remove bank details") });
    }
  });

  // GET /api/owner/banking?ownerId=… — read a portfolio's saved IBAN so an
  // authorized contact (or the owner) can view/edit it on a portfolio they
  // don't own. Scoped + gated by the same "finance.manageBanking" privilege as
  // the write paths (owner always allowed via isSelf). Returns ONLY bankDetails
  // — Stripe Connect onboarding is the owner's own legal flow and isn't exposed
  // to contacts here; the owner manages Connect via /api/me + the connect
  // endpoints. The owner's own client reads banking from /api/me, so this
  // endpoint is for the granted-portfolio case.
  app.get("/api/owner/banking", requireAuth, async (req, res) => {
    const scope = await resolveOwnerScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const authz = await authorizePortfolioRead(req.user!.uid, scope, "finance.manageBanking");
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    try {
      // Read the already-authorized portfolio doc directly. Null portfolioId
      // (legacy ?ownerId= for an owner with no portfolio) → no banking.
      const banking = scope.portfolioId ? await loadPortfolioBankingById(scope.portfolioId) : {};
      res.json({ bankDetails: banking.bankDetails ?? null });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load banking") });
    }
  });

  // GET /api/owner/transactions?portfolioId=…/?ownerId=… — read the activity
  // feed, joined with property addresses. Portfolio-scoped via
  // resolveOwnerScope.
  app.get("/api/owner/transactions", requireAuth, async (req, res) => {
    const scope = await resolveOwnerScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const authz = await authorizePortfolioRead(req.user!.uid, scope, "finance.viewHistory");
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    // Phase-2 re-key: the ledger query keys off the STABLE portfolio id. Null
    // portfolio → no data by construction → empty feed without querying.
    const { portfolioId } = scope;
    // `?sinceDays=N` returns a DATE window (used by Insights, which needs a full
    // 12-month chart + 30/60/90/120/365-day summaries) instead of the row-count
    // cap the activity feed uses. The old 25-row default silently under-reported
    // the chart/net-income for any portfolio with more than ~25 ledger entries.
    // Windowed reads use a high row cap so a busy 12-month window isn't truncated.
    const sinceDaysRaw = Number(req.query.sinceDays);
    const sinceDays =
      Number.isFinite(sinceDaysRaw) && sinceDaysRaw > 0 ? Math.min(sinceDaysRaw, 1000) : null;
    const cutoffIso = sinceDays ? new Date(Date.now() - sinceDays * 86400000).toISOString() : null;
    const limit = sinceDays ? 5000 : Math.min(Number(req.query.limit) || 25, 200);
    try {
      if (!portfolioId) return res.json([]);
      // Deliberately NO orderBy("timestamp") here: portfolioId+timestamp
      // would require a brand-new composite index, whereas a single equality
      // filter rides Firestore's automatic single-field index. We sort the
      // (per-portfolio, bounded) result in memory and apply the limit AFTER
      // the sort so the newest rows still win.
      //
      // Prepaid rent (Agreement.prepaidRents) never lands in the ledger, so we
      // also pull the portfolio's agreements and synthesize a read-only income
      // row per prepaid lease, merged in BEFORE the sort/slice so it competes
      // for recency and picks up its property address below like any other row.
      const [snap, agSnap] = await Promise.all([
        db().collection(COL.transactions).where("portfolioId", "==", portfolioId).get(),
        db().collection(COL.agreements).where("portfolioId", "==", portfolioId).get(),
      ]);
      const prepaidRows = agSnap.docs
        .map((d) => prepaidRentActivityRow(d.data() as Agreement))
        .filter((t): t is Transaction => t !== null);
      const merged = [...snap.docs.map((d) => d.data() as Transaction), ...prepaidRows].filter(
        (t) => !cutoffIso || t.timestamp >= cutoffIso,
      );
      const transactions = merged
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
        .slice(0, limit);

      if (transactions.length === 0) return res.json([]);

      const propertyIds = Array.from(
        new Set(transactions.map((t) => t.propertyId).filter((x): x is string => !!x)),
      );
      const propertyRefs = propertyIds.map((id) => db().collection(COL.properties).doc(id));
      const propertyDocs = propertyRefs.length ? await db().getAll(...propertyRefs) : [];
      const addressById = new Map<string, string>();
      propertyDocs.forEach(
        (s) => s.exists && addressById.set(s.id, (s.data() as Property).address),
      );

      const payload = transactions.map((t) => ({
        ...t,
        propertyAddress: t.propertyId ? (addressById.get(t.propertyId) ?? null) : null,
      }));
      res.json(payload);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load transactions") });
    }
  });

  // POST /api/owner/transactions — owner manually logs an income or
  // expense against one of their properties. Used by the
  // RecordActivityDialog. Status is always "completed" — this is a
  // record of something that already happened, not a payment awaiting
  // verification.
  app.post("/api/owner/transactions", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    // 200/day per owner — a real landlord might back-fill a year of
    // historical activity but that's still well below the cap. Stops a
    // runaway client loop from filling Firestore with junk rows.
    const limit = await rateLimit(`owner-tx:${uid}`, 200, 24 * 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many activity entries today. Try again tomorrow.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const propertyId = typeof body.propertyId === "string" ? body.propertyId : "";
    const amountRaw = Number(body.amount);
    const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : 0;
    const type = VALID_TX_TYPES.includes(body.type as TransactionType)
      ? (body.type as TransactionType)
      : null;
    const category = VALID_TX_CATEGORIES.includes(body.category as TransactionCategory)
      ? (body.category as TransactionCategory)
      : null;
    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : null;
    const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : "";
    const timestampIso =
      typeof body.timestamp === "string" && !isNaN(new Date(body.timestamp).getTime())
        ? new Date(body.timestamp).toISOString()
        : new Date().toISOString();

    if (!propertyId) return res.status(400).json({ error: "propertyId is required" });
    if (!amount) return res.status(400).json({ error: "amount must be > 0" });
    if (!type) return res.status(400).json({ error: "invalid type" });
    if (!category) return res.status(400).json({ error: "invalid category" });
    if (!name) return res.status(400).json({ error: "name is required" });

    try {
      const propSnap = await db().collection(COL.properties).doc(propertyId).get();
      if (!propSnap.exists) return res.status(404).json({ error: "Property not found" });
      const property = propSnap.data() as Property;
      if (property.ownerId !== uid) return res.status(403).json({ error: "Forbidden" });

      // Phase-1 portfolio re-key: stamp the owner's STABLE portfolio doc id
      // on the new ledger row at creation (reads still key off ownerId).
      const pf = await ensurePortfolio(uid);

      const ref = db().collection(COL.transactions).doc();
      const tx: Transaction = {
        id: ref.id,
        propertyId,
        ownerId: uid,
        portfolioId: pf.id,
        name,
        amount,
        currency: "EUR",
        type,
        category,
        status: "completed",
        timestamp: timestampIso,
        // Tag as owner-recorded + stamp the real write time so the owner can
        // correct it within 24h (PATCH below). `timestamp` is the (back-datable)
        // activity date and can't gate the edit window.
        source: "manual",
        createdAt: new Date().toISOString(),
        ...(notes ? { notes } : {}),
      };
      await ref.set(tx);
      res.status(201).json(tx);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to record transaction") });
    }
  });

  // PATCH /api/owner/transactions/:id — correct a manual activity the owner
  // recorded themselves, within the 24h edit window. This is the one sanctioned
  // crack in the append-only ledger (see Transaction in firestore-schema), so
  // it's tightly gated:
  //   • owner-self only — tx.ownerId must equal the caller (granted contacts,
  //     even with edit permission, can't rewrite financial history);
  //   • manual rows only — source must be "manual" (never a rent payment or any
  //     system-generated row, whose amounts feed cycle/commission accounting);
  //   • within 24h of createdAt (the real write time, not the back-datable
  //     activity timestamp).
  // Only the owner-editable fields move; id/ownerId/source/createdAt/status/
  // currency are immutable.
  app.patch("/api/owner/transactions/:id", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const id = req.params.id;
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      const ref = db().collection(COL.transactions).doc(reqStr(id));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Transaction not found" });
      const tx = snap.data() as Transaction;

      if (tx.ownerId !== uid) return res.status(403).json({ error: "Not your transaction" });
      // Post-transfer guard: a completed manual row keeps its original ownerId
      // (ledger history) but carries the stable portfolioId. After the portfolio
      // moves owners, the PRIOR owner still matches tx.ownerId — so additionally
      // require the caller to currently HOLD this row's portfolio, blocking the
      // old owner from editing rows now in the new owner's books.
      if (tx.portfolioId) {
        const myPortfolio = await getPortfolio(uid);
        if (myPortfolio?.id !== tx.portfolioId) {
          return res.status(403).json({ error: "Not your transaction" });
        }
      }
      if (tx.source !== "manual") {
        return res.status(409).json({ error: "Only manually recorded activities can be edited." });
      }
      // Missing createdAt (legacy manual rows) is treated as out-of-window:
      // we can't prove it's recent, and the ledger defaults to immutable.
      const createdMs = tx.createdAt ? new Date(tx.createdAt).getTime() : NaN;
      if (!Number.isFinite(createdMs) || Date.now() - createdMs > MANUAL_EDIT_WINDOW_MS) {
        return res
          .status(409)
          .json({ error: "The 24-hour window to edit this activity has passed." });
      }

      // Partial update: validate only the fields that were sent. The edit form
      // resubmits the full set, but accepting a subset keeps the contract robust.
      const updates: Record<string, unknown> = {};
      // FieldValue.delete() returns a fresh sentinel each call, so we can't
      // `===`-compare it later — track the clear with a flag instead.
      let notesCleared = false;

      if (body.name !== undefined) {
        const name =
          typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : null;
        if (!name) return res.status(400).json({ error: "name is required" });
        updates.name = name;
      }
      if (body.amount !== undefined) {
        const amountRaw = Number(body.amount);
        if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
          return res.status(400).json({ error: "amount must be > 0" });
        }
        updates.amount = amountRaw;
      }
      if (body.type !== undefined) {
        if (!VALID_TX_TYPES.includes(body.type as TransactionType)) {
          return res.status(400).json({ error: "invalid type" });
        }
        updates.type = body.type as TransactionType;
      }
      if (body.category !== undefined) {
        if (!VALID_TX_CATEGORIES.includes(body.category as TransactionCategory)) {
          return res.status(400).json({ error: "invalid category" });
        }
        updates.category = body.category as TransactionCategory;
      }
      if (body.timestamp !== undefined) {
        if (typeof body.timestamp !== "string" || isNaN(new Date(body.timestamp).getTime())) {
          return res.status(400).json({ error: "invalid timestamp" });
        }
        updates.timestamp = new Date(body.timestamp).toISOString();
      }
      if (body.notes !== undefined) {
        const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : "";
        // Empty clears the field rather than storing "" (mirrors POST, which
        // omits notes when blank).
        if (notes) {
          updates.notes = notes;
        } else {
          updates.notes = FieldValue.delete();
          notesCleared = true;
        }
      }
      if (body.propertyId !== undefined) {
        const propertyId = typeof body.propertyId === "string" ? body.propertyId : "";
        if (!propertyId) return res.status(400).json({ error: "propertyId is required" });
        // Re-verify ownership when the property changes — the owner can move an
        // entry to a different property, but only one they still own.
        if (propertyId !== tx.propertyId) {
          const propSnap = await db().collection(COL.properties).doc(propertyId).get();
          if (!propSnap.exists) return res.status(404).json({ error: "Property not found" });
          if ((propSnap.data() as Property).ownerId !== uid) {
            return res.status(403).json({ error: "Forbidden" });
          }
        }
        updates.propertyId = propertyId;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No editable fields supplied" });
      }

      await ref.update(updates);
      // Reflect the cleared note as an absent field in the response (the stored
      // doc had the field removed via FieldValue.delete()).
      const merged: Record<string, unknown> = { ...tx, ...updates };
      if (notesCleared) delete merged.notes;
      res.json(merged);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to update transaction") });
    }
  });
}
