// Stripe Connect onboarding + management for owners. Six endpoints:
//
//   account-link  → create Standard account on first call, return URL
//   refresh       → re-read account state, mirror enabled flags
//   disconnect    → unlink from user doc (refused if active agreements)
//   status        → cheap read of mirrored flags (no Stripe call)
//   login-link    → owner's full Stripe Dashboard URL
//   refresh-link  → resume in-progress onboarding
//
// All gated by requireAuth; per-action rate limits live inline. The
// returnUrl/refreshUrl on every redirecting endpoint is checked
// through isSafeRedirectUrl so a forged link can't bounce the user to
// an attacker domain after Stripe-hosted onboarding.

import type { Express } from "express";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { requireFeature } from "../services/featureFlags";
import { isStripeConfigured, stripe } from "../stripe";
import { errMsg } from "../services/errMsg";
import { stripeErrMsg, isStripePlatformSetupError } from "../services/stripeErr";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { isSafeRedirectUrl } from "../services/safeRedirect";
import { mirrorConnectAccount } from "../services/connectMirror";
import {
  ensurePortfolio,
  loadPortfolioBanking,
  writePortfolioBanking,
} from "../services/portfolioBanking";
import { logError } from "../services/log";
import { COL } from "../../shared/firestore-schema";

export function registerConnectRoutes(app: Express): void {
  // Stripe Connect onboarding. We create a Standard account on first
  // call, store its id on the owner's user doc, then return an
  // AccountLink URL the client redirects to. Status is mirrored back
  // on /refresh so the UI can show "Active" without waiting for a
  // webhook.
  app.post(
    "/api/owner/stripe-connect/account-link",
    requireAuth,
    requireFeature("connectOnboarding"),
    async (req, res) => {
      const { uid, email, profile } = req.user!;
      // Each call mints a fresh accountLink via the Stripe API.
      // 20/hour per owner — onboarding usually takes a few attempts at
      // most, but a UI loop or attacker shouldn't burn Stripe quota.
      const limit = await rateLimit(`connect-link:${uid}`, 20, 60 * 60);
      if (!limit.allowed) {
        res.set("Retry-After", String(limit.retryAfterSeconds));
        return res.status(429).json({
          error: "Too many onboarding attempts. Try again shortly.",
          retryAfterSeconds: limit.retryAfterSeconds,
        });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const returnUrl = typeof body.returnUrl === "string" ? body.returnUrl : "";
      const refreshUrl = typeof body.refreshUrl === "string" ? body.refreshUrl : returnUrl;
      if (!returnUrl) {
        return res.status(400).json({ error: "returnUrl is required" });
      }
      if (!isSafeRedirectUrl(returnUrl) || !isSafeRedirectUrl(refreshUrl)) {
        return res.status(400).json({
          error: "returnUrl and refreshUrl must point at an Olio domain",
        });
      }
      if (!isStripeConfigured()) {
        return res.status(503).json({ error: "Stripe is not configured on the server" });
      }
      try {
        // Banking lives on the portfolio — resolve (creating + migrating legacy
        // banking on first touch) so we read/write the Connect account there.
        const portfolio = await ensurePortfolio(uid);
        let accountId = portfolio.connectAccountId;
        if (!accountId) {
          // Standard account: direct charges, the OWNER bears liability for
          // losses/chargebacks, and the owner gets the full Stripe Dashboard
          // — matching our Connect platform profile. Standard accounts manage
          // their own capabilities (card_payments activates during onboarding;
          // transfers isn't needed for direct charges), so we don't request
          // capabilities here. The idempotency key is versioned (v2) so it can
          // never collide with a key used to create a prior Express account
          // inside Stripe's 24h replay window.
          const account = await stripe().accounts.create(
            {
              type: "standard",
              email: email ?? profile?.email,
              metadata: { ownerUid: uid },
            },
            { idempotencyKey: `connect-account:v2:${uid}` },
          );
          accountId = account.id;
          await writePortfolioBanking(portfolio.id, { connectAccountId: accountId });
        }
        const link = await stripe().accountLinks.create({
          account: accountId,
          return_url: returnUrl,
          refresh_url: refreshUrl,
          type: "account_onboarding",
        });
        res.json({ url: link.url, accountId });
      } catch (err: unknown) {
        // Platform-side Connect setup isn't finished (e.g. the "managing
        // losses" platform-profile review). The owner can't fix this — only
        // we can, in the Stripe Dashboard — so log a loud pointer for the
        // team and show the owner a friendly, actionable message instead of
        // Stripe's raw text linking to our internal settings.
        if (isStripePlatformSetupError(err)) {
          logError("connect.platform-profile-incomplete", err, {
            hint:
              "Finish Stripe Connect platform profile (per mode: test AND live) at " +
              "https://dashboard.stripe.com/settings/connect/platform-profile",
          });
          return res.status(503).json({
            code: "platform_setup_incomplete",
            error:
              "Card payments aren't available just yet — we're finishing setup on our end. " +
              "You can accept rent via bank transfer in the meantime, or try again later.",
          });
        }
        res.status(500).json({
          error: stripeErrMsg(err, "Failed to create account link", "connect/account-link"),
        });
      }
    },
  );

  // Re-read the Connect account from Stripe and mirror
  // charges_enabled / payouts_enabled onto the owner's user doc.
  // Called after the user returns from the AccountLink flow.
  app.post(
    "/api/owner/stripe-connect/refresh",
    requireAuth,
    requireFeature("connectOnboarding"),
    async (req, res) => {
      const { uid } = req.user!;
      const limit = await rateLimit(`connect-refresh:${uid}`, 30, 60 * 60);
      if (!limit.allowed) {
        res.set("Retry-After", String(limit.retryAfterSeconds));
        return res.status(429).json({
          error: "Too many refresh attempts. Try again shortly.",
          retryAfterSeconds: limit.retryAfterSeconds,
        });
      }
      if (!isStripeConfigured()) {
        return res.status(503).json({ error: "Stripe is not configured" });
      }
      // ensurePortfolio migrates any legacy connectAccountId off the user doc, so
      // a not-yet-migrated owner still resolves their account here.
      const portfolio = await ensurePortfolio(uid);
      if (!portfolio.connectAccountId) {
        return res.status(404).json({ error: "No Stripe Connect account on file" });
      }
      try {
        const account = await stripe().accounts.retrieve(portfolio.connectAccountId);
        const patch = await mirrorConnectAccount(portfolio.id, account);
        res.json({ accountId: account.id, ...patch });
      } catch (err: unknown) {
        res.status(500).json({
          error: stripeErrMsg(err, "Failed to refresh account", "connect/refresh"),
        });
      }
    },
  );

  // Disconnect the Stripe Connect account from the owner's profile.
  // We don't delete the Stripe account itself — the owner can
  // reconnect later with a fresh AccountLink — we just unlink it
  // locally so we stop routing payouts.
  //
  // Refuses if the owner has any "active" agreements: tenants on
  // those leases expect to be able to pay rent and disconnecting
  // silently would leave them stranded with no payout destination.
  // Owner must terminate/expire the leases (or finish them) before
  // removing their payout method.
  app.post("/api/owner/stripe-connect/disconnect", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const limit = await rateLimit(`connect-disconnect:${uid}`, 20, 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many disconnect attempts. Try again shortly.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    try {
      // Resolve the caller's portfolio up front — it keys BOTH the
      // active-agreements guard and the Connect-field clear below.
      const portfolio = await ensurePortfolio(uid);
      // Phase-2 re-key: count active agreements by the STABLE portfolio id
      // (the caller always has one via ensurePortfolio above). Two equality
      // filters — single-field indexes, no composite needed.
      const activeAgreements = await db()
        .collection(COL.agreements)
        .where("portfolioId", "==", portfolio.id)
        .where("status", "==", "active")
        .count()
        .get();
      const activeCount = activeAgreements.data().count;
      if (activeCount > 0) {
        return res.status(409).json({
          error: `You can't remove your payout method while you have ${activeCount} active agreement${activeCount === 1 ? "" : "s"}. End the lease${activeCount === 1 ? "" : "s"} first.`,
          code: "active_agreements_exist",
          activeAgreements: activeCount,
        });
      }
      // Clear the Connect fields on the PORTFOLIO doc (banking lives there).
      // Written inline rather than via writePortfolioBanking so we can null the
      // account id (the PortfolioBanking type models it as an optional string).
      await db().collection(COL.portfolios).doc(portfolio.id).set(
        {
          connectAccountId: null,
          connectChargesEnabled: false,
          connectPayoutsEnabled: false,
          connectDetailsSubmitted: false,
          connectRequirementsDue: [],
          connectRequirementsPastDue: [],
          connectRequirementsPendingVerification: [],
          connectDisabledReason: null,
          connectCardPaymentsStatus: null,
          connectTransfersStatus: null,
          connectLastSyncedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: errMsg(err, "Failed to disconnect") });
    }
  });

  // Rich-state read for the frontend banking page. Returns just the
  // Connect-related fields from the live profile — cheap (no Stripe
  // API call), used to render the multi-state status UI.
  app.get("/api/owner/stripe-connect/status", requireAuth, async (req, res) => {
    // Read banking from the portfolio (falls back to legacy user fields for a
    // not-yet-migrated owner). No Stripe call — just the mirrored flags.
    const b = await loadPortfolioBanking(req.user!.uid);
    res.json({
      accountId: b.connectAccountId ?? null,
      detailsSubmitted: !!b.connectDetailsSubmitted,
      chargesEnabled: !!b.connectChargesEnabled,
      payoutsEnabled: !!b.connectPayoutsEnabled,
      requirementsDue: b.connectRequirementsDue ?? [],
      requirementsPastDue: b.connectRequirementsPastDue ?? [],
      requirementsPendingVerification: b.connectRequirementsPendingVerification ?? [],
      disabledReason: b.connectDisabledReason ?? null,
      cardPaymentsStatus: b.connectCardPaymentsStatus ?? null,
      transfersStatus: b.connectTransfersStatus ?? null,
      lastSyncedAt: b.connectLastSyncedAt ?? null,
    });
  });

  // "Manage on Stripe". Owners have FULL Stripe Dashboard accounts
  // (Standard), so — unlike Express — there is no one-time login link to
  // mint (`accounts.createLoginLink` is Express-only and errors on full
  // accounts). The owner signs in to their own account at
  // dashboard.stripe.com, where they manage their bank account, balance,
  // payouts and details. We return the plain dashboard URL so the existing
  // client redirect keeps working unchanged.
  app.post("/api/owner/stripe-connect/login-link", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const limit = await rateLimit(`connect-login:${uid}`, 20, 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many login-link requests. Try again shortly.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const b = await loadPortfolioBanking(uid);
    if (!b.connectAccountId) {
      return res.status(404).json({ error: "No Stripe Connect account on file" });
    }
    res.json({ url: "https://dashboard.stripe.com/" });
  });

  // Handles the `?stripe=refresh` redirect from Stripe-hosted
  // onboarding. Mints a fresh AccountLink for the owner's existing
  // Connect account so they can resume where they left off. Different
  // from /account-link in that it never tries to create the account
  // (always reuses).
  app.post("/api/owner/stripe-connect/refresh-link", requireAuth, async (req, res) => {
    const { uid } = req.user!;
    const limit = await rateLimit(`connect-refresh-link:${uid}`, 20, 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many onboarding-link requests. Try again shortly.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const returnUrl = typeof body.returnUrl === "string" ? body.returnUrl : "";
    const refreshUrl = typeof body.refreshUrl === "string" ? body.refreshUrl : returnUrl;
    if (!returnUrl) {
      return res.status(400).json({ error: "returnUrl is required" });
    }
    if (!isSafeRedirectUrl(returnUrl) || !isSafeRedirectUrl(refreshUrl)) {
      return res.status(400).json({
        error: "returnUrl and refreshUrl must point at an Olio domain",
      });
    }
    if (!isStripeConfigured()) {
      return res.status(503).json({ error: "Stripe is not configured" });
    }
    const b = await loadPortfolioBanking(uid);
    if (!b.connectAccountId) {
      return res.status(404).json({ error: "No Stripe Connect account on file" });
    }
    try {
      const link = await stripe().accountLinks.create({
        account: b.connectAccountId,
        return_url: returnUrl,
        refresh_url: refreshUrl,
        type: "account_onboarding",
      });
      res.json({ url: link.url });
    } catch (err: unknown) {
      res.status(500).json({
        error: stripeErrMsg(err, "Failed to mint refresh link", "connect/refresh-link"),
      });
    }
  });
}
