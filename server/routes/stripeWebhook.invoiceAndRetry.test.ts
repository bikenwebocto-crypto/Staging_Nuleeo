// Covers two webhook behaviors added alongside the delinquency-visibility work:
//   1. invoice.payment_failed → surface a failed owner-subscription charge
//      (staff page + owner nudge), and ignore non-subscription invoices.
//   2. Retry semantics: a throw inside ANY handled event now returns 5xx so
//      Stripe redelivers (previously only the two money-recording events did).
// Driving the REAL route via supertest pins the switch wiring + the catch
// branch, which a handler-only unit test can't.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = { customers: new Map(), transactions: new Map() };

const notifyStaff = vi.fn();
const notifyUser = vi.fn();
// applicationFees.retrieve is made to reject in the retry test to force a throw.
let appFeeRetrieve: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
  notifyStaff.mockReset().mockResolvedValue(undefined);
  notifyUser.mockReset().mockResolvedValue(undefined);
  appFeeRetrieve = vi.fn().mockResolvedValue({ id: "fee_1", amount: 1000, amount_refunded: 0 });
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_platform";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect";
});

function makeQuery(col: string) {
  const filters: Array<{ field: string; value: unknown }> = [];
  const q = {
    where(field: string, _op: string, value: unknown) {
      filters.push({ field, value });
      return q;
    },
    limit() {
      return q;
    },
    async get() {
      let rows = Array.from(store[col].entries()).map(([id, data]) => ({ id, data }));
      for (const f of filters) rows = rows.filter((r) => r.data[f.field] === f.value);
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((r) => ({ id: r.id, data: () => r.data, ref: { update: async () => {} } })),
      };
    },
  };
  return q;
}
const fakeDb = {
  collection(name: string) {
    return {
      where: (f: string, op: string, v: unknown) => makeQuery(name).where(f, op, v),
    };
  },
};

vi.mock("../firebase", () => ({ db: () => fakeDb }));
vi.mock("../stripe", () => ({
  stripe: () => ({
    webhooks: { constructEvent: (raw: Buffer) => JSON.parse(raw.toString("utf8")) },
    products: { retrieve: async () => ({ metadata: { firebaseRole: "pro" } }) },
    applicationFees: {
      retrieve: (...a: unknown[]) => appFeeRetrieve(...a),
      createRefund: async () => ({}),
    },
  }),
}));
vi.mock("../services/rentTransaction", () => ({
  recordRentTransactionFromSession: async () => ({}),
}));
vi.mock("../services/connectMirror", () => ({ mirrorConnectAccount: async () => ({}) }));
vi.mock("../services/planReconcile", () => ({
  reconcileAfterPlanChange: async () => null,
  reactivateAfterPlanUpgrade: async () => null,
}));
vi.mock("../services/planBilling", () => ({ supersedeActiveGift: async () => {} }));
vi.mock("../services/portfolioBanking", () => ({
  loadPortfolioByConnectAccount: async () => null,
}));
vi.mock("../services/push", () => ({
  notifyStaff: (...a: unknown[]) => notifyStaff(...a),
  notifyUser: (...a: unknown[]) => notifyUser(...a),
}));
vi.mock("../services/log", () => ({ logError: () => {}, logInfo: () => {}, logWarn: () => {} }));

import { registerStripeWebhookRoute } from "./stripeWebhook";

function makeApp() {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody: unknown }).rawBody = buf;
      },
    }),
  );
  registerStripeWebhookRoute(app);
  return app;
}

function post(event: unknown) {
  return request(makeApp())
    .post("/api/webhooks/stripe")
    .set("stripe-signature", "t=1,v1=test")
    .send(event as object);
}

describe("invoice.payment_failed → surface owner delinquency", () => {
  it("pages staff AND nudges the owner for a failed SUBSCRIPTION invoice", async () => {
    store.customers.set("owner-1", { stripeId: "cus_1" });
    const res = await post({
      id: "evt_inv_1",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_1",
          customer: "cus_1",
          amount_due: 6900,
          attempt_count: 1,
          billing_reason: "subscription_cycle",
        },
      },
    });
    expect(res.status).toBe(200);
    expect(notifyStaff).toHaveBeenCalledTimes(1);
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser.mock.calls[0][0]).toMatchObject({ externalUserId: "owner-1" });
  });

  it("still pages staff when the customer isn't mapped to a uid (no owner nudge)", async () => {
    const res = await post({
      id: "evt_inv_2",
      type: "invoice.payment_failed",
      data: {
        object: { id: "in_2", customer: "cus_unmapped", billing_reason: "subscription_create" },
      },
    });
    expect(res.status).toBe(200);
    expect(notifyStaff).toHaveBeenCalledTimes(1);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("ignores a non-subscription (one-off) invoice — no false 'plan payment failed'", async () => {
    store.customers.set("owner-1", { stripeId: "cus_1" });
    const res = await post({
      id: "evt_inv_3",
      type: "invoice.payment_failed",
      data: { object: { id: "in_3", customer: "cus_1", billing_reason: "manual" } },
    });
    expect(res.status).toBe(200);
    expect(notifyStaff).not.toHaveBeenCalled();
    expect(notifyUser).not.toHaveBeenCalled();
  });
});

describe("webhook retry semantics (item 6)", () => {
  it("returns 5xx retry when a HANDLED non-money event throws (charge.refunded)", async () => {
    // A subscription/refund handler throwing used to ack 200 (dropped silently).
    // Now it returns 5xx so Stripe redelivers. Force the throw via applicationFees.retrieve.
    appFeeRetrieve.mockRejectedValueOnce(new Error("stripe boom"));
    const res = await post({
      id: "evt_ref_1",
      type: "charge.refunded",
      account: "acct_owner_1",
      data: {
        object: { id: "ch_1", amount: 10000, amount_refunded: 5000, application_fee: "fee_1" },
      },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ received: false, retry: true });
  });

  it("acks 200 for a truly-unhandled event type (Stripe stops retrying)", async () => {
    const res = await post({ id: "evt_x", type: "payout.paid", data: { object: {} } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true });
  });
});
