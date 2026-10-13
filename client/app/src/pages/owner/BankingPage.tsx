// /banking route. Thin wrapper around the shared <BankingSection /> — all
// banking logic lives there (see client/shared/components/owner/BankingSection.tsx).

import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { BankingSection } from "@ui/components/owner/BankingSection";
import { PageHeader } from "@ui/components/common/PageHeader";
import { useBankingScope } from "@/lib/useBankingScope";

export default function BankingPage() {
  // Scope to the active portfolio: own → full UI; a granted portfolio → an
  // IBAN-only manager for an authorized contact.
  const scope = useBankingScope();
  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <PageHeader
        title="Banking"
        subtitle={scope.isSelf ? "Manage your payment methods" : "Manage this portfolio's IBAN"}
      />
      <BankingSection returnPath="/banking" scope={scope} />
    </div>
  );
}
