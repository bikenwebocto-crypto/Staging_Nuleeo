// Read-only catalog endpoints surfaced on the owner shell: the Network
// page's partner directory and the marketplace listings feed.
//
// Both are admin-curated content — writes live on /api/admin/*. Partners
// are plan-gated; marketplace is open to any signed-in user (the curation
// IS the gate).

import type { Express, RequestHandler } from "express";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import {
  COL,
  type MarketplaceListing,
  type OwnerPlanPrivilegeKey,
  type Partner,
} from "../../shared/firestore-schema";

export interface DiscoveryDeps {
  requireActivePortfolioPlanPrivilege: (p: OwnerPlanPrivilegeKey) => RequestHandler;
}

export function registerDiscoveryRoutes(
  app: Express,
  { requireActivePortfolioPlanPrivilege }: DiscoveryDeps,
): void {
  // Read-only list of active partners (brokers, contractors, legal,
  // etc.) surfaced on the owner-facing Network page. Gated by the
  // owner-plan privilege `network.access` on the ACTIVE PORTFOLIO's
  // plan; default matrix grants every plan (basic/advance/pro), so
  // today this is no-op insurance. If an admin narrows the matrix
  // later, the server enforces it without further work. Create/update/
  // delete is admin-only and lives under /api/admin/partners.
  app.get(
    "/api/partners",
    requireAuth,
    requireActivePortfolioPlanPrivilege("network.access"),
    async (_req, res) => {
      try {
        const snap = await db().collection(COL.partners).where("status", "==", "active").get();
        const partners = snap.docs.map((d) => d.data() as Partner);
        // Stable order: name asc; Firestore can't combine
        // where('status') with orderBy('name') without a composite
        // index, so sort in memory.
        partners.sort((a, b) => a.name.localeCompare(b.name));
        res.json(partners);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load partners") });
      }
    },
  );

  // Read-only feed of active marketplace listings. Curated by admins
  // via /api/admin/marketplace.
  app.get("/api/marketplace", requireAuth, async (_req, res) => {
    try {
      const snap = await db()
        .collection(COL.marketplaceListings)
        .where("status", "==", "active")
        .get();
      const listings = snap.docs.map((d) => d.data() as MarketplaceListing);
      listings.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      res.json(listings);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load marketplace") });
    }
  });
}
