import { describe, it, expect } from "vitest";
import { sanitizeText } from "./unicodeSanitize";

describe("sanitizeText", () => {
  it("passes plain ASCII unchanged", () => {
    expect(sanitizeText("John Doe", 100)).toBe("John Doe");
  });

  it("preserves regular non-ASCII (accents, CJK, emoji)", () => {
    expect(sanitizeText("Pétros Αλεξάνδρου", 100)).toBe("Pétros Αλεξάνδρου");
    expect(sanitizeText("田中太郎", 100)).toBe("田中太郎");
    expect(sanitizeText("hello 👋", 100)).toBe("hello 👋");
  });

  it("preserves whitespace that's part of legitimate text", () => {
    expect(sanitizeText("first  second\tthird\nfourth", 100)).toBe("first  second\tthird\nfourth");
  });

  it("respects the length cap", () => {
    expect(sanitizeText("abcdefghij", 5)).toBe("abcde");
  });

  it("NFKC-normalizes compatibility variants", () => {
    // Fullwidth "Hello" → NFKC → "Hello"
    expect(sanitizeText("Hello", 100)).toBe("Hello");
  });

  it("returns empty for empty input", () => {
    expect(sanitizeText("", 100)).toBe("");
  });

  // ── Security regression set ─────────────────────────────────────────
  // Each test below targets an attack that worked BEFORE this helper
  // was wired in. Locking them in so a future refactor can't quietly
  // re-open the hole.

  it("strips RTL override (U+202E) — admin user-list anti-spoof", () => {
    // "John‮gnirT" would render as "TringJohn" in many admin
    // surfaces — used to impersonate other users in conversation
    // lists / push titles.
    const out = sanitizeText("John‮gnirT", 100);
    expect(out).toBe("JohngnirT");
    expect(out.includes("‮")).toBe(false);
  });

  it("strips all bidi controls (U+202A–U+202E)", () => {
    for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e]) {
      const ch = String.fromCodePoint(code);
      expect(sanitizeText(`a${ch}b`, 10)).toBe("ab");
    }
  });

  it("strips zero-width characters (U+200B–U+200D)", () => {
    for (const code of [0x200b, 0x200c, 0x200d]) {
      const ch = String.fromCodePoint(code);
      expect(sanitizeText(`a${ch}b`, 10)).toBe("ab");
    }
  });

  it("strips BOM / zero-width no-break space (U+FEFF)", () => {
    expect(sanitizeText("a﻿b", 10)).toBe("ab");
  });

  it("strips LRM/RLM (U+200E–U+200F)", () => {
    expect(sanitizeText("a‎b‏c", 10)).toBe("abc");
  });

  it("strips word-joiner + invisible-formatting (U+2060–U+206F)", () => {
    for (const code of [0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x206f]) {
      const ch = String.fromCodePoint(code);
      expect(sanitizeText(`a${ch}b`, 10)).toBe("ab");
    }
  });

  it("strips C0 controls below \\t (\\b, NUL etc.)", () => {
    expect(sanitizeText("a\x00b", 10)).toBe("ab");
    expect(sanitizeText("a\x07b", 10)).toBe("ab"); // bell
    expect(sanitizeText("a\x08b", 10)).toBe("ab"); // backspace
  });

  it("strips C0 controls above \\r (VT, FF, etc.) but keeps \\n \\r \\t", () => {
    expect(sanitizeText("a\x0Bb", 10)).toBe("ab"); // vertical tab
    expect(sanitizeText("a\x0Cb", 10)).toBe("ab"); // form feed
    expect(sanitizeText("a\nb", 10)).toBe("a\nb");
    expect(sanitizeText("a\rb", 10)).toBe("a\rb");
    expect(sanitizeText("a\tb", 10)).toBe("a\tb");
  });

  it("strips DEL (U+007F) and C1 controls (U+0080–U+009F)", () => {
    expect(sanitizeText("a\x7Fb", 10)).toBe("ab");
    expect(sanitizeText("a\x80b", 10)).toBe("ab");
    expect(sanitizeText("a\x9Fb", 10)).toBe("ab");
  });

  it("applies the cap AFTER stripping (no silent truncation of unicode)", () => {
    // 5 RTL-overrides + "Hello" — should yield "Hello" of length 5.
    const out = sanitizeText("‮‮‮‮‮Hello", 5);
    expect(out).toBe("Hello");
  });

  it("doesn't break surrogate pairs (emoji)", () => {
    // Family emoji is multi-codepoint with zero-width joiners between
    // people. We strip the U+200D ZWJ, which means a family emoji
    // collapses to its first component — acceptable tradeoff since the
    // ZWJ stripping is essential for anti-spoof, and emoji ZWJ in user
    // display names is exotic.
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    expect(sanitizeText(family, 100)).toBe("\u{1F468}\u{1F469}\u{1F467}");
  });
});
