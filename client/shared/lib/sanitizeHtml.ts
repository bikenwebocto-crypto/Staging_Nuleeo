// Centralized HTML sanitizer for admin-authored content rendered via
// `dangerouslySetInnerHTML`. The compliance docs (Terms / Privacy /
// GDPR / Owner Terms) are written by admins in a free-text editor and
// shown on PUBLIC routes — any XSS that slips through reaches every
// visitor, signed in or not.
//
// DOMPurify with default config strips <script>, on*= handlers,
// javascript: URLs, dangerous SVG primitives, and similar vectors while
// preserving normal compliance-doc markup (headings, lists, links,
// emphasis, tables).
//
// This file is browser-only — the API is `window`-aware. If we ever
// pre-render compliance HTML server-side, swap to isomorphic-dompurify
// (it pulls in jsdom, so we keep it out of the client bundle until
// that need actually lands).

import DOMPurify from "dompurify";

// DOMPurify v3's TypeScript types only expose `Config` indirectly; the
// shape we need is documented but not exported as a namespace. Keep the
// option object loosely typed — DOMPurify validates at runtime.
const DEFAULT_CONFIG = {
  // Block iframes + embeds outright. Compliance docs don't need them and
  // they widen the attack surface a lot. Also block form + input so an
  // admin doc can't impersonate a login form (DOMPurify's KEEP_CONTENT
  // default keeps inert children, which is harmless without the form).
  FORBID_TAGS: ["iframe", "object", "embed", "form", "input"],
  // RETURN_TRUSTED_TYPE: false forces a plain string back so we can
  // post-process it. Without this, browsers with Trusted Types enabled
  // would return a TrustedHTML wrapper.
  RETURN_TRUSTED_TYPE: false,
};

export function sanitizeComplianceHtml(input: string | null | undefined): string {
  if (typeof input !== "string" || input.length === 0) return "";
  const clean = String(DOMPurify.sanitize(input, DEFAULT_CONFIG));
  // Post-process: ensure all external anchors open in a new tab with
  // safe rel. We do this on the sanitized string rather than via
  // DOMPurify hooks so it works the same in test environments without
  // a DOMPurify instance to hook into.
  return clean.replace(
    /<a\s+([^>]*?)href=/gi,
    '<a target="_blank" rel="noopener noreferrer" $1href=',
  );
}
