// Unit tests for the pure date helpers in rentCycle. The impure
// advanceAgreementForPayment (Firestore reads/writes, idempotency guard,
// frequency) is integration-tested in routes/tenant.payment.test.ts against
// the in-memory Firestore double.

import { describe, it, expect } from "vitest";
import { advanceMonths, monthsPerPeriod, advanceByFrequency, computeArrears } from "./rentCycle";

describe("advanceMonths", () => {
  it("advances a plain month", () => {
    expect(advanceMonths("2026-05-15", 1)).toBe("2026-06-15");
    expect(advanceMonths("2026-06-01", 3)).toBe("2026-09-01");
    expect(advanceMonths("2026-06-01", 12)).toBe("2027-06-01");
  });

  it("crosses year boundaries", () => {
    expect(advanceMonths("2025-12-15", 1)).toBe("2026-01-15");
    expect(advanceMonths("2025-11-30", 3)).toBe("2026-02-28");
  });

  it("clamps month-end days (Jan 31 -> Feb 28; +1 from Feb stays clamped)", () => {
    expect(advanceMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(advanceMonths("2024-01-31", 1)).toBe("2024-02-29"); // leap year
    expect(advanceMonths("2026-08-31", 1)).toBe("2026-09-30");
  });

  it("handles n = 0 and ISO timestamps, returning a bare date", () => {
    expect(advanceMonths("2026-06-01", 0)).toBe("2026-06-01");
    expect(advanceMonths("2026-06-15T09:30:00.000Z", 1)).toBe("2026-07-15");
  });

  it("returns the input unchanged when it is not a valid date", () => {
    expect(advanceMonths("not-a-date", 1)).toBe("not-a-date");
  });
});

describe("monthsPerPeriod", () => {
  it("maps each frequency to its month count, defaulting to monthly", () => {
    expect(monthsPerPeriod("monthly")).toBe(1);
    expect(monthsPerPeriod("quarterly")).toBe(3);
    expect(monthsPerPeriod("yearly")).toBe(12);
    expect(monthsPerPeriod(undefined)).toBe(1);
    expect(monthsPerPeriod(null)).toBe(1);
  });
});

describe("advanceByFrequency", () => {
  it("advances one whole billing period", () => {
    expect(advanceByFrequency("2026-06-01", "monthly")).toBe("2026-07-01");
    expect(advanceByFrequency("2026-06-01", "quarterly")).toBe("2026-09-01");
    expect(advanceByFrequency("2026-06-01", "yearly")).toBe("2027-06-01");
    expect(advanceByFrequency("2026-06-01")).toBe("2026-07-01"); // default monthly
  });
});

describe("advanceMonths — paymentDayOfMonth anchoring (month-end ratchet fix)", () => {
  it("re-anchors to the stable day so a 31st lease recovers after February", () => {
    // Without the anchor, Feb 28 -> Mar would stay on the 28th forever. With
    // anchorDay=31, February clamps to the 28th but March recovers to the 31st.
    expect(advanceMonths("2026-02-28", 1, 31)).toBe("2026-03-31");
    expect(advanceMonths("2026-04-30", 1, 31)).toBe("2026-05-31");
  });
  it("still clamps when the anchor day exceeds the target month length", () => {
    expect(advanceMonths("2026-01-31", 1, 31)).toBe("2026-02-28");
    expect(advanceMonths("2026-01-31", 1, 31)).not.toBe("2026-03-03");
  });
  it("ignores an out-of-range anchor and falls back to the input's day", () => {
    expect(advanceMonths("2026-06-10", 1, 0)).toBe("2026-07-10");
    expect(advanceMonths("2026-06-10", 1, 99)).toBe("2026-07-10");
  });
});

describe("computeArrears", () => {
  const base = { monthlyRent: 1000, frequency: "monthly" as const, paymentDayOfMonth: 1 };

  it("returns zero when the lease is paid through its end (nextPaymentDate beyond throughDate)", () => {
    const r = computeArrears({ ...base, nextPaymentDate: "2026-07-01", throughDate: "2026-06-30" });
    expect(r.amount).toBe(0);
    expect(r.cycles).toBe(0);
  });

  it("counts each unpaid in-term cycle through the end date", () => {
    // Unpaid from Apr 1; lease ends Jun 30 → Apr, May, Jun = 3 months × 1000.
    expect(
      computeArrears({ ...base, nextPaymentDate: "2026-04-01", throughDate: "2026-06-30" }),
    ).toEqual({ amount: 3000, cycles: 3, fromPeriod: "2026-04-01" });
  });

  it("prices a quarterly cycle as the whole period (rent × 3)", () => {
    expect(
      computeArrears({
        nextPaymentDate: "2026-04-01",
        throughDate: "2026-06-30",
        monthlyRent: 1000,
        frequency: "quarterly",
        paymentDayOfMonth: 1,
      }),
    ).toEqual({ amount: 3000, cycles: 1, fromPeriod: "2026-04-01" });
  });

  it("returns zero when there is no schedule or no rent", () => {
    expect(
      computeArrears({ ...base, nextPaymentDate: null, throughDate: "2026-06-30" }).amount,
    ).toBe(0);
    expect(
      computeArrears({
        ...base,
        monthlyRent: 0,
        nextPaymentDate: "2026-01-01",
        throughDate: "2026-06-30",
      }).amount,
    ).toBe(0);
  });
});
