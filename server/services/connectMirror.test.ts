// Tests for mirrorConnectAccount. Verifies the authoritative-replace
// behavior (every field is written, including null for cleared values)
// + that the snapshot is mirrored onto the PORTFOLIO doc (banking moved
// off the user doc onto COL.portfolios; mirrorConnectAccount now takes a
// portfolioId and writes via writePortfolioBanking → COL.portfolios).

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, unknown>;
// One Map per collection writePortfolioBanking touches. Banking now lands on
// `portfolios`, so that's the only collection this test exercises — but the
// fakeDb routes every collection() through `store`, so each used name needs a
// Map (the in-memory Firestore double pattern shared across these tests).
const store: Record<string, Map<string, Row>> = { portfolios: new Map() };

let mockSet: ReturnType<typeof vi.fn>;
// Records the collection a write landed in so we can prove banking is written
// to `portfolios`, not the legacy `users` doc.
let lastWrittenCollection: string | null = null;
let lastWrittenPatch: Record<string, unknown> | null = null;

const fakeDb = {
  collection(name: string) {
    return {
      doc(id?: string) {
        const docId = id ?? "auto";
        return {
          id: docId,
          set: (...args: unknown[]) => {
            mockSet(...args);
            lastWrittenCollection = name;
            lastWrittenPatch = args[0] as Record<string, unknown>;
            const data = args[0] as Row;
            const opts = args[1] as { merge?: boolean } | undefined;
            if (opts?.merge) {
              store[name].set(docId, { ...(store[name].get(docId) ?? {}), ...data });
            } else {
              store[name].set(docId, data);
            }
            return Promise.resolve();
          },
        };
      },
    };
  },
};

vi.mock("../firebase", () => ({ db: () => fakeDb }));

const { mirrorConnectAccount } = await import("./connectMirror");

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
  mockSet = vi.fn();
  lastWrittenCollection = null;
  lastWrittenPatch = null;
});

describe("mirrorConnectAccount", () => {
  it("writes a fully-populated patch from a healthy account snapshot", async () => {
    await mirrorConnectAccount("pf-123", {
      id: "acct_X",
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      requirements: {
        currently_due: [],
        past_due: [],
        pending_verification: [],
        disabled_reason: null,
      },
      capabilities: {
        card_payments: "active",
        transfers: "active",
      },
    });
    const p = lastWrittenPatch!;
    expect(p.connectAccountId).toBe("acct_X");
    expect(p.connectDetailsSubmitted).toBe(true);
    expect(p.connectChargesEnabled).toBe(true);
    expect(p.connectPayoutsEnabled).toBe(true);
    expect(p.connectDisabledReason).toBeNull();
    expect(p.connectCardPaymentsStatus).toBe("active");
    expect(p.connectTransfersStatus).toBe("active");
    expect(typeof p.connectLastSyncedAt).toBe("string");
  });

  it("lands the patch on the PORTFOLIO doc (not the user) + stamps updatedAt", async () => {
    await mirrorConnectAccount("pf-123", {
      id: "acct_X",
      charges_enabled: true,
      capabilities: { card_payments: "active", transfers: "active" },
    });
    // Banking lives on COL.portfolios now — the write must land there, keyed
    // by the portfolioId we passed (NOT a user doc).
    expect(lastWrittenCollection).toBe("portfolios");
    const persisted = store.portfolios.get("pf-123")!;
    expect(persisted).toBeTruthy();
    expect(persisted.connectAccountId).toBe("acct_X");
    expect(persisted.connectChargesEnabled).toBe(true);
    expect(persisted.connectCardPaymentsStatus).toBe("active");
    // writePortfolioBanking stamps updatedAt on every write.
    expect(typeof persisted.updatedAt).toBe("string");
  });

  it("calls set with merge:true so unrelated portfolio fields aren't clobbered", async () => {
    await mirrorConnectAccount("pf-123", { id: "acct_X" });
    expect(mockSet).toHaveBeenCalledTimes(1);
    const opts = mockSet.mock.calls[0][1];
    expect(opts).toEqual({ merge: true });
  });

  // ── Regression: authoritative replace ────────────────────────────
  // The historical bug: Stripe flips an account from "restricted" back
  // to OK + clears disabled_reason. We were only writing disabled_reason
  // when truthy, so the user doc kept the stale "Contact support"
  // string forever. mirrorConnectAccount now writes EVERY field
  // including the cleared-to-null case.

  it("writes disabledReason: null when Stripe cleared the flag", async () => {
    await mirrorConnectAccount("pf-123", {
      id: "acct_X",
      charges_enabled: true,
      requirements: {
        currently_due: [],
        past_due: [],
        pending_verification: [],
        disabled_reason: null,
      },
    });
    expect(lastWrittenPatch).toMatchObject({ connectDisabledReason: null });
  });

  it("writes capability statuses as null when Stripe didn't include them", async () => {
    await mirrorConnectAccount("pf-123", {
      id: "acct_X",
      charges_enabled: false,
    });
    expect(lastWrittenPatch).toMatchObject({
      connectCardPaymentsStatus: null,
      connectTransfersStatus: null,
    });
  });

  it("normalizes a known capability status string through", async () => {
    await mirrorConnectAccount("pf-123", {
      id: "acct_X",
      capabilities: { card_payments: "pending", transfers: "restricted" },
    });
    expect(lastWrittenPatch).toMatchObject({
      connectCardPaymentsStatus: "pending",
      connectTransfersStatus: "restricted",
    });
  });

  it("drops an UNKNOWN capability status to null (defends against future Stripe values)", async () => {
    await mirrorConnectAccount("pf-123", {
      id: "acct_X",
      capabilities: { card_payments: "some-future-status" },
    });
    expect(lastWrittenPatch).toMatchObject({ connectCardPaymentsStatus: null });
  });

  it("defaults requirements arrays to [] when Stripe omitted them", async () => {
    await mirrorConnectAccount("pf-123", {
      id: "acct_X",
      charges_enabled: true,
    });
    expect(lastWrittenPatch).toMatchObject({
      connectRequirementsDue: [],
      connectRequirementsPastDue: [],
      connectRequirementsPendingVerification: [],
    });
  });

  it("passes through requirement arrays when Stripe included them", async () => {
    await mirrorConnectAccount("pf-123", {
      id: "acct_X",
      requirements: {
        currently_due: ["business_profile.url"],
        past_due: ["external_account"],
        pending_verification: ["individual.verification.document"],
        disabled_reason: "requirements.past_due",
      },
    });
    expect(lastWrittenPatch).toMatchObject({
      connectRequirementsDue: ["business_profile.url"],
      connectRequirementsPastDue: ["external_account"],
      connectRequirementsPendingVerification: ["individual.verification.document"],
      connectDisabledReason: "requirements.past_due",
    });
  });

  it("coerces falsy charges_enabled / details_submitted to false (not undefined)", async () => {
    await mirrorConnectAccount("pf-123", { id: "acct_X" });
    expect(lastWrittenPatch).toMatchObject({
      connectChargesEnabled: false,
      connectPayoutsEnabled: false,
      connectDetailsSubmitted: false,
    });
  });

  it("returns the same patch it wrote (callers can mirror locally)", async () => {
    const patch = await mirrorConnectAccount("pf-123", {
      id: "acct_X",
      charges_enabled: true,
    });
    expect(patch.connectAccountId).toBe("acct_X");
    expect(patch.connectChargesEnabled).toBe(true);
  });
});
