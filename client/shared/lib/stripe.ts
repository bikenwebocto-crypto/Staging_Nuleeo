// Thin wrappers around the Firebase Stripe Payments extension's Firestore
// conventions, so UI code doesn't have to know the document shapes.
//
// - `useProducts()` watches the `products` collection and exposes plan → priceId.
// - `startCheckout(priceId)` writes a `customers/{uid}/checkout_sessions` doc,
//   waits for the extension to attach a Stripe Checkout URL, then redirects.
// - `openCustomerPortal()` invokes the extension's `createPortalLink` callable
//   and redirects to the Stripe-hosted billing portal.

import { useEffect, useState } from "react";
import { addDoc, collection, getDocs, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { auth, db, stripeFunctions } from "./firebase";
import { DEFAULT_PLAN_LABELS, type Plan } from "@shared/firestore-schema";

// Extension defaults — these match the values configured in the
// Firebase Console (`Customers collection`, `Products collection`).
const CUSTOMERS_COLLECTION = "customers";
const PRODUCTS_COLLECTION = "products";

// Name of the callable function exposed by the extension instance.
// Format: `ext-{instanceId}-createPortalLink`.
const PORTAL_FN_NAME = "ext-firestore-stripe-payments-createPortalLink";

interface ProductDoc {
  active?: boolean;
  name?: string;
  metadata?: { firebaseRole?: string };
}

interface PriceDoc {
  active?: boolean;
  unit_amount?: number;
  currency?: string;
  interval?: "day" | "week" | "month" | "year" | null;
  type?: "one_time" | "recurring";
}

export interface PricedPlan {
  plan: Plan; // "advance" | "pro" — never "basic" (basic isn't a Stripe product)
  productId: string;
  productName: string;
  priceId: string;
  amount: number; // major units (e.g. 49.99)
  currency: string; // ISO 4217, e.g. "EUR"
  interval: PriceDoc["interval"];
}

function isPaidPlan(role: string | undefined): role is Exclude<Plan, "basic"> {
  return role === "advance" || role === "pro";
}

// Collapse the products to at most one per plan tier, preferring the product
// whose recurring price matches the canonical fixed amount for that plan
// (Growth €69 / Pro €290, from DEFAULT_PLAN_LABELS — the same figures
// withFixedPlanPrices() enforces everywhere). This is a guard against a stale or
// duplicate product doc — e.g. leftover SANDBOX products the Stripe extension
// synced pre-cutover and never cleared, which sort first by doc id and would
// otherwise hand a sandbox price to the live account ("No such price"). When the
// amounts tie or none matches canonical, the first-seen product wins (unchanged
// behavior for the normal single-product-per-tier case). Exported for tests.
export function dedupePreferCanonical(plans: PricedPlan[]): PricedPlan[] {
  const canonical: Partial<Record<Plan, number | null>> = {
    advance: DEFAULT_PLAN_LABELS.plans.advance.yearlyAmount,
    pro: DEFAULT_PLAN_LABELS.plans.pro.yearlyAmount,
  };
  const cents = (n: number) => Math.round(n * 100);
  const byRole = new Map<Plan, PricedPlan>();
  for (const p of plans) {
    const existing = byRole.get(p.plan);
    if (!existing) {
      byRole.set(p.plan, p);
      continue;
    }
    const target = canonical[p.plan];
    const pMatches = target != null && cents(p.amount) === cents(target);
    const eMatches = target != null && cents(existing.amount) === cents(target);
    // Only override the incumbent when THIS product matches canonical and the
    // incumbent doesn't — otherwise keep first-seen.
    if (pMatches && !eMatches) byRole.set(p.plan, p);
  }
  return Array.from(byRole.values());
}

// Returns the active Stripe products mapped to their Olio plan tier.
// Only products with `metadata.firebaseRole` set to a known plan are returned.
// Picks the *first* active recurring price on each product — extend this if
// you start offering monthly + yearly side-by-side.
export function useProducts(): { plans: PricedPlan[]; loading: boolean; error: string | null } {
  const [plans, setPlans] = useState<PricedPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const productsQuery = query(collection(db, PRODUCTS_COLLECTION), where("active", "==", true));

    const unsub = onSnapshot(
      productsQuery,
      async (snapshot) => {
        try {
          const next: PricedPlan[] = [];
          for (const productDoc of snapshot.docs) {
            const product = productDoc.data() as ProductDoc;
            const role = product.metadata?.firebaseRole;
            if (!isPaidPlan(role)) continue;

            const priceSnap = await getDocs(
              query(collection(productDoc.ref, "prices"), where("active", "==", true)),
            );
            const recurring = priceSnap.docs.find(
              (d) => (d.data() as PriceDoc).type === "recurring",
            );
            if (!recurring) continue;
            const price = recurring.data() as PriceDoc;
            if (typeof price.unit_amount !== "number" || !price.currency) continue;

            next.push({
              plan: role,
              productId: productDoc.id,
              productName: product.name ?? role,
              priceId: recurring.id,
              amount: price.unit_amount / 100,
              currency: price.currency.toUpperCase(),
              interval: price.interval ?? null,
            });
          }
          if (!cancelled) {
            setPlans(dedupePreferCanonical(next));
            setLoading(false);
          }
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : "Failed to load plans");
            setLoading(false);
          }
        }
      },
      (err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      },
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return { plans, loading, error };
}

// Kicks off a Stripe Checkout flow. Resolves with the redirect URL once the
// extension has provisioned the session — caller should `window.location.assign(url)`.
// Rejects if the extension reports an error or no URL is produced within ~30s.
export async function createCheckoutSession(priceId: string): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  const origin = window.location.origin;
  const docRef = await addDoc(collection(db, CUSTOMERS_COLLECTION, user.uid, "checkout_sessions"), {
    price: priceId,
    success_url: `${origin}${window.location.pathname}?checkout=success`,
    cancel_url: `${origin}${window.location.pathname}?checkout=cancelled`,
    allow_promotion_codes: true,
  });

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsub();
      reject(new Error("Stripe Checkout timed out — try again"));
    }, 30_000);

    const unsub = onSnapshot(docRef, (snap) => {
      const data = snap.data() as { url?: string; error?: { message: string } } | undefined;
      if (!data) return;
      if (data.error) {
        clearTimeout(timeout);
        unsub();
        reject(new Error(data.error.message));
        return;
      }
      if (data.url) {
        clearTimeout(timeout);
        unsub();
        resolve(data.url);
      }
    });
  });
}

// Opens the Stripe customer portal for managing payment methods, cancelling, etc.
// Caller should `window.location.assign(url)` with the returned URL.
export async function createPortalLink(): Promise<string> {
  const callable = httpsCallable<{ returnUrl: string; locale: string }, { url: string }>(
    stripeFunctions,
    PORTAL_FN_NAME,
  );
  const result = await callable({
    returnUrl: window.location.href,
    locale: "auto",
  });
  return result.data.url;
}
