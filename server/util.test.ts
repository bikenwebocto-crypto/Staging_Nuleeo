import { describe, it, expect } from "vitest";
import { PORTFOLIO_ID_ALPHABET, generatePortfolioId, splitDisplayName } from "./util";

describe("splitDisplayName", () => {
  it("returns empty firstName/lastName when input is undefined", () => {
    expect(splitDisplayName(undefined)).toEqual({ firstName: "", lastName: "" });
  });

  it("returns empty when input is whitespace only", () => {
    expect(splitDisplayName("   ")).toEqual({ firstName: "", lastName: "" });
  });

  it("puts a single-word name entirely into firstName", () => {
    expect(splitDisplayName("Cher")).toEqual({ firstName: "Cher", lastName: "" });
  });

  it("splits a typical two-word name", () => {
    expect(splitDisplayName("Ada Lovelace")).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("keeps middle names with the lastName so nothing is silently dropped", () => {
    expect(splitDisplayName("Ada Augusta King-Noel Lovelace")).toEqual({
      firstName: "Ada",
      lastName: "Augusta King-Noel Lovelace",
    });
  });

  it("collapses runs of whitespace", () => {
    expect(splitDisplayName("  Ada    Lovelace  ")).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });
});

describe("generatePortfolioId", () => {
  it("starts with the OLIO- namespace", () => {
    expect(generatePortfolioId()).toMatch(/^OLIO-/);
  });

  it("produces a 6-char suffix from the confusable-free alphabet", () => {
    const id = generatePortfolioId();
    const suffix = id.slice("OLIO-".length);
    expect(suffix).toHaveLength(6);
    for (const ch of suffix) {
      expect(PORTFOLIO_ID_ALPHABET).toContain(ch);
    }
  });

  it("never produces a suffix with visually ambiguous characters (0/O/1/I/L)", () => {
    for (let i = 0; i < 100; i++) {
      const suffix = generatePortfolioId().slice("OLIO-".length);
      expect(suffix).not.toMatch(/[01ILO]/);
    }
  });
});
