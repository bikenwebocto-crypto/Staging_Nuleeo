// Sanitizes an error from a Stripe SDK call into a client-safe string.
//
// Stripe errors carry a human-readable `message` field that is intentionally
// safe to display (e.g. "The capability 'card_payments' is not available for
// accounts in CY"). For non-Stripe failures we still defer to the caller's
// fallback so internal details (Firestore paths, stack traces) don't leak.
//
// Always logs the raw value server-side (structured logger) so logs retain
// full detail.

import Stripe from "stripe";
import { errMsg } from "./errMsg";
import { logError } from "./log";

export function stripeErrMsg(err: unknown, fallback: string, ctx?: string): string {
  if (err instanceof Stripe.errors.StripeError) {
    logError(ctx ? `stripeErr.${ctx}` : "stripeErr", err, ctx ? { ctx } : undefined);
    // `message` is Stripe's intended user-facing explanation. Prefix with the
    // error code where available so support can pattern-match quickly.
    const code = err.code ?? err.type;
    return code ? `Stripe: ${err.message} (${code})` : `Stripe: ${err.message}`;
  }
  return errMsg(err, fallback, ctx);
}

// Detects the specific class of Stripe error raised when *our platform*
// (not the connected account) hasn't finished its Connect setup — most
// commonly the "review the responsibilities of managing losses for
// connected accounts" platform-profile step that blocks `accounts.create`.
//
// This is invisible to end users and only the Olio team can clear it in the
// Stripe Dashboard, so callers translate it into a friendly "card payments
// aren't available yet" message instead of leaking Stripe's raw text (which
// links to our own internal dashboard settings). Matched on the message
// because Stripe returns a generic `invalid_request_error` type here with no
// distinguishing `code`.
export function isStripePlatformSetupError(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeError)) return false;
  const msg = (err.message ?? "").toLowerCase();
  return (
    msg.includes("platform-profile") ||
    msg.includes("platform profile") ||
    msg.includes("managing losses")
  );
}
