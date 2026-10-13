// CSV cell-formatting helpers. The big one is `csvCell` — it does
// RFC 4180 quoting AND neutralizes formula-injection prefixes so a
// tenant who puts `=HYPERLINK(...)` in their payment notes can't
// exfiltrate row data when the owner opens the export in Excel/
// Google Sheets.
//
// Used by GET /api/owner/analytics/export. Extracted here so the
// formula-trigger set is testable + documented in one place.

// Characters Excel + Google Sheets treat as the start of a formula.
// `=` / `+` / `-` / `@` are the well-known ones; `\t` and `\r` also
// trigger formula mode in some Excel locales because they can be
// embedded into a column boundary; `\` is accepted as a formula
// prefix in some Microsoft locales for command injection via DDE.
export const FORMULA_TRIGGERS = /^[=+\-@\t\r\\]/;

// Format a single value as a CSV cell. Steps:
//   1. Coerce null/undefined → empty string.
//   2. If the first char triggers formula evaluation, prefix a single
//      quote so the spreadsheet stores it as text. The quote is
//      consumed on display so the user sees the original value.
//   3. RFC 4180 quoting: wrap in double quotes, double up any embedded
//      double quotes.
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (s.length > 0 && FORMULA_TRIGGERS.test(s)) {
    s = `'${s}`;
  }
  return `"${s.replace(/"/g, '""')}"`;
}
