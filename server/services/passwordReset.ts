// Server-side password-reset flow. Mints a Firebase Auth action link via the
// Admin SDK, then delivers it through Resend with our branded HTML instead
// of Firebase's default-branded email.
//
// The host of the link (where the recipient lands) is controlled by the
// Firebase Console → Authentication → Templates → "Customize action URL"
// setting — currently `https://app.oliowallet.com/auth/action`, which is
// rendered by client/app/src/pages/auth/AuthActionPage.tsx.

import { auth } from "../firebase";
import { sendEmailViaResend } from "./resend";

const APP_NAME = "Olio Wallet";

// Send a password-reset email. Silently no-ops if the email isn't tied to
// any account so callers can always return 200 — that prevents an attacker
// from probing the user database via the public forgot-password endpoint.
export async function sendPasswordResetEmail(email: string): Promise<void> {
  const continueUrl =
    process.env.PUBLIC_APP_URL?.replace(/\/$/, "") ?? "https://app.oliowallet.com";

  let link: string;
  try {
    link = await auth().generatePasswordResetLink(email, {
      url: `${continueUrl}/login`,
      handleCodeInApp: false,
    });
  } catch (err: unknown) {
    const code =
      (err as { code?: string; errorInfo?: { code?: string } })?.code ??
      (err as { errorInfo?: { code?: string } })?.errorInfo?.code ??
      "";
    // "no such user" is the only error we swallow — every other failure
    // (rate limit, invalid email format, internal) should bubble up so it
    // gets logged.
    if (code === "auth/user-not-found") return;
    throw err;
  }

  const html = renderResetEmailHtml({ email, link });
  const text =
    `Reset your ${APP_NAME} password\n\n` +
    `We received a request to reset the password for ${email}.\n` +
    `Use this link to choose a new one:\n${link}\n\n` +
    `If you didn't request this, you can safely ignore this email — your password won't change.\n`;

  await sendEmailViaResend({
    to: email,
    subject: `Reset your ${APP_NAME} password`,
    html,
    text,
    tags: [{ name: "type", value: "password-reset" }],
  });
}

// Inlined branded HTML for the reset email. Kept here (not loaded from
// /emails/*.html on disk) because the Cloud Functions runtime only ships
// whatever sits under /functions; templates outside that tree don't make it
// into the bundle. Mirrors /emails/reset-password.html for parity.
function renderResetEmailHtml({ email, link }: { email: string; link: string }): string {
  const safeEmail = escapeHtml(email);
  const safeLink = escapeAttr(link);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>Reset your ${escapeHtml(APP_NAME)} password</title>
<style>
@media (prefers-color-scheme: dark) {
  body, .bg { background: #0a0a0a !important; }
  .card { background: #141414 !important; border-color: #262626 !important; }
  .text { color: #f5f5f5 !important; }
  .muted { color: #a3a3a3 !important; }
  .divider { border-color: #262626 !important; }
  .btn { background: #f5f5f5 !important; color: #0a0a0a !important; }
  .link-fallback { color: #a3a3a3 !important; }
}
@media only screen and (max-width: 600px) {
  .container { width: 100% !important; padding: 24px 16px !important; }
  .card { padding: 28px 24px !important; }
  h1 { font-size: 22px !important; }
}
</style>
</head>
<body class="bg text" style="margin:0;padding:0;background:#fafafa;color:#171717;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="bg" style="background:#fafafa;">
  <tr><td align="center" style="padding:48px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" class="container" style="width:560px;max-width:100%;">
      <tr><td align="left" style="padding:0 4px 24px;">
        <span class="text" style="font-size:20px;font-weight:600;letter-spacing:-0.01em;color:#171717;">${escapeHtml(APP_NAME)}</span>
      </td></tr>
      <tr><td class="card" style="background:#ffffff;border:1px solid #e5e5e5;border-radius:16px;padding:40px;">
        <h1 class="text" style="margin:0 0 12px;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-0.02em;color:#171717;">Reset your password</h1>
        <p class="muted" style="margin:0 0 28px;font-size:15px;line-height:1.55;color:#525252;">
          We received a request to reset the password for <strong class="text" style="color:#171717;font-weight:600;">${safeEmail}</strong>. Tap the button below to choose a new one.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="border-radius:10px;background:#171717;">
            <a href="${safeLink}" class="btn" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;background:#171717;">Reset password</a>
          </td></tr>
        </table>
        <p class="muted" style="margin:28px 0 8px;font-size:13px;line-height:1.55;color:#737373;">Or paste this link into your browser:</p>
        <p class="link-fallback" style="margin:0;font-size:13px;line-height:1.5;word-break:break-all;color:#737373;">
          <a href="${safeLink}" style="color:#737373;text-decoration:underline;">${safeLink}</a>
        </p>
        <hr class="divider" style="border:none;border-top:1px solid #e5e5e5;margin:32px 0;" />
        <p class="muted" style="margin:0;font-size:13px;line-height:1.55;color:#737373;">
          If you didn't request this, you can safely ignore this email — your password won't change.
        </p>
      </td></tr>
      <tr><td align="center" style="padding:24px 4px 0;">
        <p class="muted" style="margin:0;font-size:12px;line-height:1.55;color:#a3a3a3;">Sent by ${escapeHtml(APP_NAME)} · oliowallet.com</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
