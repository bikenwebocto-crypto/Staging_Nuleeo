// Regression for the MISSING customer.subscription.deleted handler. A fully
// canceled / ended paid subscription must reconcile the owner's portfolio DOWN
// to basic (soft-deactivate over-cap properties, suspend rent collection) —
// otherwise an owner who cancels keeps every over-cap property active and rent
// still collecting on a plan they no longer pay for. Driving the REAL route via
// supertest also pins the switch WIRING: a unit test on the handler couldn't
// catch the case being absent from the switch (the original bug).

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = { customers: new Map() };
const reconcileAfterPlanChange = vi.fn();
const reactivateAfterPlanUpgrade = vi.fn();
// What products.retrieve reports as firebaseRole for the canceled sub's product.
let productRole: string | null = "pro";

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
  reconcileAfterPlanChange.mockReset().mockResolvedValue(null);
  reactivateAfterPlanUpgrade.mockReset().mockResolvedValue(null);
  productRole = "pro";
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
        docs: rows.map((r) => ({ id: r.id, data: () => r.data })),
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
    products: {
      retrieve: async () => ({ metadata: productRole ? { firebaseRole: productRole } : {} }),
    },
  }),
}));
vi.mock("../services/rentTransaction", () => ({
  recordRentTransactionFromSession: async () => ({}),
}));
vi.mock("../services/connectMirror", () => ({ mirrorConnectAccount: async () => {} }));
vi.mock("../services/planReconcile", () => ({
  reconcileAfterPlanChange: (...a: unknown[]) => reconcileAfterPlanChange(...a),
  reactivateAfterPlanUpgrade: (...a: unknown[]) => reactivateAfterPlanUpgrade(...a),
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

function postDeleted(opts: { customer: string; product: string | null }) {
  const event = {
    id: "evt_del_1",
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_1",
        customer: opts.customer,
        items: { data: [{ price: { product: opts.product } }] },
      },
    },
  };
  return request(makeApp())
    .post("/api/webhooks/stripe")
    .set("stripe-signature", "t=1,v1=test")
    .send(event);
}

describe("customer.subscription.deleted → reconcile down to basic", () => {
  it("reconciles a canceled PRO owner down to basic", async () => {
    store.customers.set("owner-1", { stripeId: "cus_1" });
    productRole = "pro";
    const res = await postDeleted({ customer: "cus_1", product: "prod_pro" });
    expect(res.status).toBe(200);
    expect(reconcileAfterPlanChange).toHaveBeenCalledWith("owner-1", "pro", "basic");
  });

  it("no-ops when the product already maps to basic", async () => {
    store.customers.set("owner-1", { stripeId: "cus_1" });
    productRole = "basic";
    const res = await postDeleted({ customer: "cus_1", product: "prod_basic" });
    expect(res.status).toBe(200);
    expect(reconcileAfterPlanChange).not.toHaveBeenCalled();
  });

  it("no-ops when the product is unknown (no firebaseRole metadata)", async () => {
    store.customers.set("owner-1", { stripeId: "cus_1" });
    productRole = null;
    const res = await postDeleted({ customer: "cus_1", product: "prod_weird" });
    expect(res.status).toBe(200);
    expect(reconcileAfterPlanChange).not.toHaveBeenCalled();
  });

  it("no-ops when no customers doc maps the Stripe customer to a uid", async () => {
    productRole = "pro";
    const res = await postDeleted({ customer: "cus_unmapped", product: "prod_pro" });
    expect(res.status).toBe(200);
    expect(reconcileAfterPlanChange).not.toHaveBeenCalled();
  });
});
