import { describe, it, expect } from "vitest";
import { isRealizedRent, netRealizedRentAmount } from "./realizedRent";

describe("isRealizedRent", () => {
  it("includes completed income (card / verified offline / manual)", () => {
    expect(isRealizedRent({ type: "income", status: "completed" })).toBe(true);
  });

  it("EXCLUDES pending offline rent (awaiting owner verification)", () => {
    // The core bug: unverified offline rent must not inflate realized income.
    expect(isRealizedRent({ type: "income", status: "pending" })).toBe(false);
  });

  it("excludes failed income", () => {
    expect(isRealizedRent({ type: "income", status: "failed" })).toBe(false);
  });

  it("includes legacy income rows with no status field", () => {
    // Older completed rows predate the status field — they must still count.
    expect(isRealizedRent({ type: "income" })).toBe(true);
    expect(isRealizedRent({ type: "income", status: undefined })).toBe(true);
  });

  it("treats an empty-string status as realized (legacy-equivalent)", () => {
    expect(isRealizedRent({ type: "income", status: "" })).toBe(true);
  });

  it("excludes non-income rows regardless of status", () => {
    expect(isRealizedRent({ type: "expense", status: "completed" })).toBe(false);
    expect(isRealizedRent({ type: "expense", status: "pending" })).toBe(false);
    expect(isRealizedRent({ type: "neutral", status: "completed" })).toBe(false);
    expect(isRealizedRent({ status: "completed" })).toBe(false);
    expect(isRealizedRent({})).toBe(false);
  });

  it("does not drop an income row carrying a future settled status", () => {
    // Deny-list design: an unknown-but-settled status still counts, unlike a
    // strict status === "completed" allow-list.
    expect(isRealizedRent({ type: "income", status: "verified" })).toBe(true);
  });
});

describe("netRealizedRentAmount", () => {
  it("returns the gross amount when there is no refund", () => {
    expect(netRealizedRentAmount({ amount: 1000 })).toBe(1000);
    expect(netRealizedRentAmount({ amount: 1000, refundedAmountCents: 0 })).toBe(1000);
  });

  it("subtracts a partial refund (cents) from the gross amount (major units)", () => {
    // €1000 gross, €250 refunded (25000 cents) => €750 realized.
    expect(netRealizedRentAmount({ amount: 1000, refundedAmountCents: 25000 })).toBe(750);
  });

  it("returns 0 for a full refund and never goes negative", () => {
    expect(netRealizedRentAmount({ amount: 1000, refundedAmountCents: 100000 })).toBe(0);
    expect(netRealizedRentAmount({ amount: 1000, refundedAmountCents: 150000 })).toBe(0);
  });

  it("treats a missing / non-numeric amount as 0", () => {
    expect(netRealizedRentAmount({})).toBe(0);
    expect(netRealizedRentAmount({ amount: null })).toBe(0);
    expect(netRealizedRentAmount({ amount: "1200" })).toBe(1200);
  });

  it("ignores a negative refund value (clamped to 0)", () => {
    expect(netRealizedRentAmount({ amount: 1000, refundedAmountCents: -500 })).toBe(1000);
  });
});
