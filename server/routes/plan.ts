// Two owner-facing plan reads. Both are portfolio-scoped via
// resolveOwnerScope so a legacy/legal/financial contact sees the
// owner's cap / fee tier, not their own. Self always passes (treated
// as ownerId === uid).
//
// INTENTIONAL: unlike the other cross-portfolio reads (finance/portfolio/
// briefing), these deliberately do NOT pair resolveOwnerScope with
// authorizePortfolioRead. resolveOwnerScope already proves an ACTIVE grant on
// the portfolio; from there ANY granted contact (legal included) may see this
// low-sensitivity plan metadata — the tier name, unit cap, and rent-commission
// percentage — which is needed to render the Banking disclosure and add-unit cap
// for every contact role. There is no money figure, ledger entry, or tenant PII
// here, so the per-role matrix isn't applied on purpose. Do NOT "fix" this by
// adding authorizePortfolioRead — it would hide the cap/fee tier from legal-slot
// contacts who are meant to see it.

import type { Express } from "express";
import { requireAuth } from "../auth";
import { requireFeature } from "../services/featureFlags";
import { errMsg } from "../services/errMsg";
import { resolveOwnerScope } from "../services/ownerScope";
import { resolveUnitCap } from "../services/planLimits";
import { resolveOwnerPlan } from "../services/commission";
import { loadPlatformFeesConfig } from "../services/configCache";
import { getPlanSource, upgradePaidToPro } from "../services/planBilling";
import { isStripeConfigured } from "../stripe";

export function registerPlanRoutes(app: Express): void {
  // Returns { plan, cap, used } for the resolved portfolio. cap is null
  // for unlimited plans (or when `units.unlimited` is granted).
  app.get("/api/owner/unit-cap", requireAuth, async (req, res) => {
    const scope = await resolveOwnerScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    try {
      const info = await resolveUnitCap(scope.ownerId);
      res.json(info);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load unit cap") });
    }
  });

  // Portfolio-scoped commission lookup — returns the rent-commission
  // row for the ACTIVE portfolio's plan so the Banking disclosure
  // matches what payouts will actually use. Honors `?ownerId=`.
  app.get("/api/owner/platform-fee-tier", requireAuth, async (req, res) => {
    const scope = await resolveOwnerScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    try {
      const [plan, config] = await Promise.all([
        resolveOwnerPlan(scope.ownerId),
        loadPlatformFeesConfig(),
      ]);
      const tier = config.rentCommission[plan] ?? {
        percent: 0,
        minAmountCents: 0,
      };
      res.json({ plan, tier });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load platform fee tier") });
    }
  });

  // Where the caller's current plan came from: "paid" (real Stripe sub),
  // "gifted" (admin comp grant, no sub) or "none". Drives the upgrade UI —
  // a paid source upgrades by swapping the subscription, a gifted/none source
  // starts a fresh checkout. SELF-ONLY: reads the authenticated user's OWN
  // billing (req.user.uid), so a granted contact can never see/touch the
  // portfolio owner's subscription through here.
  app.get("/api/owner/plan/source", requireAuth, async (req, res) => {
    try {
      const info = await getPlanSource(req.user!.uid);
      res.json(info);
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to load plan source") });
    }
  });

  // Paid Growth → Pro upgrade: discounted first cycle (€200) + a fresh
  // 12-month Pro term, then the normal Pro price at renewal. SELF-ONLY and
  // idempotent — acts only on the caller's own Stripe subscription. Gifted /
  // basic owners are routed to Checkout by the client and refused here (409),
  // since there's no existing subscription to swap.
  app.post(
    "/api/owner/plan/upgrade",
    requireAuth,
    requireFeature("planUpgrades"),
    async (req, res) => {
      if (!isStripeConfigured()) {
        return res.status(503).json({ error: "Billing is not configured" });
      }
      const body = (req.body ?? {}) as { to?: unknown };
      if (body.to !== "pro") {
        return res.status(400).json({ error: "Unsupported upgrade target" });
      }
      try {
        const result = await upgradePaidToPro(req.user!.uid);
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        res.json({ ok: true, renewsAt: result.renewsAt });
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to upgrade plan") });
      }
    },
  );
}
