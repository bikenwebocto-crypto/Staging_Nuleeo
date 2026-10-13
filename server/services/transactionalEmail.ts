// Transactional emails sent through Resend. Distinct from the
// campaign system in server/routes/emailMarketing.ts (which is admin-
// curated broadcasts); these are one-shot system messages tied to a
// specific user action.
//
// All senders are best-effort: caller code shouldn't fail an endpoint
// because Resend couldn't deliver. The endpoint's own write (creating
// the user, the access-contact grant, etc.) has already succeeded by
// the time we get here, and the recipient can always sign in / accept
// the invite without the email.
//
// Templates are inlined HTML (mirrors passwordReset.ts) because the
// Cloud Functions runtime only bundles whatever sits under /functions
// — disk-loaded templates outside that tree don't make it into the
// deploy.

import { sendEmailViaResend } from "./resend";

const APP_NAME = "Olio Wallet";

export interface UserInviteEmailInput {
  email: string;
  firstName?: string;
  lastName?: string;
  link: string;
  // Human-friendly attribution for the email body — "Jane Smith
  // invited you to Olio Wallet" reads better than "An admin invited
  // you". Falls back to "the Olio team" when not provided.
  invitedByName?: string;
}

// Sent when an admin provisions a new user via POST
// /api/admin/users/invite. The `link` is the Firebase-generated one-
// time password-setup URL (continueUrl points at our app). Tagged
// "user-invite" in the Resend dashboard.
export async function sendUserInviteEmail(input: UserInviteEmailInput): Promise<void> {
  const inviter =
    input.invitedByName?.trim() && input.invitedByName.trim().length > 0
      ? input.invitedByName.trim()
      : "the Olio team";
  const recipientName = `${input.firstName ?? ""} ${input.lastName ?? ""}`.trim() || input.email;
  const html = renderUserInviteHtml({
    recipientName,
    inviter,
    link: input.link,
  });
  const text =
    `Welcome to ${APP_NAME}\n\n` +
    `${inviter} invited you to join ${APP_NAME}.\n` +
    `Set your password to get started:\n${input.link}\n\n` +
    `If you weren't expecting this invitation, you can safely ignore this email.\n`;

  await sendEmailViaResend({
    to: input.email,
    subject: `${inviter} invited you to ${APP_NAME}`,
    html,
    text,
    tags: [{ name: "type", value: "user-invite" }],
  });
}

export interface PortfolioAccessInviteEmailInput {
  email: string;
  ownerName: string;
  // legacy / legal / financial — what slot the invitee was added to.
  type: "legacy" | "legal" | "financial";
}

// Sent when an owner adds someone as a portfolio access contact via
// PUT /api/owner/access-contacts/:type. The invitee already has an
// Olio account (the endpoint refuses if they don't); this email +
// the in-app push are the two channels that surface the pending
// invite. Tagged "portfolio-access-invite".
export async function sendPortfolioAccessInviteEmail(
  input: PortfolioAccessInviteEmailInput,
): Promise<void> {
  const typeLabel =
    input.type === "legacy" ? "legacy owner" : input.type === "legal" ? "legal" : "financial";
  const reviewUrl = "https://app.oliowallet.com/portfolio-access";

  const html = renderPortfolioAccessInviteHtml({
    ownerName: input.ownerName,
    typeLabel,
    reviewUrl,
  });
  const text =
    `Portfolio access invitation\n\n` +
    `${input.ownerName} wants to grant you ${typeLabel} access to their ` +
    `${APP_NAME} portfolio.\n\n` +
    `Review and accept (or decline) the invitation:\n${reviewUrl}\n\n` +
    `If you weren't expecting this invitation, you can ignore this email and the ` +
    `invitation will stay pending until you decide.\n`;

  await sendEmailViaResend({
    to: input.email,
    subject: `${input.ownerName} invited you to their ${APP_NAME} portfolio`,
    html,
    text,
    tags: [{ name: "type", value: "portfolio-access-invite" }],
  });
}

export interface TenantAgreementInviteEmailInput {
  email: string;
  ownerName: string;
  // Address / building label the owner picked for the lease. Falls
  // back to "a property" when missing.
  propertyLabel?: string;
  // True when the recipient already has a linked Olio account; flips
  // the CTA copy from "Sign up" to "Sign in" so we don't confuse
  // existing users.
  hasAccount: boolean;
}

// Sent when an owner creates a rental agreement via POST
// /api/owner/agreements. Goes to the tenant's email regardless of
// whether they have an Olio account yet — for existing accounts the
// email + the in-app push are redundant channels, for new emails it's
// the only way the tenant finds out a lease is waiting. Critically does
// NOT carry a password-setup or signup token (the recipient hasn't
// proven control of this email, so we can't mint a credentialed link
// for them — they self-serve sign up at app.oliowallet.com and the
// /api/me handler auto-links the pending tenancy by email match).
// Tagged "tenant-agreement-invite".
export async function sendTenantAgreementInviteEmail(
  input: TenantAgreementInviteEmailInput,
): Promise<void> {
  const propertyLabel = input.propertyLabel?.trim() || "a property";
  // Deep-link straight to the agreements list where the approve/decline
  // buttons live. A logged-out / not-yet-registered recipient hits the
  // auth gate first, signs in or signs up, and /api/me links the pending
  // tenancy by email match before landing them here.
  const reviewUrl = "https://app.oliowallet.com/tenant/agreements";
  const html = renderTenantAgreementInviteHtml({
    ownerName: input.ownerName,
    propertyLabel,
    reviewUrl,
    hasAccount: input.hasAccount,
  });
  const ctaCopy = input.hasAccount
    ? "Sign in to review the lease and approve or decline it"
    : "Sign up with this email to review the lease and approve or decline it";
  const text =
    `New lease to review\n\n` +
    `${input.ownerName} sent you a lease for ${propertyLabel} ` +
    `in ${APP_NAME}.\n\n` +
    `${ctaCopy}:\n${reviewUrl}\n\n` +
    `If you don't recognize this landlord, ignore this email and ` +
    `no account will be created.\n`;

  await sendEmailViaResend({
    to: input.email,
    subject: `${input.ownerName} sent you a lease for ${propertyLabel}`,
    html,
    text,
    tags: [{ name: "type", value: "tenant-agreement-invite" }],
  });
}

// ── Template renderers ──────────────────────────────────────────────
// Inlined HTML mirrors the branded reset email so the visual identity
// stays consistent. Same dark-mode CSS rules, same 560px shell, same
// type stack.

function renderUserInviteHtml({
  recipientName,
  inviter,
  link,
}: {
  recipientName: string;
  inviter: string;
  link: string;
}): string {
  const safeName = escapeHtml(recipientName);
  const safeInviter = escapeHtml(inviter);
  const safeLink = escapeAttr(link);
  return shell({
    title: `Welcome to ${APP_NAME}`,
    body: `
        <h1 class="text" style="margin:0 0 12px;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-0.02em;color:#171717;">Welcome to ${escapeHtml(APP_NAME)}</h1>
        <p class="muted" style="margin:0 0 28px;font-size:15px;line-height:1.55;color:#525252;">
          Hi <strong class="text" style="color:#171717;font-weight:600;">${safeName}</strong> — ${safeInviter} invited you to join ${escapeHtml(APP_NAME)}. Click below to set your password and get started.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="border-radius:10px;background:#171717;">
            <a href="${safeLink}" class="btn" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;background:#171717;">Set your password</a>
          </td></tr>
        </table>
        <p class="muted" style="margin:28px 0 8px;font-size:13px;line-height:1.55;color:#737373;">Or paste this link into your browser:</p>
        <p class="link-fallback" style="margin:0;font-size:13px;line-height:1.5;word-break:break-all;color:#737373;">
          <a href="${safeLink}" style="color:#737373;text-decoration:underline;">${safeLink}</a>
        </p>
        <hr class="divider" style="border:none;border-top:1px solid #e5e5e5;margin:32px 0;" />
        <p class="muted" style="margin:0;font-size:13px;line-height:1.55;color:#737373;">
          If you weren't expecting this invitation, you can safely ignore this email.
        </p>`,
  });
}

function renderPortfolioAccessInviteHtml({
  ownerName,
  typeLabel,
  reviewUrl,
}: {
  ownerName: string;
  typeLabel: string;
  reviewUrl: string;
}): string {
  const safeOwner = escapeHtml(ownerName);
  const safeType = escapeHtml(typeLabel);
  const safeUrl = escapeAttr(reviewUrl);
  return shell({
    title: `Portfolio access invitation`,
    body: `
        <h1 class="text" style="margin:0 0 12px;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-0.02em;color:#171717;">Portfolio access invitation</h1>
        <p class="muted" style="margin:0 0 28px;font-size:15px;line-height:1.55;color:#525252;">
          <strong class="text" style="color:#171717;font-weight:600;">${safeOwner}</strong> wants to grant you <strong class="text" style="color:#171717;font-weight:600;">${safeType}</strong> access to their ${escapeHtml(APP_NAME)} portfolio. The invitation stays pending until you accept or decline.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="border-radius:10px;background:#171717;">
            <a href="${safeUrl}" class="btn" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;background:#171717;">Review invitation</a>
          </td></tr>
        </table>
        <p class="muted" style="margin:28px 0 8px;font-size:13px;line-height:1.55;color:#737373;">Or paste this link into your browser:</p>
        <p class="link-fallback" style="margin:0;font-size:13px;line-height:1.5;word-break:break-all;color:#737373;">
          <a href="${safeUrl}" style="color:#737373;text-decoration:underline;">${safeUrl}</a>
        </p>
        <hr class="divider" style="border:none;border-top:1px solid #e5e5e5;margin:32px 0;" />
        <p class="muted" style="margin:0;font-size:13px;line-height:1.55;color:#737373;">
          If you don't recognize this person, ignore the email and the invitation will stay pending — no data is shared until you accept.
        </p>`,
  });
}

function renderTenantAgreementInviteHtml({
  ownerName,
  propertyLabel,
  reviewUrl,
  hasAccount,
}: {
  ownerName: string;
  propertyLabel: string;
  reviewUrl: string;
  hasAccount: boolean;
}): string {
  const safeOwner = escapeHtml(ownerName);
  const safeProperty = escapeHtml(propertyLabel);
  const safeUrl = escapeAttr(reviewUrl);
  const cta = hasAccount ? "Review your lease" : "Get started";
  const intro = hasAccount
    ? `Sign in to review the lease and approve or decline it, then set up rent payments through ${escapeHtml(APP_NAME)}.`
    : `Sign up with this email to review the lease and approve or decline it, then set up rent payments through ${escapeHtml(APP_NAME)}.`;
  return shell({
    title: `New lease to review`,
    body: `
        <h1 class="text" style="margin:0 0 12px;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-0.02em;color:#171717;">New lease to review</h1>
        <p class="muted" style="margin:0 0 28px;font-size:15px;line-height:1.55;color:#525252;">
          <strong class="text" style="color:#171717;font-weight:600;">${safeOwner}</strong> sent you a lease for <strong class="text" style="color:#171717;font-weight:600;">${safeProperty}</strong>. ${intro}
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="border-radius:10px;background:#171717;">
            <a href="${safeUrl}" class="btn" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;background:#171717;">${escapeHtml(cta)}</a>
          </td></tr>
        </table>
        <p class="muted" style="margin:28px 0 8px;font-size:13px;line-height:1.55;color:#737373;">Or paste this link into your browser:</p>
        <p class="link-fallback" style="margin:0;font-size:13px;line-height:1.5;word-break:break-all;color:#737373;">
          <a href="${safeUrl}" style="color:#737373;text-decoration:underline;">${safeUrl}</a>
        </p>
        <hr class="divider" style="border:none;border-top:1px solid #e5e5e5;margin:32px 0;" />
        <p class="muted" style="margin:0;font-size:13px;line-height:1.55;color:#737373;">
          If you don't recognize this landlord, ignore this email — no account will be created and no data is shared until you sign in.
        </p>`,
  });
}

function shell({ title, body }: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${escapeHtml(title)}</title>
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
      <tr><td class="card" style="background:#ffffff;border:1px solid #e5e5e5;border-radius:16px;padding:40px;">${body}
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
