// Unicode hygiene for free-text user input that lands in admin
// surfaces, push titles, or rendered names. Without this:
//   - A name registered as "John‮gnirT" renders backwards in admin
//     user lists ("TringJohn") because of the RTL override (U+202E).
//   - Zero-width chars (U+200B…U+200D, U+FEFF) let an attacker register
//     a display name that's pixel-identical to another user's.
//   - Compatibility variants (e.g. fullwidth ASCII) treated as distinct
//     by code that does string equality.
//
// `sanitizeText` runs NFKC normalization then strips:
//   C0 controls (skip \t \n \r — those are line content, not hostile)
//   U+007F DEL
//   U+0080–U+009F C1 controls
//   U+200B–U+200D zero-width + U+200E–U+200F LRM/RLM
//   U+202A–U+202E bidi embed / override
//   U+2060–U+206F word-joiner + invisible-formatting
//   U+FEFF BOM (zero-width no-break space)
//
// Use this for any user-supplied display string (firstName, lastName,
// address, etc.). Don't use for URLs or rich-text — strip-all is too
// aggressive there.

export function sanitizeText(s: string, cap: number): string {
  const normalized = s.normalize("NFKC");
  const filtered: string[] = [];
  for (const ch of normalized) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x08) continue;
    if (c === 0x0b || c === 0x0c) continue;
    if (c >= 0x0e && c <= 0x1f) continue;
    if (c === 0x7f) continue;
    if (c >= 0x80 && c <= 0x9f) continue;
    if (c >= 0x200b && c <= 0x200f) continue;
    if (c >= 0x202a && c <= 0x202e) continue;
    if (c >= 0x2060 && c <= 0x206f) continue;
    if (c === 0xfeff) continue;
    filtered.push(ch);
  }
  return filtered.join("").slice(0, cap);
}
