import { describe, expect, it } from "vitest";
import type { Transaction } from "./firestore-schema";
import {
  bankMovementKey,
  isAwaitingReview,
  isVerifiedLedgerActivity,
  pickDuplicateCandidate,
  resolveReconciliationStatus,
  resolveTransactionSource,
  workspaceIdFor,
} from "./transactions";

const base: Transaction = {
  id: "x",
  name: "Rent Payment",
  amount: 1200,
  currency: "EUR",
  type: "income",
  category: "rent",
  status: "completed",
  timestamp: "2026-11-01T10:00:00.000Z",
};

describe("resolveTransactionSource (legacy compatibility)", () => {
  it("prefers the stamped source", () => {
    expect(resolveTransactionSource({ ...base, source: "manual" })).toBe("manual");
  });
  it("infers legacy rows from deterministic id prefixes", () => {
    expect(resolveTransactionSource({ ...base, id: "stripe_cs_1" })).toBe("rent");
    expect(resolveTransactionSource({ ...base, id: "offline_abc" })).toBe("rent");
    expect(resolveTransactionSource({ ...base, id: "settle_abc" })).toBe("settlement");
    expect(
      resolveTransactionSource({ ...base, id: "a1", type: "neutral", category: "maintenance" }),
    ).toBe("maintenance_report");
  });
  it("never classifies an unknown legacy row as manual (keeps it immutable)", () => {
    expect(
      resolveTransactionSource({ ...base, id: "auto1", category: "tax", type: "expense" }),
    ).not.toBe("manual");
  });
});

describe("reconciliation is independent of payment status", () => {
  it("a completed legacy payment is unreconciled", () => {
    expect(resolveReconciliationStatus(base)).toBe("unreconciled");
  });
  it("neutral rows have nothing to reconcile", () => {
    expect(resolveReconciliationStatus({ ...base, type: "neutral", category: "maintenance" })).toBe(
      "not_applicable",
    );
  });
});

describe("imports require review", () => {
  const imported: Transaction = {
    ...base,
    id: "bank_1",
    type: "neutral",
    category: "other",
    status: "pending",
    source: "bank_import",
    classification: { status: "suggested", type: "income", category: "other" },
  };
  it("pending suggested import is not verified ledger activity", () => {
    expect(isAwaitingReview(imported)).toBe(true);
    expect(isVerifiedLedgerActivity(imported)).toBe(false);
  });
  it("approved import is verified", () => {
    const approved: Transaction = {
      ...imported,
      type: "income",
      status: "completed",
      classification: { ...imported.classification!, status: "approved" },
    };
    expect(isVerifiedLedgerActivity(approved)).toBe(true);
  });
});

describe("bank duplicate detection", () => {
  const movement = { date: "2026-11-02", amount: 1200, description: "SEPA rent J Doe" };
  it("matches an existing payment with same amount/direction within 3 days", () => {
    expect(pickDuplicateCandidate([{ ...base, id: "stripe_1" }], movement)?.id).toBe("stripe_1");
  });
  it("ignores wrong direction, different amount, far dates, and already-matched rows", () => {
    const rows: Transaction[] = [
      { ...base, id: "a", type: "expense" },
      { ...base, id: "b", amount: 1199.99 },
      { ...base, id: "c", timestamp: "2026-10-01T00:00:00.000Z" },
      { ...base, id: "d", reconciliation: { status: "matched" } },
      { ...base, id: "e", status: "failed" },
    ];
    expect(pickDuplicateCandidate(rows, movement)).toBeNull();
  });
  it("does not let two bank lines claim the same payment", () => {
    expect(pickDuplicateCandidate([{ ...base, id: "s" }], movement, new Set(["s"]))).toBeNull();
  });
  it("movement key is stable for the same line", () => {
    expect(bankMovementKey(movement, "acc")).toBe(
      bankMovementKey({ ...movement, description: "  sepa RENT  j doe " }, "acc"),
    );
    expect(bankMovementKey({ ...movement, movementId: "m1" }, "acc")).toBe("acc|id|m1");
  });
});

describe("workspaceIdFor", () => {
  it("business rows go to the owner's business workspace", () => {
    expect(workspaceIdFor({ entityId: "e1", ownerId: "u1" })).toBe("biz_u1");
  });
  it("portfolio rows go to the real-estate workspace", () => {
    expect(workspaceIdFor({ portfolioId: "p1" })).toBe("re_p1");
  });
});
