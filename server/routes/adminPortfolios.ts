// Superadmin portfolio operations. Today: owner-transfer — reassign an entire
// portfolio (properties, leases, tenants, documents, banking shell) to a new
// owner. The heavy lifting (guarded, ordered, idempotent, resumable) lives in
// server/services/portfolioTransfer.ts; this is the thin authenticated surface.
//
// SUPERADMIN-ONLY: a portfolio transfer moves money-routing + a whole business
// between accounts — far higher stakes than the per-property transfer owners
// can self-serve. Gated to superadmin until an owner-initiated invite/accept
// flow is designed.

import type { Express, RequestHandler } from "express";
import { requireAuth } from "../auth";
import { reqStr } from "../util";
import { errMsg } from "../services/errMsg";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import {
  transferPortfolio,
  PortfolioTransferError,
  type TransferError,
} from "../services/portfolioTransfer";
import type { Role } from "../../shared/firestore-schema";

export interface AdminPortfoliosDeps {
  requireRole: (...roles: Role[]) => RequestHandler;
}

// Map the service's typed error to an HTTP status + client-facing message.
function statusFor(detail: TransferError): { status: number; error: string; extra?: object } {
  switch (detail.code) {
    case "portfolio_not_found":
      return { status: 404, error: "Portfolio not found." };
    case "recipient_not_found":
      return {
        status: 404,
        error: "No Olio user found for that recipient. Ask them to sign up first.",
      };
    case "already_owner":
      return { status: 400, error: "That user already owns this portfolio." };
    case "recipient_has_portfolio":
      return {
        status: 409,
        error:
          "The recipient already owns a portfolio. Merging portfolios isn't supported yet — transfer to a user who isn't already an owner.",
      };
    case "recipient_is_tenant":
      return {
        status: 409,
        error: "The recipient is a tenant in this portfolio. They can't also become its owner.",
      };
    case "recipient_over_cap":
      return {
        status: 402,
        error:
          "The recipient's plan can't hold this portfolio's properties. They need to upgrade first.",
        extra: { cap: detail.cap, used: detail.used, incoming: detail.incoming },
      };
    case "in_progress_elsewhere":
      return {
        status: 409,
        error: "A transfer of this portfolio to a different recipient is already in progress.",
      };
  }
}

export function registerAdminPortfoliosRoutes(
  app: Express,
  { requireRole }: AdminPortfoliosDeps,
): void {
  // POST /api/admin/portfolios/:id/transfer  body: { newOwnerId }
  app.post(
    "/api/admin/portfolios/:id/transfer",
    requireAuth,
    requireRole("superadmin"),
    async (req, res) => {
      const actorUid = req.user!.uid;
      // A transfer is heavy + irreversible-ish; a tiny per-actor cap stops a
      // runaway script from churning portfolios. 30/hour is far above any real
      // admin cadence.
      const limit = await rateLimit(`portfolio-transfer:${actorUid}`, 30, 60 * 60);
      if (!limit.allowed) {
        res.set("Retry-After", String(limit.retryAfterSeconds));
        return res.status(429).json({ error: "Too many transfers. Try again shortly." });
      }

      const portfolioId = reqStr(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const newOwnerId = typeof body.newOwnerId === "string" ? body.newOwnerId.trim() : "";
      if (!newOwnerId) return res.status(400).json({ error: "newOwnerId is required" });

      try {
        const result = await transferPortfolio({
          portfolioId,
          newOwnerId,
          actorUid,
          nowIso: new Date().toISOString(),
        });
        res.json(result);
      } catch (err: unknown) {
        if (err instanceof PortfolioTransferError) {
          const { status, error, extra } = statusFor(err.detail);
          return res.status(status).json({ error, code: err.detail.code, ...extra });
        }
        res.status(500).json({ error: errMsg(err, "Failed to transfer portfolio") });
      }
    },
  );
}
