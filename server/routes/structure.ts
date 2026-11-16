// Owner "Structure" page: ownership hierarchy Owner(entity) → Property → Unit → Tenant.
//
//   GET /api/owner/structure → StructureResponse (shared/structure.ts)
//
// Scoped like every owner read: resolveOwnerScope + authorizePortfolioRead.
// Properties/agreements/tenants/projects are keyed by the portfolio id;
// entities belong to the portfolio's owner (ownerId).

import type { Express } from "express";
import { requireAuth } from "../auth";
import { db } from "../firebase";
import { errMsg } from "../services/errMsg";
import { authorizePortfolioRead, resolveOwnerScope } from "../services/ownerScope";
import {
  COL,
  type Agreement,
  type Entity,
  type Project,
  type Property,
  type Tenant,
  type User,
} from "../../shared/firestore-schema";
import { buildStructure, type StructureResponse } from "../../shared/structure";

const EMPTY: StructureResponse = buildStructure({
  properties: [],
  entities: [],
  agreements: [],
  tenants: [],
  projects: [],
});

export function registerStructureRoutes(app: Express): void {
  app.get("/api/owner/structure", requireAuth, async (req, res) => {
    const scope = await resolveOwnerScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const authz = await authorizePortfolioRead(req.user!.uid, scope, "property.view");
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    const { ownerId, portfolioId } = scope;
    try {
      if (!portfolioId) return res.json(EMPTY);
      const byPortfolio = (col: string) =>
        db().collection(col).where("portfolioId", "==", portfolioId).get();
      const [propSnap, agrSnap, tenSnap, projSnap, entSnap] = await Promise.all([
        byPortfolio(COL.properties),
        byPortfolio(COL.agreements),
        byPortfolio(COL.tenants),
        byPortfolio(COL.projects),
        db().collection(COL.entities).where("ownerId", "==", ownerId).get(),
      ]);
      const tenants = tenSnap.docs.map((d) => ({ ...(d.data() as Tenant), id: d.id }));

      // Tenant.name is the invite email until sign-up — prefer the linked
      // User's real name (same rule as GET /api/owner/agreements).
      const userIds = Array.from(
        new Set(tenants.map((t) => t.userId).filter((x): x is string => !!x)),
      );
      const userDocs = userIds.length
        ? await db().getAll(...userIds.map((id) => db().collection(COL.users).doc(id)))
        : [];
      const names = new Map<string, string>();
      userDocs.forEach((s) => {
        const u = s.data() as User | undefined;
        const n = u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : "";
        if (n) names.set(s.id, n);
      });

      const body = buildStructure({
        properties: propSnap.docs.map((d) => ({ ...(d.data() as Property), id: d.id })),
        agreements: agrSnap.docs.map((d) => ({ ...(d.data() as Agreement), id: d.id })),
        tenants: tenants.map((t) => ({ ...t, name: (t.userId && names.get(t.userId)) || t.name })),
        projects: projSnap.docs.map((d) => ({ ...(d.data() as Project), id: d.id })),
        entities: entSnap.docs
          .map((d) => ({ ...(d.data() as Entity), id: d.id }))
          .filter((e) => !e.archivedAt),
      });
      res.json(body);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load structure") });
    }
  });
}
