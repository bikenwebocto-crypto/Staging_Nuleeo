// Forgot-password recovery endpoint. PUBLIC — anti-enumeration response
// returns 200 always, BEFORE any work happens, so response time can't
// reveal whether the address is registered.

import type { Express } from "express";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { sendPasswordResetEmail } from "../services/passwordReset";
import { logError, logWarn } from "../services/log";

export function registerForgotPasswordRoutes(app: Express): void {
  app.post("/api/auth/forgot-password", async (req, res) => {
    // Unicode-normalize before lowercasing so the rate-limit key folds
    // visually-identical emails together. Without this, the per-email
    // 5/h cap can be bypassed by varying the Unicode form (`İ` vs `i`,
    // `ß` vs `ss`) — each unique byte sequence gets a fresh bucket.
    const raw =
      typeof (req.body as { email?: unknown } | null)?.email === "string"
        ? (req.body as { email: string }).email.normalize("NFKC").trim().toLowerCase()
        : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
      return res.status(400).json({ error: "Valid email required" });
    }
    // Constant-time response — return 200 BEFORE doing any real work
    // so the response time is the same regardless of:
    //   - whether the email maps to a real account
    //   - whether we're rate-limited
    //   - whether Firebase / Resend errors
    // Without this, the prior shape returned in 100ms vs 500ms vs 800ms
    // depending on which branch hit, giving a statistical oracle for
    // account-existence enumeration even though the body was uniform.
    // The actual send happens in a fire-and-forget Promise chain after
    // we've already responded.
    res.json({ ok: true });

    // Two-layer rate limit:
    //   - per-IP (30/hour): bounds raw request volume from a single host.
    //   - per-email (5/hour): bounds Resend send credits + Firebase Auth
    //     reset-link quota burn against a single victim address.
    (async () => {
      try {
        const ipKey = `forgot-ip:${req.ip ?? "unknown"}`;
        const emailKey = `forgot-email:${raw}`;
        const [ipOk, emailOk] = await Promise.all([
          rateLimit(ipKey, 30, 60 * 60),
          rateLimit(emailKey, 5, 60 * 60),
        ]);
        if (!ipOk.allowed || !emailOk.allowed) {
          const masked = raw.length > 2 ? `${raw.slice(0, 2)}***@***` : "***@***";
          logWarn("forgot_password.rate-limited", {
            ip: req.ip,
            emailMasked: masked,
            ipOk: ipOk.allowed,
            emailOk: emailOk.allowed,
          });
          return;
        }
        await sendPasswordResetEmail(raw);
      } catch (err) {
        const maskedErrEmail = raw.length > 2 ? `${raw.slice(0, 2)}***@***` : "***@***";
        logError("forgot_password.send-failed", err, { emailMasked: maskedErrEmail });
      }
    })();
  });
}
