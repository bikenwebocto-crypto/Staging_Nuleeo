// Unit tests for the "is this rent cycle already paid?" guard that keeps the
// overdue reminder from nagging tenants who have paid. The rest of the sweep
// (Firestore queries, OneSignal push, plan/prefs gating) is integration-shaped
// and covered elsewhere; this pins the pure decision logic.

import { describe, expect, it } from "vitest";
import { cycleHasRentPayment } from "./rentReminders";

const DUE = "2026-06-01"; // cycle due date the overdue sweep is checking

type Tx = { category: string; status: string; timestamp: string };
const tx = (over: Partial<Tx> = {}): Tx => ({
  category: "rent",
  status: "completed",
  timestamp: "2026-06-01T09:00:00.000Z",
  ...over,
});

describe("cycleHasRentPayment", () => {
  it("treats a card payment (completed) on the due date as paid", () => {
    expect(cycleHasRentPayment([tx()], DUE)).toBe(true);
  });

  it("treats a verified offline payment (completed) as paid", () => {
    expect(cycleHasRentPayment([tx({ status: "completed" })], DUE)).toBe(true);
  });

  it("does NOT silence the nudge for an unverified offline payment (pending)", () => {
    // We take the owner's verification, not the tenant's claim, as proof of
    // payment — a logged-but-unconfirmed bank transfer still gets nagged.
    expect(cycleHasRentPayment([tx({ status: "pending" })], DUE)).toBe(false);
  });

  it("does NOT count a pending payment even if a separate failed one exists", () => {
    expect(cycleHasRentPayment([tx({ status: "pending" }), tx({ status: "failed" })], DUE)).toBe(
      false,
    );
  });

  it("counts a payment made a few days early (within the lookback window)", () => {
    expect(cycleHasRentPayment([tx({ timestamp: "2026-05-25T00:00:00.000Z" })], DUE)).toBe(true);
  });

  it("ignores the previous month's payment (~30 days before the due date)", () => {
    expect(cycleHasRentPayment([tx({ timestamp: "2026-05-01T09:00:00.000Z" })], DUE)).toBe(false);
  });

  it("ignores failed payments", () => {
    expect(cycleHasRentPayment([tx({ status: "failed" })], DUE)).toBe(false);
  });

  it("ignores non-rent transactions (e.g. a deposit or fee)", () => {
    expect(cycleHasRentPayment([tx({ category: "deposit" })], DUE)).toBe(false);
  });

  it("returns false when the tenancy has no transactions at all", () => {
    expect(cycleHasRentPayment([], DUE)).toBe(false);
  });

  it("tolerates a full ISO timestamp as the due date", () => {
    expect(cycleHasRentPayment([tx()], "2026-06-01T00:00:00.000Z")).toBe(true);
  });
});
