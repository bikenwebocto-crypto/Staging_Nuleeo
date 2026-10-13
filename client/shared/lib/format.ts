// Project-wide formatters. Olio is Cyprus-based with the euro as the default
// currency, so en-IE is the canonical locale (DD/MM/YYYY dates, €1,234.50).
// Use these instead of bespoke per-file Intl.NumberFormat calls so display
// stays consistent across owner/tenant/admin surfaces.

const DEFAULT_LOCALE = "en-IE";
const DEFAULT_CURRENCY = "EUR";

// Maps ISO 4217 currency codes to their display symbol where one exists.
// Falls back to the code itself (e.g. "USD") when no symbol is canonical.
const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
};

export function currencySymbol(code: string | undefined | null): string {
  if (!code) return CURRENCY_SYMBOLS[DEFAULT_CURRENCY];
  const upper = code.toUpperCase();
  return CURRENCY_SYMBOLS[upper] ?? upper;
}

type FormatCurrencyOpts = {
  // Default 2. Set to 0 for compact dashboard tiles.
  decimals?: number;
  // Override the ISO currency code. Defaults to EUR.
  currency?: string;
};

export function formatCurrency(amount: number, opts: FormatCurrencyOpts = {}): string {
  const { decimals = 2, currency = DEFAULT_CURRENCY } = opts;
  if (!Number.isFinite(amount)) return formatCurrency(0, opts);
  return new Intl.NumberFormat(DEFAULT_LOCALE, {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
}

// Dashboard variants — common shorthands so callers can express intent.
export const formatCurrencyCompact = (amount: number, currency?: string): string =>
  formatCurrency(amount, { decimals: 0, currency });

// Whole amounts drop the ".00"; anything with real cents keeps two decimals
// (29.00 → "€29", 29.50 → "€29.50"). Used by activity feeds where round
// numbers are common and trailing zeros are visual noise. We round to whole
// cents ONCE and let both the keep-decimals decision AND the rendered value
// derive from that single integer, so they can never disagree at a
// floating-point cent boundary (e.g. an x.xx5 amount from percentage rent
// indexation would otherwise round one way for the decision and another for
// display, silently dropping a cent). `|| 0` also normalises -0 → 0 so a value
// that rounds to zero never leaks a misleading minus sign.
function toCents(amount: number): number {
  return Number.isFinite(amount) ? Math.round(amount * 100) || 0 : 0;
}

// Full currency string (symbol + amount) with the trailing ".00" trimmed off
// whole amounts. For callers that pass an ISO currency code, like the owner/
// tenant dashboard activity widgets.
export function formatCurrencyTrim(amount: number, opts: FormatCurrencyOpts = {}): string {
  const cents = toCents(amount);
  return formatCurrency(cents / 100, { ...opts, decimals: cents % 100 === 0 ? 0 : 2 });
}

// Numeric-only variant of the same ".00"-trimming rule (29 → "29",
// 1234.5 → "1,234.50"), for callers that prepend their own currency symbol
// (e.g. the Activity page, which keeps the symbol separate for fee/net lines).
export function formatAmountTrim(amount: number): string {
  const cents = toCents(amount);
  const decimals = cents % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat(DEFAULT_LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(cents / 100);
}

// Tile-sized compact currency for dashboards — drops to "k" / "M" suffix once
// the number gets large enough to crowd a small tile. Always EUR for now;
// extend when we ship multi-currency dashboards. Non-finite input → "—" so
// callers can stay uncluttered.
export function formatCurrencyShort(amount: number): string {
  if (!Number.isFinite(amount)) return "—";
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000) {
    return `${sign}€${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}€${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  }
  return formatCurrencyCompact(amount);
}

// Human-readable file size for upload lists / document rows. Bytes → "B",
// "KB", or "MB" with sensible precision (whole KB, one decimal MB).
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Date helpers — all default to en-IE which renders DD/MM/YYYY.
// Falls back to a dash for null/empty/invalid input so calling code can stay
// uncluttered.

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  // TZ-safe rendering for date-only inputs ("2026-05-15"). new Date()
  // parses these as UTC midnight; toLocaleDateString without an
  // explicit timeZone uses the browser TZ, so a São Paulo (UTC-3)
  // viewer sees "14 May 2026" instead of "15 May 2026". Detecting
  // date-only by absence of a `T` and rendering in UTC keeps the
  // displayed day equal to the stored day. Datetime strings (with `T`)
  // continue to render in local TZ as users expect.
  const isDateOnly = typeof iso === "string" && !iso.includes("T");
  return d.toLocaleDateString(DEFAULT_LOCALE, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(isDateOnly ? { timeZone: "UTC" } : {}),
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  // Date-only inputs ("2026-06-08", no `T`) carry no real time-of-day — they're
  // a calendar day a user picked (e.g. a back-dated ledger entry or a lease
  // signature date). Rendering them with a clock fabricates a time: new Date()
  // parses them as UTC midnight, which a Cyprus (UTC+3) viewer sees as "03:00".
  // Fall back to the date-only formatter (which also pins the day in UTC).
  // Genuine datetimes (with `T`) keep their hour:minute as before.
  if (typeof iso === "string" && !iso.includes("T")) return formatDate(iso);
  return d.toLocaleString(DEFAULT_LOCALE, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatDateNumeric(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  // Date-only inputs ("2026-07-01", no `T`) parse as UTC midnight; without an
  // explicit timeZone a negative-offset viewer (e.g. the Americas) sees the
  // previous calendar day. Pin date-only values to UTC so the rendered day
  // equals the stored day — same guard as formatDate/formatDateTime. (This is
  // the tenant dashboard's "Next Rent Due" formatter.)
  const isDateOnly = typeof iso === "string" && !iso.includes("T");
  return d.toLocaleDateString(DEFAULT_LOCALE, isDateOnly ? { timeZone: "UTC" } : {});
}

// Converts a date-only value from an <input type="date"> ("2026-06-08") into a
// full ISO timestamp anchored to the CURRENT local time-of-day, instead of
// midnight. `new Date("2026-06-08").toISOString()` parses as midnight UTC,
// which then renders as a misleading fixed clock time in the viewer's zone
// (e.g. "03:00" in Cyprus, UTC+3 — see formatDateTime). Anchoring to the local
// wall-clock means logging an event today records the real moment (a 14:04
// payment shows 14:04), while a back-dated entry lands at a realistic local
// time on the chosen day rather than 00:00Z. The calendar day is preserved
// because the Date is constructed in local time. Malformed input → now.
export function dateInputToIso(day: string | null | undefined): string {
  if (typeof day !== "string") return new Date().toISOString();
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return new Date().toISOString();
  const now = new Date();
  return new Date(
    y,
    m - 1,
    d,
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds(),
  ).toISOString();
}

// Inverse of dateInputToIso: turns a stored ISO timestamp back into the
// YYYY-MM-DD an <input type="date"> expects, so an edit form can pre-fill the
// calendar with the day the user originally picked. Datetime strings (with a
// `T`) are read in local time — matching dateInputToIso, which anchored them to
// the local wall-clock — so the calendar shows the same day, not a TZ-shifted
// one. Date-only strings ("2026-06-08") pass through unchanged. Malformed → "".
export function isoToDateInput(iso: string | null | undefined): string {
  if (typeof iso !== "string" || !iso) return "";
  if (!iso.includes("T")) {
    return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "";
  }
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatMonthAbbr(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(DEFAULT_LOCALE, { month: "short" });
}

// Long-form month + year ("May 2026") — used by group headers in feeds /
// transaction lists where the short abbreviation is too terse.
export function formatMonthYearLong(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(DEFAULT_LOCALE, { month: "long", year: "numeric" });
}

// Long-form day + month + year ("21 May 2026") — used by per-day group
// headers in transaction feeds.
export function formatDayMonthYearLong(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(DEFAULT_LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
