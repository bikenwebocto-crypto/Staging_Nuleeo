// Resolves the active portfolio's banking scope for <BankingSection scope=…>.
//
// BankingSection lives in client/shared and can't import the app-only
// useActivePortfolio context, so the app computes the scope here and passes it
// down as plain data. Owner (self) → the full UI (IBAN + Stripe Connect); a
// granted contact → an IBAN-only manager, editable iff they hold the realtime
// "finance.manageBanking" privilege on that portfolio.

import { useActivePortfolio } from "@/lib/activePortfolio";
import type { AccessiblePortfolio } from "@/lib/ownerQueries";
import { useCanPortfolio } from "@ui/lib/usePrivileges";
import type { BankingScope } from "@ui/components/owner/BankingSection";
import type { PortfolioRoleKey } from "@shared/firestore-schema";

// AccessiblePortfolio.role uses display labels that differ from the
// privilege-matrix role keys: "legacy" → "legacyOwner" (and "self" is handled
// by useCanPortfolio via ownerId === own uid → "owner").
const ROLE_TO_PRIVILEGE_ROLE: Record<AccessiblePortfolio["role"], PortfolioRoleKey> = {
  self: "owner",
  legacy: "legacyOwner",
  legal: "legal",
  financial: "financial",
};

export function useBankingScope(): BankingScope {
  const { activeOwnerId, activePortfolioDocId, isSelf, activePortfolio } = useActivePortfolio();
  const can = useCanPortfolio(
    activeOwnerId,
    activePortfolio ? ROLE_TO_PRIVILEGE_ROLE[activePortfolio.role] : undefined,
  );
  return {
    ownerId: activeOwnerId,
    // Stable Portfolio doc id — BankingSection prefers `?portfolioId=` in its
    // read/write URLs and falls back to `?ownerId=` while this is null.
    portfolioDocId: activePortfolioDocId,
    isSelf,
    // The owner is always allowed (the server enforces this too via isSelf);
    // a delegated contact is gated by the matrix privilege.
    canManageBanking: isSelf || can("finance.manageBanking"),
  };
}
