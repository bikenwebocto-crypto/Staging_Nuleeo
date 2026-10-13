import { describe, it, expect } from "vitest";
import Stripe from "stripe";
import { isStripePlatformSetupError, stripeErrMsg } from "./stripeErr";

// Build a real StripeInvalidRequestError so the instanceof check in the
// detector exercises the same path production hits.
function invalidRequest(message: string): Stripe.errors.StripeError {
  return new Stripe.errors.StripeInvalidRequestError({
    type: "invalid_request_error",
    message,
  });
}

describe("isStripePlatformSetupError", () => {
  it("matches the 'managing losses' platform-profile error", () => {
    const err = invalidRequest(
      "Please review the responsibilities of managing losses for connected " +
        "accounts at https://dashboard.stripe.com/settings/connect/platform-profile.",
    );
    expect(isStripePlatformSetupError(err)).toBe(true);
  });

  it("matches on the platform-profile URL slug alone", () => {
    expect(
      isStripePlatformSetupError(invalidRequest("Visit .../connect/platform-profile to continue.")),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isStripePlatformSetupError(invalidRequest("MANAGING LOSSES not reviewed"))).toBe(true);
  });

  it("ignores unrelated Stripe errors", () => {
    expect(isStripePlatformSetupError(invalidRequest("No such customer: cus_123"))).toBe(false);
  });

  it("ignores non-Stripe errors", () => {
    expect(isStripePlatformSetupError(new Error("managing losses"))).toBe(false);
    expect(isStripePlatformSetupError(null)).toBe(false);
    expect(isStripePlatformSetupError(undefined)).toBe(false);
    expect(isStripePlatformSetupError("managing losses")).toBe(false);
  });
});

describe("stripeErrMsg", () => {
  it("prefixes Stripe errors and defers non-Stripe errors to the fallback", () => {
    expect(stripeErrMsg(invalidRequest("No such product: prod_x"), "fb")).toBe(
      "Stripe: No such product: prod_x (StripeInvalidRequestError)",
    );
    expect(stripeErrMsg(new Error("boom"), "Friendly fallback")).toBe("Friendly fallback");
  });
});
