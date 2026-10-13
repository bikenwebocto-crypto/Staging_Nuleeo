// Tenant ticket creation. Files a maintenance/property issue from the
// tenant dashboard, mirrors property issues into the activity ledger,
// and pushes the landlord. Admin-side ticket endpoints
// (GET/PATCH/messages) still live in routes.ts.

import type { Express } from "express";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { reqStr } from "../util";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { notifyUser, notifyStaff } from "../services/push";
import { ensurePortfolio } from "../services/portfolioBanking";
import {
  COL,
  type Ticket,
  type TicketPriority,
  type Tenant,
  type Transaction,
} from "../../shared/firestore-schema";

// These mirror the validation arrays used by the admin ticket PATCH
// endpoint in routes.ts. Duplicated rather than imported because the
// admin half hasn't been extracted yet — when it is, both modules
// should pull from a shared `ticketTypes.ts` service.
const TICKET_CATEGORIES: Ticket["category"][] = [
  "billing",
  "technical",
  "account",
  "general",
  "property",
];
const TICKET_PRIORITIES: TicketPriority[] = ["low", "medium", "high", "urgent"];

export function registerTicketRoutes(app: Express): void {
  app.post("/api/tickets", requireAuth, async (req, res) => {
    const { uid, email, profile } = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Per-user daily cap — a real user files a handful of tickets at
    // most; 20/day catches the typo+retry case without letting a
    // single account flood the support queue.
    const limit = await rateLimit(`ticket:${uid}`, 20, 24 * 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many tickets today. Try again tomorrow.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const subject = typeof body.subject === "string" ? body.subject.trim().slice(0, 200) : "";
    const description =
      typeof body.description === "string" ? body.description.trim().slice(0, 4000) : "";
    const category = TICKET_CATEGORIES.includes(body.category as Ticket["category"])
      ? (body.category as Ticket["category"])
      : "general";
    const priority = TICKET_PRIORITIES.includes(body.priority as TicketPriority)
      ? (body.priority as TicketPriority)
      : "medium";
    const propertyId = typeof body.propertyId === "string" ? body.propertyId : undefined;
    const unitId = typeof body.unitId === "string" ? body.unitId : undefined;

    if (!subject) return res.status(400).json({ error: "subject is required" });
    if (!description) return res.status(400).json({ error: "description is required" });

    const ref = db().collection(COL.tickets).doc();
    const now = new Date().toISOString();
    const ticket: Ticket = {
      id: ref.id,
      subject,
      userId: uid,
      userEmail: profile?.email ?? email ?? "",
      category,
      priority,
      status: "open",
      createdAt: now,
      updatedAt: now,
      description,
      ...(propertyId ? { propertyId } : {}),
      ...(unitId ? { unitId } : {}),
    };
    await ref.set(ticket);

    // Page platform staff about every new ticket — ALL categories land in the
    // support queue (billing/technical/account/general are staff-only; property
    // tickets also notify the owner below). Best-effort; never blocks the write.
    await notifyStaff({
      title: `New ${category} ticket`,
      message: `${ticket.userEmail || "A user"}: ${subject}`,
      url: "https://platform.oliowallet.com/admin/support",
    });

    // Mirror property-issue tickets into the activity ledger as a
    // neutral transaction so they show up in the tenant's "Recent
    // Activity" feed alongside payments.
    if (category === "property" && (propertyId || unitId)) {
      const tenantSnap = await db()
        .collection(COL.tenants)
        .where("userId", "==", uid)
        .where("status", "==", "active")
        .limit(5)
        .get();
      const tenantDoc = tenantSnap.docs.find((d) => {
        const t = d.data() as Tenant;
        return (unitId && t.unitId === unitId) || (propertyId && t.propertyId === propertyId);
      });
      if (tenantDoc) {
        const t = tenantDoc.data() as Tenant;
        // Phase-1 portfolio re-key: stamp the LANDLORD's stable portfolio doc
        // id on the mirrored ledger row at creation (reads still key off
        // ownerId). The row belongs to the property's owner, not the caller.
        const pf = await ensurePortfolio(t.ownerId);
        const txRef = db().collection(COL.transactions).doc();
        const tx: Transaction = {
          id: txRef.id,
          propertyId: t.propertyId,
          unitId: t.unitId,
          tenantId: t.id,
          ownerId: t.ownerId,
          portfolioId: pf.id,
          name: `Reported issue: ${subject}`,
          amount: 0,
          currency: "EUR",
          type: "neutral",
          category: "maintenance",
          status: "pending",
          timestamp: now,
          notes: ref.id,
        };
        await txRef.set(tx);

        // Notify the landlord that their tenant filed a property issue.
        const tenantName =
          `${profile?.firstName ?? ""} ${profile?.lastName ?? ""}`.trim() || "Your tenant";
        await notifyUser({
          externalUserId: t.ownerId,
          category: "maintenance",
          title: "New maintenance request",
          message: `${tenantName} reported: ${subject}`,
          url: "https://app.oliowallet.com/owner",
        });
      }
    }

    res.status(201).json(ticket);
  });

  // POST /api/owner/maintenance/resolve/:id — owner marks a tenant-reported
  // maintenance issue as fixed. The tenant's "Report a Problem" flow above
  // mirrors each property issue into the activity ledger as a neutral /
  // maintenance transaction (status "pending"); this is its lifecycle
  // complement, so it lives in the same file. It flips that transaction to
  // "resolved", closes the backing support ticket, and notifies the tenant.
  //
  // Owner-self only — the transaction's ownerId must equal the caller. A
  // granted portfolio contact (legal/financial) can read the report but, like
  // offline-rent verify, can't change its status. Idempotent: resolving an
  // already-resolved report returns its current state without re-notifying.
  app.post("/api/owner/maintenance/resolve/:id", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const txId = req.params.id;
    try {
      const ref = db().collection(COL.transactions).doc(reqStr(txId));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Report not found" });
      const tx = snap.data() as Transaction;

      if (tx.ownerId !== uid) return res.status(403).json({ error: "Not your report" });
      // Only the tenant-reported maintenance rows carry the pending→resolved
      // lifecycle. Owner-recorded maintenance ledger entries are expenses
      // (status "completed") and aren't resolvable here.
      if (tx.type !== "neutral" || tx.category !== "maintenance") {
        return res.status(400).json({ error: "Only maintenance reports can be resolved" });
      }
      if (tx.status === "resolved") {
        return res.json(tx); // already resolved — no-op, don't re-notify
      }
      if (tx.status !== "pending") {
        return res.status(409).json({ error: "Only pending maintenance reports can be resolved" });
      }

      const resolvedAt = new Date().toISOString();
      await ref.set({ status: "resolved", resolvedAt, resolvedBy: uid }, { merge: true });
      const updated: Transaction = { ...tx, status: "resolved", resolvedAt, resolvedBy: uid };

      // Close the backing support ticket. The mirror stores the ticket id in
      // `notes` (see POST /api/tickets above). Best-effort — the resolve has
      // already committed; a stale ticket status must not fail it.
      const ticketId = typeof tx.notes === "string" ? tx.notes.trim() : "";
      if (ticketId) {
        try {
          const ticketRef = db().collection(COL.tickets).doc(ticketId);
          const ticketSnap = await ticketRef.get();
          if (ticketSnap.exists) {
            const ticket = ticketSnap.data() as Ticket;
            // Only advance a still-open ticket. Staff drive the support queue
            // independently (admin PATCH /api/admin/tickets/:id), so don't
            // regress one they already moved to a terminal state ("resolved"
            // or "closed") back to "resolved" — the owner's ledger resolve must
            // not churn the queue backward.
            if (ticket.status === "open" || ticket.status === "in_progress") {
              await ticketRef.set({ status: "resolved", updatedAt: resolvedAt }, { merge: true });
            }
          }
        } catch {
          // Non-fatal.
        }
      }

      // Notify the tenant their issue was fixed. tx.tenantId points at the
      // tenancy doc, so resolve the User.id through it — the same hop the
      // offline-rent verify push uses.
      if (tx.tenantId) {
        try {
          const tenancySnap = await db().collection(COL.tenants).doc(tx.tenantId).get();
          if (tenancySnap.exists) {
            const tenancy = tenancySnap.data() as Tenant;
            if (tenancy.userId) {
              const issue =
                tx.name.replace(/^Reported issue:\s*/i, "").trim() || "your maintenance request";
              await notifyUser({
                externalUserId: tenancy.userId,
                category: "maintenance",
                title: "Maintenance resolved",
                message: `Your landlord marked "${issue}" as resolved.`,
                url: "https://app.oliowallet.com/tenant/activity",
              });
            }
          }
        } catch {
          // Non-fatal — resolve succeeded; the push is best-effort.
        }
      }

      res.json(updated);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to resolve report") });
    }
  });
}
