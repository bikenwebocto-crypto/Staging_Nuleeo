// Unit tests for the 30-day inactive-property purge-eligibility predicate. The
// rest of the sweep (Firestore reads, storage deletes, batch writes) is
// integration-shaped and covered by staging QA; this pins the pure decision of
// WHICH properties are due for their document purge.

import { describe, expect, it } from "vitest";
import { isPropertyDueForPurge } from "./sweepInactiveUnits";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = new Date("2026-06-15T05:00:00.000Z").getTime();
const daysAgoIso = (n: number) => new Date(NOW_MS - n * DAY_MS).toISOString();

describe("isPropertyDueForPurge", () => {
  it("is due once inactive for the full 30-day window", () => {
    expect(
      isPropertyDueForPurge({ status: "inactive", deactivatedAt: daysAgoIso(31) }, NOW_MS),
    ).toBe(true);
    // Exactly 30 days + a hair past counts; this uses 30d + 1ms.
    expect(
      isPropertyDueForPurge(
        { status: "inactive", deactivatedAt: new Date(NOW_MS - 30 * DAY_MS - 1).toISOString() },
        NOW_MS,
      ),
    ).toBe(true);
  });

  it("is NOT due while still inside the grace window", () => {
    expect(
      isPropertyDueForPurge({ status: "inactive", deactivatedAt: daysAgoIso(10) }, NOW_MS),
    ).toBe(false);
    expect(
      isPropertyDueForPurge({ status: "inactive", deactivatedAt: daysAgoIso(29) }, NOW_MS),
    ).toBe(false);
  });

  it("is NOT due at EXACTLY 30 days — boundary stays in grace (matches restoreDecision's resume)", () => {
    // The sweep uses strict `<` so a property deactivated exactly 30 days ago is
    // still resumable, never simultaneously resume-able AND purge-able.
    expect(
      isPropertyDueForPurge(
        { status: "inactive", deactivatedAt: new Date(NOW_MS - 30 * DAY_MS).toISOString() },
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("skips properties already purged (idempotent re-runs)", () => {
    expect(
      isPropertyDueForPurge(
        { status: "inactive", deactivatedAt: daysAgoIso(90), docsPurgedAt: daysAgoIso(60) },
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("ignores active properties entirely", () => {
    expect(isPropertyDueForPurge({ status: "active", deactivatedAt: daysAgoIso(90) }, NOW_MS)).toBe(
      false,
    );
    expect(isPropertyDueForPurge({ deactivatedAt: daysAgoIso(90) }, NOW_MS)).toBe(false);
  });

  it("treats a missing deactivatedAt as not due (can't prove the window elapsed)", () => {
    expect(isPropertyDueForPurge({ status: "inactive" }, NOW_MS)).toBe(false);
    expect(isPropertyDueForPurge({ status: "inactive", deactivatedAt: "garbage" }, NOW_MS)).toBe(
      false,
    );
  });
});
