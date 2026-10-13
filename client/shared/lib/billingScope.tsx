import { createContext, useContext, type ReactNode } from "react";

// Billing scope — communicates who currently has authority to change the
// active portfolio's subscription. Plans are portfolio-scoped: only the
// portfolio owner can upgrade/downgrade the plan on the portfolio they own.
// A granted contact (legacy/legal/financial) viewing someone else's
// portfolio sees the PricingModal in a read-only state with a hint that
// only the portfolio owner can change the plan.
//
// Default value treats the viewer as the owner (safe for platform admin
// pages where there's no portfolio scope). The user app's
// `ActivePortfolioProvider` wraps a `BillingScopeProvider` that reflects
// the active portfolio's owner.

interface BillingScope {
  canManageBilling: boolean;
  // Display name of the portfolio owner — shown in the "Only X can change
  // this plan" hint. Null when the viewer is the owner.
  ownerName: string | null;
}

const BillingScopeContext = createContext<BillingScope>({
  canManageBilling: true,
  ownerName: null,
});

export function BillingScopeProvider({
  canManageBilling,
  ownerName,
  children,
}: BillingScope & { children: ReactNode }) {
  return (
    <BillingScopeContext.Provider value={{ canManageBilling, ownerName }}>
      {children}
    </BillingScopeContext.Provider>
  );
}

export function useBillingScope(): BillingScope {
  return useContext(BillingScopeContext);
}
