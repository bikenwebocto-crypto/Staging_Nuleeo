// Tests for the email shell renderer + its URL guard. wrapInEmailShell is the
// one place campaign content (body, CTA button, signature, custom footer)
// becomes HTML, so this covers: the http(s)-only CTA guard (a javascript:/
// data: link must never become an href), the Body → CTA → Signature → Footer
// order, and that the mandatory unsubscribe/copyright line is always present.

import { describe, it, expect } from "vitest";
import { isRenderableUrl, renderTemplate, wrapInEmailShell } from "./mergeVars";

describe("isRenderableUrl", () => {
  it("accepts http and https", () => {
    expect(isRenderableUrl("https://oliowallet.com/x")).toBe(true);
    expect(isRenderableUrl("http://example.com")).toBe(true);
    expect(isRenderableUrl("  https://spaced.com  ")).toBe(true);
  });

  it("rejects dangerous or non-web protocols", () => {
    expect(isRenderableUrl("javascript:alert(1)")).toBe(false);
    expect(isRenderableUrl("data:text/html,<script>")).toBe(false);
    expect(isRenderableUrl("mailto:hi@olio.com")).toBe(false);
    expect(isRenderableUrl("ftp://host/file")).toBe(false);
    expect(isRenderableUrl("not a url")).toBe(false);
    expect(isRenderableUrl("")).toBe(false);
  });
});

describe("wrapInEmailShell — base", () => {
  it("always renders the copyright + unsubscribe footer", () => {
    const { html, text } = wrapInEmailShell({
      subject: "Hi",
      body: "Hello there",
      unsubscribeUrl: "https://app.oliowallet.com/api/u/tok",
    });
    expect(html).toContain("Olio Wallet");
    expect(html).toContain("https://app.oliowallet.com/api/u/tok");
    expect(html).toContain(">Unsubscribe<");
    expect(text).toContain("Unsubscribe: https://app.oliowallet.com/api/u/tok");
  });

  it("escapes HTML in the body", () => {
    const { html } = wrapInEmailShell({ subject: "s", body: "<script>evil()</script>" });
    expect(html).not.toContain("<script>evil()</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("wrapInEmailShell — CTA button", () => {
  it("renders a button anchor for a valid http(s) link", () => {
    const { html, text } = wrapInEmailShell({
      subject: "s",
      body: "b",
      cta: { label: "View listing", url: "https://oliowallet.com/l/1" },
    });
    expect(html).toContain('href="https://oliowallet.com/l/1"');
    expect(html).toContain("View listing");
    expect(text).toContain("View listing: https://oliowallet.com/l/1");
  });

  it("DROPS a CTA whose url is a dangerous protocol — no href, no button", () => {
    const { html, text } = wrapInEmailShell({
      subject: "s",
      body: "b",
      cta: { label: "Click me", url: "javascript:alert(document.cookie)" },
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Click me");
    expect(text).not.toContain("Click me");
  });

  it("drops a CTA with an empty label", () => {
    const { html } = wrapInEmailShell({
      subject: "s",
      body: "b",
      cta: { label: "   ", url: "https://oliowallet.com" },
    });
    expect(html).not.toContain("https://oliowallet.com");
  });
});

describe("wrapInEmailShell — signature + footer note", () => {
  it("renders the signature after the body and the footer note above copyright", () => {
    const { html, text } = wrapInEmailShell({
      subject: "s",
      body: "The message body",
      signature: "Best,\nThe Olio Team",
      footerText: "Olio Wallet Ltd · Nicosia",
    });
    expect(html).toContain("The Olio Team");
    expect(html).toContain("Olio Wallet Ltd · Nicosia");
    // Order: body → signature → footer note → copyright.
    const bodyIdx = html.indexOf("The message body");
    const sigIdx = html.indexOf("The Olio Team");
    const footerIdx = html.indexOf("Olio Wallet Ltd");
    const copyrightIdx = html.indexOf("© ");
    expect(bodyIdx).toBeLessThan(sigIdx);
    expect(sigIdx).toBeLessThan(footerIdx);
    expect(footerIdx).toBeLessThan(copyrightIdx);
    expect(text).toContain("Best,\nThe Olio Team");
    expect(text).toContain("Olio Wallet Ltd · Nicosia");
  });

  it("full order: body → CTA → signature → footer", () => {
    const { html } = wrapInEmailShell({
      subject: "s",
      body: "BODYMARK",
      cta: { label: "CTAMARK", url: "https://oliowallet.com" },
      signature: "SIGMARK",
      footerText: "FOOTMARK",
    });
    const order = ["BODYMARK", "CTAMARK", "SIGMARK", "FOOTMARK"].map((m) => html.indexOf(m));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it("omits optional blocks when empty/whitespace", () => {
    const { html } = wrapInEmailShell({
      subject: "s",
      body: "b",
      signature: "   ",
      footerText: "",
    });
    // Still has the mandatory footer, but no stray empty signature div.
    expect(html).toContain("Olio Wallet");
  });
});

describe("renderTemplate", () => {
  it("substitutes merge vars used by signature/footer/cta label", () => {
    const out = renderTemplate("Hi {{first_name}}, on {{date}}", {
      recipient: { userId: "u", email: "a@b.com", firstName: "Jane", lastName: "Doe" },
      now: new Date("2026-07-06T00:00:00Z"),
    });
    expect(out).toBe("Hi Jane, on 2026-07-06");
  });
});
