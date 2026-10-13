// Tests for the owner-plan upgrade billing service. The money path here is the
// FIRST direct stripe.subscriptions.update() in the server, so the parameter
// mapping (no proration credit, fresh cycle, one-time coupon) and the
// eligibility gating are the invariants that matter. Stripe + Firestore are
// mocked; the exact invoice behavior is verified separately in Stripe test mode.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mutable mock state (mock-prefixed for vitest's hoist check) ─────────────
let mockPlan = "advance";
let mockProducts: any[] = [];
let mockPrices: any[] = [];
let mockCouponRetrieveErr: any = null;
let mockCreatedCoupons: any[] = [];
let mockSubsList: any[] = []; // stripe subscriptions.list
let mockUpdateCalls: any[] = [];
let mockUpdateReturn: any = {};
let mockSubsMirror: any[] = []; // firestore customers/{uid}/subscriptions
let mockCustomerDoc: any = undefined; // customers/{uid}
let mockGiftDoc: any = undefined; // complimentaryPlans/{uid}
let mockGiftSetCalls: any[] = [];
let mockUpgradeTarget: number | null = 200; // config/planLabels.proUpgradeFirstCycleAmount

vi.mock("./commission", () => ({ resolveOwnerPlan: () => Promise.resolve(mockPlan) }));
vi.mock("./configCache", () => ({
  loadPlanLabels: () =>
    Promise.resolve({ plans: {}, proUpgradeFirstCycleAmount: mockUpgradeTarget }),
}));
vi.mock("./log", () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }));
vi.mock("../stripe", () => ({
  isStripeConfigured: () => true,
  stripe: () => ({
    products: { list: () => Promise.resolve({ data: mockProducts }) },
    prices: { list: () => Promise.resolve({ data: mockPrices }) },
    coupons: {
      retrieve: (id: string) =>
        mockCouponRetrieveErr ? Promise.reject(mockCouponRetrieveErr) : Promise.resolve({ id }),
      create: (params: any) => {
        mockCreatedCoupons.push(params);
        return Promise.resolve(params);
      },
    },
    subscriptions: {
      list: () => Promise.resolve({ data: mockSubsList }),
      update: (id: string, params: any, opts: any) => {
        mockUpdateCalls.push({ id, params, opts });
        return Promise.resolve(mockUpdateReturn);
      },
    },
  }),
}));
vi.mock("../firebase", () => ({
  db: () => ({
    collection: (name: string) => {
      if (name === "customers") {
        return {
          doc: () => ({
            get: () =>
              Promise.resolve({
                exists: mockCustomerDoc !== undefined,
                data: () => mockCustomerDoc,
              }),
            collection: () => {
              const q: any = {
                where: () => q,
                limit: () => q,
                get: () =>
                  Promise.resolve({
                    empty: mockSubsMirror.length === 0,
                    docs: mockSubsMirror.map((d: any) => ({ data: () => d })),
                  }),
              };
              return q;
            },
          }),
        };
      }
      // complimentaryPlans (and any other collection)
      return {
        doc: () => ({
          get: () =>
            Promise.resolve({ exists: mockGiftDoc !== undefined, data: () => mockGiftDoc }),
          set: (patch: any) => {
            mockGiftSetCalls.push(patch);
            return Promise.resolve();
          },
        }),
      };
    },
  }),
}));

const {
  ensureProIntroCoupon,
  resolvePlanStripePrice,
  getPlanSource,
  upgradePaidToPro,
  supersedeActiveGift,
} = await import("./planBilling");

beforeEach(() => {
  mockPlan = "advance";
  mockProducts = [];
  mockPrices = [];
  mockCouponRetrieveErr = null;
  mockCreatedCoupons = [];
  mockSubsList = [];
  mockUpdateCalls = [];
  mockUpdateReturn = {};
  mockSubsMirror = [];
  mockCustomerDoc = undefined;
  mockGiftDoc = undefined;
  mockGiftSetCalls = [];
  mockUpgradeTarget = 200;
});

// Helper: wire up a Pro product+price in Stripe (and the Growth product so the
// source-price assertion in upgradePaidToPro can resolve it). The default
// growthPriceId matches the subscription item price the upgrade tests use.
function provisionPro(unitAmount = 29000, currency = "eur", growthPriceId = "price_growth") {
  mockProducts = [
    { id: "prod_pro", metadata: { firebaseRole: "pro" }, default_price: "price_pro" },
    { id: "prod_growth", metadata: { firebaseRole: "advance" }, default_price: growthPriceId },
  ];
  mockPrices = [
    { id: "price_pro", type: "recurring", unit_amount: unitAmount, currency },
    { id: growthPriceId, type: "recurring", unit_amount: 6900, currency },
  ];
}

describe("ensureProIntroCoupon", () => {
  it("creates a once-coupon of (full − target) and returns a delta-encoded id", async () => {
    mockCouponRetrieveErr = { code: "resource_missing" };
    const id = await ensureProIntroCoupon(29000, "eur"); // 290 − 200 = 90
    expect(id).toBe("olio_pro_intro_9000_eur");
    expect(mockCreatedCoupons).toHaveLength(1);
    expect(mockCreatedCoupons[0]).toMatchObject({
      id: "olio_pro_intro_9000_eur",
      amount_off: 9000,
      currency: "eur",
      duration: "once",
    });
  });

  it("reuses an existing coupon without creating a new one", async () => {
    mockCouponRetrieveErr = null; // retrieve succeeds
    const id = await ensureProIntroCoupon(29000, "eur");
    expect(id).toBe("olio_pro_intro_9000_eur");
    expect(mockCreatedCoupons).toHaveLength(0);
  });

  it("lowercases the currency in the coupon id", async () => {
    mockCouponRetrieveErr = { statusCode: 404 };
    const id = await ensureProIntroCoupon(29000, "EUR");
    expect(id).toBe("olio_pro_intro_9000_eur");
  });

  it("returns null when the target is >= the full price (no discount)", async () => {
    const id = await ensureProIntroCoupon(15000, "eur"); // 150 < 200 target
    expect(id).toBeNull();
    expect(mockCreatedCoupons).toHaveLength(0);
  });

  it("honours an admin-configured target other than the default", async () => {
    mockUpgradeTarget = 150; // admin set first-year to €150
    mockCouponRetrieveErr = { code: "resource_missing" };
    const id = await ensureProIntroCoupon(29000, "eur"); // 290 − 150 = 140
    expect(id).toBe("olio_pro_intro_14000_eur");
    expect(mockCreatedCoupons[0]).toMatchObject({ amount_off: 14000, duration: "once" });
  });

  it("returns null when the admin disabled the discount (null / 0 target)", async () => {
    mockUpgradeTarget = null;
    expect(await ensureProIntroCoupon(29000, "eur")).toBeNull();
    mockUpgradeTarget = 0;
    expect(await ensureProIntroCoupon(29000, "eur")).toBeNull();
    expect(mockCreatedCoupons).toHaveLength(0);
  });
});

describe("resolvePlanStripePrice", () => {
  it("resolves the price for a role via firebaseRole metadata + default_price", async () => {
    provisionPro();
    const price = await resolvePlanStripePrice("pro");
    expect(price).toEqual({
      productId: "prod_pro",
      priceId: "price_pro",
      unitAmountCents: 29000,
      currency: "eur",
    });
  });

  it("returns null when the product isn't provisioned", async () => {
    mockProducts = [];
    expect(await resolvePlanStripePrice("pro")).toBeNull();
  });
});

describe("getPlanSource", () => {
  it("reports paid + renewal date when an active subscription mirror exists", async () => {
    mockSubsMirror = [
      {
        status: "active",
        current_period_end: "2027-06-15T00:00:00.000Z",
        cancel_at_period_end: true,
      },
    ];
    const info = await getPlanSource("uid");
    expect(info).toEqual({
      source: "paid",
      plan: "advance",
      renewsAt: "2027-06-15T00:00:00.000Z",
      cancelAtPeriodEnd: true,
      giftExpiresAt: null,
    });
  });

  it("reports gifted when there's no subscription but an active comp grant", async () => {
    mockSubsMirror = [];
    mockGiftDoc = { status: "active", plan: "advance", expiresAt: "2027-01-01T00:00:00.000Z" };
    const info = await getPlanSource("uid");
    expect(info.source).toBe("gifted");
    expect(info.giftExpiresAt).toBe("2027-01-01T00:00:00.000Z");
    expect(info.renewsAt).toBeNull();
  });

  it("reports none when there's neither a subscription nor an active gift", async () => {
    mockSubsMirror = [];
    mockGiftDoc = { status: "expired", plan: "advance", expiresAt: "2024-01-01T00:00:00.000Z" };
    const info = await getPlanSource("uid");
    expect(info.source).toBe("none");
  });
});

describe("upgradePaidToPro", () => {
  function provisionPaidGrowth() {
    mockPlan = "advance";
    mockSubsMirror = [{ status: "active", current_period_end: "2026-12-01T00:00:00.000Z" }];
    mockCustomerDoc = { stripeId: "cus_123" };
    mockSubsList = [
      { id: "sub_1", items: { data: [{ id: "si_1", price: { id: "price_growth" } }] } },
    ];
    provisionPro();
    mockCouponRetrieveErr = { code: "resource_missing" };
    mockUpdateReturn = { items: { data: [{ current_period_end: "2027-06-15T00:00:00.000Z" }] } };
  }

  it("swaps the subscription with the exact rule-bearing parameters", async () => {
    provisionPaidGrowth();
    const result = await upgradePaidToPro("uid");

    expect(result).toEqual({ ok: true, renewsAt: "2027-06-15T00:00:00.000Z" });
    expect(mockUpdateCalls).toHaveLength(1);
    const { id, params, opts } = mockUpdateCalls[0];
    expect(id).toBe("sub_1");
    expect(params.items).toEqual([{ id: "si_1", price: "price_pro" }]);
    expect(params.proration_behavior).toBe("none"); // lose unused Growth time
    expect(params.billing_cycle_anchor).toBe("now"); // fresh 12-month term
    expect(params.discounts).toEqual([{ coupon: "olio_pro_intro_9000_eur" }]); // €200 once
    expect(opts.idempotencyKey).toBe("plan-upgrade-pro:uid:sub_1");
  });

  it("applies no discount block when Pro <= target (still upgrades, full price)", async () => {
    provisionPaidGrowth();
    provisionPro(15000); // 150 < 200 target → no coupon
    const result = await upgradePaidToPro("uid");
    expect(result.ok).toBe(true);
    expect(mockUpdateCalls[0].params.discounts).toEqual([]);
  });

  it("refuses a gifted owner (no subscription to swap)", async () => {
    mockPlan = "advance";
    mockSubsMirror = []; // no paid sub
    mockGiftDoc = { status: "active", plan: "advance", expiresAt: "2027-01-01T00:00:00.000Z" };
    const result = await upgradePaidToPro("uid");
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mockUpdateCalls).toHaveLength(0);
  });

  it("refuses an owner who is already Pro", async () => {
    mockPlan = "pro";
    mockSubsMirror = [{ status: "active", current_period_end: "2026-12-01T00:00:00.000Z" }];
    const result = await upgradePaidToPro("uid");
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mockUpdateCalls).toHaveLength(0);
  });

  it("refuses when the subscription is already on the Pro price (idempotent)", async () => {
    provisionPaidGrowth();
    mockSubsList = [{ id: "sub_1", items: { data: [{ id: "si_1", price: { id: "price_pro" } }] } }];
    const result = await upgradePaidToPro("uid");
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mockUpdateCalls).toHaveLength(0);
  });

  it("returns 503 when Pro isn't provisioned in Stripe", async () => {
    provisionPaidGrowth();
    mockProducts = [];
    mockPrices = [];
    const result = await upgradePaidToPro("uid");
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(mockUpdateCalls).toHaveLength(0);
  });

  it("refuses the swap when the subscription item isn't on the Growth price", async () => {
    // Plan claim says advance, but the live subscription item is on some other
    // price (stale claim / hand-edited sub). The €200 coupon math is only valid
    // migrating FROM Growth, so the swap must be refused — nothing is updated.
    provisionPaidGrowth();
    mockSubsList = [
      { id: "sub_1", items: { data: [{ id: "si_1", price: { id: "price_legacy" } }] } },
    ];
    const result = await upgradePaidToPro("uid");
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mockUpdateCalls).toHaveLength(0);
  });

  it("still upgrades when the Growth product isn't provisioned (no positive mismatch)", async () => {
    // Only refuse on a POSITIVE mismatch — a missing Growth product (not yet
    // provisioned) must not block a genuine Growth owner's upgrade.
    provisionPaidGrowth();
    mockProducts = [
      { id: "prod_pro", metadata: { firebaseRole: "pro" }, default_price: "price_pro" },
    ];
    mockPrices = [{ id: "price_pro", type: "recurring", unit_amount: 29000, currency: "eur" }];
    const result = await upgradePaidToPro("uid");
    expect(result.ok).toBe(true);
    expect(mockUpdateCalls).toHaveLength(1);
    expect(mockUpdateCalls[0].params.items).toEqual([{ id: "si_1", price: "price_pro" }]);
  });
});

describe("supersedeActiveGift", () => {
  it("flips an active gift to superseded with a timestamp", async () => {
    mockGiftDoc = { status: "active", plan: "advance" };
    const changed = await supersedeActiveGift("uid");
    expect(changed).toBe(true);
    expect(mockGiftSetCalls).toHaveLength(1);
    expect(mockGiftSetCalls[0].status).toBe("superseded");
    expect(typeof mockGiftSetCalls[0].supersededAt).toBe("string");
  });

  it("is a no-op when there's no gift doc", async () => {
    mockGiftDoc = undefined;
    expect(await supersedeActiveGift("uid")).toBe(false);
    expect(mockGiftSetCalls).toHaveLength(0);
  });

  it("is a no-op when the gift isn't active (idempotent)", async () => {
    mockGiftDoc = { status: "superseded", plan: "advance" };
    expect(await supersedeActiveGift("uid")).toBe(false);
    expect(mockGiftSetCalls).toHaveLength(0);
  });
});
