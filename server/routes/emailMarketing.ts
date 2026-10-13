// Email-marketing API routes. Mounted from server/routes.ts via
// `registerEmailMarketingRoutes(app, deps)` so the privilege middleware
// factory (which lives in routes.ts) is passed in instead of imported,
// avoiding a circular dep.
//
// All admin routes are gated on the `comm.email` platform privilege. The
// webhook route is public — request authenticity is established via the
// Svix HMAC signature Resend attaches to every delivery.

import { createHash, randomUUID } from "node:crypto";
import type { Express, RequestHandler, Request, Response } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { logError } from "../services/log";
import {
  COL,
  SUBCOL_EMAIL_RECIPIENTS,
  type EmailCampaign,
  type EmailCampaignAudience,
  type EmailCampaignStatus,
  type EmailCta,
  type EmailRecipient,
  type EmailTemplate,
  type MarketingAudienceFilter,
  type PlatformPrivilegeKey,
  type User,
} from "../../shared/firestore-schema";
import {
  parseMarketingFilter,
  resolveEmailAudienceByCampaign,
  resolveMarketingAudience,
} from "../services/audiences";
import { errMsg } from "../services/errMsg";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { runEmailDispatchTick } from "../jobs/emailDispatchTick";
import { ResendError, sendEmailViaResend, verifyResendWebhookSignature } from "../services/resend";
import { isRenderableUrl, renderTemplate, wrapInEmailShell } from "../services/mergeVars";
import { verifyUnsubscribeToken } from "../services/unsubscribe";

const AUDIENCES: readonly EmailCampaignAudience[] = ["all", "owners", "tenants"];
const MAX_SUBJECT_LEN = 200;
const MAX_BODY_LEN = 50_000;
const MAX_SIGNATURE_LEN = 2_000;
const MAX_FOOTER_LEN = 2_000;
const MAX_CTA_LABEL_LEN = 80;
const MAX_CTA_URL_LEN = 2_000;

export interface EmailMarketingDeps {
  requirePlatformPrivilege: (p: PlatformPrivilegeKey) => RequestHandler;
}

export function registerEmailMarketingRoutes(
  app: Express,
  { requirePlatformPrivilege }: EmailMarketingDeps,
): void {
  const gate = [requireAuth, requirePlatformPrivilege("comm.email")] as const;

  // ── Campaigns: list ───────────────────────────────────────────────────────
  app.get("/api/admin/emails", ...gate, async (req, res) => {
    const statusFilter = parseStatusFilter(req.query.status);
    try {
      let q = db()
        .collection(COL.emailCampaigns)
        .orderBy("createdAt", "desc")
        .limit(100) as FirebaseFirestore.Query;
      if (statusFilter) q = q.where("status", "==", statusFilter);
      const snap = await q.get();
      res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to list campaigns") });
    }
  });

  // ── Campaigns: get one + first page of recipients ─────────────────────────
  app.get("/api/admin/emails/:id", ...gate, async (req, res) => {
    const id = String(req.params.id);
    try {
      const [campaignSnap, recipientsSnap] = await Promise.all([
        db().collection(COL.emailCampaigns).doc(id).get(),
        db()
          .collection(COL.emailCampaigns)
          .doc(id)
          .collection(SUBCOL_EMAIL_RECIPIENTS)
          .limit(100)
          .get(),
      ]);
      if (!campaignSnap.exists) return res.status(404).json({ error: "Not found" });
      res.json({
        campaign: { id: campaignSnap.id, ...campaignSnap.data() },
        recipients: recipientsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      });
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to load campaign") });
    }
  });

  // ── Campaigns: paginated recipients ───────────────────────────────────────
  app.get("/api/admin/emails/:id/recipients", ...gate, async (req, res) => {
    const id = String(req.params.id);
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    try {
      let q = db()
        .collection(COL.emailCampaigns)
        .doc(id)
        .collection(SUBCOL_EMAIL_RECIPIENTS)
        .orderBy("email")
        .limit(limit) as FirebaseFirestore.Query;
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const nextCursor =
        docs.length === limit
          ? ((docs[docs.length - 1] as { email?: string }).email ?? null)
          : null;
      res.json({ recipients: docs, nextCursor });
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to load recipients") });
    }
  });

  // ── Campaigns: create draft ───────────────────────────────────────────────
  app.post("/api/admin/emails", ...gate, async (req, res) => {
    const parsed = parseCampaignInput(req.body);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const uid = req.user!.uid;
    const id = randomUUID();
    const now = new Date().toISOString();
    const campaign: EmailCampaign = {
      id,
      subject: parsed.subject,
      bodyText: parsed.bodyText,
      // Exactly one audience spec (parseCampaignInput guarantees this):
      // targetUserId (single user) | filter (rich segment) | audience (legacy).
      ...(parsed.targetUserId ? { targetUserId: parsed.targetUserId } : {}),
      ...(parsed.filter ? { filter: parsed.filter } : {}),
      ...(parsed.audience ? { audience: parsed.audience } : {}),
      // Optional content extras — omit empty/cleared values (Firestore rejects
      // undefined; a blank signature/footer or null cta just isn't stored).
      ...(parsed.signature ? { signature: parsed.signature } : {}),
      ...(parsed.footerText ? { footerText: parsed.footerText } : {}),
      ...(parsed.cta ? { cta: parsed.cta } : {}),
      status: "draft",
      createdAt: now,
      updatedAt: now,
      createdBy: uid,
      updatedBy: uid,
    };
    try {
      await db().collection(COL.emailCampaigns).doc(id).set(campaign);
      res.status(201).json(campaign);
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to create campaign") });
    }
  });

  // ── Campaigns: update draft ───────────────────────────────────────────────
  app.patch("/api/admin/emails/:id", ...gate, async (req, res) => {
    const id = String(req.params.id);
    const parsed = parseCampaignPatch(req.body);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    try {
      const ref = db().collection(COL.emailCampaigns).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Not found" });
      const cur = snap.data() as EmailCampaign;
      if (cur.status !== "draft") {
        return res.status(409).json({ error: "Only draft campaigns can be edited" });
      }
      const now = new Date().toISOString();
      const update: Record<string, unknown> = { updatedAt: now, updatedBy: req.user!.uid };
      const responsePatch: Partial<EmailCampaign> = { updatedAt: now, updatedBy: req.user!.uid };
      if (parsed.subject !== undefined) {
        update.subject = parsed.subject;
        responsePatch.subject = parsed.subject;
      }
      if (parsed.bodyText !== undefined) {
        update.bodyText = parsed.bodyText;
        responsePatch.bodyText = parsed.bodyText;
      }
      // Content extras: a blank string (signature/footerText) or null (cta)
      // means the admin cleared the field → delete it; otherwise store the
      // value. `undefined` means the key wasn't in the patch → leave as-is.
      if (parsed.signature !== undefined) {
        update.signature = parsed.signature ? parsed.signature : FieldValue.delete();
        responsePatch.signature = parsed.signature || undefined;
      }
      if (parsed.footerText !== undefined) {
        update.footerText = parsed.footerText ? parsed.footerText : FieldValue.delete();
        responsePatch.footerText = parsed.footerText || undefined;
      }
      if (parsed.cta !== undefined) {
        update.cta = parsed.cta ? parsed.cta : FieldValue.delete();
        responsePatch.cta = parsed.cta ?? undefined;
      }
      // When the audience selector changes, replace it wholesale: set the
      // chosen field and DELETE the other two so no stale higher-precedence
      // spec (targetUserId > filter > audience) overrides the new pick at send.
      if (
        parsed.audience !== undefined ||
        parsed.filter !== undefined ||
        parsed.targetUserId !== undefined
      ) {
        update.audience = parsed.audience ?? FieldValue.delete();
        update.filter = parsed.filter ?? FieldValue.delete();
        update.targetUserId = parsed.targetUserId ?? FieldValue.delete();
        responsePatch.audience = parsed.audience;
        responsePatch.filter = parsed.filter;
        responsePatch.targetUserId = parsed.targetUserId;
      }
      await ref.update(update);
      res.json({ ...cur, ...responsePatch });
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to update campaign") });
    }
  });

  // ── Campaigns: delete (draft + cancelled only) ────────────────────────────
  app.delete("/api/admin/emails/:id", ...gate, async (req, res) => {
    const id = String(req.params.id);
    try {
      const ref = db().collection(COL.emailCampaigns).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Not found" });
      const cur = snap.data() as EmailCampaign;
      if (cur.status !== "draft" && cur.status !== "cancelled") {
        return res.status(409).json({ error: "Only draft or cancelled campaigns can be deleted" });
      }
      await ref.delete();
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to delete campaign") });
    }
  });

  // ── Campaigns: send now ───────────────────────────────────────────────────
  app.post("/api/admin/emails/:id/send", ...gate, async (req, res) => {
    const id = String(req.params.id);
    try {
      const result = await prepareCampaignForDispatch(id, req.user!.uid, null);
      if ("error" in result) {
        return res.status(result.status).json({ error: result.error });
      }
      // Fire-and-forget: kick the dispatcher so the first batch goes out
      // immediately, instead of waiting up to a minute for the scheduler.
      // The HTTPS function may be terminated before the tick finishes for
      // larger campaigns — that's by design. Per-uid recipient idempotency
      // means the scheduled tick (timeoutSeconds: 540) safely resumes from
      // wherever the inline tick was cut off, on the next 1-minute fire.
      void runEmailDispatchTick().catch((err) => logError("email_dispatch.inline-failed", err));
      res.status(202).json(result.campaign);
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to send campaign") });
    }
  });

  // ── Campaigns: schedule ───────────────────────────────────────────────────
  app.post("/api/admin/emails/:id/schedule", ...gate, async (req, res) => {
    const id = String(req.params.id);
    const scheduledAt = typeof req.body?.scheduledAt === "string" ? req.body.scheduledAt : null;
    if (!scheduledAt) {
      return res.status(400).json({ error: "scheduledAt (ISO 8601) is required" });
    }
    const when = Date.parse(scheduledAt);
    if (!Number.isFinite(when)) {
      return res.status(400).json({ error: "scheduledAt is not a valid date" });
    }
    if (when <= Date.now()) {
      return res.status(400).json({ error: "scheduledAt must be in the future" });
    }
    try {
      const ref = db().collection(COL.emailCampaigns).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Not found" });
      const cur = snap.data() as EmailCampaign;
      if (cur.status !== "draft") {
        return res.status(409).json({ error: "Only drafts can be scheduled" });
      }
      const patch: Partial<EmailCampaign> = {
        status: "scheduled",
        scheduledAt: new Date(when).toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: req.user!.uid,
      };
      await ref.update(patch);
      res.json({ ...cur, ...patch });
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to schedule campaign") });
    }
  });

  // ── Campaigns: cancel ─────────────────────────────────────────────────────
  app.post("/api/admin/emails/:id/cancel", ...gate, async (req, res) => {
    const id = String(req.params.id);
    try {
      const ref = db().collection(COL.emailCampaigns).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Not found" });
      const cur = snap.data() as EmailCampaign;
      if (cur.status !== "scheduled" && cur.status !== "sending") {
        return res
          .status(409)
          .json({ error: "Only scheduled or in-flight campaigns can be cancelled" });
      }
      const patch: Partial<EmailCampaign> = {
        status: "cancelled",
        updatedAt: new Date().toISOString(),
        updatedBy: req.user!.uid,
      };
      await ref.update(patch);
      res.json({ ...cur, ...patch });
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to cancel campaign") });
    }
  });

  // ── Campaigns: send test ──────────────────────────────────────────────────
  app.post("/api/admin/emails/:id/test", ...gate, async (req, res) => {
    const id = String(req.params.id);
    // Per-admin cap on test sends. Each call burns one Resend credit
    // + makes an external API call; a UI loop or attacker shouldn't
    // be able to spam Resend through this. 50/hour generous for
    // real campaign QA.
    const adminUid = req.user!.uid;
    const limit = await rateLimit(`email-test:${adminUid}`, 50, 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many test sends. Try again shortly.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const to = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    if (!isLikelyEmail(to)) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    try {
      const snap = await db().collection(COL.emailCampaigns).doc(id).get();
      if (!snap.exists) return res.status(404).json({ error: "Not found" });
      const cur = snap.data() as EmailCampaign;
      const subject = `[TEST] ${cur.subject}`;
      const recipient = { userId: "test", email: to, firstName: "", lastName: "" };
      const ctx = { recipient };
      const body = renderTemplate(cur.bodyText, ctx);
      const signature = cur.signature ? renderTemplate(cur.signature, ctx) : undefined;
      const footerText = cur.footerText ? renderTemplate(cur.footerText, ctx) : undefined;
      const cta = cur.cta
        ? { label: renderTemplate(cur.cta.label, ctx), url: cur.cta.url }
        : undefined;
      const { html, text } = wrapInEmailShell({ subject, body, cta, signature, footerText });
      const result = await sendEmailViaResend({
        to,
        subject,
        html,
        text,
        tags: [
          { name: "campaign_id", value: id },
          { name: "test", value: "true" },
        ],
      });
      res.json({ ok: true, providerMessageId: result.id });
    } catch (err) {
      const status = err instanceof ResendError ? 502 : 500;
      res.status(status).json({ error: errMsg(err, "Failed to send test email") });
    }
  });

  // ── Audience size preview ─────────────────────────────────────────────────
  // Lets the campaign editor show "this will reach ~N recipients" before
  // sending. Body is a MarketingAudienceFilter; resolved on the email channel
  // (honors marketingEmails opt-out) so the count matches what would actually
  // be queued. Mirrors /api/admin/notifications/audience-count.
  app.post("/api/admin/emails/audience-count", ...gate, async (req, res) => {
    const parsed = parseMarketingFilter(req.body);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    try {
      const list = await resolveMarketingAudience(parsed, "email");
      res.json({ count: list.length });
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to compute audience") });
    }
  });

  // ── Templates: list ───────────────────────────────────────────────────────
  app.get("/api/admin/emails/templates", ...gate, async (_req, res) => {
    try {
      const snap = await db()
        .collection(COL.emailTemplates)
        .orderBy("updatedAt", "desc")
        .limit(200)
        .get();
      res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to list templates") });
    }
  });

  // ── Templates: create ─────────────────────────────────────────────────────
  app.post("/api/admin/emails/templates", ...gate, async (req, res) => {
    const parsed = parseTemplateInput(req.body);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const id = randomUUID();
    const now = new Date().toISOString();
    const template: EmailTemplate = {
      id,
      ...parsed,
      createdAt: now,
      updatedAt: now,
      createdBy: req.user!.uid,
    };
    try {
      await db().collection(COL.emailTemplates).doc(id).set(template);
      res.status(201).json(template);
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to create template") });
    }
  });

  // ── Templates: update ─────────────────────────────────────────────────────
  app.patch("/api/admin/emails/templates/:id", ...gate, async (req, res) => {
    const id = String(req.params.id);
    const parsed = parseTemplatePatch(req.body);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    try {
      const ref = db().collection(COL.emailTemplates).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Not found" });
      const patch = { ...parsed, updatedAt: new Date().toISOString() };
      await ref.update(patch);
      res.json({ ...(snap.data() as EmailTemplate), ...patch });
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to update template") });
    }
  });

  // ── Templates: delete ─────────────────────────────────────────────────────
  app.delete("/api/admin/emails/templates/:id", ...gate, async (req, res) => {
    const id = String(req.params.id);
    try {
      await db().collection(COL.emailTemplates).doc(id).delete();
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to delete template") });
    }
  });

  // ── Resend integration status ─────────────────────────────────────────────
  // Reports which Resend secrets are present at runtime so the admin Settings
  // page can show a clear "connected / partially configured" badge without
  // burning provider quota. Booleans only — never reveal the secret values.
  app.get("/api/admin/integrations/email/status", ...gate, (_req, res) => {
    const apiKey = Boolean(process.env.RESEND_API_KEY);
    const from = Boolean(process.env.RESEND_FROM);
    const webhookSecret = Boolean(process.env.RESEND_WEBHOOK_SECRET);
    const unsubscribeSecret = Boolean(process.env.UNSUBSCRIBE_SECRET);
    res.json({
      provider: "resend",
      connected: apiKey && from,
      apiKey,
      from,
      webhookSecret,
      unsubscribeSecret,
    });
  });

  // ── One-click unsubscribe (PUBLIC — token IS the auth) ────────────────────
  // RFC 8058 split: GET renders a confirmation page; POST performs the
  // unsubscribe. Without this, email-link prefetchers (Gmail/Outlook
  // SafeLinks/Mimecast) fetch every URL in a delivered message via GET
  // and would mass-unsubscribe every recipient before they ever opened
  // the email. Mail clients that implement one-click unsub POST on real
  // user intent (Gmail/Apple Mail "Unsubscribe" button).
  //
  // Also single-use: first successful POST persists
  // `usedUnsubscribeTokens/{sha256(token)}` inside a transaction; replays
  // see the doc + return success-shape but skip the marketingEmails
  // write. Without it, anyone reading the token once (inbox dump, log
  // sink, screenshot) could keep flipping marketingEmails:false even
  // after the user re-opted-in from Settings.
  const handleUnsubscribe = async (
    token: string,
  ): Promise<{ ok: true } | { ok: false; status: number; title: string; body: string }> => {
    const payload = verifyUnsubscribeToken(token);
    if (!payload) {
      return {
        ok: false,
        status: 400,
        title: "Link expired",
        body: "This unsubscribe link is invalid or expired. You can manage email preferences in Settings.",
      };
    }
    try {
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const usedRef = db().collection("usedUnsubscribeTokens").doc(tokenHash);
      const wasFirstUse = await db().runTransaction(async (t) => {
        const existing = await t.get(usedRef);
        if (existing.exists) return false;
        t.set(usedRef, {
          userId: payload.userId,
          issuedAt: payload.issuedAt,
          usedAt: Date.now(),
        });
        return true;
      });
      if (!wasFirstUse) return { ok: true };

      await db()
        .collection(COL.users)
        .doc(payload.userId)
        .set({ notificationPrefs: { marketingEmails: false } } as Partial<User>, { merge: true });
      return { ok: true };
    } catch (err) {
      logError("email.unsubscribe-write-failed", err);
      return {
        ok: false,
        status: 500,
        title: "Something went wrong",
        body: "We couldn't update your preferences right now. Please try again in a few minutes.",
      };
    }
  };

  app.get("/api/u/:token", (req, res) => {
    const token = String(req.params.token || "");
    if (!verifyUnsubscribeToken(token)) {
      return res
        .status(400)
        .type("text/html")
        .send(
          renderUnsubscribeHtml({
            title: "Link expired",
            body: "This unsubscribe link is invalid or expired. You can manage email preferences in Settings.",
          }),
        );
    }
    res.type("text/html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confirm unsubscribe · Olio</title>
<style>body{font:14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#f7f7f8;margin:0;padding:60px 20px;color:#1f1f1f;text-align:center}.card{max-width:480px;margin:0 auto;background:#fff;border:1px solid #ececec;border-radius:12px;padding:32px}.btn{display:inline-block;padding:12px 24px;background:#0f0f0f;color:#fff;border:0;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}h1{margin:0 0 12px;font-size:20px}p{color:#6b7280;line-height:1.55}</style>
</head><body><div class="card">
<h1>Confirm unsubscribe</h1>
<p>Click below to stop receiving Olio marketing emails. You can re-subscribe any time from Settings → Notifications.</p>
<form method="post" action="/api/u/${encodeURIComponent(token)}">
<button type="submit" class="btn">Unsubscribe</button>
</form>
</div></body></html>`);
  });

  app.post("/api/u/:token", async (req, res) => {
    const token = String(req.params.token || "");
    const result = await handleUnsubscribe(token);
    if (!result.ok) {
      return res
        .status(result.status)
        .type("text/html")
        .send(renderUnsubscribeHtml({ title: result.title, body: result.body }));
    }
    res.type("text/html").send(
      renderUnsubscribeHtml({
        title: "You're unsubscribed",
        body: "We won't send you any more marketing emails. You can re-subscribe any time from Settings → Notifications.",
      }),
    );
  });

  // ── Resend webhook (PUBLIC — authenticated by Svix HMAC) ──────────────────
  // Resend signs every webhook delivery using Svix. Headers carried with the
  // request: svix-id, svix-timestamp, svix-signature. Verification rejects
  // forged or replayed events; only after that do we touch Firestore.
  app.post("/api/webhooks/resend", async (req, res) => {
    // Raw body is captured into req.rawBody by the json verify hook in
    // app.ts. Svix requires the exact bytes that were signed — re-stringifying
    // req.body would invalidate the signature on payloads with insignificant
    // whitespace differences.
    const raw =
      (req as Request & { rawBody?: unknown }).rawBody instanceof Buffer
        ? (req as Request & { rawBody: Buffer }).rawBody
        : Buffer.from(JSON.stringify(req.body ?? {}));
    if (!verifyResendWebhookSignature(raw, req.headers)) {
      return res.status(401).json({ error: "Invalid signature" });
    }
    try {
      await handleResendWebhookEvent(req.body);
      res.json({ ok: true });
    } catch (err) {
      logError("email.webhook-failed", err);
      // Return 200 so Resend doesn't replay-storm us — we logged it.
      res.json({ ok: false });
    }
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function prepareCampaignForDispatch(
  campaignId: string,
  uid: string,
  _scheduledAt: string | null,
): Promise<{ status: number; error: string } | { campaign: EmailCampaign }> {
  const ref = db().collection(COL.emailCampaigns).doc(campaignId);
  const snap = await ref.get();
  if (!snap.exists) return { status: 404, error: "Not found" };
  const cur = snap.data() as EmailCampaign;
  if (cur.status !== "draft") {
    return { status: 409, error: "Only drafts can be sent" };
  }

  // Resolve via the campaign's full spec (targetUserId > filter > legacy
  // audience). Using resolveEmailAudienceByCampaign — NOT resolveAudience(
  // cur.audience ?? "all") — is what makes targeted ("Pro owners only" /
  // "Specific user") campaigns actually send to the intended cohort instead
  // of falling back to every owner + tenant.
  const audienceList = await resolveEmailAudienceByCampaign(cur);
  if (audienceList.length === 0) {
    return { status: 400, error: "Audience resolved to zero recipients" };
  }

  // Write recipients FIRST, then flip the campaign to "sending". If a
  // recipient batch fails partway, the campaign stays in "draft" and the
  // admin can retry — set() with a uid-keyed doc id is idempotent, so the
  // retry will simply re-stamp existing rows. Doing it the other way
  // (status flip before recipients) leaves a "sending" campaign with 0
  // queued docs; the next dispatcher tick would then transition it to
  // "sent" with zero sends, and /send only accepts drafts so there's no
  // recovery path.
  const recipients = ref.collection(SUBCOL_EMAIL_RECIPIENTS);
  for (let i = 0; i < audienceList.length; i += 500) {
    const slice = audienceList.slice(i, i + 500);
    const batch = db().batch();
    for (const r of slice) {
      const recipient: EmailRecipient = {
        userId: r.userId,
        email: r.email,
        status: "queued",
      };
      batch.set(recipients.doc(r.userId), recipient);
    }
    await batch.commit();
  }

  const now = new Date().toISOString();
  const campaignPatch: Partial<EmailCampaign> = {
    status: "sending",
    recipientCount: audienceList.length,
    acceptedCount: 0,
    deliveredCount: 0,
    failedCount: 0,
    openedCount: 0,
    clickedCount: 0,
    unsubscribedCount: 0,
    sentBy: uid,
    updatedAt: now,
    updatedBy: uid,
  };
  await ref.update(campaignPatch);

  return { campaign: { ...cur, ...campaignPatch } };
}

async function handleResendWebhookEvent(payload: unknown): Promise<void> {
  // Resend events wrap a `data` object containing `email_id` (uuid of the
  // sent message). See https://resend.com/docs/dashboard/webhooks/event-types.
  // We accept any of the documented `email.*` event types and bail quietly
  // on unknowns — the webhook itself returned 200 so Resend stops retrying
  // and an operator can investigate via logs.
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return;

  const event = stringOrNull(p.type) ?? "";
  const data = (p.data ?? {}) as Record<string, unknown>;
  const messageId = stringOrNull(data.email_id) ?? stringOrNull(data.id);
  if (!messageId) return;

  // Find the recipient doc across all campaigns.
  const snap = await db()
    .collectionGroup(SUBCOL_EMAIL_RECIPIENTS)
    .where("providerMessageId", "==", messageId)
    .limit(1)
    .get();
  if (snap.empty) return;
  const recipientDoc = snap.docs[0];
  const campaignRef = recipientDoc.ref.parent.parent;
  if (!campaignRef) return;

  const now = new Date().toISOString();
  const recipientPatch: Partial<EmailRecipient> = {};
  let counterField: keyof EmailCampaign | null = null;

  switch (event) {
    case "email.sent":
      recipientPatch.status = "sent";
      break;
    case "email.delivered":
      recipientPatch.status = "delivered";
      recipientPatch.deliveredAt = now;
      counterField = "deliveredCount";
      break;
    case "email.opened":
      recipientPatch.status = "opened";
      recipientPatch.openedAt = now;
      counterField = "openedCount";
      break;
    case "email.clicked":
      recipientPatch.status = "clicked";
      recipientPatch.clickedAt = now;
      counterField = "clickedCount";
      break;
    case "email.bounced":
    case "email.failed":
      recipientPatch.status = "failed";
      recipientPatch.error =
        stringOrNull((data.bounce as Record<string, unknown> | undefined)?.subType as unknown) ??
        stringOrNull(data.reason) ??
        "delivery failed";
      counterField = "failedCount";
      break;
    case "email.complained":
      // Spam complaint — treat as opt-out and stop sending to this address.
      recipientPatch.status = "unsubscribed";
      counterField = "unsubscribedCount";
      try {
        const userId = (recipientDoc.data() as EmailRecipient).userId;
        await db()
          .collection(COL.users)
          .doc(userId)
          .set({ notificationPrefs: { marketingEmails: false } } as Partial<User>, {
            merge: true,
          });
      } catch (err) {
        logError("email.complaint-write-failed", err);
      }
      break;
    case "email.delivery_delayed":
    case "email.scheduled":
      // Informational only — keep current status, just refresh updatedAt.
      break;
    default:
      return;
  }

  if (Object.keys(recipientPatch).length > 0) {
    await recipientDoc.ref.update(recipientPatch);
  }
  if (counterField) {
    await campaignRef.update({
      [counterField]: FieldValue.increment(1),
      updatedAt: now,
    });
  }
}

// ── Input parsing ───────────────────────────────────────────────────────────

interface CampaignInput {
  subject: string;
  bodyText: string;
  // Exactly one audience spec — resolution precedence is
  // targetUserId > filter > audience (see resolveEmailAudienceByCampaign).
  audience?: EmailCampaignAudience;
  filter?: MarketingAudienceFilter;
  targetUserId?: string;
  // Optional content extras. On a PATCH, an explicit empty string (signature/
  // footerText) or `null` (cta) means "clear this field" — the route handler
  // translates those to a Firestore field delete.
  signature?: string;
  footerText?: string;
  cta?: EmailCta | null;
}

// Parse the optional CTA object. Returns:
//   undefined  — key absent (leave unchanged on PATCH; omit on create)
//   null       — explicit clear (empty object / null / both fields blank)
//   EmailCta   — a valid { label, url } with an http(s) url
// Anything malformed (label without url, invalid protocol, over-length) is a
// hard error so the admin gets feedback instead of a silently dropped button.
function parseCtaInput(raw: unknown): EmailCta | null | undefined | { error: string } {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object") return { error: "cta must be an object" };
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === "string" ? o.label.trim() : "";
  const url = typeof o.url === "string" ? o.url.trim() : "";
  // Both blank → treated as "no CTA" (clear), not an error — lets the editor
  // send an empty CTA without the admin having to omit the key.
  if (!label && !url) return null;
  if (!label) return { error: "cta.label is required when a link is set" };
  if (!url) return { error: "cta.url is required when a button label is set" };
  if (label.length > MAX_CTA_LABEL_LEN)
    return { error: `cta.label exceeds ${MAX_CTA_LABEL_LEN} chars` };
  if (url.length > MAX_CTA_URL_LEN) return { error: `cta.url exceeds ${MAX_CTA_URL_LEN} chars` };
  if (!isRenderableUrl(url))
    return { error: "cta.url must be a valid http(s) link (e.g. https://…)" };
  return { label, url };
}

// Parse the optional signature / footer text (with a length cap). Returns the
// trimmed string (possibly "" to signal a clear on PATCH), or an error.
function parseOptionalText(
  raw: unknown,
  field: string,
  max: number,
): string | undefined | { error: string } {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return { error: `${field} must be a string` };
  if (raw.length > max) return { error: `${field} exceeds ${max} chars` };
  return raw.trim();
}

type AudienceSpec =
  | { audience: EmailCampaignAudience }
  | { filter: MarketingAudienceFilter }
  | { targetUserId: string };

// Parse the audience selector the editor emits — a single-user `targetUserId`,
// a rich `filter`, or the legacy `audience` enum. `partial` lets the selector
// be absent (PATCH of an unrelated field). Without this, a `filter`/
// `targetUserId` campaign 400s and the targeted-send UI is dead.
function parseAudienceSpec(
  b: Record<string, unknown>,
  partial: boolean,
): AudienceSpec | null | { error: string } {
  if (typeof b.targetUserId === "string" && b.targetUserId.trim()) {
    return { targetUserId: b.targetUserId.trim() };
  }
  if (b.filter !== undefined && b.filter !== null) {
    const filter = parseMarketingFilter(b.filter);
    if ("error" in filter) return { error: `filter.${filter.error}` };
    return { filter };
  }
  if (b.audience !== undefined) {
    if (!AUDIENCES.includes(b.audience as EmailCampaignAudience)) {
      return { error: `audience must be one of ${AUDIENCES.join(", ")}` };
    }
    return { audience: b.audience as EmailCampaignAudience };
  }
  if (partial) return null;
  return { error: "an audience, filter, or targetUserId is required" };
}

function parseCampaignInput(body: unknown): CampaignInput | { error: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { error: "Invalid body" };
  const subject = typeof b.subject === "string" ? b.subject.trim() : "";
  const bodyText = typeof b.bodyText === "string" ? b.bodyText : "";
  if (!subject) return { error: "subject is required" };
  if (subject.length > MAX_SUBJECT_LEN)
    return { error: `subject exceeds ${MAX_SUBJECT_LEN} chars` };
  if (!bodyText) return { error: "bodyText is required" };
  if (bodyText.length > MAX_BODY_LEN) return { error: `bodyText exceeds ${MAX_BODY_LEN} chars` };
  const spec = parseAudienceSpec(b, false);
  if (spec === null) return { error: "an audience, filter, or targetUserId is required" };
  if ("error" in spec) return spec;

  const extras = parseContentExtras(b);
  if ("error" in extras) return extras;

  return { subject, bodyText, ...spec, ...extras };
}

// Shared parse for the optional content extras (signature / footerText / cta),
// used by both create and patch. On success returns only the keys that were
// present in the body (so create omits absent ones and patch can distinguish
// "unchanged" from "cleared"). A blank string / null cta is preserved so the
// route can translate it into a Firestore field delete.
function parseContentExtras(
  b: Record<string, unknown>,
): { signature?: string; footerText?: string; cta?: EmailCta | null } | { error: string } {
  const out: { signature?: string; footerText?: string; cta?: EmailCta | null } = {};
  const signature = parseOptionalText(b.signature, "signature", MAX_SIGNATURE_LEN);
  if (signature !== undefined) {
    if (typeof signature === "object") return signature;
    out.signature = signature;
  }
  const footerText = parseOptionalText(b.footerText, "footerText", MAX_FOOTER_LEN);
  if (footerText !== undefined) {
    if (typeof footerText === "object") return footerText;
    out.footerText = footerText;
  }
  const cta = parseCtaInput(b.cta);
  if (cta !== undefined) {
    if (cta !== null && "error" in cta) return cta;
    out.cta = cta;
  }
  return out;
}

function parseCampaignPatch(body: unknown): Partial<CampaignInput> | { error: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { error: "Invalid body" };
  const out: Partial<CampaignInput> = {};
  if (b.subject !== undefined) {
    if (typeof b.subject !== "string") return { error: "subject must be a string" };
    const trimmed = b.subject.trim();
    if (!trimmed) return { error: "subject cannot be empty" };
    if (trimmed.length > MAX_SUBJECT_LEN)
      return { error: `subject exceeds ${MAX_SUBJECT_LEN} chars` };
    out.subject = trimmed;
  }
  if (b.bodyText !== undefined) {
    if (typeof b.bodyText !== "string") return { error: "bodyText must be a string" };
    if (b.bodyText.length > MAX_BODY_LEN)
      return { error: `bodyText exceeds ${MAX_BODY_LEN} chars` };
    out.bodyText = b.bodyText;
  }
  if (b.audience !== undefined || b.filter !== undefined || b.targetUserId !== undefined) {
    const spec = parseAudienceSpec(b, true);
    if (spec && "error" in spec) return spec;
    if (spec) Object.assign(out, spec);
  }
  const extras = parseContentExtras(b);
  if ("error" in extras) return extras;
  Object.assign(out, extras);
  if (Object.keys(out).length === 0) return { error: "Nothing to update" };
  return out;
}

interface TemplateInput {
  name: string;
  subject: string;
  body: string;
}

function parseTemplateInput(body: unknown): TemplateInput | { error: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { error: "Invalid body" };
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const subject = typeof b.subject === "string" ? b.subject.trim() : "";
  const tbody = typeof b.body === "string" ? b.body : "";
  if (!name) return { error: "name is required" };
  if (!subject) return { error: "subject is required" };
  if (!tbody) return { error: "body is required" };
  return { name, subject, body: tbody };
}

function parseTemplatePatch(body: unknown): Partial<TemplateInput> | { error: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { error: "Invalid body" };
  const out: Partial<TemplateInput> = {};
  if (typeof b.name === "string") out.name = b.name.trim();
  if (typeof b.subject === "string") out.subject = b.subject.trim();
  if (typeof b.body === "string") out.body = b.body;
  if (Object.keys(out).length === 0) return { error: "Nothing to update" };
  return out;
}

function parseStatusFilter(v: unknown): EmailCampaignStatus | null {
  const valid: EmailCampaignStatus[] = [
    "draft",
    "scheduled",
    "sending",
    "sent",
    "failed",
    "cancelled",
  ];
  if (typeof v === "string" && (valid as string[]).includes(v)) {
    return v as EmailCampaignStatus;
  }
  return null;
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "string" ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function isLikelyEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Minimal branded confirmation page rendered after one-click unsubscribe.
// Kept inline so the unsubscribe flow has no client dependency — the user
// clicks a link from their inbox and sees a clean page even if the SPA
// bundles haven't loaded yet.
function renderUnsubscribeHtml({ title, body }: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Olio</title>
<style>
  body{margin:0;background:#f7f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f1f1f;}
  .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
  .card{background:#fff;border:1px solid #ececec;border-radius:14px;padding:40px;max-width:440px;width:100%;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.04);}
  .brand{font-weight:700;letter-spacing:.5px;color:#0f0f0f;margin-bottom:24px;}
  h1{font-size:18px;margin:0 0 12px;}
  p{font-size:14px;line-height:1.55;color:#4b5563;margin:0;}
</style></head><body><div class="wrap"><div class="card">
<div class="brand">OLIO</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>
</div></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Silence unused-import false positives for types referenced only in JSDoc / casts.

type _UnusedResponse = Response;
