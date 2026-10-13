// Tests for the platform-commission clamp. The critical invariant for DIRECT
// charges: application_fee_amount must be STRICTLY LESS THAN the charge amount,
// or Stripe rejects checkout.sessions.create. computeRentCommission must never
// return a fee >= gross, even under an admin misconfig (percent=100, or a flat
// minimum that exceeds a low rent).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RentCommissionTier } from "../../shared/firestore-schema";

const mockGetUser = vi.fn();
vi.mock("../firebase", () => ({ auth: () => ({ getUser: mockGetUser }) }));

let tier: RentCommissionTier;
vi.mock("./configCache", () => ({
  loadPlatformFeesConfig: () => Promise.resolve({ rentCommission: { pro: tier } }),
}));

const { computeRentCommission, resolveOwnerPlan } = await import("./commission");

beforeEach(() => {
  mockGetUser.mockResolvedValue({ customClaims: { stripeRole: "pro" } });
  tier = { percent: 0, minAmountCents: 0 };
});

describe("computeRentCommission fee clamp", () => {
  it("never returns a fee >= gross when percent is 100", async () => {
    tier = { percent: 100, minAmountCents: 0 };
    const { feeCents } = await computeRentCommission("uid", 150000);
    expect(feeCents).toBeLessThan(150000);
    expect(feeCents).toBe(149999);
  });

  it("clamps a flat minimum that exceeds a low rent to one cent below gross", async () => {
    tier = { percent: 0, minAmountCents: 99999 };
    const { feeCents } = await computeRentCommission("uid", 5000);
    expect(feeCents).toBe(4999);
  });

  it("leaves a normal percentage fee unchanged (well below gross)", async () => {
    tier = { percent: 2, minAmountCents: 0 };
    const { feeCents } = await computeRentCommission("uid", 100000);
    expect(feeCents).toBe(2000);
  });

  it("returns 0 for a zero-amount charge (cap floors at 0)", async () => {
    tier = { percent: 100, minAmountCents: 500 };
    const { feeCents } = await computeRentCommission("uid", 0);
    expect(feeCents).toBe(0);
  });

  it("honours the flat minimum when it's below gross", async () => {
    tier = { percent: 0, minAmountCents: 1500 };
    const { feeCents } = await computeRentCommission("uid", 100000);
    expect(feeCents).toBe(1500);
  });
});

// resolveOwnerPlan validates the stripeRole claim against KNOWN_PLANS and
// defaults to "basic" on anything missing/unknown/erroring — same fallback the
// client's usePlan() uses. This decides which commission tier (and unit cap, via
// other callers) an owner gets, so the claim-validation + fallback paths matter.
describe("resolveOwnerPlan", () => {
  it("resolves a valid stripeRole claim to the matching plan", async () => {
    mockGetUser.mockResolvedValue({ customClaims: { stripeRole: "business" } });
    expect(await resolveOwnerPlan("uid")).toBe("business");
  });

  it("defaults to 'basic' when the stripeRole claim is missing", async () => {
    mockGetUser.mockResolvedValue({ customClaims: {} });
    expect(await resolveOwnerPlan("uid")).toBe("basic");
  });

  it("defaults to 'basic' when there are no custom claims at all", async () => {
    mockGetUser.mockResolvedValue({});
    expect(await resolveOwnerPlan("uid")).toBe("basic");
  });

  it("defaults to 'basic' when the claim is an unknown plan string", async () => {
    mockGetUser.mockResolvedValue({ customClaims: { stripeRole: "enterprise" } });
    expect(await resolveOwnerPlan("uid")).toBe("basic");
  });

  it("defaults to 'basic' when the claim is a non-string value", async () => {
    mockGetUser.mockResolvedValue({ customClaims: { stripeRole: 42 } });
    expect(await resolveOwnerPlan("uid")).toBe("basic");
  });

  it("defaults to 'basic' when the auth lookup throws", async () => {
    mockGetUser.mockRejectedValue(new Error("user-not-found"));
    expect(await resolveOwnerPlan("uid")).toBe("basic");
  });
});
