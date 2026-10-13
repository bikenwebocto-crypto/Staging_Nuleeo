import { describe, it, expect } from "vitest";
import type {
  OwnerAgreement,
  OwnerProperty,
  OwnerSummary,
  OwnerTenant,
  OwnerTransaction,
} from "./ownerQueries";
import {
  buildEquityTimeline,
  buildExpenseTrend,
  buildExpiringLeases,
  buildForwardIncome,
  buildMonthlyCashflow,
  buildPropertyLeaderboard,
  computeDepositCoverage,
  computeHHI,
  computeIncomeMix,
  computeLeaseHygiene,
  computePeriodDeltas,
  computeRentReconciliation,
  computeTenure,
  computeTotalReturn,
  computeVacancyRisk,
  isValidYmd,
  rankTenantScores,
  scoreTenantPayments,
  ymdToLocalMidnightMs,
} from "./portfolioInsights";

// Fixed "now" — local noon, 17 Jun 2026. All date math in the module uses LOCAL
// time consistently, and fixtures below use local-naive ISO strings, so these
// assertions are timezone-independent.
const NOW = new Date(2026, 5, 17, 12, 0, 0).getTime();
const DAY = 86_400_000;

// ── factories (fill all required fields; override what a test cares about) ──
function tx(p: Partial<OwnerTransaction>): OwnerTransaction {
  return {
    id: "t" + Math.random().toString(36).slice(2),
    name: "rent",
    amount: 1000,
    currency: "EUR",
    type: "income",
    category: "rent",
    status: "completed",
    timestamp: "2026-06-01T10:00:00",
    propertyAddress: null,
    ...p,
  } as OwnerTransaction;
}
function tenant(p: Partial<OwnerTenant>): OwnerTenant {
  return {
    id: "tenant1",
    userId: null,
    name: "Alice",
    email: "a@x.io",
    phone: null,
    status: "active",
    rentAmount: 1000,
    nextPayment: null,
    paymentStatus: null,
    outstandingBalance: 0,
    propertyId: "p1",
    propertyAddress: "1 Main St",
    unitId: "p1",
    unitLabel: null,
    createdAt: "2025-01-01T00:00:00",
    ...p,
  };
}
function prop(p: Partial<OwnerProperty>): OwnerProperty {
  return {
    id: "p1",
    ownerId: "o1",
    address: "1 Main St, Town",
    propertyValue: 300000,
    acquisitionPrice: 240000,
    createdAt: "2024-01-01T00:00:00",
    unitCount: 1,
    rentAmount: 1000,
    occupied: true,
    tenancyState: "occupied",
    tenantName: "Alice",
    ...p,
  };
}
function agr(p: Partial<OwnerAgreement>): OwnerAgreement {
  return {
    id: "a1",
    status: "active",
    leaseType: "Residential Lease",
    tenantId: "tenant1",
    tenantName: "Alice",
    tenantEmail: "a@x.io",
    tenantPhone: null,
    tenantUserId: null,
    owner: "o1",
    propertyId: "p1",
    unitId: "p1",
    address: "1 Main St",
    propertyImage: null,
    monthlyRent: 1000,
    deposit: 2000,
    agreementValue: 12000,
    startDate: "2025-01-01",
    endDate: "2027-01-01",
    signedAt: null,
    documentUrl: null,
    documentName: null,
    documentSize: null,
    documentUploadedAt: null,
    paymentDayOfMonth: 1,
    noticePeriodMonths: 1,
    paymentFrequency: "monthly",
    rentalDurationMonths: 24,
    rentFreePeriodMonths: 0,
    prepaidRents: 0,
    autoRenewal: "none",
    indexation: null,
    ...p,
  };
}
const summary = (p: Partial<OwnerSummary> = {}): OwnerSummary => ({
  unitCount: 1,
  portfolioValue: 300000,
  monthlyRevenue: 1000,
  occupancyRate: 100,
  equityInvested: 240000,
  ...p,
});

// rent paid `lateness` days after a due cycle; method defaults to card.
function rentPaid(
  tenantId: string,
  due: string,
  lateness: number,
  extra: Partial<OwnerTransaction> = {},
) {
  const dueMs = ymdToLocalMidnightMs(due)!;
  const paid = new Date(dueMs + lateness * DAY);
  const iso = `${paid.getFullYear()}-${String(paid.getMonth() + 1).padStart(2, "0")}-${String(paid.getDate()).padStart(2, "0")}T12:00:00`;
  return tx({
    tenantId,
    category: "rent",
    type: "income",
    status: "completed",
    rentPeriod: due,
    timestamp: iso,
    paymentMethod: "card",
    ...extra,
  });
}

describe("date helpers", () => {
  it("validates YYYY-MM-DD and rejects junk / ISO datetimes", () => {
    expect(isValidYmd("2026-06-08")).toBe(true);
    expect(isValidYmd("2026-13-40")).toBe(false);
    expect(isValidYmd("2026-02-30")).toBe(false);
    expect(isValidYmd("")).toBe(false);
    expect(isValidYmd("nope")).toBe(false);
    expect(isValidYmd("2026-06-08T10:00:00")).toBe(false);
    expect(isValidYmd(null)).toBe(false);
  });
  it("parses to local midnight (calendar day preserved)", () => {
    const ms = ymdToLocalMidnightMs("2026-06-08")!;
    const d = new Date(ms);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(8);
    expect(ymdToLocalMidnightMs("bad")).toBeNull();
  });
});

describe("scoreTenantPayments", () => {
  it("never-paid active tenant → unrated, null score/grade", () => {
    const s = scoreTenantPayments([], [tenant({ id: "t1", status: "active" })], NOW);
    expect(s).toHaveLength(1);
    expect(s[0].state).toBe("unrated");
    expect(s[0].score).toBeNull();
    expect(s[0].grade).toBeNull();
  });
  it("only-prepaid tenant → excluded → unrated", () => {
    const txns = [
      tx({
        tenantId: "t1",
        source: "prepaid",
        rentPeriod: undefined,
        timestamp: "2026-05-01T12:00:00",
      }),
    ];
    const s = scoreTenantPayments(txns, [tenant({ id: "t1" })], NOW);
    expect(s[0].state).toBe("unrated");
    expect(s[0].paymentCount).toBe(0);
  });
  it("perfect payer → 100 / A", () => {
    const txns = [
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
    ].map((d) => rentPaid("t1", d, 0));
    const s = scoreTenantPayments(txns, [tenant({ id: "t1" })], NOW);
    expect(s[0].onTimePct).toBe(100);
    expect(s[0].score).toBe(100);
    expect(s[0].grade).toBe("A");
    expect(s[0].state).toBe("rated");
  });
  it("grace boundary: 3 days on-time, 4 days late", () => {
    const onTime = scoreTenantPayments(
      [
        rentPaid("t1", "2026-05-01", 3),
        rentPaid("t1", "2026-06-01", 3),
        rentPaid("t1", "2026-04-01", 3),
      ],
      [tenant({ id: "t1" })],
      NOW,
    );
    expect(onTime[0].onTimePct).toBe(100);
    const late = scoreTenantPayments(
      [
        rentPaid("t1", "2026-05-01", 4),
        rentPaid("t1", "2026-06-01", 4),
        rentPaid("t1", "2026-04-01", 4),
      ],
      [tenant({ id: "t1" })],
      NOW,
    );
    expect(late[0].lateEvents).toBe(3);
  });
  it("chronic late flagged at 3 late events", () => {
    const txns = ["2026-03-01", "2026-04-01", "2026-05-01"].map((d) => rentPaid("t1", d, 10));
    const s = scoreTenantPayments(txns, [tenant({ id: "t1" })], NOW);
    expect(s[0].chronicLate).toBe(true);
  });
  it("score bounds: extremely late → min 20 (caps) / grade F", () => {
    // Two capped penalty terms (≤40 each) bound the score to [20, 100], so a
    // maximally-late tenant lands at 20 — still an unambiguous F (< 60).
    const txns = ["2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"].map((d) =>
      rentPaid("t1", d, 60),
    );
    const s = scoreTenantPayments(txns, [tenant({ id: "t1" })], NOW);
    expect(s[0].score).toBe(20);
    expect(s[0].score).toBeGreaterThanOrEqual(0);
    expect(s[0].grade).toBe("F");
  });
  it("provisional with 1-2 payments", () => {
    const one = scoreTenantPayments([rentPaid("t1", "2026-06-01", 0)], [tenant({ id: "t1" })], NOW);
    expect(one[0].state).toBe("provisional");
    expect(one[0].score).not.toBeNull();
    const two = scoreTenantPayments(
      [rentPaid("t1", "2026-05-01", 0), rentPaid("t1", "2026-06-01", 0)],
      [tenant({ id: "t1" })],
      NOW,
    );
    expect(two[0].state).toBe("provisional");
  });
  it("confidence = card / total; offline-heavy is low confidence", () => {
    const txns = [
      rentPaid("t1", "2026-02-01", 0, { paymentMethod: "bank_transfer" }),
      rentPaid("t1", "2026-03-01", 0, { paymentMethod: "bank_transfer" }),
      rentPaid("t1", "2026-04-01", 0, { paymentMethod: "bank_transfer" }),
      rentPaid("t1", "2026-05-01", 0, { paymentMethod: "bank_transfer" }),
      rentPaid("t1", "2026-06-01", 0, { paymentMethod: "card" }),
    ];
    const s = scoreTenantPayments(txns, [tenant({ id: "t1" })], NOW);
    expect(s[0].confidence).toBeCloseTo(0.2, 5);
    expect(s[0].lowConfidence).toBe(true);
  });
  it("rent rows missing rentPeriod counted as unscorable, excluded from score", () => {
    const txns = [
      rentPaid("t1", "2026-05-01", 0),
      tx({
        tenantId: "t1",
        category: "rent",
        rentPeriod: undefined,
        timestamp: "2026-06-01T12:00:00",
      }),
    ];
    const s = scoreTenantPayments(txns, [tenant({ id: "t1" })], NOW);
    expect(s[0].paymentCount).toBe(1);
    expect(s[0].unscorablePayments).toBe(1);
  });
  it("pending / failed rent never scored", () => {
    const txns = [
      tx({
        tenantId: "t1",
        category: "rent",
        status: "pending",
        rentPeriod: "2026-06-01",
        timestamp: "2026-06-01T12:00:00",
      }),
      tx({
        tenantId: "t1",
        category: "rent",
        status: "failed",
        rentPeriod: "2026-05-01",
        timestamp: "2026-05-01T12:00:00",
      }),
    ];
    const s = scoreTenantPayments(txns, [tenant({ id: "t1" })], NOW);
    expect(s[0].paymentCount).toBe(0);
    expect(s[0].state).toBe("unrated");
  });
  it("null tenantId rows skipped without throwing", () => {
    const txns = [tx({ tenantId: undefined, category: "rent", rentPeriod: "2026-06-01" })];
    expect(() => scoreTenantPayments(txns, [], NOW)).not.toThrow();
    expect(scoreTenantPayments(txns, [], NOW)).toHaveLength(0);
  });
  it("invited tenant with no payments omitted", () => {
    const s = scoreTenantPayments([], [tenant({ id: "t1", status: "invited" })], NOW);
    expect(s).toHaveLength(0);
  });
});

describe("rankTenantScores", () => {
  it("rated-desc, then provisional, then unrated; avg over rated only", () => {
    const scores = scoreTenantPayments(
      [
        ...["2026-03-01", "2026-04-01", "2026-05-01"].map((d) => rentPaid("good", d, 0)),
        ...["2026-03-01", "2026-04-01", "2026-05-01"].map((d) => rentPaid("bad", d, 20)),
        rentPaid("prov", "2026-06-01", 0),
      ],
      [
        tenant({ id: "good" }),
        tenant({ id: "bad" }),
        tenant({ id: "prov" }),
        tenant({ id: "newbie" }),
      ],
      NOW,
    );
    const ranked = rankTenantScores(scores);
    expect(ranked.scores[0].tenantId).toBe("good");
    expect(ranked.scores[ranked.scores.length - 1].state).toBe("unrated");
    expect(ranked.avgPortfolioScore).not.toBeNull();
  });
});

describe("buildPropertyLeaderboard", () => {
  it("empty properties → []", () => {
    expect(buildPropertyLeaderboard([], [], 90, NOW)).toEqual([]);
  });
  it("no in-window tx → zeroed row, null derived, hasActivity false", () => {
    const rows = buildPropertyLeaderboard([prop({ id: "p1" })], [], 90, NOW);
    expect(rows[0].revenue).toBe(0);
    expect(rows[0].profit).toBe(0);
    expect(rows[0].netMargin).toBeNull();
    expect(rows[0].hasActivity).toBe(false);
  });
  it("divide-by-zero guards: zero cost basis → null cashROI/appreciation", () => {
    const rows = buildPropertyLeaderboard(
      [prop({ id: "p1", acquisitionPrice: 0, propertyValue: 0 })],
      [
        tx({
          propertyId: "p1",
          type: "expense",
          category: "maintenance",
          amount: 50,
          timestamp: "2026-06-10T12:00:00",
        }),
      ],
      90,
      NOW,
    );
    expect(rows[0].cashROI).toBeNull();
    expect(rows[0].appreciation).toBeNull();
    expect(rows[0].netMargin).toBeNull(); // revenue 0
  });
  it("NaN sqm → eurPerSqm null", () => {
    const rows = buildPropertyLeaderboard(
      [prop({ id: "p1", sqm: "abc" }), prop({ id: "p2", sqm: "" }), prop({ id: "p3", sqm: "0" })],
      [],
      90,
      NOW,
    );
    expect(rows.every((r) => r.eurPerSqm === null)).toBe(true);
  });
  it("cost-basis fallback when no acquisition price", () => {
    const rows = buildPropertyLeaderboard(
      [prop({ id: "p1", acquisitionPrice: 0, propertyValue: 100000 })],
      [],
      90,
      NOW,
    );
    expect(rows[0].usedFallback).toBe(true);
    expect(rows[0].costBasis).toBe(80000);
  });
  it("prepaid lump counts once into revenue", () => {
    const rows = buildPropertyLeaderboard(
      [prop({ id: "p1" })],
      [
        tx({
          propertyId: "p1",
          source: "prepaid",
          amount: 6000,
          category: "rent",
          timestamp: "2026-06-10T12:00:00",
        }),
      ],
      90,
      NOW,
    );
    expect(rows[0].revenue).toBe(6000);
  });
  it("window scoping: old tx excluded", () => {
    const rows = buildPropertyLeaderboard(
      [prop({ id: "p1" })],
      [tx({ propertyId: "p1", amount: 1000, timestamp: "2026-01-01T12:00:00" })], // ~168d ago, outside 90d
      90,
      NOW,
    );
    expect(rows[0].revenue).toBe(0);
  });
  it("null propertyId tx ignored", () => {
    const rows = buildPropertyLeaderboard(
      [prop({ id: "p1" })],
      [tx({ propertyId: undefined, amount: 999 })],
      90,
      NOW,
    );
    expect(rows[0].revenue).toBe(0);
  });
});

describe("computePeriodDeltas", () => {
  it("365D window → no prior period (feed ceiling)", () => {
    const d = computePeriodDeltas([], 365, NOW);
    expect(d.priorAvailable).toBe(false);
    expect(d.netIncome.deltaPct).toBeNull();
  });
  it("prior window zero → null delta (no Infinity)", () => {
    const txns = [
      tx({ type: "income", category: "rent", amount: 500, timestamp: "2026-06-10T12:00:00" }),
    ];
    const d = computePeriodDeltas(txns, 30, NOW);
    expect(d.netIncome.value).toBe(500);
    expect(d.netIncome.deltaPct).toBeNull();
  });
  it("happy path delta", () => {
    const txns = [
      tx({ type: "income", category: "rent", amount: 1000, timestamp: "2026-06-10T12:00:00" }), // current 30d
      tx({ type: "income", category: "rent", amount: 500, timestamp: "2026-05-10T12:00:00" }), // prior 30d
    ];
    const d = computePeriodDeltas(txns, 30, NOW);
    expect(d.netIncome.value).toBe(1000);
    expect(d.netIncome.prior).toBe(500);
    expect(d.netIncome.deltaPct).toBeCloseTo(100, 5);
  });
});

describe("computeRentReconciliation", () => {
  it("prepaid lump does NOT inflate current-month collected", () => {
    const txns = [
      tx({ category: "rent", source: "prepaid", amount: 6000, timestamp: "2026-06-05T12:00:00" }),
    ];
    const r = computeRentReconciliation(summary({ monthlyRevenue: 1000 }), txns, NOW);
    expect(r.collected).toBe(0);
    expect(r.expected).toBe(1000);
  });
  it("expected 0 → pct null, no NaN", () => {
    const r = computeRentReconciliation(summary({ monthlyRevenue: 0 }), [], NOW);
    expect(r.pct).toBeNull();
  });
});

describe("computeHHI", () => {
  it("single property → 10000 / Single asset", () => {
    const h = computeHHI([prop({ id: "p1", propertyValue: 300000 })]);
    expect(h.assetHHI).toBe(10000);
    expect(h.label).toBe("Single asset");
  });
  it("zero-value portfolio → null", () => {
    expect(computeHHI([prop({ propertyValue: 0 })]).assetHHI).toBeNull();
  });
  it("missing city bucketed Unknown without crash", () => {
    expect(() => computeHHI([prop({ city: undefined, propertyValue: 100 })])).not.toThrow();
  });
});

describe("buildForwardIncome", () => {
  it("none/null lease drops after endDate; auto/fixed continues", () => {
    const ending = agr({ id: "a1", autoRenewal: "none", endDate: "2026-08-01", monthlyRent: 1000 });
    const renewing = agr({
      id: "a2",
      autoRenewal: "auto",
      endDate: "2026-08-01",
      monthlyRent: 500,
      propertyId: "p2",
    });
    const fwd = buildForwardIncome([ending, renewing], summary(), NOW);
    // Month 0 (Jun) both live → 1500; a later month after Aug → only the renewing 500.
    expect(fwd.months[0].projected).toBe(1500);
    expect(fwd.months[11].projected).toBe(500);
  });
  it("rentFree + prepaid leading months produce 0", () => {
    const a = agr({
      startDate: "2026-06-01",
      rentFreePeriodMonths: 1,
      prepaidRents: 1,
      monthlyRent: 1000,
      autoRenewal: "auto",
    });
    const fwd = buildForwardIncome([a], summary(), NOW);
    expect(fwd.months[0].projected).toBe(0); // month 0 within lead
    expect(fwd.months[1].projected).toBe(0); // month 1 within lead
    expect(fwd.months[2].projected).toBe(1000); // month 2 billable
  });
  it("empty agreements → 12 zero months", () => {
    const fwd = buildForwardIncome([], summary({ monthlyRevenue: 0 }), NOW);
    expect(fwd.months).toHaveLength(12);
    expect(fwd.months.every((m) => m.projected === 0)).toBe(true);
  });
});

describe("buildExpiringLeases", () => {
  it("only none/null + active included; auto/fixed excluded; holdover flagged", () => {
    const soon = agr({ id: "a1", autoRenewal: "none", endDate: "2026-08-01" });
    const auto = agr({ id: "a2", autoRenewal: "auto", endDate: "2026-08-01" });
    const holdover = agr({ id: "a3", autoRenewal: null, endDate: "2026-05-01" });
    const res = buildExpiringLeases([soon, auto, holdover], NOW);
    const ids = res.leases.map((l) => l.id);
    expect(ids).toContain("a1");
    expect(ids).not.toContain("a2");
    expect(res.leases.find((l) => l.id === "a3")?.holdover).toBe(true);
  });
});

describe("computeTotalReturn", () => {
  it("bad acquisitionYear floored, equity 0 → appreciation null", () => {
    const r = computeTotalReturn(
      summary({ equityInvested: 0 }),
      [prop({ acquisitionYear: "abc" })],
      NOW,
    );
    expect(r.appreciationRunRate).toBeNull();
    expect(r.avgHoldingYears).toBeGreaterThanOrEqual(1);
  });
});

describe("computeDepositCoverage", () => {
  it("rent 0 → coverage null; deposit 0 → band none", () => {
    const c = computeDepositCoverage([agr({ monthlyRent: 0, deposit: 0 })], []);
    expect(c.rows[0].coverage).toBeNull();
    expect(c.rows[0].band).toBe("none");
    expect(c.weightedCoverage).toBeNull();
  });
  it("weak coverage counted as under-secured", () => {
    const c = computeDepositCoverage([agr({ monthlyRent: 1000, deposit: 500 })], []);
    expect(c.rows[0].band).toBe("weak");
    expect(c.underSecuredCount).toBe(1);
  });
});

describe("computeTenure", () => {
  it("renewal uses earliest start, not reset", () => {
    const a1 = agr({ id: "a1", tenantId: "t1", startDate: "2023-01-01" });
    const a2 = agr({ id: "a2", tenantId: "t1", startDate: "2025-01-01" });
    const t = computeTenure([a1, a2], [tenant({ id: "t1", status: "active" })], NOW);
    expect(t.rows[0].tenureMonths).toBeGreaterThan(36); // from 2023, not 2025
    expect(t.rows[0].bucket).toBe("Long-term");
  });
});

describe("computeLeaseHygiene", () => {
  it("auto/fixed count as covered; null payment day counted", () => {
    const h = computeLeaseHygiene([
      agr({ id: "a1", autoRenewal: "auto", monthlyRent: 1000, paymentDayOfMonth: 1 }),
      agr({ id: "a2", autoRenewal: "none", monthlyRent: 1000, paymentDayOfMonth: null }),
    ]);
    expect(h.autoRenewPct).toBe(50);
    expect(h.nullDayCount).toBe(1);
  });
});

describe("computeVacancyRisk", () => {
  it("none weight 1, auto excluded, short-tenure multiplier applied", () => {
    const lapsing = agr({
      id: "a1",
      autoRenewal: "none",
      endDate: "2026-07-01",
      monthlyRent: 1000,
      startDate: "2026-03-01",
    });
    const auto = agr({ id: "a2", autoRenewal: "auto", endDate: "2026-07-01", monthlyRent: 1000 });
    const r = computeVacancyRisk([lapsing, auto], summary({ monthlyRevenue: 2000 }), 90, NOW);
    expect(r.atRiskMonthly).toBeCloseTo(1150, 0); // 1000 * 1.15 (tenure < 12mo)
  });
});

describe("cash-flow & cost series", () => {
  it("empty feed → 12 zero buckets; pending rent excluded", () => {
    const cf = buildMonthlyCashflow([], NOW);
    expect(cf).toHaveLength(12);
    const withPending = buildMonthlyCashflow(
      [tx({ status: "pending", category: "rent", amount: 999, timestamp: "2026-06-01T12:00:00" })],
      NOW,
    );
    expect(withPending[11].income).toBe(0);
  });
  it("expense trend folds unknown category to other", () => {
    const tr = buildExpenseTrend(
      [tx({ type: "expense", category: "other", amount: 100, timestamp: "2026-06-01T12:00:00" })],
      NOW,
    );
    expect(tr[11].other).toBe(100);
  });
});

describe("computeIncomeMix", () => {
  it("only-prepaid → single prepaid slice; cardPct from source rent", () => {
    const mix = computeIncomeMix(
      [tx({ category: "rent", source: "prepaid", amount: 6000, timestamp: "2026-06-01T12:00:00" })],
      90,
      NOW,
    );
    expect(mix.bySource).toEqual([{ name: "prepaid", value: 6000 }]);
    expect(mix.cardPct).toBe(0);
  });
  it("no rent → cardPct null", () => {
    expect(computeIncomeMix([], 90, NOW).cardPct).toBeNull();
  });
});

describe("buildEquityTimeline", () => {
  it("cumulative cost basis + today marker + unrealized gain", () => {
    const t = buildEquityTimeline(
      [
        prop({ id: "p1", acquisitionPrice: 100000, acquisitionYear: "2020" }),
        prop({ id: "p2", acquisitionPrice: 140000, acquisitionYear: "2022" }),
      ],
      summary({ portfolioValue: 300000, equityInvested: 240000 }),
    );
    expect(t.steps[t.steps.length - 1].cumulativeCost).toBe(240000);
    expect(t.todayValue).toBe(300000);
    expect(t.unrealizedGain).toBe(60000);
  });
});
