// Coverage for the charge.refunded → application-fee refund path, which moves
// real platform money but previously had zero tests. Drives the real route via
// supertest with stripe().applicationFees mocked, asserting the PROPORTIONAL
// fee refund + the idempotency key keyed on the event id.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const retrieve = vi.fn();
const createRefund = vi.fn();
// Firestore double for the refund-stamp lookup: onChargeRefunded resolves the
// rent Transaction by stripePaymentIntentId and updates it. txDocs is what the
// where(...).limit(1).get() returns; txUpdate is the spy on that row's update.
const txUpdate = vi.fn();
let txDocs: Array<{ ref: { update: (...a: unknown[]) => unknown } }> = [];

beforeEach(() => {
  retrieve.mockReset();
  createRefund.mockReset().mockResolvedValue({});
  txUpdate.mockReset().mockResolvedValue(undefined);
  txDocs = [];
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_platform";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect";
});

vi.mock("../firebase", () => ({
  db: () => ({
    collection: () => ({
      where: () => ({
        limit: () => ({
          get: async () => ({ empty: txDocs.length === 0, docs: txDocs }),
        }),
      }),
    }),
  }),
}));
vi.mock("../stripe", () => ({
  stripe: () => ({
    webhooks: { constructEvent: (raw: Buffer) => JSON.parse(raw.toString("utf8")) },
    applicationFees: {
      retrieve: (...a: unknown[]) => retrieve(...a),
      createRefund: (...a: unknown[]) => createRefund(...a),
    },
  }),
}));
vi.mock("../services/rentTransaction", () => ({
  recordRentTransactionFromSession: async () => ({}),
}));
vi.mock("../services/connectMirror", () => ({ mirrorConnectAccount: async () => {} }));
vi.mock("../services/planReconcile", () => ({
  reconcileAfterPlanChange: async () => null,
  reactivateAfterPlanUpgrade: async () => null,
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

function postCharge(object: Record<string, unknown>) {
  const event = {
    id: "evt_cr_1",
    type: "charge.refunded",
    account: "acct_owner",
    data: { object },
  };
  return request(makeApp())
    .post("/api/webhooks/stripe")
    .set("stripe-signature", "t=1,v1=test")
    .send(event);
}

describe("charge.refunded → proportional application-fee refund", () => {
  it("refunds the full fee when the whole charge was refunded", async () => {
    retrieve.mockResolvedValueOnce({ id: "fee_1", amount: 300, amount_refunded: 0 });
    const res = await postCharge({
      amount: 10000,
      amount_refunded: 10000,
      application_fee: "fee_1",
    });
    expect(res.status).toBe(200);
    expect(createRefund).toHaveBeenCalledWith(
      "fee_1",
      { amount: 300 },
      { idempotencyKey: "refund_evt_cr_1" },
    );
  });

  it("refunds proportionally on a partial charge refund", async () => {
    retrieve.mockResolvedValueOnce({ id: "fee_1", amount: 300, amount_refunded: 0 });
    const res = await postCharge({
      amount: 10000,
      amount_refunded: 5000,
      application_fee: "fee_1",
    });
    expect(res.status).toBe(200);
    // 50% of the charge → 50% of the €3.00 fee.
    expect(createRefund).toHaveBeenCalledWith(
      "fee_1",
      { amount: 150 },
      { idempotencyKey: "refund_evt_cr_1" },
    );
  });

  it("no-ops when nothing was refunded to the cardholder", async () => {
    const res = await postCharge({ amount: 10000, amount_refunded: 0, application_fee: "fee_1" });
    expect(res.status).toBe(200);
    expect(retrieve).not.toHaveBeenCalled();
    expect(createRefund).not.toHaveBeenCalled();
  });

  it("no-ops when the charge carries no application fee", async () => {
    const res = await postCharge({ amount: 10000, amount_refunded: 10000, application_fee: null });
    expect(res.status).toBe(200);
    expect(retrieve).not.toHaveBeenCalled();
    expect(createRefund).not.toHaveBeenCalled();
  });

  it("no-ops when the fee is already fully refunded (no headroom)", async () => {
    retrieve.mockResolvedValueOnce({ id: "fee_1", amount: 300, amount_refunded: 300 });
    const res = await postCharge({
      amount: 10000,
      amount_refunded: 10000,
      application_fee: "fee_1",
    });
    expect(res.status).toBe(200);
    expect(createRefund).not.toHaveBeenCalled();
  });

  it("stamps the cardholder refund + cumulative fee refund onto the matching rent Transaction", async () => {
    txDocs = [{ ref: { update: txUpdate } }];
    retrieve.mockResolvedValueOnce({ id: "fee_1", amount: 300, amount_refunded: 0 });
    const res = await postCharge({
      id: "ch_1",
      amount: 10000,
      amount_refunded: 4000, // 40% partial refund
      application_fee: "fee_1",
      payment_intent: "pi_123",
    });
    expect(res.status).toBe(200);
    // Fee refund still runs: 40% of the €3.00 fee.
    expect(createRefund).toHaveBeenCalledWith(
      "fee_1",
      { amount: 120 },
      { idempotencyKey: "refund_evt_cr_1" },
    );
    // …and the rent row is annotated so the admin view reflects the refund.
    expect(txUpdate).toHaveBeenCalledWith({ refundedAmountCents: 4000, feeRefundedCents: 120 });
  });

  it("does not throw (still 200, fee still refunded) when no rent row matches the PaymentIntent", async () => {
    txDocs = []; // no Transaction carries this PaymentIntent
    retrieve.mockResolvedValueOnce({ id: "fee_1", amount: 300, amount_refunded: 0 });
    const res = await postCharge({
      id: "ch_1",
      amount: 10000,
      amount_refunded: 10000,
      application_fee: "fee_1",
      payment_intent: "pi_unknown",
    });
    expect(res.status).toBe(200);
    expect(createRefund).toHaveBeenCalledWith(
      "fee_1",
      { amount: 300 },
      { idempotencyKey: "refund_evt_cr_1" },
    );
    expect(txUpdate).not.toHaveBeenCalled();
  });
});
