import { describe, it, expect } from "vitest";
import { advanceOneMonth, deriveFeeBreakdown } from "./rentTransaction";
import type { RentCheckoutSession } from "./rentTransaction";

function session(overrides: Partial<RentCheckoutSession>): RentCheckoutSession {
  return {
    id: "cs_test",
    amount_total: 100_000,
    currency: "eur",
    metadata: null,
    payment_intent: null,
    ...overrides,
  };
}

describe("advanceOneMonth", () => {
  it("advances ordinary mid-month dates without clamping", () => {
    expect(advanceOneMonth("2026-05-15")).toBe("2026-06-15");
    expect(advanceOneMonth("2026-01-10")).toBe("2026-02-10");
    expect(advanceOneMonth("2026-11-15")).toBe("2026-12-15");
  });

  it("rolls over from December into the next year", () => {
    expect(advanceOneMonth("2025-12-15")).toBe("2026-01-15");
    expect(advanceOneMonth("2025-12-31")).toBe("2026-01-31");
  });

  // Regression: naive setUTCMonth() makes Jan 31 → Mar 3 (skips Feb). The
  // clamp must land on Feb 28 (or 29 in a leap year). Without this, the
  // rent-reminder cron skips an entire cycle for any agreement whose due
  // date falls on the 29th–31st.
  it("clamps Jan 31 to the last day of February (non-leap year)", () => {
    expect(advanceOneMonth("2026-01-31")).toBe("2026-02-28");
  });

  it("clamps Jan 31 to Feb 29 in a leap year", () => {
    expect(advanceOneMonth("2024-01-31")).toBe("2024-02-29");
  });

  it("clamps 31-day → 30-day month boundaries", () => {
    // Mar 31 → Apr 30 (April has 30 days)
    expect(advanceOneMonth("2026-03-31")).toBe("2026-04-30");
    // May 31 → Jun 30
    expect(advanceOneMonth("2026-05-31")).toBe("2026-06-30");
    // Aug 31 → Sep 30
    expect(advanceOneMonth("2026-08-31")).toBe("2026-09-30");
    // Oct 31 → Nov 30
    expect(advanceOneMonth("2026-10-31")).toBe("2026-11-30");
  });

  it("doesn't over-clamp when the target month is long enough", () => {
    // Feb 28 → Mar 28 (not Mar 31)
    expect(advanceOneMonth("2026-02-28")).toBe("2026-03-28");
    // Apr 30 → May 30 (not May 31)
    expect(advanceOneMonth("2026-04-30")).toBe("2026-05-30");
  });

  it("strips the time component when given a full ISO timestamp", () => {
    expect(advanceOneMonth("2026-05-15T14:30:00.000Z")).toBe("2026-06-15");
  });

  it("returns the input verbatim on garbage values", () => {
    expect(advanceOneMonth("not-a-date")).toBe("not-a-date");
    expect(advanceOneMonth("")).toBe("");
  });
});

describe("deriveFeeBreakdown", () => {
  it("prefers the expanded payment_intent.application_fee_amount", () => {
    const result = deriveFeeBreakdown(
      session({
        amount_total: 100_000,
        payment_intent: { application_fee_amount: 5_000 },
        metadata: { applicationFeeCents: "9999" }, // ignored — PI wins
      }),
    );
    expect(result.feeCents).toBe(5_000);
    expect(result.grossCents).toBe(100_000);
    expect(result.ownerNetCents).toBe(95_000);
  });

  it("falls back to metadata.applicationFeeCents when PI is unexpanded", () => {
    const result = deriveFeeBreakdown(
      session({
        amount_total: 100_000,
        payment_intent: "pi_unexpanded_id", // just an id string
        metadata: { applicationFeeCents: "5000" },
      }),
    );
    expect(result.feeCents).toBe(5_000);
    expect(result.ownerNetCents).toBe(95_000);
  });

  it("falls back to metadata when PI is null", () => {
    const result = deriveFeeBreakdown(
      session({
        payment_intent: null,
        metadata: { applicationFeeCents: "2500" },
      }),
    );
    expect(result.feeCents).toBe(2_500);
  });

  it("falls back to metadata when PI is expanded but missing the fee field", () => {
    const result = deriveFeeBreakdown(
      session({
        payment_intent: {},
        metadata: { applicationFeeCents: "3000" },
      }),
    );
    expect(result.feeCents).toBe(3_000);
  });

  it("returns zero fee when both sources are absent", () => {
    const result = deriveFeeBreakdown(session({ amount_total: 100_000, metadata: null }));
    expect(result.feeCents).toBe(0);
    expect(result.grossCents).toBe(100_000);
    expect(result.ownerNetCents).toBe(100_000);
  });

  it("ignores a negative fee from PI (defensive against bad data)", () => {
    const result = deriveFeeBreakdown(
      session({ payment_intent: { application_fee_amount: -500 } }),
    );
    expect(result.feeCents).toBe(0);
  });

  it("ignores garbage metadata values", () => {
    const result = deriveFeeBreakdown(
      session({ metadata: { applicationFeeCents: "not-a-number" } }),
    );
    expect(result.feeCents).toBe(0);
  });

  it("floor()s fractional metadata fee", () => {
    const result = deriveFeeBreakdown(session({ metadata: { applicationFeeCents: "1234.99" } }));
    expect(result.feeCents).toBe(1_234);
  });

  it("handles amount_total: null without crashing", () => {
    const result = deriveFeeBreakdown(session({ amount_total: null }));
    expect(result.grossCents).toBe(0);
    expect(result.ownerNetCents).toBe(0);
  });

  it("clamps ownerNetCents at 0 — fee can't exceed gross", () => {
    // Defensive: if Stripe somehow reports fee > gross, we don't
    // produce a negative net.
    const result = deriveFeeBreakdown(
      session({
        amount_total: 1_000,
        payment_intent: { application_fee_amount: 5_000 },
      }),
    );
    expect(result.feeCents).toBe(5_000);
    expect(result.ownerNetCents).toBe(0);
  });

  it("captures ownerPlanAtSend from metadata when valid", () => {
    for (const plan of ["basic", "advance", "pro", "business"] as const) {
      const result = deriveFeeBreakdown(session({ metadata: { ownerPlan: plan } }));
      expect(result.ownerPlanAtSend).toBe(plan);
    }
  });

  it("omits ownerPlanAtSend when metadata.ownerPlan is unknown", () => {
    const result = deriveFeeBreakdown(session({ metadata: { ownerPlan: "enterprise" } }));
    expect(result.ownerPlanAtSend).toBeUndefined();
  });

  it("omits ownerPlanAtSend when metadata is null", () => {
    const result = deriveFeeBreakdown(session({ metadata: null }));
    expect(result.ownerPlanAtSend).toBeUndefined();
  });
});
