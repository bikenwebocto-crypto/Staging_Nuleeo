// Single source of truth for mirroring a Stripe Connect Account into the
// owner's PORTFOLIO doc. Called from:
//   - POST /api/owner/stripe-connect/refresh   (manual user click)
//   - the account.updated webhook handler      (Stripe push)
// so both paths land on identical fields and can't drift. Banking lives on the
// portfolio (not the user), so callers resolve the portfolio first and pass
// its id — see server/services/portfolioBanking.ts.
//
// We use a structural type (`AccountSnapshot`) rather than `Stripe.Account`
// directly: the SDK's namespace types aren't reachable under the functions
// build's `moduleResolution: "node"`, and structural typing satisfies the
// SDK's wider type at every call site.

import { type PortfolioBanking } from "../../shared/firestore-schema";
import { writePortfolioBanking } from "./portfolioBanking";

type CapStatus = "active" | "pending" | "inactive" | "restricted";

// Subset of the Stripe.Account fields we read. Matches Stripe's shape; the
// SDK's full type is structurally compatible.
export interface AccountSnapshot {
  id: string;
  details_submitted?: boolean | null;
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
  requirements?: {
    currently_due?: string[] | null;
    past_due?: string[] | null;
    pending_verification?: string[] | null;
    disabled_reason?: string | null;
  } | null;
  capabilities?: {
    card_payments?: string | null;
    transfers?: string | null;
  } | null;
}

const KNOWN_CAP_STATUSES: readonly string[] = ["active", "pending", "inactive", "restricted"];

function normalizeCapStatus(v: unknown): CapStatus | undefined {
  return typeof v === "string" && KNOWN_CAP_STATUSES.includes(v) ? (v as CapStatus) : undefined;
}

export async function mirrorConnectAccount(
  portfolioId: string,
  account: AccountSnapshot,
): Promise<Partial<PortfolioBanking>> {
  const cardPayments = normalizeCapStatus(account.capabilities?.card_payments);
  const transfers = normalizeCapStatus(account.capabilities?.transfers);

  // Authoritative-replace from the latest Stripe snapshot — including the
  // cleared-to-null case. We previously only wrote disabled_reason /
  // card_payments / transfers when Stripe reported a truthy value, which
  // meant a "restricted" account that later cleared its disabled_reason
  // kept the stale value on the user doc. useConnectStatus checks
  // `reason` first → owner jammed on "Contact support" forever even after
  // Stripe was happy. Both /refresh and the account.updated webhook hand
  // us a full account snapshot, so partial payloads can't corrupt state.
  const patch: Partial<PortfolioBanking> = {
    connectAccountId: account.id,
    connectDetailsSubmitted: Boolean(account.details_submitted),
    connectChargesEnabled: Boolean(account.charges_enabled),
    connectPayoutsEnabled: Boolean(account.payouts_enabled),
    connectRequirementsDue: account.requirements?.currently_due ?? [],
    connectRequirementsPastDue: account.requirements?.past_due ?? [],
    connectRequirementsPendingVerification: account.requirements?.pending_verification ?? [],
    connectLastSyncedAt: new Date().toISOString(),
    connectDisabledReason: account.requirements?.disabled_reason ?? null,
    connectCardPaymentsStatus: cardPayments ?? null,
    connectTransfersStatus: transfers ?? null,
  };

  await writePortfolioBanking(portfolioId, patch);
  return patch;
}
