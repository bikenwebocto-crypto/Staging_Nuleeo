// Business Detail endpoints (a business is an Entity with entityType COMPANY).
//
//   GET   /api/entities/:id/detail         → BusinessDetailResponse
//   PATCH /api/entities/:id                { ...details }  → Entity
//   POST  /api/entities/:id/archive        → Entity   (soft: sets archivedAt)
//   POST  /api/entities/:id/unarchive      → Entity
//   PUT   /api/entities/:id/shareholders   { shareholders, complete } → BusinessDetailResponse
//
// Access: only the account that owns the entity (Entity.ownerId === caller).
// Anyone else gets 404 (existence is not leaked). Writes also require the
// owner experience. All input is validated server-side by the shared rules.
// Financial KPIs / invoices are null until those modules exist — never faked.

import type { Express, Request, Response } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { requireAuth } from "../auth";
import { db } from "../firebase";
import { errMsg } from "../services/errMsg";
import { sanitizeText } from "../services/unicodeSanitize";
import { resolveOwnerPlan } from "../services/commission";
import { COL, type Entity, type User } from "../../shared/firestore-schema";
import { canOwnWorkspaces } from "../../shared/workspaces";
import { buildBusinessEdit, sanitizeWizardData } from "../../shared/businesses";
import {
  allocationTotal,
  buildNotifications,
  validateShareholders,
  type BusinessDetailResponse,
  type Shareholding,
  type ShareholderView,
} from "../../shared/shareholdings";

const ID_RE = /^[A-Za-z0-9_-]{1,160}$/;

type Loaded = { ok: true; entity: Entity } | { ok: false };

async function loadOwnBusiness(uid: string, id: string): Promise<Loaded> {
  if (!ID_RE.test(id)) return { ok: false };
  const snap = await db().collection(COL.entities).doc(id).get();
  const e = snap.data() as Entity | undefined;
  if (!snap.exists || !e || e.ownerId !== uid || e.entityType !== "COMPANY") return { ok: false };
  return { ok: true, entity: { ...e, id: snap.id } };
}

async function isOwner(req: Request): Promise<boolean> {
  const { uid, profile } = req.user!;
  return canOwnWorkspaces(profile, () => resolveOwnerPlan(uid));
}

const notFound = (res: Response) => res.status(404).json({ error: "Business not found" });

async function buildDetail(uid: string, profile: User | undefined, business: Entity): Promise<BusinessDetailResponse> {
  const [holdingsSnap, entitiesSnap] = await Promise.all([
    db().collection(COL.shareholdings).where("ownerId", "==", uid).get(),
    db().collection(COL.entities).where("ownerId", "==", uid).get(),
  ]);
  const entities = new Map(entitiesSnap.docs.map((d) => [d.id, { ...(d.data() as Entity), id: d.id }]));
  const rows = holdingsSnap.docs
    .map((d) => ({ ...(d.data() as Shareholding), id: d.id }))
    .filter((h) => h.entityId === business.id);

  const you = [profile?.firstName, profile?.lastName].filter(Boolean).join(" ");
  let shareholders: ShareholderView[] = rows.map((h) => ({
    id: h.id,
    holderType: h.holderType,
    ...(h.holderUserId ? { holderUserId: h.holderUserId } : {}),
    ...(h.holderName ? { holderName: h.holderName } : {}),
    ...(h.holderEmail ? { holderEmail: h.holderEmail } : {}),
    ...(h.holderEntityId ? { holderEntityId: h.holderEntityId } : {}),
    percent: h.percent,
    ...(h.role ? { role: h.role } : {}),
    isYou: h.holderUserId === uid,
    label:
      h.holderUserId === uid
        ? you ? `You (${you})` : "You"
        : h.holderType === "ENTITY"
          ? (entities.get(h.holderEntityId ?? "")?.name ?? "Unknown company")
          : (h.holderName ?? "Unnamed"),
  }));
  // Businesses created by the wizard before any shareholder edit: show the
  // creator's recorded role/share (real data, not a placeholder).
  if (shareholders.length === 0 && (business.creatorRole || typeof business.creatorSharePercent === "number")) {
    shareholders = [
      {
        id: "creator",
        holderType: "PERSON",
        holderUserId: uid,
        percent: business.creatorSharePercent ?? 0,
        ...(business.creatorRole ? { role: business.creatorRole } : {}),
        isYou: true,
        label: you ? `You (${you})` : "You",
      },
    ];
  }
  const total = allocationTotal(shareholders);
  const complete = !!business.ownershipComplete && total === 100;
  const notifications = buildNotifications(business, total, complete);
  return {
    business,
    shareholders,
    allocation: { total, complete },
    notifications,
    kpis: { revenue30d: null, expenses30d: null, profitMarginPct: null, needsAttention: notifications.length },
    invoices: { unpaid: null, overdue: null, paidThisMonth: null, creationAvailable: false },
    companyOptions: [...entities.values()]
      .filter((e) => e.entityType === "COMPANY" && e.id !== business.id && !e.archivedAt)
      .map((e) => ({ id: e.id, name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function registerBusinessDetailRoutes(app: Express): void {
  app.get("/api/entities/:id/detail", requireAuth, async (req, res) => {
    const { uid, profile } = req.user!;
    try {
      const loaded = await loadOwnBusiness(uid, String(req.params.id));
      if (!loaded.ok) return notFound(res);
      res.json(await buildDetail(uid, profile, loaded.entity));
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load business") });
    }
  });

  app.patch("/api/entities/:id", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    try {
      const loaded = await loadOwnBusiness(uid, String(req.params.id));
      if (!loaded.ok) return notFound(res);
      if (!(await isOwner(req))) return res.status(403).json({ error: "Owner experience required" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const built = buildBusinessEdit(loaded.entity, sanitizeWizardData(body, sanitizeText), Object.keys(body));
      if (!built.ok) {
        return res.status(400).json({ error: Object.values(built.errors)[0], errors: built.errors });
      }
      const update: Record<string, unknown> = { ...built.set, updatedAt: new Date().toISOString() };
      for (const k of Object.keys(update)) if (update[k] === undefined) delete update[k];
      for (const k of built.remove) update[k] = FieldValue.delete();
      const ref = db().collection(COL.entities).doc(loaded.entity.id);
      await ref.update(update);
      const fresh = await ref.get();
      res.json({ ...(fresh.data() as Entity), id: ref.id });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to update business") });
    }
  });

  for (const action of ["archive", "unarchive"] as const) {
    app.post(`/api/entities/:id/${action}`, requireAuth, async (req, res) => {
      const { uid } = req.user!;
      try {
        const loaded = await loadOwnBusiness(uid, String(req.params.id));
        if (!loaded.ok) return notFound(res);
        if (!(await isOwner(req))) return res.status(403).json({ error: "Owner experience required" });
        // Soft and reversible: nothing is deleted, shareholdings stay.
        const nowIso = new Date().toISOString();
        const ref = db().collection(COL.entities).doc(loaded.entity.id);
        await ref.update(
          action === "archive"
            ? { archivedAt: loaded.entity.archivedAt ?? nowIso, updatedAt: nowIso }
            : { archivedAt: FieldValue.delete(), updatedAt: nowIso },
        );
        const fresh = await ref.get();
        res.json({ ...(fresh.data() as Entity), id: ref.id });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, `Failed to ${action} business`) });
      }
    });
  }

  app.put("/api/entities/:id/shareholders", requireAuth, async (req, res) => {
    const { uid, profile } = req.user!;
    const body = (req.body ?? {}) as { shareholders?: unknown; complete?: unknown };
    try {
      const loaded = await loadOwnBusiness(uid, String(req.params.id));
      if (!loaded.ok) return notFound(res);
      if (!(await isOwner(req))) return res.status(403).json({ error: "Owner experience required" });
      if (loaded.entity.archivedAt) return res.status(409).json({ error: "Unarchive the business to edit shareholders" });

      const [entitiesSnap, holdingsSnap] = await Promise.all([
        db().collection(COL.entities).where("ownerId", "==", uid).get(),
        db().collection(COL.shareholdings).where("ownerId", "==", uid).get(),
      ]);
      const holdings = holdingsSnap.docs.map((d) => ({ ...(d.data() as Shareholding), id: d.id }));
      const checked = validateShareholders(
        body.shareholders,
        {
          callerUid: uid,
          entityId: loaded.entity.id,
          ownedEntities: entitiesSnap.docs.map((d) => ({ ...(d.data() as Entity), id: d.id })),
          otherHoldings: holdings.filter((h) => h.entityId !== loaded.entity.id),
        },
        { complete: body.complete === true, clean: sanitizeText },
      );
      if (!checked.ok) return res.status(400).json({ error: checked.error, rowErrors: checked.rowErrors });

      const nowIso = new Date().toISOString();
      const col = db().collection(COL.shareholdings);
      const batch = db().batch();
      for (const h of holdings.filter((x) => x.entityId === loaded.entity.id)) batch.delete(col.doc(h.id));
      for (const r of checked.rows) {
        const ref = col.doc();
        const row: Shareholding = { ...r, id: ref.id, ownerId: uid, entityId: loaded.entity.id, createdAt: nowIso, updatedAt: nowIso };
        batch.set(ref, row);
      }
      const self = checked.rows.find((r) => r.holderUserId === uid);
      batch.update(db().collection(COL.entities).doc(loaded.entity.id), {
        ownershipComplete: body.complete === true && checked.total === 100,
        creatorSharePercent: self ? self.percent : FieldValue.delete(),
        ...(self?.role ? { creatorRole: self.role } : {}),
        updatedAt: nowIso,
      });
      await batch.commit();

      const fresh = await loadOwnBusiness(uid, loaded.entity.id);
      if (!fresh.ok) return notFound(res);
      res.json(await buildDetail(uid, profile, fresh.entity));
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to save shareholders") });
    }
  });
}
