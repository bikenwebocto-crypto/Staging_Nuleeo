// Plan tier for the ACTIVE PORTFOLIO. Use this — not `usePlan()` — for
// feature gates on owner-side pages, because plans are portfolio-scoped:
// a granted contact (legacy / legal / financial) inherits the portfolio
// owner's plan when acting on that portfolio.
//
//   isSelf  → caller's own stripeRole claim (instant, via usePlan)
//   granted → activePortfolio.ownerPlan returned by /api/portfolios/accessible
//
// `usePlan()` still represents the *caller's* own subscription and remains
// the right hook for billing surfaces (Profile → Billing, PricingModal,
// ProfileDrawer).

import { usePlan } from "@ui/lib/usePlan";
import { useActivePortfolio } from "@/lib/activePortfolio";
import type { Plan } from "@shared/firestore-schema";

export function useActivePortfolioPlan(): {
  plan: Plan;
  loading: boolean;
  refreshPlan: () => Promise<void>;
} {
  const self = usePlan();
  const { isSelf, activePortfolio, loading: portfolioLoading } = useActivePortfolio();

  if (isSelf) {
    return self;
  }

  // For granted portfolios the plan rides on the AccessiblePortfolio payload.
  // refreshPlan() still bumps the caller's own claim — switching back to self
  // would pick it up; for the active granted portfolio, the portfolio query
  // refetch (handled elsewhere) is the right path.
  return {
    plan: (activePortfolio?.ownerPlan ?? "basic") as Plan,
    loading: portfolioLoading || self.loading,
    refreshPlan: self.refreshPlan,
  };
}
