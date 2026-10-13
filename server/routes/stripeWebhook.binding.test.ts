// H7 regression: the rent webhook must bind the recorded transaction to the
// connected account that fired the event (event.account), NOT trust the
// session's metadata.ownerId. A malicious connected owner can craft a paid
// session on their OWN Standard account carrying a victim's ownerId; without
// this binding we'd record a forged rent payment into the victim's portfolio.
//
// We drive the real route via supertest. constructEvent is mocked to parse the
// raw body (signature is irrelevant to the behavior under test), and
// recordRentTransactionFromSession is a spy we assert on.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
// Banking (incl. the Connect account id) lives on COL.portfolios. The binding
// resolves the owner via loadPortfolioByConnectAccount, which queries
// `portfolios` by connectAccountId (the sole source of truth — no user-doc
// fallback). So the store needs a `portfolios` Map.
const store: Record<string, Map<string, Row>> = { users: new Map(), portfolios: new Map() };
let autoId = 0;
const recordRentTransactionFromSession = vi.fn();

beforeEach(() => {
  for (const m of Object.values(store)) m.clear();
  autoId = 0;
  recordRentTransactionFromSession.mockReset().mockResolvedValue({ tx: {}, created: true });
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_platform";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect";
});

function makeRef(col: string, id: string) {
  return {
    id,
    async get() {
      const data = store[col].get(id);
      return { exists: !!data, id, data: () => data };
    },
    async set(data: Row, opts?: { merge?: boolean }) {
      if (opts?.merge) {
        store[col].set(id, { ...(store[col].get(id) ?? {}), ...data });
      } else {
        store[col].set(id, data);
      }
    },
  };
}

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
      let rows = Array.from(store[col].entries()).map(([id, data]) => ({
        id,
        data,
      }));
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
      // No-arg doc() generates a fresh id (ensurePortfolio creates the
      // portfolio with an owner-independent id, NOT the ownerId).
      doc(id?: string) {
        return makeRef(name, id ?? `auto_${name}_${autoId++}`);
      },
      where(field: string, op: string, value: unknown) {
        return makeQuery(name).where(field, op, value);
      },
    };
  },
};

vi.mock("../firebase", () => ({ db: () => fakeDb }));
vi.mock("../stripe", () => ({
  stripe: () => ({
    webhooks: {
      constructEvent: (raw: Buffer) => JSON.parse(raw.toString("utf8")),
    },
    checkout: { sessions: { retrieve: async () => ({ id: "cs_1" }) } },
  }),
}));
vi.mock("../services/rentTransaction", () => ({
  recordRentTransactionFromSession: (...a: unknown[]) => recordRentTransactionFromSession(...a),
}));
vi.mock("../services/connectMirror", () => ({ mirrorConnectAccount: async () => {} }));
vi.mock("../services/planReconcile", () => ({
  reconcileAfterPlanChange: async () => null,
  reactivateAfterPlanUpgrade: async () => null,
}));
vi.mock("../services/log", () => ({
  logError: () => {},
  logInfo: () => {},
  logWarn: () => {},
}));

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

function postRentEvent(opts: { ownerId: string; account?: string; portfolioId?: string }) {
  const event = {
    id: "evt_1",
    type: "checkout.session.completed",
    ...(opts.account ? { account: opts.account } : {}),
    data: {
      object: {
        id: "cs_1",
        payment_status: "paid",
        metadata: {
          purpose: "rent",
          ownerId: opts.ownerId,
          // Newer checkout sessions stamp the STABLE portfolio id too;
          // pre-deploy sessions omit it (the legacy/back-compat shape).
          ...(opts.portfolioId ? { portfolioId: opts.portfolioId } : {}),
        },
      },
    },
  };
  return request(makeApp())
    .post("/api/webhooks/stripe")
    .set("stripe-signature", "t=1,v1=test")
    .send(event);
}

describe("rent webhook account binding (H7)", () => {
  it("records when the account is held by a PORTFOLIO doc (the binding source)", async () => {
    // Migrated owner: banking lives on the portfolio (keyed by its own id,
    // ownerId set), and the user doc no longer carries connectAccountId. The
    // binding resolves directly through `portfolios` — no legacy fallback.
    store.portfolios.set("pf-xyz", {
      id: "pf-xyz",
      ownerId: "owner-a",
      connectAccountId: "acct_a",
    });
    const res = await postRentEvent({ ownerId: "owner-a", account: "acct_a" });
    expect(res.status).toBe(200);
    expect(recordRentTransactionFromSession).toHaveBeenCalledTimes(1);
  });

  it("REFUSES a portfolio-held account when metadata.ownerId is a forged victim", async () => {
    // Same H7 intent, now via the portfolio path: the account belongs to the
    // portfolio's real owner, but the session claims a different ownerId.
    store.portfolios.set("pf-xyz", {
      id: "pf-xyz",
      ownerId: "owner-a",
      connectAccountId: "acct_a",
    });
    const res = await postRentEvent({ ownerId: "victim", account: "acct_a" });
    expect(res.status).toBe(200);
    expect(recordRentTransactionFromSession).not.toHaveBeenCalled();
  });

  it("REFUSES to record when no portfolio holds the event.account", async () => {
    const res = await postRentEvent({ ownerId: "owner-a", account: "acct_unknown" });
    expect(res.status).toBe(200);
    expect(recordRentTransactionFromSession).not.toHaveBeenCalled();
  });

  it("REFUSES a rent event with no event.account (platform-side delivery)", async () => {
    store.portfolios.set("pf-xyz", {
      id: "pf-xyz",
      ownerId: "owner-a",
      connectAccountId: "acct_a",
    });
    const res = await postRentEvent({ ownerId: "owner-a" });
    expect(res.status).toBe(200);
    expect(recordRentTransactionFromSession).not.toHaveBeenCalled();
  });
});

// Phase 2 hardening: checkout now stamps the STABLE portfolio id into session
// metadata alongside ownerId. When present it must ALSO match the portfolio
// bound to event.account (defense in depth on top of the H7 ownerId binding);
// when absent (a session created before the stamp deployed) the ownerId check
// alone still decides — no regression for in-flight checkouts.
describe("rent webhook portfolio-id binding (Phase 2)", () => {
  beforeEach(() => {
    store.portfolios.set("pf-xyz", {
      id: "pf-xyz",
      ownerId: "owner-a",
      connectAccountId: "acct_a",
    });
  });

  it("records when metadata carries the MATCHING portfolioId + ownerId", async () => {
    const res = await postRentEvent({
      ownerId: "owner-a",
      account: "acct_a",
      portfolioId: "pf-xyz",
    });
    expect(res.status).toBe(200);
    expect(recordRentTransactionFromSession).toHaveBeenCalledTimes(1);
  });

  it("REFUSES a matching ownerId with a MISMATCHED portfolioId", async () => {
    // ownerId lines up with the bound portfolio's owner, but the session
    // claims a DIFFERENT portfolio — the new check must reject it.
    const res = await postRentEvent({
      ownerId: "owner-a",
      account: "acct_a",
      portfolioId: "pf-victim",
    });
    expect(res.status).toBe(200);
    expect(recordRentTransactionFromSession).not.toHaveBeenCalled();
  });

  it("still records a LEGACY session with no metadata.portfolioId (back-compat)", async () => {
    const res = await postRentEvent({ ownerId: "owner-a", account: "acct_a" });
    expect(res.status).toBe(200);
    expect(recordRentTransactionFromSession).toHaveBeenCalledTimes(1);
  });
});

// A transient failure while RECORDING a paid rent charge must return 5xx so
// Stripe retries (the recorder is idempotent on the deterministic stripe_<id>
// doc, so a retry can't double-book). Previously every handler error was
// swallowed with a 200, permanently losing the ledger row for real money moved.
describe("money-event errors return 5xx (Stripe retry)", () => {
  beforeEach(() => {
    store.portfolios.set("pf-xyz", {
      id: "pf-xyz",
      ownerId: "owner-a",
      connectAccountId: "acct_a",
    });
  });

  it("returns 500 when recording a paid rent charge throws transiently", async () => {
    recordRentTransactionFromSession.mockRejectedValueOnce(new Error("firestore unavailable"));
    const res = await postRentEvent({ ownerId: "owner-a", account: "acct_a" });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ received: false, retry: true });
    expect(recordRentTransactionFromSession).toHaveBeenCalledTimes(1);
  });
});
