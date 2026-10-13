// Unit tests for the productToPlan helper used by the subscription-
// updated webhook handler. Mocks the Stripe SDK so each test controls
// what `products.retrieve` returns.

import { describe, it, expect, beforeEach, vi } from "vitest";
import Stripe from "stripe";

let mockRetrieve: ReturnType<typeof vi.fn>;

vi.mock("../stripe", () => ({
  stripe: () => ({ products: { retrieve: mockRetrieve } }),
}));

const { productToPlan, selectAndVerify } = await import("./stripeWebhook");

beforeEach(() => {
  mockRetrieve = vi.fn();
});

describe("selectAndVerify", () => {
  // A real Stripe client (no network) for genuine HMAC sign + verify. The
  // `../stripe` mock above is irrelevant here — selectAndVerify takes the
  // verifier injected, so we hand it this client's real constructEvent.
  const realStripe = new Stripe("sk_test_dummy_key_for_crypto_only");
  const construct = (raw: Buffer, sig: string, secret: string) =>
    realStripe.webhooks.constructEvent(raw, sig, secret) as unknown as {
      type: string;
      account?: string;
    };

  const PLATFORM = "whsec_platform_secret_aaaaaaaaaaaaaaaa";
  const CONNECT = "whsec_connect_secret_bbbbbbbbbbbbbbbbbb";

  function signed(payloadObj: unknown, secret: string) {
    const payload = JSON.stringify(payloadObj);
    const header = realStripe.webhooks.generateTestHeaderString({ payload, secret });
    return { raw: Buffer.from(payload, "utf8"), header };
  }

  it("verifies a PLATFORM-signed delivery against the first secret", () => {
    const { raw, header } = signed({ type: "account.updated" }, PLATFORM);
    const ev = selectAndVerify(raw, header, [PLATFORM, CONNECT], construct);
    expect(ev.type).toBe("account.updated");
  });

  it("falls back to the CONNECT secret for a connected-account delivery", () => {
    // Direct-charge events are signed by the Connect endpoint's secret and
    // carry `account`. The platform secret fails first; the fallback wins.
    const { raw, header } = signed(
      { type: "checkout.session.completed", account: "acct_owner_123" },
      CONNECT,
    );
    const ev = selectAndVerify(raw, header, [PLATFORM, CONNECT], construct);
    expect(ev.type).toBe("checkout.session.completed");
    expect(ev.account).toBe("acct_owner_123");
  });

  it("throws when no provided secret matches the signature", () => {
    const { raw, header } = signed({ type: "checkout.session.completed" }, CONNECT);
    expect(() => selectAndVerify(raw, header, [PLATFORM], construct)).toThrow();
  });

  it("skips undefined/unset secrets and throws if none are configured", () => {
    const { raw, header } = signed({ type: "account.updated" }, PLATFORM);
    expect(() => selectAndVerify(raw, header, [undefined, undefined], construct)).toThrow(
      /no signing secret configured/,
    );
  });
});

describe("productToPlan", () => {
  it("returns null for null / undefined / empty productId", async () => {
    expect(await productToPlan(null)).toBeNull();
    expect(await productToPlan(undefined)).toBeNull();
    expect(await productToPlan("")).toBeNull();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("returns the plan key when product.metadata.firebaseRole is a known plan", async () => {
    mockRetrieve.mockResolvedValueOnce({
      metadata: { firebaseRole: "pro" },
    });
    expect(await productToPlan("prod_123")).toBe("pro");
  });

  it("handles every known plan tier", async () => {
    for (const plan of ["basic", "advance", "pro", "business"] as const) {
      mockRetrieve.mockResolvedValueOnce({
        metadata: { firebaseRole: plan },
      });
      expect(await productToPlan("prod_x")).toBe(plan);
    }
  });

  it("returns null when firebaseRole is missing", async () => {
    mockRetrieve.mockResolvedValueOnce({ metadata: {} });
    expect(await productToPlan("prod_x")).toBeNull();
  });

  it("returns null when firebaseRole is an UNKNOWN value", async () => {
    // Defense against a misconfigured product metadata field.
    mockRetrieve.mockResolvedValueOnce({
      metadata: { firebaseRole: "enterprise-platinum" },
    });
    expect(await productToPlan("prod_x")).toBeNull();
  });

  it("returns null when metadata is missing entirely", async () => {
    mockRetrieve.mockResolvedValueOnce({});
    expect(await productToPlan("prod_x")).toBeNull();
  });

  it("returns null when metadata is null", async () => {
    mockRetrieve.mockResolvedValueOnce({ metadata: null });
    expect(await productToPlan("prod_x")).toBeNull();
  });

  it("returns null when Stripe throws (network / unknown product)", async () => {
    mockRetrieve.mockRejectedValueOnce(new Error("No such product: prod_bad"));
    expect(await productToPlan("prod_bad")).toBeNull();
  });

  it("doesn't propagate the Stripe error — caller would crash otherwise", async () => {
    mockRetrieve.mockRejectedValueOnce(new Error("boom"));
    // Should not throw
    await expect(productToPlan("prod_x")).resolves.toBeNull();
  });
});
