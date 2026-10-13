import { describe, it, expect } from "vitest";
import {
  EUROPEAN_COUNTRIES,
  findCountryByName,
  getCountryCode,
  validatePostalCode,
  DEFAULT_COUNTRY_CODE,
} from "./countries";

describe("EUROPEAN_COUNTRIES dataset integrity", () => {
  it("every country's own example postal code matches its own regex", () => {
    const broken = EUROPEAN_COUNTRIES.filter(
      (c) => c.postal && !c.postal.regex.test(c.postal.example),
    ).map((c) => `${c.name} (${c.code}): "${c.postal!.example}"`);
    expect(broken).toEqual([]);
  });

  it("has unique, lowercase ISO2 codes and includes Cyprus as the default", () => {
    const codes = EUROPEAN_COUNTRIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => c === c.toLowerCase() && c.length === 2)).toBe(true);
    expect(codes).toContain(DEFAULT_COUNTRY_CODE);
    expect(findCountryByName("Cyprus")?.code).toBe("cy");
  });
});

describe("findCountryByName", () => {
  it("matches case- and whitespace-insensitively", () => {
    expect(findCountryByName("  cYpRuS ")?.code).toBe("cy");
    expect(findCountryByName("United Kingdom")?.code).toBe("gb");
  });

  it("returns undefined for unknown / empty names", () => {
    expect(findCountryByName("Imaginary Country")).toBeUndefined();
    expect(findCountryByName("")).toBeUndefined();
    expect(findCountryByName(null)).toBeUndefined();
  });
});

describe("getCountryCode", () => {
  it("resolves known names to their ISO2", () => {
    expect(getCountryCode("Cyprus")).toBe("cy");
    expect(getCountryCode("Germany")).toBe("de");
  });

  it("falls back to Cyprus for unknown / legacy values", () => {
    expect(getCountryCode("Imaginary Country")).toBe(DEFAULT_COUNTRY_CODE);
    expect(getCountryCode("")).toBe(DEFAULT_COUNTRY_CODE);
    expect(getCountryCode(undefined)).toBe(DEFAULT_COUNTRY_CODE);
  });
});

describe("validatePostalCode", () => {
  it("accepts a well-formed code for the country", () => {
    expect(validatePostalCode("Cyprus", "1010").valid).toBe(true);
    expect(validatePostalCode("Netherlands", "1011 AB").valid).toBe(true);
    expect(validatePostalCode("United Kingdom", "SW1A 1AA").valid).toBe(true);
    // Case-insensitive for letter-bearing formats.
    expect(validatePostalCode("United Kingdom", "sw1a 1aa").valid).toBe(true);
  });

  it("rejects a malformed code and returns a country-specific message", () => {
    const r = validatePostalCode("Cyprus", "8008008008008");
    expect(r.valid).toBe(false);
    expect(r.message).toContain("Cyprus");
    expect(r.message).toContain("1010"); // the example
  });

  it("treats an empty value as valid (presence is enforced separately)", () => {
    expect(validatePostalCode("Cyprus", "").valid).toBe(true);
    expect(validatePostalCode("Cyprus", "   ").valid).toBe(true);
  });

  it("never blocks for an unknown country or one without a postal format", () => {
    expect(validatePostalCode("Imaginary Country", "8008008008008").valid).toBe(true);
    expect(validatePostalCode("", "whatever").valid).toBe(true);
  });

  it("ignores surrounding whitespace on the value", () => {
    expect(validatePostalCode("Cyprus", "  1010  ").valid).toBe(true);
  });
});
