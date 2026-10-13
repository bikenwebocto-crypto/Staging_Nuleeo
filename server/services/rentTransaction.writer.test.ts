// Regression test for the rent-sign invariant on the Stripe card-capture
// writer (recordRentTransactionFromSession).
//
// Background: until 2026-06-07 this writer stored collected rent as
// `type: "expense"`, inverting every owner financial reader AND zeroing the
// admin platform-revenue dashboard (which filters `type === "income"` before
// summing applicationFeeCents). Collected rent is the owner's INCOME. This
// test pins that invariant against silent regression — it lives in its own
// file so it can mock ./rentCycle without disturbing rentTransaction.test.ts
// (which exercises the real advanceMonths helper).

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {
  transactions: new Map(),
  users: new Map(),
};

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
});

function makeRef(col: string, id: string) {
  return {
    id,
    async get() {
      const data = store[col].get(id);
      return { exists: !!data, id, data: () => data };
    },
    set(data: Row) {
      store[col].set(id, data);
    },
  };
}

const fakeDb = {
  collection(name: string) {
    return { doc: (id: string) => makeRef(name, id) };
  },
  async runTransaction<T>(cb: (t: unknown) => Promise<T>): Promise<T> {
    const t = {
      async get(ref: { get: () => Promise<unknown> }) {
        return ref.get();
      },
      set(ref: { set: (d: Row) => void }, data: Row) {
        ref.set(data);
      },
    };
    return cb(t);
  },
};

vi.mock("../firebase", () => ({ db: () => fakeDb }));
vi.mock("./push", () => ({ notifyUser: async () => {} }));
vi.mock("./rentCycle", () => ({
  advanceAgreementForPayment: async () => ({ advanced: false }),
  advanceMonths: (iso: string) => iso,
}));

import { recordRentTransactionFromSession } from "./rentTransaction";
import type { RentCheckoutSession } from "./rentTransaction";

function session(overrides: Partial<RentCheckoutSession> = {}): RentCheckoutSession {
  return {
    id: "cs_sign_test",
    amount_total: 120_000,
    currency: "eur",
    metadata: { ownerId: "owner-1", tenantId: "ten-1", propertyId: "prop-1" },
    payment_intent: { application_fee_amount: 5_000 },
    ...overrides,
  };
}

describe("recordRentTransactionFromSession — rent-sign invariant", () => {
  it("records collected card rent as type=income (not expense), category=rent", async () => {
    const { tx, created } = await recordRentTransactionFromSession(session());
    expect(created).toBe(true);
    expect(tx.type).toBe("income");
    expect(tx.category).toBe("rent");
    // Persisted shape matches the returned tx.
    expect(store.transactions.get("stripe_cs_sign_test")?.type).toBe("income");
    // Fee is still captured so the admin revenue/commission chart (which reads
    // applicationFeeCents off income rows) has data to sum.
    expect(tx.applicationFeeCents).toBe(5_000);
  });

  it("stores the PaymentIntent id so a later charge.refunded can find this row", async () => {
    // Unexpanded (bare id) form.
    const a = await recordRentTransactionFromSession(
      session({ id: "cs_pi_str", payment_intent: "pi_abc" }),
    );
    expect(a.tx.stripePaymentIntentId).toBe("pi_abc");
    expect(store.transactions.get("stripe_cs_pi_str")?.stripePaymentIntentId).toBe("pi_abc");

    // Expanded form: read the id off the object.
    const b = await recordRentTransactionFromSession(
      session({ id: "cs_pi_obj", payment_intent: { id: "pi_xyz", application_fee_amount: 5_000 } }),
    );
    expect(b.tx.stripePaymentIntentId).toBe("pi_xyz");
  });
});
