// Dashboard + workspace design tokens.
//
// Values are the LOCKED Nuleeo desktop tokens (Figma "final direction",
// 20 Oct 2026): surface/page #060A0B, surface/card #111618 (radius 24),
// surface/raised #1C2325, text primary/secondary/tertiary, brand lime (avatar,
// Pro bar, chat only), modern-aqua for charts/links, and status colours.
// Rule: no dividers or borders — spacing separates rows.
//
// Kept in a plain module (not the component file) so the React Refresh rule
// stays happy and the palette can be imported by charts as well as cards.
export const PALETTE = {
  bg: "#060A0B",
  card: "#111618",
  cardAlt: "#1C2325",
  // Kept for existing callers; with the no-borders rule this matches raised.
  border: "#1C2325",
  borderHover: "#2A3134",
  text: "#F4F4F2",
  muted: "#A3A7AB",
  tertiary: "#7D8287",
  lime: "#E2F645",
  cyan: "#73C2CD",
  green: "#7BD88F",
  amber: "#F5B65C",
  coral: "#FF7A7A",
  focus: "#A78C68",
} as const;

export const CARD = "rounded-[24px] bg-[#111618]";
export const CARD_ALT = "rounded-[24px] bg-[#1C2325]";
