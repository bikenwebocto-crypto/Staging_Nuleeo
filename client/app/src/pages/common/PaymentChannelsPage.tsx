// /payment-channels route. Thin wrapper around the shared <BankingSection />
// (see client/shared/components/owner/BankingSection.tsx for the real logic).
// Kept separate from /banking only because the mobile header + breadcrumb
// flow differ — content is identical.

import { useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { useHideMobileHeader } from "@/components/common/AppLayout";
import { BankingSection } from "@ui/components/owner/BankingSection";
import { useBankingScope } from "@/lib/useBankingScope";

export default function PaymentChannelsPage() {
  useHideMobileHeader();
  const bankingScope = useBankingScope();
  const [, setLocation] = useLocation();

  return (
    <>
      {/* Mobile Header */}
      <div className="md:hidden bg-card pt-6 px-5 flex items-center justify-between mb-8 sticky top-0 z-10 shadow-sm pb-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Back"
            onClick={() => {
              if (window.history.length > 1) window.history.back();
              else setLocation("/owner");
            }}
            className="w-10 h-10 bg-secondary rounded-full flex items-center justify-center hover:bg-secondary transition"
          >
            <ArrowLeft size={20} className="text-foreground" />
          </button>
          <h1 className="text-xl font-bold text-foreground">Banking Settings</h1>
        </div>
      </div>

      {/* pb clears the floating mobile nav (see PAGE_CONTAINER_CLASSNAME note);
          this page owns its chrome so it can't reuse that constant directly. */}
      <div className="max-w-md mx-auto md:max-w-none md:mx-0 px-5 md:px-8 pb-[var(--mobile-nav-clearance)] md:pb-10">
        <BankingSection returnPath="/payment-channels" scope={bankingScope} />
      </div>
    </>
  );
}
