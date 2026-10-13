// Notification-marketing API routes. Mounted from server/routes.ts via
// `registerNotificationRoutes(app, deps)` so the privilege middleware factory
// (which lives in routes.ts) is passed in instead of imported, avoiding a
// circular dep.
//
// All routes are gated on the `comm.email` platform privilege — same gate as
// /admin/email-marketing, since both live in the Marketing surface.
//
// Targeting: pushes only ever go to users with the `owner` or `tenant` role.
// Admin / employee / superadmin accounts are excluded server-side regardless
// of what the caller asks for.

import type { Express, RequestHandler } from "express";
import { auth, db } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { PushError, sendPush } from "../services/push";
import {
  parseMarketingFilter,
  resolvePushAudience,
  type PushAudienceFilter,
} from "../services/audiences";
import { COL, type PlatformPrivilegeKey, type User } from "../../shared/firestore-schema";

const MAX_TITLE_LEN = 200;
const MAX_MESSAGE_LEN = 2000;
const MAX_BROADCAST = 1000; // hard cap to keep one click from blasting the world

export interface NotificationDeps {
  requirePlatformPrivilege: (p: PlatformPrivilegeKey) => RequestHandler;
}

interface SendInput {
  audience: { kind: "filter"; filter: PushAudienceFilter } | { kind: "user"; userId: string };
  title: string;
  message: string;
  url?: string;
}

export function registerNotificationRoutes(
  app: Express,
  { requirePlatformPrivilege }: NotificationDeps,
): void {
  const gate = [requireAuth, requirePlatformPrivilege("comm.email")] as const;

  // ── Send broadcast push ────────────────────────────────────────────────────
  // Resolves the requested audience server-side, then fans out via OneSignal
  // one recipient at a time. We use per-user `external_id` targeting (not
  // OneSignal segments) so admin-only roles can never slip into the audience
  // even if a segment was misconfigured.
  app.post("/api/admin/notifications/send", ...gate, async (req, res) => {
    // Per-admin cap on broadcast sends. Each call fan-outs up to
    // MAX_BROADCAST OneSignal API calls — a UI loop or compromised
    // admin shouldn't be able to drain push credits or spam every
    // user repeatedly. 20/hour is well above any legit broadcast
    // workflow but caps the runaway case.
    const adminUid = req.user!.uid;
    const limit = await rateLimit(`broadcast:${adminUid}`, 20, 60 * 60);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many broadcasts. Try again shortly.",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const parsed = parseSendInput(req.body);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });

    try {
      const targets = await resolveTargets(parsed);
      if (targets.length === 0) {
        return res.status(400).json({ error: "Audience resolved to zero recipients" });
      }
      if (targets.length > MAX_BROADCAST) {
        return res.status(400).json({
          error: `Audience of ${targets.length} exceeds the per-send cap of ${MAX_BROADCAST}. Narrow the filter.`,
        });
      }

      let delivered = 0;
      let attempted = 0;
      const failures: Array<{ userId: string; email: string; error: string }> = [];

      for (const t of targets) {
        attempted += 1;
        try {
          const result = await sendPush({
            externalUserId: t.userId,
            title: parsed.title,
            message: parsed.message,
            url: parsed.url,
          });
          if (result.recipients > 0) delivered += 1;
        } catch (err) {
          failures.push({
            userId: t.userId,
            email: t.email,
            error: err instanceof Error ? err.message : "Push failed",
          });
        }
      }

      res.json({
        ok: true,
        attempted,
        // delivered = OneSignal reported ≥1 active subscription. The gap
        // between attempted and delivered is mostly users who never granted
        // browser permission — the admin sees that in the response.
        delivered,
        failed: failures.length,
        failures: failures.slice(0, 20),
      });
    } catch (err) {
      const status = err instanceof PushError ? 502 : 500;
      res.status(status).json({ error: errMsg(err, "Failed to send notification") });
    }
  });

  // ── Send password-reset push ───────────────────────────────────────────────
  // Mints a Firebase Auth password-reset action link via the Admin SDK and
  // pushes it to a specific user. The link target is governed by the same
  // Firebase Console "Customize action URL" setting that the email reset
  // uses, so the recipient lands on the branded /auth/action page.
  app.post("/api/admin/notifications/password-reset", ...gate, async (req, res) => {
    // Each call burns one Firebase generatePasswordResetLink (subject
    // to Firebase Auth quota) + one OneSignal push. 50/h per admin
    // bounds the runaway case while leaving plenty of headroom for
    // legit support workflow.
    const adminUid = req.user!.uid;
    const resetLimit = await rateLimit(`reset-push:${adminUid}`, 50, 60 * 60);
    if (!resetLimit.allowed) {
      res.set("Retry-After", String(resetLimit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many password-reset pushes. Try again shortly.",
        retryAfterSeconds: resetLimit.retryAfterSeconds,
      });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const emailIn = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!userId && !emailIn) {
      return res.status(400).json({ error: "userId or email is required" });
    }
    try {
      const authUser = userId ? await auth().getUser(userId) : await auth().getUserByEmail(emailIn);
      if (!authUser.email) {
        return res.status(400).json({ error: "Target user has no email on file" });
      }
      const continueUrl =
        process.env.PUBLIC_APP_URL?.replace(/\/$/, "") ?? "https://app.oliowallet.com";
      const link = await auth().generatePasswordResetLink(authUser.email, {
        url: `${continueUrl}/login`,
        handleCodeInApp: false,
      });

      const result = await sendPush({
        externalUserId: authUser.uid,
        title: "Reset your Olio password",
        message: "Tap to choose a new password for your account.",
        url: link,
      });

      res.json({
        ok: true,
        notificationId: result.id,
        recipients: result.recipients,
        ...(result.recipients === 0
          ? {
              warning:
                "OneSignal accepted the request but the user has 0 active push subscriptions. Ask them to open app.oliowallet.com and allow notifications first.",
            }
          : {}),
      });
    } catch (err: any) {
      if (err?.code === "auth/user-not-found") {
        return res.status(404).json({ error: "No Olio account matches that user" });
      }
      const status = err instanceof PushError ? 502 : 500;
      res.status(status).json({ error: errMsg(err, "Failed to send password-reset push") });
    }
  });

  // ── Preview audience size ──────────────────────────────────────────────────
  // Lets the UI show "this will reach ~N users" before the admin commits.
  app.post("/api/admin/notifications/audience-count", ...gate, async (req, res) => {
    const parsed = parseMarketingFilter(req.body);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    try {
      const list = await resolvePushAudience(parsed);
      res.json({ count: list.length });
    } catch (err) {
      res.status(500).json({ error: errMsg(err, "Failed to compute audience") });
    }
  });
}

async function resolveTargets(input: SendInput): Promise<Array<{ userId: string; email: string }>> {
  const aud = input.audience;
  if (aud.kind === "user") {
    // Single-user send: resolve the one recipient directly instead of scanning
    // the whole users collection. Still confirm they're an owner/tenant with an
    // email and haven't opted out of marketing push — the password-reset
    // endpoint is the only path that may push to a staff account, and it
    // doesn't go through this resolver.
    const snap = await db().collection(COL.users).doc(aud.userId).get();
    if (!snap.exists) return [];
    const u = snap.data() as User;
    const isOwner = u.roles?.includes("owner") ?? false;
    const isTenant = u.roles?.includes("tenant") ?? false;
    if (!u.email || (!isOwner && !isTenant)) return [];
    if (u.notificationPrefs?.pushEnabled === false || u.notificationPrefs?.marketingPush === false)
      return [];
    return [{ userId: u.id, email: u.email }];
  }
  const list = await resolvePushAudience(aud.filter);
  return list.map((u) => ({ userId: u.userId, email: u.email }));
}

// ── Input parsing ───────────────────────────────────────────────────────────
// The audience-filter parsing/validation lives in services/audiences.ts
// (`parseMarketingFilter`) so the push and email marketing surfaces validate
// identically and can't drift.

function parseSendInput(raw: unknown): SendInput | { error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const message = typeof b.message === "string" ? b.message.trim() : "";
  const url = typeof b.url === "string" && b.url.trim() ? b.url.trim() : undefined;
  if (!title) return { error: "title is required" };
  if (title.length > MAX_TITLE_LEN) return { error: `title exceeds ${MAX_TITLE_LEN} chars` };
  if (!message) return { error: "message is required" };
  if (message.length > MAX_MESSAGE_LEN)
    return { error: `message exceeds ${MAX_MESSAGE_LEN} chars` };
  // The broadcast click-through opens directly from a trusted, Olio-branded
  // push to up to MAX_BROADCAST real users. Restrict it to an Olio host so a
  // compromised/rogue comm.email session can't turn the channel into a
  // phishing amplifier. (The password-reset endpoint mints its own Firebase
  // link and does NOT go through this parser, so it's unaffected.)
  if (url && !isAllowedBroadcastUrl(url)) {
    return { error: "url must be an https link on an oliowallet.com domain" };
  }

  const audienceRaw = (b.audience ?? {}) as Record<string, unknown>;
  if (audienceRaw.kind === "user") {
    const userId = typeof audienceRaw.userId === "string" ? audienceRaw.userId.trim() : "";
    if (!userId) return { error: "audience.userId is required" };
    return { title, message, url, audience: { kind: "user", userId } };
  }
  if (audienceRaw.kind === "filter") {
    const filter = parseMarketingFilter(audienceRaw.filter ?? {});
    if ("error" in filter) return { error: `audience.filter.${filter.error}` };
    return { title, message, url, audience: { kind: "filter", filter } };
  }
  return { error: "audience.kind must be 'filter' or 'user'" };
}

// Broadcast click-through URLs must point at an Olio host (no open redirect /
// phishing amplification). Rejects userinfo ("user@evil.com") tricks and any
// non-https scheme.
function isAllowedBroadcastUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return host === "oliowallet.com" || host.endsWith(".oliowallet.com");
}
