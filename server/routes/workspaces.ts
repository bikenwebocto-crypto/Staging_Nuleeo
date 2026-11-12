// Workspace endpoints: list, create, open (select).
//
//   GET  /api/workspaces           → WorkspaceListResponse
//   POST /api/workspaces           { type, name? } → 201 WorkspaceListEntry
//   POST /api/workspaces/:id/open  → 204 (records User.lastWorkspaceId)
//
// Creating a workspace requires the owner experience (same rule as the
// client's isOwnerExperience). Listing/opening is open to any signed-in user;
// non-owners only ever see workspaces shared with them via portfolio access.
// The dashboard DATA behind a real-estate workspace is still authorized per
// request by ownerScope — these routes only manage the container.

import type { Express } from "express";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { sanitizeText } from "../services/unicodeSanitize";
import { resolveOwnerPlan } from "../services/commission";
import {
  createWorkspace,
  listWorkspaces,
  recordWorkspaceOpened,
  resolveWorkspaceAccess,
} from "../services/workspaces";
import { WORKSPACE_NAME_MAX } from "../../shared/firestore-schema";
import {
  canOwnWorkspaces,
  defaultWorkspaceName,
  isWorkspaceType,
  validateWorkspaceName,
} from "../../shared/workspaces";

export function registerWorkspaceRoutes(app: Express): void {
  app.get("/api/workspaces", requireAuth, async (req, res) => {
    const { uid, profile } = req.user!;
    try {
      const isOwner = await canOwnWorkspaces(profile, () => resolveOwnerPlan(uid));
      res.json(await listWorkspaces(uid, profile, isOwner));
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load workspaces") });
    }
  });

  app.post("/api/workspaces", requireAuth, async (req, res) => {
    const { uid, profile } = req.user!;
    const body = (req.body ?? {}) as { type?: unknown; name?: unknown };
    if (!isWorkspaceType(body.type)) {
      return res.status(400).json({ error: "type must be 'real_estate' or 'business'" });
    }
    const type = body.type;
    // Sanitize with a little headroom so an over-long name is REJECTED with a
    // clear message instead of silently truncated.
    const raw = typeof body.name === "string" ? body.name : "";
    const name =
      sanitizeText(raw, WORKSPACE_NAME_MAX + 1).trim() ||
      defaultWorkspaceName(type, profile?.firstName);
    const nameError = validateWorkspaceName(name);
    if (nameError) return res.status(400).json({ error: nameError });
    try {
      const isOwner = await canOwnWorkspaces(profile, () => resolveOwnerPlan(uid));
      if (!isOwner) {
        return res
          .status(403)
          .json({ error: "Turn on the owner experience to create a workspace" });
      }
      const result = await createWorkspace(uid, profile, type, name);
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      res.status(201).json(result.entry);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to create workspace") });
    }
  });

  app.post("/api/workspaces/:id/open", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const id = String(req.params.id ?? "");
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) {
      return res.status(404).json({ error: "Workspace not found" });
    }
    try {
      const access = await resolveWorkspaceAccess(uid, id);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      await recordWorkspaceOpened(uid, id);
      res.status(204).end();
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to open workspace") });
    }
  });
}
