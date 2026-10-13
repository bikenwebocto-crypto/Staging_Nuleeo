// Platform-commission calculation. Single source of truth used by:
//  - /api/tenant/payment/checkout (to pass `application_fee_amount` to Stripe)
//  - /api/owner/platform-fee-tier (so the owner-side disclosure UI shows the
//    same numbers the checkout will use)
//
// The owner's subscription plan is resolved from the Firebase Auth custom
// claim `stripeRole` (set by the Stripe Payments extension) — same pattern
// as the rest of the codebase (see server/routes.ts).

import { auth } from "../firebase";
import { type OwnerPlanKey, type RentCommissionTier } from "../../shared/firestore-schema";
import { loadPlatformFeesConfig } from "./configCache";

export { loadPlatformFeesConfig };

const KNOWN_PLANS: readonly OwnerPlanKey[] = ["basic", "advance", "pro", "business"];

export interface FeeBreakdown {
  feeCents: number;
  plan: OwnerPlanKey;
  tier: RentCommissionTier;
}

// Resolve a Firebase Auth UID to a known OwnerPlanKey. Defaults to "basic"
// when the claim is missing, unknown, or auth lookup fails — same fallback
// the client's usePlan() uses.
export async function resolveOwnerPlan(ownerUid: string): Promise<OwnerPlanKey> {
  try {
    const authUser = await auth().getUser(ownerUid);
    const claim = (authUser.customClaims as { stripeRole?: unknown } | undefined)?.stripeRole;
    if (typeof claim === "string" && (KNOWN_PLANS as readonly string[]).includes(claim)) {
      return claim as OwnerPlanKey;
    }
  } catch {
    // fall through to default
  }
  return "basic";
}

export async function computeRentCommission(
  ownerUid: string,
  grossCents: number,
): Promise<FeeBreakdown> {
  const [plan, config] = await Promise.all([resolveOwnerPlan(ownerUid), loadPlatformFeesConfig()]);
  const tier = config.rentCommission[plan] ?? { percent: 0, minAmountCents: 0 };
  const percentFee = Math.round((grossCents * (tier.percent ?? 0)) / 100);
  const min = tier.minAmountCents ?? 0;
  // Clamp the fee to STRICTLY below the payment. On a direct charge Stripe
  // requires application_fee_amount < the charge amount, so a 100% percent or
  // a flat minimum that meets/exceeds a low rent would otherwise make
  // checkout.sessions.create throw and block card rent for that unit. Capping
  // one cent under gross keeps an admin misconfig from breaking payments.
  const cap = Math.max(0, grossCents - 1);
  const feeCents = Math.max(0, Math.min(cap, Math.max(min, percentFee)));
  return { feeCents, plan, tier };
}
