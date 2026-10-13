import Stripe from "stripe";

// Lazy singleton: the env var is read on first use so the server can boot even
// when Stripe isn't configured (e.g. in dev environments running offline only).
//
// API version + appInfo are pinned per Stripe's best-practice guidance — that
// way a future SDK upgrade can't silently change behavior, and our app
// identifies itself in Stripe Dashboard / support tickets.
//
// We use `InstanceType<typeof Stripe>` rather than `Stripe` as the type so
// the file compiles under both `moduleResolution: "bundler"` (root tsc) and
// `moduleResolution: "node"` (functions tsc) — under the latter the default
// import resolves to a namespace whose type form is the constructor, not the
// instance.
let _stripe: InstanceType<typeof Stripe> | null = null;

// Pinned to the API version this integration was built and tested against.
// The SDK's bundled default moved to "2026-05-27.dahlia" in stripe@22.2.x and it
// types `apiVersion` as that single literal, but we do NOT auto-adopt API-version
// changes on the money path — bump this deliberately (and retest webhooks/checkout)
// when upgrading. The assertion keeps the explicit pin while satisfying the SDK's
// stricter literal type; Stripe fully supports requesting a prior version at runtime.
const STRIPE_API_VERSION = "2026-04-22.dahlia" as unknown as NonNullable<
  ConstructorParameters<typeof Stripe>[1]
>["apiVersion"];

const APP_INFO = {
  name: "Olio Wallet",
  version: "1.0.0",
  url: "https://oliowallet.com",
} as const;

export function stripe(): InstanceType<typeof Stripe> {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set — cannot create a Stripe client. Configure the env var to enable card payments.",
    );
  }
  _stripe = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    appInfo: APP_INFO,
    // Retry transient failures (network errors, 429 rate-limits, 5xx) with
    // exponential backoff instead of failing the request on the first blip —
    // important for checkout/Connect/subscription calls on a flaky network or
    // during a Stripe rate-limit. Safe against double-charges: we pass an
    // idempotencyKey on every write and the SDK reuses it across retries. 2 is
    // Stripe's recommended value; bounded backoff keeps us well under the
    // function timeout.
    maxNetworkRetries: 2,
  });
  return _stripe;
}

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

// Which Stripe mode the loaded secret key selects. Mode is NOT a code flag —
// it's implied entirely by whether STRIPE_SECRET_KEY (and its paired webhook
// secrets + connected-account ids) are live or test. Recognizes both secret
// (sk_) and restricted (rk_) keys. Returns null when Stripe isn't configured.
//
// IMPORTANT: connected-account ids and webhook secrets are mode-specific and are
// NOT namespaced by mode in our data — a live acct_ won't work under a test key
// and vice-versa. So switching this key's mode after go-live would strand owners
// on the other mode's Connect account. We log it at startup (server/app.ts) as a
// deliberate, observable signal rather than leaving mode purely by convention.
export function stripeMode(): "live" | "test" | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  return null;
}
