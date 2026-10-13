// Validates a client-supplied redirect URL against an allowlist of Olio
// origins. Used wherever a user-supplied successUrl/cancelUrl/returnUrl
// is handed to Stripe (or any third-party redirector) — without this, an
// attacker could craft a Stripe Checkout link whose post-payment redirect
// lands the victim at evil.com/phishing styled to look like an Olio
// confirmation page.
//
// Accepts:
//   - app.oliowallet.com and platform.oliowallet.com (the two prod hosts)
//   - oliowallet.com (apex marketing site)
//   - localhost / 127.0.0.1 (dev only — PUBLIC_APP_URL override)
//   - PUBLIC_APP_URL host (lets a staging deploy work without code changes)
//
// Anything else returns false.

const PROD_HOSTS = new Set([
  "app.oliowallet.com",
  "platform.oliowallet.com",
  "oliowallet.com",
  "www.oliowallet.com",
]);

function publicAppHost(): string | null {
  const url = process.env.PUBLIC_APP_URL;
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Block SSRF — return true only for URLs we'd happily fetch on behalf
// of a user. Used at write-time for user-supplied image URLs (which the
// briefing service downloads + base64-embeds into the PDF; a naive
// implementation lets an authenticated user read cloud-metadata
// endpoints, localhost services, RFC1918 ranges, etc.).
//
// Accepts only https:// on a public hostname (rejects every private IP
// literal + the obvious hostnames that resolve to one). DNS rebinding is
// still possible — for full defence we'd resolve the hostname and check
// the resolved IP — but for the briefing fetch + image embed this
// hostname-only check meaningfully raises the bar.
//
// IPv6 handling: Node's URL.hostname returns IPv6 literals WRAPPED in
// brackets (`"[::1]"`, `"[::ffff:7f00:1]"`). The earlier regex only
// matched the un-bracketed form so `https://[::1]/` bypassed every
// check and let SSRF reach `127.0.0.1` via IPv4-mapped IPv6. We now
// strip brackets first and use `net.isIP` to authoritatively classify
// the IP family before pattern-matching.

import { isIP } from "net";

export function isPublicHttpsUrl(input: string | null | undefined): boolean {
  if (!input || typeof input !== "string") return false;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;

  let host = url.hostname.toLowerCase();
  // Strip the [..] brackets Node wraps IPv6 literals in.
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  // Hostname-form blocks (anything that resolves to localhost / metadata).
  if (host === "localhost" || host === "ip6-localhost") return false;
  if (host === "metadata.google.internal" || host === "metadata") return false;

  const family = isIP(host); // 0 = not IP, 4 = IPv4, 6 = IPv6

  if (family === 4) {
    // IPv4 literal — block loopback, RFC1918, link-local, all-zeros,
    // cloud metadata (169.254.169.254 covered by link-local), broadcast.
    if (/^127\./.test(host)) return false;
    if (/^10\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^169\.254\./.test(host)) return false;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return false; // 172.16/12
    if (/^0\./.test(host)) return false; // 0.0.0.0/8
    if (host === "255.255.255.255") return false;
    return true;
  }

  if (family === 6) {
    // IPv6 literal — block loopback, link-local (fe80::/10),
    // unique-local (fc00::/7 — both fc** and fd**), unspecified (::),
    // and IPv4-mapped IPv6 (::ffff:0:0/96) which sneaks IPv4 private
    // ranges in through the back door (`::ffff:7f00:1` = 127.0.0.1).
    if (host === "::1" || host === "::") return false;
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return false; // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return false; // fc00::/7 unique-local
    // IPv4-mapped: ::ffff:x.x.x.x or ::ffff:xxxx:xxxx — recurse on the
    // embedded IPv4 form by splitting off the last two hex groups.
    if (/^::ffff:/i.test(host)) {
      // Convert "::ffff:7f00:1" or "::ffff:127.0.0.1" → "127.0.0.1"
      const tail = host.slice(7); // drop "::ffff:"
      if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) {
        // dotted form — re-check via the IPv4 branch
        if (/^(?:127|10|192\.168|169\.254|0)\./.test(tail)) return false;
        if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(tail)) return false;
      } else {
        // hex form — convert two 16-bit groups to dotted-quad
        const parts = tail.split(":");
        if (parts.length === 2) {
          const hi = parseInt(parts[0] || "0", 16);
          const lo = parseInt(parts[1] || "0", 16);
          const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          if (/^(?:127|10|192\.168|169\.254|0)\./.test(dotted)) return false;
          if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(dotted)) return false;
        }
      }
    }
    return true;
  }

  // Plain hostname — allow. (We don't resolve DNS here; that's the
  // tradeoff documented above. The fetch-time re-check in briefing.ts
  // adds defense in depth.)
  return true;
}

export function isSafeRedirectUrl(input: string | null | undefined): boolean {
  if (!input || typeof input !== "string") return false;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  // http/https only — no javascript: / data: / file:.
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  // http allowed only on localhost (dev). Prod must be https.
  if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return false;
  }
  if (PROD_HOSTS.has(url.hostname)) return true;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
  const extra = publicAppHost();
  if (extra && url.hostname === extra) return true;
  return false;
}
