// Two lead-style submission endpoints — both write to the admin queue
// at /admin/* via separate collections. Bundled here because they share
// the same shape: authenticated user POSTs a form, server validates +
// rate-limits + writes one row.

import type { Express } from "express";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import {
  COL,
  SUGGESTION_PROPERTY_TYPES,
  type ExpertApplication,
  type MarketplaceLead,
  type MarketplaceListing,
  type PortfolioSize,
  type SuggestionPropertyType,
  type SuggestionRequest,
} from "../../shared/firestore-schema";

// Runtime validation array for the portfolioSize union type. Inlined
// here because the original lived in routes.ts (server-only enum).
const PORTFOLIO_SIZES: PortfolioSize[] = ["1-2", "3-5", "5-10", "10+"];

export function registerExpertRoutes(app: Express): void {
  // Submit a request for a human Account Manager from the Expert page.
  app.post("/api/expert/apply", requireAuth, async (req, res) => {
    const { uid, email, profile } = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Per-user daily cap. Application is a one-shot from the user's
    // perspective; allow 3/day to cover typo+retry without letting a
    // single account spam the admin queue with thousands of rows.
    const limit = await rateLimit(`expert-apply:${uid}`, 3, 24 * 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many applications today. Try again tomorrow.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
    // Cap message at 4kB so an attacker can't pile up giant blobs in
    // Firestore. Generous: ~600 words of plain text.
    const message = rawMessage.slice(0, 4000);
    const portfolioSize = body.portfolioSize as PortfolioSize | undefined;
    const services = Array.isArray(body.services)
      ? body.services.filter((s): s is string => typeof s === "string").slice(0, 20)
      : [];

    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }
    if (!portfolioSize || !PORTFOLIO_SIZES.includes(portfolioSize)) {
      return res.status(400).json({ error: "portfolioSize is invalid" });
    }

    const ref = db().collection(COL.expertApplications).doc();
    const now = new Date().toISOString();
    const application: ExpertApplication = {
      id: ref.id,
      userId: uid,
      email: profile?.email ?? email ?? "",
      message,
      portfolioSize,
      services,
      status: "new",
      createdAt: now,
    };
    await ref.set(application);
    res.status(201).json(application);
  });

  // Owner submits "Find me a property" from AddPropertyDrawer. Persisted
  // in the suggestionRequests collection; the platform team picks it up
  // from the admin queue at /admin/investment-leads.
  app.post("/api/owner/suggestion-request", requireAuth, async (req, res) => {
    const { uid, email, profile } = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Per-user daily cap. A power user might submit several leads for
    // different cities; 10 covers that without letting one account
    // flood the admin queue.
    const limit = await rateLimit(`suggestion-request:${uid}`, 10, 24 * 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many suggestion requests today. Try again tomorrow.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const location = typeof body.location === "string" ? body.location.trim().slice(0, 200) : "";
    const propertyTypeRaw = typeof body.propertyType === "string" ? body.propertyType : "";
    const propertyType = (SUGGESTION_PROPERTY_TYPES as readonly string[]).includes(propertyTypeRaw)
      ? (propertyTypeRaw as SuggestionPropertyType)
      : null;

    // Budget is optional but, when provided, must be a positive number.
    // Accept either a number or a string of digits (the client formats
    // with thousand separators for display only).
    let budget: number | null = null;
    if (typeof body.budget === "number" && Number.isFinite(body.budget)) {
      budget = Math.max(0, Math.floor(body.budget));
    } else if (typeof body.budget === "string") {
      const digits = body.budget.replace(/\D/g, "");
      if (digits) budget = Number(digits);
    }

    if (!location) return res.status(400).json({ error: "location is required" });
    if (!propertyType) return res.status(400).json({ error: "propertyType is invalid" });

    const ref = db().collection(COL.suggestionRequests).doc();
    const now = new Date().toISOString();
    const userName = `${profile?.firstName ?? ""} ${profile?.lastName ?? ""}`.trim();
    const lead: SuggestionRequest = {
      id: ref.id,
      userId: uid,
      userEmail: profile?.email ?? email ?? "",
      userName,
      location,
      budget,
      propertyType,
      status: "new",
      createdAt: now,
    };
    await ref.set(lead);

    res.status(201).json(lead);
  });

  // Owner clicks "I'm interested" on a specific marketplace listing. The
  // listing fields (title/price/location) are snapshotted into the lead so
  // the admin queue remains readable if the listing is later edited or
  // withdrawn. Distinct queue from suggestionRequests (open-ended search).
  app.post("/api/owner/marketplace-leads", requireAuth, async (req, res) => {
    const { uid, email, profile } = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const limit = await rateLimit(`marketplace-lead:${uid}`, 20, 24 * 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many interest submissions today. Try again tomorrow.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const listingId = typeof body.listingId === "string" ? body.listingId.trim() : "";
    if (!listingId) {
      return res.status(400).json({ error: "listingId is required" });
    }

    const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
    const message = rawMessage.slice(0, 4000);

    // Read the listing server-side so the snapshot can't be spoofed by a
    // client sending a different title/price.
    const listingSnap = await db().collection(COL.marketplaceListings).doc(listingId).get();
    if (!listingSnap.exists) {
      return res.status(404).json({ error: "Listing not found" });
    }
    const listing = listingSnap.data() as MarketplaceListing;

    const ref = db().collection(COL.marketplaceLeads).doc();
    const now = new Date().toISOString();
    const userName = `${profile?.firstName ?? ""} ${profile?.lastName ?? ""}`.trim();
    const lead: MarketplaceLead = {
      id: ref.id,
      listingId,
      listingTitle: listing.title,
      listingPrice: listing.price,
      listingLocation: listing.location,
      userId: uid,
      userEmail: profile?.email ?? email ?? "",
      userName,
      ...(message ? { message } : {}),
      status: "new",
      createdAt: now,
    };
    await ref.set(lead);

    res.status(201).json(lead);
  });
}
