// Entity endpoints (companies + the owner's personal holding).
//
//   GET  /api/entities  → EntityListResponse (the caller's own entities)
//   POST /api/entities  EntityInput → 201 Entity
//
// Business Portfolio (a business IS an Entity with entityType COMPANY):
//   GET    /api/entities/portfolio?q=&ownership=&view=  → BusinessPortfolioResponse
//   GET    /api/entities/draft                          → { draft | null }
//   PUT    /api/entities/draft  { step, data }          → { draft }
//   DELETE /api/entities/draft                          → 204
//   POST   /api/entities/business { submissionId, data } → 201 Entity (200 on retry)
//   GET    /api/entities/:id                            → Entity (owner only)
//
// Entities belong to the OWNER, not to a workspace. Creating one requires the
// owner experience (same gate as workspaces). At most one PERSONAL entity per
// owner — enforced in a transaction so concurrent creates can't both win.

import { createHash } from "node:crypto";
import type { Express } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { requireAuth } from "../auth";
import { db } from "../firebase";
import { errMsg } from "../services/errMsg";
import { sanitizeText } from "../services/unicodeSanitize";
import { resolveOwnerPlan } from "../services/commission";
import { COL, type Entity, type User } from "../../shared/firestore-schema";
import {
  buildBusinessEntityFields,
  buildBusinessPortfolio,
  sanitizeWizardData,
  type BusinessDraft,
} from "../../shared/businesses";
import { validateEntityInput, type EntityListResponse } from "../../shared/entities";
import { canOwnWorkspaces } from "../../shared/workspaces";
import { registerBusinessDetailRoutes } from "./businessDetail";

const SUBMISSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;

async function ownerGate(uid: string, profile: Parameters<typeof canOwnWorkspaces>[0]) {
  return canOwnWorkspaces(profile, () => resolveOwnerPlan(uid));
}

async function loadOwnEntities(uid: string): Promise<Entity[]> {
  const snap = await db().collection(COL.entities).where("ownerId", "==", uid).get();
  return snap.docs.map((d) => ({ ...(d.data() as Entity), id: d.id }));
}

// Deterministic per (owner, submission) so a double-submit / retry lands on
// the same doc instead of creating a duplicate business.
function businessDocId(uid: string, submissionId: string): string {
  return `biz_${createHash("sha256").update(`${uid}\u0000${submissionId}`).digest("hex").slice(0, 24)}`;
}

function registerBusinessRoutes(app: Express): void {
  // Business Portfolio: list + search/filter + consolidated summary.
  app.get("/api/entities/portfolio", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "";
    const ownership = (["all", "sole", "shared", "unknown"] as const).find((o) => o === req.query.ownership);
    const view = req.query.view === "archived" ? "archived" : "active";
    try {
      res.json(buildBusinessPortfolio(await loadOwnEntities(uid), { q, ownership, view }));
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load businesses") });
    }
  });

  // Wizard draft (one per user, stored on the user doc).
  app.get("/api/entities/draft", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    try {
      const snap = await db().collection(COL.users).doc(uid).get();
      const draft = (snap.data() as User | undefined)?.businessDraft ?? null;
      res.json({ draft });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load draft") });
    }
  });

  app.put("/api/entities/draft", requireAuth, async (req, res) => {
    const { uid, profile } = req.user!;
    const body = (req.body ?? {}) as { step?: unknown; data?: unknown };
    const step = body.step;
    if (step !== 1 && step !== 2 && step !== 3 && step !== 4) {
      return res.status(400).json({ error: "step must be 1-4" });
    }
    try {
      if (!(await ownerGate(uid, profile))) {
        return res.status(403).json({ error: "Turn on the owner experience to add a business" });
      }
      const draft: BusinessDraft = {
        step,
        data: sanitizeWizardData(body.data, sanitizeText),
        updatedAt: new Date().toISOString(),
      };
      await db().collection(COL.users).doc(uid).set({ businessDraft: draft }, { merge: true });
      res.json({ draft });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to save draft") });
    }
  });

  app.delete("/api/entities/draft", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    try {
      await db().collection(COL.users).doc(uid).update({ businessDraft: FieldValue.delete() });
      res.status(204).end();
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to discard draft") });
    }
  });

  // Create a business from the wizard. Idempotent on submissionId.
  app.post("/api/entities/business", requireAuth, async (req, res) => {
    const { uid, profile } = req.user!;
    const body = (req.body ?? {}) as { submissionId?: unknown; data?: unknown };
    if (typeof body.submissionId !== "string" || !SUBMISSION_ID_RE.test(body.submissionId)) {
      return res.status(400).json({ error: "submissionId is required" });
    }
    const built = buildBusinessEntityFields(sanitizeWizardData(body.data, sanitizeText));
    if (!built.ok) {
      return res.status(400).json({
        error: Object.values(built.errors)[0] ?? "Invalid business details",
        step: built.step,
        errors: built.errors,
      });
    }
    try {
      if (!(await ownerGate(uid, profile))) {
        return res.status(403).json({ error: "Turn on the owner experience to add a business" });
      }
      const nowIso = new Date().toISOString();
      const ref = db().collection(COL.entities).doc(businessDocId(uid, body.submissionId));
      const entity: Entity = {
        ...built.fields,
        id: ref.id,
        // Owner comes from the verified token only — never from the body.
        ownerId: uid,
        createdBy: uid,
        source: "MANUAL",
        submissionId: body.submissionId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      try {
        await ref.create(entity);
      } catch (err) {
        if ((err as { code?: number }).code !== 6) throw err;
        // Same submission already created it → return that one (no duplicate).
        const existing = await ref.get();
        const prev = existing.data() as Entity | undefined;
        if (!prev || prev.ownerId !== uid) return res.status(409).json({ error: "Conflict" });
        return res.status(200).json({ ...prev, id: ref.id });
      }
      // Best-effort: the business exists even if clearing the draft fails.
      await db()
        .collection(COL.users)
        .doc(uid)
        .update({ businessDraft: FieldValue.delete() })
        .catch(() => {});
      res.status(201).json(entity);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to add business") });
    }
  });

  // Single entity (owner-scoped). Non-owners get 404, not 403.
  app.get("/api/entities/:id", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const id = String(req.params.id ?? "");
    if (!ENTITY_ID_RE.test(id)) return res.status(404).json({ error: "Not found" });
    try {
      const snap = await db().collection(COL.entities).doc(id).get();
      const e = snap.data() as Entity | undefined;
      if (!snap.exists || !e || e.ownerId !== uid) return res.status(404).json({ error: "Not found" });
      res.json({ ...e, id: snap.id });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load business") });
    }
  });
}

export function registerEntityRoutes(app: Express): void {
  registerBusinessRoutes(app);
  registerBusinessDetailRoutes(app);

  app.get("/api/entities", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    try {
      const snap = await db().collection(COL.entities).where("ownerId", "==", uid).get();
      const entities = snap.docs
        .map((d) => ({ ...(d.data() as Entity), id: d.id }))
        .sort((a, b) =>
          a.entityType !== b.entityType
            ? a.entityType === "PERSONAL"
              ? -1
              : 1
            : a.name.localeCompare(b.name),
        );
      const body: EntityListResponse = {
        entities,
        canCreatePersonal: !entities.some((e) => e.entityType === "PERSONAL"),
      };
      res.json(body);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load entities") });
    }
  });

  app.post("/api/entities", requireAuth, async (req, res) => {
    const { uid, profile } = req.user!;
    const nowIso = new Date().toISOString();
    const parsed = validateEntityInput(req.body, nowIso, sanitizeText);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    try {
      const isOwner = await canOwnWorkspaces(profile, () => resolveOwnerPlan(uid));
      if (!isOwner) {
        return res.status(403).json({ error: "Turn on the owner experience to add a company" });
      }
      const col = db().collection(COL.entities);
      const ref = col.doc();
      const entity: Entity = {
        ...parsed.value,
        id: ref.id,
        ownerId: uid,
        createdBy: uid,
        source: "MANUAL",
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const created = await db().runTransaction(async (t) => {
        if (entity.entityType === "PERSONAL") {
          const existing = await t.get(
            col.where("ownerId", "==", uid).where("entityType", "==", "PERSONAL").limit(1),
          );
          if (!existing.empty) return false;
        }
        t.create(ref, entity);
        return true;
      });
      if (!created) {
        return res.status(409).json({ error: "You already have a personal entity" });
      }
      res.status(201).json(entity);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to create entity") });
    }
  });
}
