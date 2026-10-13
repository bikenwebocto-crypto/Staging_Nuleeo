// Two admin Stripe ops surfaced on /admin/owner-plans:
//
//   GET  /api/admin/stripe/live-health             → one-shot probe of
//        whether LIVE Stripe is wired up for billing + Connect +
//        webhooks, with a per-event missing-list.
//   POST /api/admin/stripe/provision-plan-products → one-click fix
//        for the "missing Stripe product" warning; creates advance/pro
//        products with the right firebaseRole metadata + a yearly
//        price from config/planLabels.

import type { Express, RequestHandler } from "express";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { stripe, stripeMode } from "../stripe";
import { errMsg } from "../services/errMsg";
import { logInfo } from "../services/log";
import { loadPlatformFeesConfig } from "../services/configCache";
import { ensureProIntroCoupon, resolvePlanStripePrice } from "../services/planBilling";
import {
  COL,
  CONFIG_DOC_PLAN_LABELS,
  DEFAULT_PLAN_LABELS,
  withFixedPlanPrices,
  type PlanLabelsConfig,
  type PlatformPrivilegeKey,
} from "../../shared/firestore-schema";

export interface AdminStripeDeps {
  requirePlatformPrivilege: (p: PlatformPrivilegeKey) => RequestHandler;
}

export interface WebhookEndpointHealth {
  id: string;
  url: string;
  status: string;
  events: string[];
  missingEvents: string[];
  connect: boolean;
}

// Infer connect-scope from an endpoint's enabled events, used only when Stripe
// gives no explicit scope signal (the v1 webhook-endpoint LIST response carries
// NO `connect` boolean). The decisive tell: the PLATFORM (your-account)
// endpoint receives the owner-subscription events; a connected-accounts
// endpoint never does (owners' Stripe accounts process tenant rent, not
// subscriptions). NOTE you can't tell them apart by checkout.session.completed
// / payment_intent.succeeded — the platform endpoint also gets those (owner
// subscription checkouts) — so subscription events are the reliable signal.
const SUBSCRIPTION_EVENT_PREFIX = "customer.subscription.";
const DIRECT_CHARGE_EVENTS = ["checkout.session.completed", "payment_intent.succeeded"];
function inferConnectFromEvents(events: string[]): boolean {
  if (events.some((e) => e.startsWith(SUBSCRIPTION_EVENT_PREFIX))) return false; // platform
  return DIRECT_CHARGE_EVENTS.some((e) => events.includes(e)); // connect iff direct-charge
}

// Merge Stripe's TWO webhook systems into one normalized health list:
//   - classic v1 webhook endpoints   (sdk.webhookEndpoints.list)
//   - v2 "event destinations"        (sdk.v2.core.eventDestinations.list —
//                                      what the Dashboard's Workbench creates)
// A Connect endpoint can live in either, and connect-scope is signalled
// differently (and unreliably) across them:
//   - v1: response has NO `connect` field → infer from events (see above).
//   - v2: `events_from` — any entry other than "@self" = connected accounts.
// Only endpoints whose URL ends with `path` (our handler) are kept; each is
// flagged for the required events missing for its scope. Exported for tests.
export function classifyWebhookEndpoints(args: {
  v1: unknown[];
  v2: unknown[];
  path: string;
  connectEvents: string[];
  platformEvents: string[];
}): WebhookEndpointHealth[] {
  const raw: Omit<WebhookEndpointHealth, "missingEvents">[] = [];

  // v1 classic webhook endpoints.
  for (const item of args.v1) {
    const ep = item as Record<string, any>;
    const url: string = ep?.url ?? "";
    if (!url.endsWith(args.path)) continue;
    const events: string[] = Array.isArray(ep?.enabled_events) ? ep.enabled_events : [];
    raw.push({
      id: ep?.id ?? "",
      url,
      status: ep?.status ?? "unknown",
      events,
      // `connect` is absent on the v1 LIST response → infer from events.
      connect: typeof ep?.connect === "boolean" ? ep.connect : inferConnectFromEvents(events),
    });
  }

  // v2 event destinations (Workbench). `webhook_endpoint.url` is an includable
  // field — the probe requests it explicitly so this match works.
  for (const item of args.v2) {
    const ed = item as Record<string, any>;
    const url: string = ed?.webhook_endpoint?.url ?? "";
    if (!url.endsWith(args.path)) continue;
    if (raw.some((r) => r.id === ed?.id)) continue; // de-dupe if surfaced twice
    const events: string[] = Array.isArray(ed?.enabled_events) ? ed.enabled_events : [];
    const eventsFrom: string[] = Array.isArray(ed?.events_from) ? ed.events_from : [];
    raw.push({
      id: ed?.id ?? "",
      url,
      // v2 status uses the same "enabled"/"disabled" vocabulary as v1.
      status: ed?.status ?? "unknown",
      events,
      connect:
        eventsFrom.length > 0
          ? eventsFrom.some((s) => s !== "@self")
          : inferConnectFromEvents(events),
    });
  }

  return raw.map((ep) => {
    const wildcards = ep.events.includes("*");
    // A Connect endpoint must carry the direct-charge events; the platform
    // endpoint the platform-native ones.
    const required = ep.connect ? args.connectEvents : args.platformEvents;
    const missingEvents = wildcards ? [] : required.filter((e) => !ep.events.includes(e));
    return { ...ep, missingEvents };
  });
}

export function registerAdminStripeRoutes(
  app: Express,
  { requirePlatformPrivilege }: AdminStripeDeps,
): void {
  // One-shot probe used by /admin/owner-plans to show whether LIVE
  // Stripe is actually wired up for both billing surfaces:
  //   - owner subscriptions (firestore-stripe-payments extension products)
  //   - Connect split payments (platform account + connected owners)
  // Also lists registered webhook endpoints and flags missing required
  // events so an admin can see at a glance what to fix in the Stripe
  // Dashboard.
  app.get(
    "/api/admin/stripe/live-health",
    requireAuth,
    requirePlatformPrivilege("platform.modifySettings"),
    async (_req, res) => {
      // Direct-charge events fire on owners' connected accounts and reach us
      // only via a Connect endpoint (connect:true); platform-native events use
      // the "Your account" endpoint. So each endpoint type needs a DIFFERENT
      // set of events — we flag missing per endpoint accordingly.
      const PLATFORM_WEBHOOK_EVENTS = [
        "account.updated",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        // Delinquency visibility: a failed owner-plan charge is otherwise
        // invisible in-app (no invoice.* mirror). Handled in stripeWebhook.ts.
        "invoice.payment_failed",
      ];
      const CONNECT_WEBHOOK_EVENTS = [
        "checkout.session.completed",
        "payment_intent.succeeded",
        "charge.refunded",
        "account.updated",
      ];
      const REQUIRED_WEBHOOK_EVENTS = Array.from(
        new Set([...PLATFORM_WEBHOOK_EVENTS, ...CONNECT_WEBHOOK_EVENTS]),
      );
      const WEBHOOK_PATH = "/api/webhooks/stripe";

      const key = process.env.STRIPE_SECRET_KEY ?? "";
      if (!key) {
        return res.json({
          configured: false,
          mode: null,
          account: null,
          connect: { enabled: false, connectedAccountsCount: 0 },
          products: { advance: null, pro: null },
          webhooks: { endpoints: [], requiredEvents: REQUIRED_WEBHOOK_EVENTS },
          fees: (await loadPlatformFeesConfig()).rentCommission,
        });
      }

      // Shared mode derivation (recognizes restricted rk_live_ keys too, which
      // the old inline sk_live_ check misread as "test").
      const mode: "live" | "test" = stripeMode() === "live" ? "live" : "test";

      // Fire everything in parallel so the panel stays snappy. Every
      // probe is wrapped to never throw — partial results are more
      // useful than a 500.
      const sdk = stripe();
      const isErr = (x: unknown): x is { __error: string } =>
        typeof x === "object" && x !== null && "__error" in x;
      const safe = <T extends object>(p: Promise<T>): Promise<T | { __error: string }> =>
        p.catch((err: unknown) => ({
          __error: err instanceof Error ? err.message : String(err),
        }));

      // The Dashboard's "Workbench → Event destinations" creates v2 event
      // destinations, which the classic v1 webhookEndpoints.list() never
      // returns. Probe that list too (guarded — an older SDK/account may lack
      // the v2 surface). `webhook_endpoint.url` is an includable field, so we
      // must request it explicitly or every destination comes back URL-less
      // and won't match our handler path.
      const listEventDestinations = (): Promise<object> => {
        const v2 = (sdk as unknown as { v2?: any }).v2;
        if (!v2?.core?.eventDestinations?.list) return Promise.resolve({ data: [] });
        return v2.core.eventDestinations.list({
          include: ["webhook_endpoint.url"],
          limit: 100,
        });
      };

      const [accountRes, productsRes, accountsListRes, webhooksRes, eventDestRes, feesRes] =
        await Promise.all([
          // Stripe SDK types require an id for accounts.retrieve, but
          // at runtime calling it with no arg returns the platform's
          // own account — which is exactly what we want here. Cast
          // to escape the overload constraint.
          safe((sdk.accounts.retrieve as () => Promise<object>)()),
          safe(sdk.products.list({ active: true, limit: 100 })),
          safe(sdk.accounts.list({ limit: 1 })),
          safe(sdk.webhookEndpoints.list({ limit: 100 })),
          safe(listEventDestinations()),
          loadPlatformFeesConfig(),
        ]);

      const accountInfo =
        accountRes && !isErr(accountRes)
          ? {
              id: (accountRes as any).id as string,
              chargesEnabled: !!(accountRes as any).charges_enabled,
              payoutsEnabled: !!(accountRes as any).payouts_enabled,
              detailsSubmitted: !!(accountRes as any).details_submitted,
              country: ((accountRes as any).country as string) ?? null,
              defaultCurrency:
                (((accountRes as any).default_currency as string) ?? "").toUpperCase() || null,
              businessName: ((accountRes as any).business_profile?.name as string) ?? null,
            }
          : null;

      // Connect is operational iff accounts.list succeeded — that
      // endpoint is platform-only. A `permission`/`not_a_platform`
      // error tells us Connect is not enabled on this Stripe account.
      const connectEnabled = accountsListRes && !isErr(accountsListRes);
      const connectedAccountsCount = await (async () => {
        if (!connectEnabled) return 0;
        try {
          // The /v1/accounts list returns has_more — a single page of
          // 100 is plenty for the badge. We don't need an exact count.
          const r = await sdk.accounts.list({ limit: 100 });
          return r.data.length + (r.has_more ? 100 : 0);
        } catch {
          return 0;
        }
      })();

      type ProductInfo = {
        productId: string;
        productName: string;
        active: boolean;
        priceId: string | null;
        amount: number | null;
        currency: string | null;
        interval: string | null;
      };
      const productByRole: Record<"advance" | "pro", ProductInfo | null> = {
        advance: null,
        pro: null,
      };
      if (productsRes && !isErr(productsRes)) {
        for (const p of (productsRes as any).data as any[]) {
          const role = p?.metadata?.firebaseRole;
          if (role !== "advance" && role !== "pro") continue;
          let priceId: string | null = null;
          let amount: number | null = null;
          let currency: string | null = null;
          let interval: string | null = null;
          try {
            const prices = await sdk.prices.list({
              product: p.id,
              active: true,
              limit: 10,
            });
            const recurring = prices.data.find((x: any) => x.type === "recurring");
            const chosen = recurring ?? prices.data[0];
            if (chosen) {
              priceId = chosen.id;
              amount = typeof chosen.unit_amount === "number" ? chosen.unit_amount / 100 : null;
              currency = (chosen.currency ?? "").toUpperCase() || null;
              interval = chosen.recurring?.interval ?? null;
            }
          } catch {
            // leave price fields null
          }
          productByRole[role as "advance" | "pro"] = {
            productId: p.id,
            productName: p.name ?? role,
            active: !!p.active,
            priceId,
            amount,
            currency,
            interval,
          };
        }
      }

      // Webhook endpoints — merge classic v1 endpoints + v2 event
      // destinations, keep only the ones pointing at our handler path, and
      // flag missing required events. See classifyWebhookEndpoints for the
      // (unreliable) connect-scope detection across the two systems.
      const endpoints = classifyWebhookEndpoints({
        v1: webhooksRes && !isErr(webhooksRes) ? ((webhooksRes as any).data ?? []) : [],
        v2: eventDestRes && !isErr(eventDestRes) ? ((eventDestRes as any).data ?? []) : [],
        path: WEBHOOK_PATH,
        connectEvents: CONNECT_WEBHOOK_EVENTS,
        platformEvents: PLATFORM_WEBHOOK_EVENTS,
      });
      // Observability: which webhook endpoints we saw and how we classified
      // them (no secrets). Lets us debug the live-health "missing endpoint"
      // chip from logs without guessing.
      logInfo("stripe.live-health.webhooks", {
        v1Count: webhooksRes && !isErr(webhooksRes) ? ((webhooksRes as any).data?.length ?? 0) : 0,
        v2Count:
          eventDestRes && !isErr(eventDestRes) ? ((eventDestRes as any).data?.length ?? 0) : 0,
        v2Error: isErr(eventDestRes) ? eventDestRes.__error : undefined,
        endpoints: endpoints.map((e) => ({
          id: e.id,
          connect: e.connect,
          status: e.status,
          events: e.events,
          missing: e.missingEvents,
        })),
      });

      res.json({
        configured: true,
        mode,
        account: accountInfo,
        connect: {
          enabled: !!connectEnabled,
          connectedAccountsCount,
          error: isErr(accountsListRes) ? accountsListRes.__error : undefined,
        },
        products: productByRole,
        webhooks: { endpoints, requiredEvents: REQUIRED_WEBHOOK_EVENTS },
        fees: feesRes.rentCommission,
      });
    },
  );

  // One-click fix for the "Missing Stripe product (firebaseRole=…)"
  // warning on /admin/owner-plans. Looks at advance + pro tiers, finds
  // the ones not already present in the connected Stripe account, and
  // creates them with the correct firebaseRole metadata (which the
  // Firebase Stripe Payments extension uses to set the user's
  // `stripeRole` custom claim on subscription). Yearly price is the
  // fixed code value (DEFAULT_PLAN_LABELS) — skips any role whose
  // yearlyAmount is 0 / null so we never create a free recurring price.
  app.post(
    "/api/admin/stripe/provision-plan-products",
    requireAuth,
    requirePlatformPrivilege("platform.modifySettings"),
    async (_req, res) => {
      if (!process.env.STRIPE_SECRET_KEY) {
        return res.status(400).json({ error: "STRIPE_SECRET_KEY is not set" });
      }
      const sdk = stripe();

      const labelsSnap = await db().collection(COL.config).doc(CONFIG_DOC_PLAN_LABELS).get();
      const stored = labelsSnap.exists ? (labelsSnap.data() as Partial<PlanLabelsConfig>) : {};
      // Prices are fixed in code — overlay so we provision Stripe products at
      // the canonical yearly price, never a stale stored value.
      const plans = withFixedPlanPrices({
        plans: { ...DEFAULT_PLAN_LABELS.plans, ...(stored.plans ?? {}) },
        proUpgradeFirstCycleAmount: DEFAULT_PLAN_LABELS.proUpgradeFirstCycleAmount,
      }).plans;

      const TARGET_ROLES = ["advance", "pro"] as const;
      type Role = (typeof TARGET_ROLES)[number];

      const existing: Record<Role, string | null> = {
        advance: null,
        pro: null,
      };
      try {
        const list = await sdk.products.list({ active: true, limit: 100 });
        for (const p of list.data as any[]) {
          const r = p?.metadata?.firebaseRole;
          if (r === "advance" || r === "pro") existing[r as Role] = p.id;
        }
      } catch (err: unknown) {
        return res.status(502).json({ error: errMsg(err, "Failed to list Stripe products") });
      }

      const created: { role: Role; productId: string; priceId: string }[] = [];
      const skipped: { role: Role; reason: string }[] = [];

      for (const role of TARGET_ROLES) {
        if (existing[role]) {
          skipped.push({ role, reason: "already exists" });
          continue;
        }
        const label = plans[role];
        const yearly = label?.yearlyAmount ?? 0;
        if (!yearly || yearly <= 0) {
          skipped.push({
            role,
            reason: "yearlyAmount is 0 — edit the panel first",
          });
          continue;
        }
        try {
          const product = await sdk.products.create({
            name: label.label || (role === "advance" ? "Growth" : "Pro"),
            description: label.description || undefined,
            metadata: { firebaseRole: role },
          });
          const price = await sdk.prices.create({
            product: product.id,
            currency: "eur",
            unit_amount: Math.round(yearly * 100),
            recurring: { interval: "year" },
          });
          // Make this the default price so the extension picks it up
          // cleanly.
          await sdk.products.update(product.id, { default_price: price.id });
          created.push({ role, productId: product.id, priceId: price.id });
        } catch (err: unknown) {
          return res.status(502).json({
            error: errMsg(err, `Failed to create Stripe product for ${role}`),
            created,
            skipped,
          });
        }
      }

      // Also ensure the one-time "first Pro cycle = €200" upgrade coupon, so the
      // paid Growth→Pro endpoint can apply it. Idempotent; skipped when Pro
      // isn't provisioned (no price to discount).
      let coupon: { id: string } | { skipped: string } = {
        skipped: "Pro price not provisioned",
      };
      try {
        const proPrice = await resolvePlanStripePrice("pro");
        if (proPrice) {
          const id = await ensureProIntroCoupon(proPrice.unitAmountCents, proPrice.currency);
          coupon = id ? { id } : { skipped: "target ≥ Pro price (no discount)" };
        }
      } catch (err: unknown) {
        coupon = { skipped: errMsg(err, "coupon provisioning failed") };
      }

      res.json({ created, skipped, coupon });
    },
  );
}
