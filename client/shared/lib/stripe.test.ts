import { describe, it, expect, vi } from "vitest";

// Importing ./stripe pulls in ./firebase, which calls initializeApp() at module
// load from import.meta.env. Stub it so the pure helper under test needs no
// Firebase env or network.
vi.mock("./firebase", () => ({ auth: {}, db: {}, stripeFunctions: {} }));

const { dedupePreferCanonical } = await import("./stripe");

type PP = Parameters<typeof dedupePreferCanonical>[0][number];
const mk = (plan: "advance" | "pro", amount: number, id: string): PP => ({
  plan,
  productId: `prod_${id}`,
  productName: id,
  priceId: `price_${id}`,
  amount,
  currency: "EUR",
  interval: "year",
});

describe("dedupePreferCanonical", () => {
  it("returns a single product per tier unchanged", () => {
    const out = dedupePreferCanonical([mk("advance", 69, "growth"), mk("pro", 290, "pro")]);
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.priceId).sort()).toEqual(["price_growth", "price_pro"]);
  });

  it("prefers the canonical-priced product when a stale duplicate sorts first (the sandbox bug)", () => {
    // Sandbox Growth (€49.99) appears before live Growth (€69) — the exact shape
    // that handed a sandbox price to the live account ("No such price").
    const out = dedupePreferCanonical([mk("advance", 49.99, "sandbox"), mk("advance", 69, "live")]);
    expect(out).toHaveLength(1);
    expect(out[0].priceId).toBe("price_live");
  });

  it("prefers canonical Pro (€290) over a sandbox €299.99 regardless of order", () => {
    const a = dedupePreferCanonical([mk("pro", 299.99, "sandbox"), mk("pro", 290, "live")]);
    const b = dedupePreferCanonical([mk("pro", 290, "live"), mk("pro", 299.99, "sandbox")]);
    expect(a[0].priceId).toBe("price_live");
    expect(b[0].priceId).toBe("price_live");
  });

  it("keeps the first-seen product when neither duplicate matches the canonical amount", () => {
    const out = dedupePreferCanonical([mk("advance", 49.99, "first"), mk("advance", 59, "second")]);
    expect(out).toHaveLength(1);
    expect(out[0].priceId).toBe("price_first");
  });
});
