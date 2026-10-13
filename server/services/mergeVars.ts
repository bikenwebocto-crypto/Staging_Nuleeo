// Per-recipient merge-variable substitution. Mirrors the preview-time
// rendering in the client so what an admin sees in the editor matches what
// arrives in the recipient's inbox.

import type { AudienceRecipient } from "./audiences";

export interface MergeContext {
  recipient: AudienceRecipient;
  now?: Date;
  unsubscribeUrl?: string;
}

export function renderTemplate(template: string, ctx: MergeContext): string {
  const now = ctx.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const first = ctx.recipient.firstName?.trim();
  const last = ctx.recipient.lastName?.trim();
  const name = first || "there";

  return template
    .replace(/\{\{\s*name\s*\}\}/g, name)
    .replace(/\{\{\s*first_name\s*\}\}/g, first || "")
    .replace(/\{\{\s*last_name\s*\}\}/g, last || "")
    .replace(/\{\{\s*date\s*\}\}/g, date)
    .replace(/\{\{\s*email\s*\}\}/g, ctx.recipient.email)
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/g, ctx.unsubscribeUrl ?? "");
}

// Only http(s) links may reach a rendered href. A stray javascript:/data:/
// mailto: URL from a bad CTA input must never be linkified. Server-side parse
// already rejects these, but the renderer guards again (defense in depth).
export function isRenderableUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Wrap a plaintext-authored body into a minimal branded HTML email. Keeps
// styling inline (Gmail/Outlook strip <style>). The footer surfaces an
// unsubscribe link; the same URL also rides as a List-Unsubscribe HTTP
// header (set by the sender) for one-click clients.
//
// Optional blocks — order is Body → CTA button → Signature → Footer:
//   cta        a call-to-action button (label + validated http(s) url)
//   signature  a sign-off appended after the body/CTA
//   footerText custom text shown ABOVE the mandatory copyright/unsubscribe line
export function wrapInEmailShell(opts: {
  subject: string;
  body: string;
  unsubscribeUrl?: string;
  cta?: { label: string; url: string };
  signature?: string;
  footerText?: string;
}): { html: string; text: string } {
  // Sender identity + physical postal address — required in every commercial
  // email by CAN-SPAM (US) and expected for GDPR/PECR sender identity and
  // Gmail/Yahoo bulk-sender deliverability. Defaults to the legal entity used
  // across the compliance docs; override MARKETING_SENDER_ADDRESS with the full
  // registered street address when available.
  const senderAddress =
    process.env.MARKETING_SENDER_ADDRESS?.trim() || "Olio Wallet Ltd · Nicosia, Cyprus";

  // Normalize optional inputs. A CTA only counts if it has a label AND a
  // renderable url; otherwise it's dropped entirely (no dead button).
  const ctaLabel = opts.cta?.label.trim() ?? "";
  const ctaUrl = opts.cta?.url.trim() ?? "";
  const cta = ctaLabel && isRenderableUrl(ctaUrl) ? { label: ctaLabel, url: ctaUrl } : null;
  const signature = opts.signature?.trim() ? opts.signature.trim() : null;
  const footerText = opts.footerText?.trim() ? opts.footerText.trim() : null;

  const text =
    `${opts.body}\n\n` +
    `${cta ? `${cta.label}: ${cta.url}\n\n` : ""}` +
    `${signature ? `${signature}\n\n` : ""}` +
    `—\nYou received this from Olio. ` +
    `${opts.unsubscribeUrl ? `Unsubscribe: ${opts.unsubscribeUrl}` : "Manage email preferences in Settings."}\n` +
    `${footerText ? `${footerText}\n` : ""}` +
    `${senderAddress}\n`;

  const paragraphs = opts.body
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.55;color:#1f1f1f;">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`,
    )
    .join("");

  // CTA button — a bulletproof, table-free inline-block anchor styled to match
  // the brand header. Centered, with breathing room above the signature.
  const ctaHtml = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:8px 0 4px 0;"><tr><td align="center">
          <a href="${escapeAttr(cta.url)}" style="display:inline-block;background:#0f0f0f;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(cta.label)}</a>
        </td></tr></table>`
    : "";

  // Signature — muted sign-off block, line breaks preserved.
  const signatureHtml = signature
    ? `<div style="margin-top:20px;font-size:14px;line-height:1.5;color:#4b5563;">${escapeHtml(signature).replace(/\n/g, "<br/>")}</div>`
    : "";

  // The provider (Resend) also injects List-Unsubscribe headers when the
  // sending domain is configured for one-click unsubscribe; this visible
  // footer link is the body-level equivalent.
  const footerLink = opts.unsubscribeUrl
    ? `<a href="${escapeAttr(opts.unsubscribeUrl)}" style="color:#6b7280;">Unsubscribe</a>`
    : `Manage email preferences in Settings`;

  // Custom footer text sits above the mandatory copyright/unsubscribe/address
  // line — additive, never a replacement.
  const footerTextHtml = footerText
    ? `<div style="margin-bottom:10px;color:#4b5563;">${escapeHtml(footerText).replace(/\n/g, "<br/>")}</div>`
    : "";

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(opts.subject)}</title></head>
<body style="margin:0;padding:0;background:#f7f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f7f7f8;padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #ececec;">
        <tr><td style="background:#0f0f0f;color:#ffffff;padding:18px 24px;text-align:center;font-weight:700;letter-spacing:.5px;">OLIO</td></tr>
        <tr><td style="padding:28px 28px 12px 28px;">
          ${paragraphs}
          ${ctaHtml}
          ${signatureHtml}
        </td></tr>
        <tr><td style="padding:16px 28px 28px 28px;border-top:1px solid #ececec;color:#6b7280;font-size:12px;line-height:1.5;">
          ${footerTextHtml}© ${new Date().getFullYear()} Olio Wallet · ${footerLink}
          <br/>${escapeHtml(senderAddress)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { html, text };
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
