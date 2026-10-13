import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isSafeRedirectUrl, isPublicHttpsUrl } from "./safeRedirect";

const ORIG_PUBLIC_APP_URL = process.env.PUBLIC_APP_URL;

beforeEach(() => {
  delete process.env.PUBLIC_APP_URL;
});

afterEach(() => {
  if (ORIG_PUBLIC_APP_URL !== undefined) {
    process.env.PUBLIC_APP_URL = ORIG_PUBLIC_APP_URL;
  } else {
    delete process.env.PUBLIC_APP_URL;
  }
});

describe("isSafeRedirectUrl", () => {
  it("rejects empty / non-string / non-URL inputs", () => {
    expect(isSafeRedirectUrl(null)).toBe(false);
    expect(isSafeRedirectUrl(undefined)).toBe(false);
    expect(isSafeRedirectUrl("")).toBe(false);
    expect(isSafeRedirectUrl("not a url")).toBe(false);
    expect(isSafeRedirectUrl("/relative/path")).toBe(false);
  });

  it("rejects javascript:, data:, file: schemes", () => {
    expect(isSafeRedirectUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeRedirectUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeRedirectUrl("file:///etc/passwd")).toBe(false);
  });

  it("allows the prod hosts", () => {
    expect(isSafeRedirectUrl("https://app.oliowallet.com/owner")).toBe(true);
    expect(isSafeRedirectUrl("https://platform.oliowallet.com/admin")).toBe(true);
    expect(isSafeRedirectUrl("https://oliowallet.com/")).toBe(true);
    expect(isSafeRedirectUrl("https://www.oliowallet.com/about")).toBe(true);
  });

  it("rejects attacker-controlled domains", () => {
    expect(isSafeRedirectUrl("https://evil.com/")).toBe(false);
    expect(isSafeRedirectUrl("https://app.oliowallet.com.evil.com/")).toBe(false);
    expect(isSafeRedirectUrl("https://attacker.oliowallet.com.evil.com")).toBe(false);
  });

  it("rejects http on prod hosts (no plaintext post-payment redirect)", () => {
    expect(isSafeRedirectUrl("http://app.oliowallet.com/")).toBe(false);
  });

  it("allows http on localhost only (for dev)", () => {
    expect(isSafeRedirectUrl("http://localhost:5173/")).toBe(true);
    expect(isSafeRedirectUrl("http://127.0.0.1:8080/")).toBe(true);
  });

  it("honors PUBLIC_APP_URL host (for staging)", () => {
    process.env.PUBLIC_APP_URL = "https://staging-app.oliowallet.com";
    expect(isSafeRedirectUrl("https://staging-app.oliowallet.com/foo")).toBe(true);
    expect(isSafeRedirectUrl("https://other-staging.example.com/")).toBe(false);
  });

  it("preserves the path + query — only the origin is checked", () => {
    expect(
      isSafeRedirectUrl("https://app.oliowallet.com/owner/properties/abc?session_id=xyz"),
    ).toBe(true);
  });
});

describe("isPublicHttpsUrl", () => {
  it("accepts a normal public https URL", () => {
    expect(isPublicHttpsUrl("https://example.com/foo.jpg")).toBe(true);
    expect(isPublicHttpsUrl("https://firebasestorage.googleapis.com/v0/b/x/o/y")).toBe(true);
  });

  it("rejects non-https protocols", () => {
    expect(isPublicHttpsUrl("http://example.com/")).toBe(false);
    expect(isPublicHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isPublicHttpsUrl("data:image/png;base64,abc")).toBe(false);
    expect(isPublicHttpsUrl("file:///etc/passwd")).toBe(false);
    expect(isPublicHttpsUrl("ftp://example.com")).toBe(false);
  });

  it("rejects loopback + private IPv4", () => {
    expect(isPublicHttpsUrl("https://127.0.0.1/")).toBe(false);
    expect(isPublicHttpsUrl("https://127.5.5.5/")).toBe(false);
    expect(isPublicHttpsUrl("https://10.0.0.1/")).toBe(false);
    expect(isPublicHttpsUrl("https://192.168.1.1/")).toBe(false);
    expect(isPublicHttpsUrl("https://169.254.169.254/")).toBe(false); // GCP metadata
    expect(isPublicHttpsUrl("https://172.16.0.1/")).toBe(false);
    expect(isPublicHttpsUrl("https://172.31.255.255/")).toBe(false);
    expect(isPublicHttpsUrl("https://0.0.0.0/")).toBe(false);
  });

  // Regression: the prior regex didn't match bracketed IPv6 hostnames
  // that Node returns from URL.hostname, so `https://[::1]/` reached
  // 127.0.0.1 via the IPv4-mapped fallback. SSRF re-opened.
  it("rejects IPv6 loopback (regression)", () => {
    expect(isPublicHttpsUrl("https://[::1]/admin")).toBe(false);
    expect(isPublicHttpsUrl("https://[::]/")).toBe(false);
  });

  it("rejects IPv6 link-local and unique-local", () => {
    expect(isPublicHttpsUrl("https://[fe80::1]/")).toBe(false);
    expect(isPublicHttpsUrl("https://[fc00::1]/")).toBe(false);
    expect(isPublicHttpsUrl("https://[fd12:3456:789a::1]/")).toBe(false);
  });

  // Regression: IPv4-mapped IPv6 sneaks private IPv4 in through the
  // back door. `::ffff:7f00:1` is 127.0.0.1 in IPv6 syntax.
  it("rejects IPv4-mapped IPv6 that points at private ranges", () => {
    expect(isPublicHttpsUrl("https://[::ffff:7f00:1]/")).toBe(false); // 127.0.0.1
    expect(isPublicHttpsUrl("https://[::ffff:127.0.0.1]/")).toBe(false);
    expect(isPublicHttpsUrl("https://[::ffff:a9fe:a9fe]/")).toBe(false); // 169.254.169.254
    expect(isPublicHttpsUrl("https://[::ffff:c0a8:101]/")).toBe(false); // 192.168.1.1
  });

  it("rejects cloud-metadata hostnames", () => {
    expect(isPublicHttpsUrl("https://metadata.google.internal/computeMetadata/v1/")).toBe(false);
    expect(isPublicHttpsUrl("https://metadata/")).toBe(false);
  });

  it("rejects localhost hostname", () => {
    expect(isPublicHttpsUrl("https://localhost/")).toBe(false);
    expect(isPublicHttpsUrl("https://ip6-localhost/")).toBe(false);
  });

  it("rejects garbage input", () => {
    expect(isPublicHttpsUrl(null)).toBe(false);
    expect(isPublicHttpsUrl(undefined)).toBe(false);
    expect(isPublicHttpsUrl("")).toBe(false);
    expect(isPublicHttpsUrl("not a url")).toBe(false);
  });
});
