// Pure-function helpers used by routes.ts. Kept separate so they can be
// unit-tested without booting Firebase Admin or Express.

// 6 chars from a confusable-free base32 alphabet (no 0/O/1/I/L) → 32^6 ≈ 1.07B
// combinations. We do not check for collisions — at our user volume the
// birthday probability is negligible, and the value is namespaced with "OLIO-"
// so the displayed code is always recognizably an Olio portfolio id.
// Express 5 types route params and query values as `string | string[]`
// (path-to-regexp v8 can yield array params from `*`/`+` patterns, and repeated
// query keys like `?a=1&a=2` parse to an array). This app uses neither — every
// route param is a single segment and query keys are read as single values — so
// coerce to a plain string at the read site: pass strings through, take the first
// element of an array, and treat anything missing/odd as "". Keeps handlers
// reading `req.params.x` / `req.query.x` as the strings they are at runtime.
export function reqStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : "";
  return "";
}

export const PORTFOLIO_ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generatePortfolioId(): string {
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += PORTFOLIO_ID_ALPHABET.charAt(
      Math.floor(Math.random() * PORTFOLIO_ID_ALPHABET.length),
    );
  }
  return `OLIO-${suffix}`;
}

// Split an OAuth-provider `displayName` ("First Middle Last") into firstName
// and lastName. Single-word names go entirely into firstName so we never
// silently lose the user's only known name. Empty input yields empty strings.
export function splitDisplayName(displayName: string | undefined): {
  firstName: string;
  lastName: string;
} {
  const parts = (displayName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}
