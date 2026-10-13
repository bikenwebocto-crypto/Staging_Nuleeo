// OneSignal Web Push admin Integrations panel:
//
//   GET  /api/admin/integrations/push/status — config probe
//   POST /api/admin/push/test                — send a test push
//
// Both share the `comm.email` privilege gate since they live in the
// same admin Integrations tab.

import type { Express, RequestHandler } from "express";
import { auth } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { PushError, getPushIntegrationStatus, sendPush } from "../services/push";
import type { PlatformPrivilegeKey, Role } from "../../shared/firestore-schema";

export interface AdminPushDeps {
  requireRole: (...roles: Role[]) => RequestHandler;
  requirePlatformPrivilege: (p: PlatformPrivilegeKey) => RequestHandler;
}

export function registerAdminPushRoutes(
  app: Express,
  { requireRole, requirePlatformPrivilege }: AdminPushDeps,
): void {
  app.get(
    "/api/admin/integrations/push/status",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.email"),
    (_req, res) => {
      res.json(getPushIntegrationStatus());
    },
  );

  app.post(
    "/api/admin/push/test",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.email"),
    async (req, res) => {
      // 50/h per admin — each call burns a OneSignal credit + does a
      // getUserByEmail (which also leaks existence via the success/
      // user-not-found split). Cap the runaway case.
      const adminUid = req.user!.uid;
      const pushLimit = await rateLimit(`push-test:${adminUid}`, 50, 60 * 60);
      if (!pushLimit.allowed) {
        res.set("Retry-After", String(pushLimit.retryAfterSeconds));
        return res.status(429).json({
          error: "Too many push tests. Try again shortly.",
          retryAfterSeconds: pushLimit.retryAfterSeconds,
        });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const targetEmail =
        typeof body.targetEmail === "string" ? body.targetEmail.trim().toLowerCase() : "";
      if (!targetEmail) {
        return res.status(400).json({ error: "targetEmail is required" });
      }
      try {
        const authUser = await auth().getUserByEmail(targetEmail);
        const result = await sendPush({
          externalUserId: authUser.uid,
          title: "Olio — test push",
          message: `Hi! This is a test push sent at ${new Date().toLocaleTimeString("en-GB")}.`,
          url: "https://app.oliowallet.com/",
        });
        if (result.recipients === 0) {
          return res.status(200).json({
            ok: true,
            notificationId: result.id,
            recipients: 0,
            warning:
              "OneSignal accepted the request but the target has 0 active push subscriptions. The user needs to open app.oliowallet.com and allow notifications first.",
          });
        }
        res.json({
          ok: true,
          notificationId: result.id,
          recipients: result.recipients,
        });
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e?.code === "auth/user-not-found") {
          return res.status(404).json({ error: "No Olio account with that email" });
        }
        if (err instanceof PushError) {
          return res
            .status(err.status >= 400 && err.status < 600 ? err.status : 502)
            .json({ error: err.message });
        }
        res.status(500).json({ error: errMsg(err, "Failed to send test push") });
      }
    },
  );
}
