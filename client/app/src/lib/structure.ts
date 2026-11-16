import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@ui/lib/useAuth";
import type { StructureResponse } from "@shared/structure";
import { useActivePortfolio, withOwnerScope } from "@/lib/activePortfolio";

// Ownership hierarchy for the active portfolio (Owner → Property → Unit → Tenant).
export function useOwnerStructure() {
  const { firebaseUser } = useAuth();
  const { activeOwnerId, activePortfolioDocId, isSelf } = useActivePortfolio();
  const url = withOwnerScope("/api/owner/structure", activeOwnerId, isSelf, activePortfolioDocId);
  return useQuery<StructureResponse>({
    queryKey: [url],
    enabled: !!firebaseUser,
  });
}
