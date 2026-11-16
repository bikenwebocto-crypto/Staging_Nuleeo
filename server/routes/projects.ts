// Projects — owner-defined groupings of properties (e.g. "Limassol Seafront"),
// picked from the "Project (optional)" dropdown on Add asset. Scoped to the
// caller's own portfolio; properties link via Property.projectId.
import type { Express } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { requireAuth } from "../auth";
import { db } from "../firebase";
import { errMsg } from "../services/errMsg";
import { sanitizeText } from "../services/unicodeSanitize";
import { ensurePortfolio, getPortfolio } from "../services/portfolioBanking";
import { reqStr } from "../util";
import { COL, type Project } from "../../shared/firestore-schema";

const PROJECT_NAME_MAX = 120;
// Firestore batches cap at 500 writes. Leave headroom so the project delete
// below can share a batch if we ever need to fuse the two operations.
const PROPERTY_BATCH_SIZE = 400;

function projectName(raw: unknown): string {
  return typeof raw === "string" ? sanitizeText(raw.trim(), PROJECT_NAME_MAX) : "";
}

async function loadOwnedProject(uid: string, id: string) {
  if (!id) return null;
  const ref = db().collection(COL.projects).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const project = snap.data() as Project;
  if (project.ownerId !== uid) return null;
  const portfolio = await getPortfolio(uid);
  if (!portfolio || project.portfolioId !== portfolio.id) return null;
  return { ref, project, portfolio };
}

export function registerProjectRoutes(app: Express): void {
  app.get("/api/projects", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    try {
      const portfolio = await getPortfolio(uid);
      if (!portfolio) return res.json({ projects: [] });
      const snap = await db()
        .collection(COL.projects)
        .where("portfolioId", "==", portfolio.id)
        .get();
      const projects = snap.docs
        .map((d) => d.data() as Project)
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ projects });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load projects") });
    }
  });

  app.post("/api/projects", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const name = projectName((req.body ?? {}).name);
    if (!name) return res.status(400).json({ error: "name is required" });
    try {
      const portfolio = await ensurePortfolio(uid);
      const col = db().collection(COL.projects);
      const dupe = await col
        .where("portfolioId", "==", portfolio.id)
        .where("name", "==", name)
        .limit(1)
        .get();
      if (!dupe.empty) return res.status(200).json(dupe.docs[0].data() as Project);
      const ref = col.doc();
      const project: Project = {
        id: ref.id,
        ownerId: uid,
        portfolioId: portfolio.id,
        name,
        createdAt: new Date().toISOString(),
      };
      await ref.set(project);
      res.status(201).json(project);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to create project") });
    }
  });

  app.patch("/api/projects/:id", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const id = reqStr(req.params.id);
    const name = projectName((req.body ?? {}).name);
    if (!name) return res.status(400).json({ error: "name is required" });

    try {
      const loaded = await loadOwnedProject(uid, id);
      if (!loaded) return res.status(404).json({ error: "Project not found" });

      const col = db().collection(COL.projects);
      const dupe = await col
        .where("portfolioId", "==", loaded.portfolio.id)
        .where("name", "==", name)
        .get();
      if (dupe.docs.some((d) => d.id !== id))
        return res.status(409).json({ error: "A project with that name already exists" });

      const updatedAt = new Date().toISOString();
      await loaded.ref.update({ name, updatedAt });
      res.json({ ...loaded.project, name, updatedAt });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to update project") });
    }
  });

  app.delete("/api/projects/:id", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const id = reqStr(req.params.id);

    try {
      const loaded = await loadOwnedProject(uid, id);
      if (!loaded) return res.status(404).json({ error: "Project not found" });

      // Unassign first, then delete the project. If a later step fails the
      // project still exists and the operation can be retried safely; the
      // properties themselves are never touched beyond projectId.
      const properties = await db()
        .collection(COL.properties)
        .where("portfolioId", "==", loaded.portfolio.id)
        .where("projectId", "==", id)
        .get();

      for (let i = 0; i < properties.docs.length; i += PROPERTY_BATCH_SIZE) {
        const batch = db().batch();
        for (const doc of properties.docs.slice(i, i + PROPERTY_BATCH_SIZE)) {
          batch.update(doc.ref, { projectId: FieldValue.delete() });
        }
        await batch.commit();
      }

      await loaded.ref.delete();
      res.json({ deleted: true, unassigned: properties.size });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to delete project") });
    }
  });
}
