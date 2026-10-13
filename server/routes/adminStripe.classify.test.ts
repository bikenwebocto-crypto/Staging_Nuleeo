import { describe, it, expect } from "vitest";
import { classifyWebhookEndpoints } from "./adminStripe";

// Mirrors the constants the live-health route passes in.
const PATH = "/api/webhooks/stripe";
const CONNECT_EVENTS = [
  "checkout.session.completed",
  "payment_intent.succeeded",
  "charge.refunded",
  "account.updated",
];
const PLATFORM_EVENTS = [
  "account.updated",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];
// A realistic platform ("Your account") endpoint also subscribes to the
// checkout/payment events (owner SUBSCRIPTION checkouts fire them on the
// platform account) — this is exactly the case that broke the first fix.
const PLATFORM_EVENTS_REALISTIC = [
  ...PLATFORM_EVENTS,
  "checkout.session.completed",
  "payment_intent.succeeded",
  "charge.refunded",
];

const classify = (v1: unknown[], v2: unknown[]) =>
  classifyWebhookEndpoints({
    v1,
    v2,
    path: PATH,
    connectEvents: CONNECT_EVENTS,
    platformEvents: PLATFORM_EVENTS,
  });

describe("classifyWebhookEndpoints", () => {
  it("classifies a v1 endpoint with an explicit connect:true flag as connect", () => {
    const out = classify(
      [
        {
          id: "we_1",
          url: `https://app.oliowallet.com${PATH}`,
          status: "enabled",
          connect: true,
          enabled_events: CONNECT_EVENTS,
        },
      ],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].connect).toBe(true);
    expect(out[0].missingEvents).toEqual([]);
  });

  it("INFERS connect-scope on a v1 endpoint that has no connect field (the real bug) from the direct-charge events", () => {
    // This is the connected-olio case: a v1 `we_` endpoint whose LIST response
    // carries no `connect` field, listening to the 4 connect events.
    const out = classify(
      [
        {
          id: "we_connected",
          url: `https://app.oliowallet.com${PATH}`,
          status: "enabled",
          enabled_events: CONNECT_EVENTS, // no `connect` field present
        },
      ],
      [],
    );
    expect(out[0].connect).toBe(true);
    expect(out[0].missingEvents).toEqual([]);
  });

  it("classifies a v1 platform endpoint (subscription events, no direct-charge events) as platform", () => {
    const out = classify(
      [
        {
          id: "we_platform",
          url: `https://app.oliowallet.com${PATH}`,
          status: "enabled",
          enabled_events: PLATFORM_EVENTS,
        },
      ],
      [],
    );
    expect(out[0].connect).toBe(false);
    expect(out[0].missingEvents).toEqual([]);
  });

  it("REGRESSION: a platform endpoint that ALSO carries checkout.session.completed stays platform (not connect) via its subscription events", () => {
    // The exact shape that misclassified before: olio-app has direct-charge
    // events too, but its customer.subscription.* events mark it platform.
    const out = classify(
      [
        {
          id: "we_olio_app",
          url: `https://app.oliowallet.com${PATH}`,
          status: "enabled",
          enabled_events: PLATFORM_EVENTS_REALISTIC,
        },
      ],
      [],
    );
    expect(out[0].connect).toBe(false);
  });

  it("detects BOTH a platform and a connect endpoint at the same URL (full green case)", () => {
    const out = classify(
      [
        {
          id: "we_olio_app",
          url: `https://app.oliowallet.com${PATH}`,
          status: "enabled",
          enabled_events: PLATFORM_EVENTS_REALISTIC,
        },
        {
          id: "we_connected_olio",
          url: `https://app.oliowallet.com${PATH}`,
          status: "enabled",
          enabled_events: CONNECT_EVENTS,
        },
      ],
      [],
    );
    const platform = out.find((e) => !e.connect);
    const connect = out.find((e) => e.connect);
    expect(platform).toBeTruthy();
    expect(connect).toBeTruthy();
    expect(platform!.id).toBe("we_olio_app");
    expect(connect!.id).toBe("we_connected_olio");
    expect(platform!.missingEvents).toEqual([]);
    expect(connect!.missingEvents).toEqual([]);
  });

  it("reads a v2 event destination, deriving connect-scope from events_from (@accounts) and url from webhook_endpoint.url", () => {
    const out = classify(
      [],
      [
        {
          id: "ed_1",
          status: "enabled",
          events_from: ["@accounts"],
          enabled_events: CONNECT_EVENTS,
          webhook_endpoint: { url: `https://app.oliowallet.com${PATH}` },
        },
      ],
    );
    expect(out).toHaveLength(1);
    expect(out[0].connect).toBe(true);
    expect(out[0].missingEvents).toEqual([]);
  });

  it("treats a v2 destination scoped to @self as a platform endpoint", () => {
    const out = classify(
      [],
      [
        {
          id: "ed_self",
          status: "enabled",
          events_from: ["@self"],
          enabled_events: PLATFORM_EVENTS,
          webhook_endpoint: { url: `https://app.oliowallet.com${PATH}` },
        },
      ],
    );
    expect(out[0].connect).toBe(false);
  });

  it("ignores endpoints whose URL does not end with the handler path", () => {
    const out = classify(
      [
        {
          id: "we_other",
          url: "https://app.oliowallet.com/api/other",
          status: "enabled",
          enabled_events: CONNECT_EVENTS,
        },
      ],
      [
        {
          id: "ed_other",
          status: "enabled",
          events_from: ["@accounts"],
          enabled_events: CONNECT_EVENTS,
          webhook_endpoint: { url: "https://example.com/nope" },
        },
      ],
    );
    expect(out).toEqual([]);
  });

  it("reports missing events for an incomplete connect endpoint", () => {
    const out = classify(
      [
        {
          id: "we_partial",
          url: `https://app.oliowallet.com${PATH}`,
          status: "enabled",
          // has a connect-only event (so inferred connect) but missing charge.refunded + account.updated
          enabled_events: ["checkout.session.completed", "payment_intent.succeeded"],
        },
      ],
      [],
    );
    expect(out[0].connect).toBe(true);
    expect(out[0].missingEvents).toEqual(["charge.refunded", "account.updated"]);
  });

  it("treats a wildcard '*' subscription as covering all required events", () => {
    const out = classify(
      [
        {
          id: "we_wild",
          url: `https://app.oliowallet.com${PATH}`,
          status: "enabled",
          connect: true,
          enabled_events: ["*"],
        },
      ],
      [],
    );
    expect(out[0].missingEvents).toEqual([]);
  });

  it("de-dupes an endpoint that surfaces in both lists by id", () => {
    const out = classify(
      [
        {
          id: "we_dup",
          url: `https://app.oliowallet.com${PATH}`,
          status: "enabled",
          enabled_events: CONNECT_EVENTS,
        },
      ],
      [
        {
          id: "we_dup",
          status: "enabled",
          events_from: ["@accounts"],
          enabled_events: CONNECT_EVENTS,
          webhook_endpoint: { url: `https://app.oliowallet.com${PATH}` },
        },
      ],
    );
    expect(out).toHaveLength(1);
  });
});
