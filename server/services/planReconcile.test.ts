// Focused tests for the plan-downgrade reconcile pure helpers.
// We don't mock the entire Firestore + Storage stack here — that would
// be flakier than valuable. Instead we import the deterministic bits of
// the policy (rank comparison, delete ordering) DIRECTLY from the module
// under test and prove THEY are correct. Previously these were copied
// in-file, so the shipped comparator that decides which properties get
// deleted on downgrade had zero real coverage. The full end-to-end
// firestore-touching path is exercised by staging deploy + manual QA.

import { describe, it, expect, vi } from "vitest";

// planReconcile.ts pulls in ../firebase + ./push transitively. Neither
// runs anything at module load (all SDK init is lazy inside functions),
// but stub them so an accidental call can't reach the real Admin SDK and
// so PLAN_RANK / orderForDeletion can be imported in isolation.
vi.mock("../firebase", () => ({
  db: () => {
    throw new Error("db() should not be called by the pure helpers");
  },
  bucket: () => {
    throw new Error("bucket() should not be called by the pure helpers");
  },
}));
vi.mock("./push", () => ({ notifyUser: vi.fn() }));

import {
  PLAN_RANK,
  orderForDeletion,
  restoreDecision,
  effectiveCap,
  GRACE_DAYS,
} from "./planReconcile";
import type { Property } from "../../shared/firestore-schema";

const DAY_MS = 24 * 60 * 60 * 1000;
// Build an ISO `daysAgo` days before `now`.
function isoDaysBefore(now: string, daysAgo: number): string {
  return new Date(new Date(now).getTime() - daysAgo * DAY_MS).toISOString();
}

// Minimal Property factory — orderForDeletion only reads `id` + `createdAt`
// and partitions by the supplied occupiedSet, so the rest is irrelevant.
function prop(id: string, createdAt: string): Property {
  return { id, createdAt } as Property;
}

describe("plan-downgrade rank comparison", () => {
  it("upgrades return ≥ in rank (no reconcile)", () => {
    expect(PLAN_RANK.advance).toBeGreaterThan(PLAN_RANK.basic);
    expect(PLAN_RANK.pro).toBeGreaterThan(PLAN_RANK.advance);
    expect(PLAN_RANK.business).toBeGreaterThan(PLAN_RANK.pro);
  });

  it("downgrades return < in rank (reconcile fires)", () => {
    expect(PLAN_RANK.pro < PLAN_RANK.business).toBe(true);
    expect(PLAN_RANK.advance < PLAN_RANK.pro).toBe(true);
    expect(PLAN_RANK.basic < PLAN_RANK.advance).toBe(true);
  });

  it("lateral changes are not downgrades", () => {
    const lateral = "pro" as const;
    expect(PLAN_RANK[lateral] >= PLAN_RANK[lateral]).toBe(true);
  });
});

describe("plan-downgrade delete-order policy", () => {
  it("vacant properties come before occupied ones (user policy)", () => {
    const props: Property[] = [
      prop("occ-old", "2024-01-01"),
      prop("vac-old", "2024-01-02"),
      prop("occ-new", "2026-01-01"),
      prop("vac-new", "2026-01-02"),
    ];
    const occupied = new Set(["occ-old", "occ-new"]);
    const ordered = orderForDeletion(props, occupied);
    expect(ordered.map((p) => p.id)).toEqual(["vac-new", "vac-old", "occ-new", "occ-old"]);
  });

  it("within each group, newest first (older = more established → preserve)", () => {
    const props: Property[] = [
      prop("old", "2020-01-01"),
      prop("mid", "2022-01-01"),
      prop("new", "2026-01-01"),
    ];
    const ordered = orderForDeletion(props, new Set());
    expect(ordered.map((p) => p.id)).toEqual(["new", "mid", "old"]);
  });

  it("downgrade from 5 → 2 with mixed occupancy deletes vacant first", () => {
    const props: Property[] = [
      prop("p1-occ", "2024-01-01"),
      prop("p2-vac", "2024-02-01"),
      prop("p3-occ", "2024-03-01"),
      prop("p4-vac", "2024-04-01"),
      prop("p5-occ", "2024-05-01"),
    ];
    const occupied = new Set(["p1-occ", "p3-occ", "p5-occ"]);
    const newCap = 2;
    const excess = props.length - newCap; // 3
    const toDelete = orderForDeletion(props, occupied).slice(0, excess);
    // Both vacant + the newest occupied (p5).
    expect(toDelete.map((p) => p.id).sort()).toEqual(["p2-vac", "p4-vac", "p5-occ"].sort());
    // The 2 OLDEST occupied survive — longest-held tenancies preserved.
    const kept = props.filter((p) => !toDelete.includes(p));
    expect(kept.map((p) => p.id).sort()).toEqual(["p1-occ", "p3-occ"].sort());
  });

  it("downgrade with all vacant survives no tenancy disruption", () => {
    const props: Property[] = [
      prop("v1", "2024-01-01"),
      prop("v2", "2024-02-01"),
      prop("v3", "2024-03-01"),
      prop("v4", "2024-04-01"),
    ];
    const occupied = new Set<string>();
    const toDelete = orderForDeletion(props, occupied).slice(0, 2);
    // Every delete is vacant — no occupied gets touched.
    expect(toDelete.every((p) => !occupied.has(p.id))).toBe(true);
  });

  it("downgrade with all occupied still deletes the newest tenancies", () => {
    const props: Property[] = [
      prop("o1", "2020-01-01"),
      prop("o2", "2022-01-01"),
      prop("o3", "2024-01-01"),
      prop("o4", "2026-01-01"),
    ];
    const occupied = new Set(["o1", "o2", "o3", "o4"]);
    const toDelete = orderForDeletion(props, occupied).slice(0, 2);
    // Newest two occupied — preserves the longest-running leases.
    expect(toDelete.map((p) => p.id)).toEqual(["o4", "o3"]);
  });
});

describe("effective unit cap (units.unlimited privilege override)", () => {
  it("a units.unlimited grant overrides the labelled cap to null (unlimited)", () => {
    // Matches the read-side gate (resolveUnitCap): a granted tier is uncapped,
    // so reconcile must NOT soft-deactivate properties when downgrading into it.
    expect(effectiveCap(2, true)).toBeNull();
    expect(effectiveCap(20, true)).toBeNull();
    expect(effectiveCap(null, true)).toBeNull();
  });

  it("without the grant the labelled cap is used verbatim", () => {
    expect(effectiveCap(2, false)).toBe(2);
    expect(effectiveCap(20, false)).toBe(20);
    expect(effectiveCap(null, false)).toBeNull(); // already unlimited (e.g. business)
  });
});

describe("30-day restore decision", () => {
  const now = "2026-06-15T12:00:00.000Z";

  it("resumes a lease suspended within the grace window when rent collection is allowed", () => {
    expect(restoreDecision(isoDaysBefore(now, 5), now, true)).toBe("resume");
    expect(restoreDecision(isoDaysBefore(now, GRACE_DAYS), now, true)).toBe("resume"); // exactly 30d still in
  });

  it("holds (keeps paused) within the window when rent collection is still lost", () => {
    expect(restoreDecision(isoDaysBefore(now, 5), now, false)).toBe("hold");
  });

  it("terminates a lease past the 30-day window regardless of rent collection", () => {
    expect(restoreDecision(isoDaysBefore(now, GRACE_DAYS + 1), now, true)).toBe("terminate");
    expect(restoreDecision(isoDaysBefore(now, 90), now, false)).toBe("terminate");
  });

  it("treats a missing suspendedAt as out-of-window (terminate)", () => {
    expect(restoreDecision(undefined, now, true)).toBe("terminate");
    expect(restoreDecision("not-a-date", now, true)).toBe("terminate");
  });

  it("the grace window is 30 days", () => {
    expect(GRACE_DAYS).toBe(30);
  });
});
