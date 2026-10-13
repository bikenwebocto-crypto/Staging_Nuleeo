import { describe, it, expect } from "vitest";
import {
  formatCurrency,
  formatCurrencyCompact,
  formatCurrencyShort,
  formatCurrencyTrim,
  formatAmountTrim,
  formatDate,
  formatDateTime,
  formatDateNumeric,
  dateInputToIso,
  formatMonthAbbr,
  formatMonthYearLong,
  formatDayMonthYearLong,
  currencySymbol,
} from "./format";

describe("formatCurrency", () => {
  it("renders an integer with two decimals", () => {
    expect(formatCurrency(1234)).toBe("€1,234.00");
  });

  // Regression: TenantDashboard used to render `€{n.toLocaleString()}<span>.00</span>`,
  // producing `€1,234.5.00` for non-integer rents. The shared helper must format
  // decimals correctly without any trailing `.00` band-aid.
  it("renders a non-integer rent without double-decimal artifacts", () => {
    expect(formatCurrency(1234.5)).toBe("€1,234.50");
    expect(formatCurrency(1234.56)).toBe("€1,234.56");
  });

  it("renders zero as €0.00", () => {
    expect(formatCurrency(0)).toBe("€0.00");
  });

  it("renders negative amounts with the locale's minus prefix", () => {
    // en-IE EUR negatives use the leading minus form: -€1,234.00
    expect(formatCurrency(-1234)).toBe("-€1,234.00");
  });

  it("falls back to €0.00 for non-finite input rather than throwing", () => {
    expect(formatCurrency(NaN)).toBe("€0.00");
    expect(formatCurrency(Infinity)).toBe("€0.00");
    expect(formatCurrency(-Infinity)).toBe("€0.00");
  });

  it("honors the decimals option", () => {
    expect(formatCurrency(1234, { decimals: 0 })).toBe("€1,234");
    expect(formatCurrency(1234.5, { decimals: 0 })).toBe("€1,235");
    expect(formatCurrency(1234.567, { decimals: 3 })).toBe("€1,234.567");
  });

  it("supports overriding the currency code", () => {
    // en-IE renders USD as "US$1,234.00"; assert via substring so the test
    // doesn't break if ICU/CLDR data shifts the exact prefix.
    expect(formatCurrency(1234, { currency: "USD" })).toMatch(/1,234\.00/);
    expect(formatCurrency(1234, { currency: "USD" })).toMatch(/\$/);
    expect(formatCurrency(1234, { currency: "GBP" })).toContain("£");
  });
});

describe("formatCurrencyCompact", () => {
  it("rounds to whole euros", () => {
    expect(formatCurrencyCompact(1234)).toBe("€1,234");
    expect(formatCurrencyCompact(1234.5)).toBe("€1,235");
    expect(formatCurrencyCompact(1234.49)).toBe("€1,234");
  });

  it("handles large numbers with thousands separators", () => {
    expect(formatCurrencyCompact(1234567)).toBe("€1,234,567");
  });

  it("renders zero without decimals", () => {
    expect(formatCurrencyCompact(0)).toBe("€0");
  });

  it("passes through the currency override", () => {
    expect(formatCurrencyCompact(1234, "GBP")).toContain("£");
    expect(formatCurrencyCompact(1234, "GBP")).toMatch(/1,234\b/);
  });
});

describe("formatCurrencyTrim", () => {
  it("drops the .00 on whole amounts", () => {
    expect(formatCurrencyTrim(29)).toBe("€29");
    expect(formatCurrencyTrim(1234)).toBe("€1,234");
    expect(formatCurrencyTrim(0)).toBe("€0");
  });

  it("keeps two decimals when there are real cents", () => {
    expect(formatCurrencyTrim(29.5)).toBe("€29.50");
    expect(formatCurrencyTrim(29.55)).toBe("€29.55");
    expect(formatCurrencyTrim(1234.5)).toBe("€1,234.50");
  });

  it("ignores sub-cent floating-point dust when deciding", () => {
    // 29.004 rounds to 29.00 → treated as whole; 29.006 rounds to 29.01.
    expect(formatCurrencyTrim(29.004)).toBe("€29");
    expect(formatCurrencyTrim(29.006)).toBe("€29.01");
  });

  it("never shows a bare whole number that secretly carries a rounded-up cent", () => {
    // The decimals decision and the rendered value both derive from one
    // rounded-to-cents integer, so any trimmed (no ".") output is a true whole
    // euro — never a value that quietly rounded a cent up. Exercised across
    // x.xx5 float boundaries where a naive two-step round could diverge.
    for (const v of [1.005, 1.015, 2.675, 99.995, 0.005]) {
      const trimmed = formatCurrencyTrim(v);
      if (!trimmed.includes(".")) {
        // Same cents rounding, forced to 2 decimals, must read N.00.
        expect(formatCurrency(Math.round(v * 100) / 100, { decimals: 2 })).toMatch(/\.00$/);
      }
    }
  });

  it("never leaks a minus sign for values that round to zero", () => {
    expect(formatCurrencyTrim(-0)).toBe("€0");
    expect(formatCurrencyTrim(-0.001)).toBe("€0");
  });

  it("preserves the leading minus for negatives", () => {
    expect(formatCurrencyTrim(-29)).toBe("-€29");
    expect(formatCurrencyTrim(-29.5)).toBe("-€29.50");
  });

  it("passes through the currency override", () => {
    expect(formatCurrencyTrim(29, { currency: "GBP" })).toBe("£29");
    expect(formatCurrencyTrim(29.5, { currency: "GBP" })).toBe("£29.50");
  });

  it("falls back to €0 for non-finite input", () => {
    expect(formatCurrencyTrim(NaN)).toBe("€0");
    expect(formatCurrencyTrim(Infinity)).toBe("€0");
  });
});

describe("formatAmountTrim", () => {
  it("drops the .00 on whole amounts, no currency symbol", () => {
    expect(formatAmountTrim(29)).toBe("29");
    expect(formatAmountTrim(1234)).toBe("1,234");
    expect(formatAmountTrim(0)).toBe("0");
  });

  it("keeps two decimals when there are real cents", () => {
    expect(formatAmountTrim(29.5)).toBe("29.50");
    expect(formatAmountTrim(29.55)).toBe("29.55");
    expect(formatAmountTrim(1234.5)).toBe("1,234.50");
  });

  it('falls back to "0" for non-finite input', () => {
    expect(formatAmountTrim(NaN)).toBe("0");
    expect(formatAmountTrim(Infinity)).toBe("0");
  });

  it('normalises negative zero to a clean "0"', () => {
    expect(formatAmountTrim(-0)).toBe("0");
    expect(formatAmountTrim(-0.001)).toBe("0");
  });
});

describe("formatCurrencyShort", () => {
  it("renders amounts under 1k via the compact (no-decimal) formatter", () => {
    expect(formatCurrencyShort(0)).toBe("€0");
    expect(formatCurrencyShort(999)).toBe("€999");
  });

  it("uses a `k` suffix between 1k and 1M, with one decimal under 10k", () => {
    expect(formatCurrencyShort(1234)).toBe("€1.2k");
    expect(formatCurrencyShort(9999)).toBe("€10.0k");
    // 10k and up drops to whole-thousand for compactness
    expect(formatCurrencyShort(12345)).toBe("€12k");
    expect(formatCurrencyShort(999_000)).toBe("€999k");
  });

  it("uses an `M` suffix above 1M", () => {
    expect(formatCurrencyShort(1_234_567)).toBe("€1.2M");
    expect(formatCurrencyShort(12_500_000)).toBe("€13M");
  });

  it("preserves sign for negative amounts", () => {
    expect(formatCurrencyShort(-1234)).toBe("-€1.2k");
    expect(formatCurrencyShort(-1_234_567)).toBe("-€1.2M");
  });

  it("falls back to the em-dash for non-finite input", () => {
    expect(formatCurrencyShort(NaN)).toBe("—");
    expect(formatCurrencyShort(Infinity)).toBe("—");
  });
});

describe("formatMonthYearLong", () => {
  it("returns the em-dash placeholder for invalid input", () => {
    expect(formatMonthYearLong(null)).toBe("—");
    expect(formatMonthYearLong("")).toBe("—");
    expect(formatMonthYearLong("not a date")).toBe("—");
  });

  it("renders long month + numeric year", () => {
    expect(formatMonthYearLong("2026-05-21T00:00:00Z")).toBe("May 2026");
    expect(formatMonthYearLong("2026-01-15T00:00:00Z")).toBe("January 2026");
    expect(formatMonthYearLong("2026-12-31T00:00:00Z")).toBe("December 2026");
  });
});

describe("formatDayMonthYearLong", () => {
  it("returns the em-dash placeholder for invalid input", () => {
    expect(formatDayMonthYearLong(null)).toBe("—");
    expect(formatDayMonthYearLong("nope")).toBe("—");
  });

  it("renders day + long month + numeric year", () => {
    expect(formatDayMonthYearLong("2026-05-21T00:00:00Z")).toBe("21 May 2026");
    expect(formatDayMonthYearLong("2026-12-31T00:00:00Z")).toBe("31 December 2026");
  });
});

describe("formatDate", () => {
  it("returns the em-dash placeholder for null/undefined/empty", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("")).toBe("—");
  });

  it("returns the em-dash placeholder for invalid input", () => {
    expect(formatDate("not a date")).toBe("—");
    expect(formatDate("2026-99-99")).toBe("—");
  });

  it("renders a valid ISO date in en-IE day-month-year form", () => {
    const out = formatDate("2026-05-21T00:00:00Z");
    expect(out).toContain("21");
    expect(out).toContain("May");
    expect(out).toContain("2026");
  });
});

describe("formatDateTime", () => {
  it("returns the em-dash placeholder for invalid input", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("garbage")).toBe("—");
  });

  it("includes both date and 24-hour time tokens", () => {
    const out = formatDateTime("2026-05-21T14:30:00Z");
    expect(out).toContain("21");
    expect(out).toContain("May");
    expect(out).toContain("2026");
    // hour12 is false, so the rendered hour digits should be present somewhere
    // in the string (exact format depends on locale separator).
    expect(out).toMatch(/\d{2}:\d{2}/);
  });

  it("renders a date-only input WITHOUT a fabricated clock time", () => {
    // A bare "YYYY-MM-DD" carries no real time-of-day; rendering it as
    // midnight UTC would surface a misleading "03:00" in UTC+3. It must fall
    // back to the date-only formatter and show no hour:minute.
    const out = formatDateTime("2026-05-21");
    expect(out).toContain("21");
    expect(out).toContain("May");
    expect(out).toContain("2026");
    expect(out).not.toMatch(/\d{2}:\d{2}/);
    expect(out).toBe(formatDate("2026-05-21"));
  });
});

describe("dateInputToIso", () => {
  it("falls back to now for malformed input", () => {
    // A valid full ISO timestamp, not "—".
    expect(dateInputToIso("")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(dateInputToIso(null)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(dateInputToIso("not-a-date")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("produces a full ISO timestamp anchored to the chosen calendar day", () => {
    const iso = dateInputToIso("2026-06-08");
    // Full timestamp (has the time component + Z), not a bare date.
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/);
    // The calendar day round-trips in LOCAL time regardless of the runner's
    // timezone (the Date is constructed in local time), so it never shifts to
    // a different day the way midnight-UTC parsing would.
    const back = new Date(iso);
    expect(back.getFullYear()).toBe(2026);
    expect(back.getMonth()).toBe(5); // June, 0-indexed
    expect(back.getDate()).toBe(8);
  });

  it("does not pin the time to midnight UTC", () => {
    // The bug was a hard 00:00:00.000Z stamp. Unless the test happens to run at
    // exactly local midnight, the anchored time reflects the current wall clock.
    const now = new Date();
    const atMidnight = now.getHours() === 0 && now.getMinutes() === 0 && now.getSeconds() === 0;
    if (!atMidnight) {
      expect(dateInputToIso("2026-06-08")).not.toBe("2026-06-08T00:00:00.000Z");
    }
  });
});

describe("formatDateNumeric", () => {
  it("returns the em-dash placeholder for invalid input", () => {
    expect(formatDateNumeric(undefined)).toBe("—");
    expect(formatDateNumeric("nope")).toBe("—");
  });

  it("renders a numeric date in en-IE form", () => {
    const out = formatDateNumeric("2026-05-21T00:00:00Z");
    // en-IE numeric date is DD/MM/YYYY — assert on the digit pattern rather
    // than exact characters so the test isn't fragile to non-ASCII separators.
    expect(out).toMatch(/21/);
    expect(out).toMatch(/2026/);
    // Slash separators are standard for en-IE numeric format.
    expect(out).toContain("/");
  });
});

describe("formatMonthAbbr", () => {
  it("returns the em-dash placeholder for invalid input", () => {
    expect(formatMonthAbbr(null)).toBe("—");
    expect(formatMonthAbbr("")).toBe("—");
  });

  it("returns the abbreviated month name for a valid ISO date", () => {
    expect(formatMonthAbbr("2026-05-21T00:00:00Z")).toBe("May");
    expect(formatMonthAbbr("2026-01-01T00:00:00Z")).toBe("Jan");
    expect(formatMonthAbbr("2026-12-31T00:00:00Z")).toBe("Dec");
  });
});

describe("currencySymbol", () => {
  it("maps known ISO codes to their canonical symbols", () => {
    expect(currencySymbol("EUR")).toBe("€");
    expect(currencySymbol("USD")).toBe("$");
    expect(currencySymbol("GBP")).toBe("£");
  });

  it("is case-insensitive", () => {
    expect(currencySymbol("eur")).toBe("€");
    expect(currencySymbol("usd")).toBe("$");
  });

  it("falls back to the code itself for unknown currencies", () => {
    expect(currencySymbol("JPY")).toBe("JPY");
    expect(currencySymbol("ZAR")).toBe("ZAR");
  });

  it("falls back to the euro symbol when input is missing", () => {
    expect(currencySymbol(undefined)).toBe("€");
    expect(currencySymbol(null)).toBe("€");
    expect(currencySymbol("")).toBe("€");
  });
});
