import { describe, it, expect } from "vitest";
import {
  COUNTRY_CODES,
  DEFAULT_PHONE_COUNTRY,
  findPhoneCountry,
  parseStoredPhone,
  combinePhone,
} from "./phoneCountries";

describe("COUNTRY_CODES dataset integrity", () => {
  it("has unique ISO2 codes and Cyprus as the default/first entry", () => {
    const codes = COUNTRY_CODES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(DEFAULT_PHONE_COUNTRY.code).toBe("CY");
    expect(COUNTRY_CODES[0].code).toBe("CY");
  });

  it("every dial code starts with + and every length is positive", () => {
    const broken = COUNTRY_CODES.filter((c) => !/^\+\d+$/.test(c.dial) || c.len <= 0);
    expect(broken).toEqual([]);
  });
});

describe("parseStoredPhone", () => {
  it("defaults to Cyprus with an empty number for blank/nullish input", () => {
    expect(parseStoredPhone("")).toEqual({ country: "CY", national: "" });
    expect(parseStoredPhone("   ")).toEqual({ country: "CY", national: "" });
    expect(parseStoredPhone(null)).toEqual({ country: "CY", national: "" });
    expect(parseStoredPhone(undefined)).toEqual({ country: "CY", national: "" });
  });

  it("splits the canonical stored format into country + national digits", () => {
    expect(parseStoredPhone("+357 99123456")).toEqual({ country: "CY", national: "99123456" });
    expect(parseStoredPhone("+44 7911123456")).toEqual({ country: "GB", national: "7911123456" });
  });

  it("matches the longest dial-code prefix, not a shorter coincidence", () => {
    // "+357…" must resolve to Cyprus (+357), never Greece (+30) or others.
    expect(parseStoredPhone("+357 99123456").country).toBe("CY");
    // "+3580…" (Finland +358) must not collapse to a shorter code.
    expect(parseStoredPhone("+358 401234567").country).toBe("FI");
  });

  it("handles shared dial codes deterministically (first listed wins)", () => {
    // US and Canada both use +1; US is listed first, so a stored "+1 …" always
    // resolves to US. This is a known, lossy round-trip for non-first +1
    // countries (Canada) — the dialable number is unaffected, only the picker
    // label. Acceptable for a Cyprus-focused product.
    expect(parseStoredPhone("+1 2025550123").country).toBe("US");
  });

  it("tolerates a stored value with no spaces", () => {
    expect(parseStoredPhone("+35799123456")).toEqual({ country: "CY", national: "99123456" });
  });

  it("treats a leading 00 international prefix like +", () => {
    expect(parseStoredPhone("0035799123456")).toEqual({ country: "CY", national: "99123456" });
    expect(parseStoredPhone("00 357 99 12 34 56")).toEqual({ country: "CY", national: "99123456" });
  });

  it("keeps legacy free-text numbers under the default country", () => {
    expect(parseStoredPhone("99123456")).toEqual({ country: "CY", national: "99123456" });
  });

  it("falls back to the default country for an unknown dial code", () => {
    expect(parseStoredPhone("+999 12345")).toEqual({ country: "CY", national: "99912345" });
  });
});

describe("combinePhone", () => {
  it("joins dial code and national digits in the canonical format", () => {
    expect(combinePhone("CY", "99123456")).toBe("+357 99123456");
    expect(combinePhone("GB", "7911123456")).toBe("+44 7911123456");
  });

  it("returns an empty string when there is no number (never a bare dial code)", () => {
    expect(combinePhone("CY", "")).toBe("");
    expect(combinePhone("GB", "   ")).toBe("");
  });

  it("strips stray non-digits from the national part", () => {
    expect(combinePhone("CY", "99 12 34 56")).toBe("+357 99123456");
  });

  it("falls back to the default dial code for an unknown country", () => {
    expect(combinePhone("ZZ", "12345678")).toBe("+357 12345678");
  });

  it("round-trips with parseStoredPhone", () => {
    const stored = "+49 15123456789";
    const { country, national } = parseStoredPhone(stored);
    expect(combinePhone(country, national)).toBe(stored);
  });
});

describe("findPhoneCountry", () => {
  it("resolves a known code and returns undefined otherwise", () => {
    expect(findPhoneCountry("CY")?.dial).toBe("+357");
    expect(findPhoneCountry("ZZ")).toBeUndefined();
    expect(findPhoneCountry(null)).toBeUndefined();
  });
});
