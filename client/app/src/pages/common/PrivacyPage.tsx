import { useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { useComplianceDocs } from "@ui/lib/complianceStore";
import { sanitizeComplianceHtml } from "@ui/lib/sanitizeHtml";
import { cn } from "@ui/lib/utils";
import { useHideMobileHeader } from "@/components/common/AppLayout";
import { DeleteAccountSection } from "@ui/components/common/DeleteAccountSection";

type Tab = "terms" | "privacy" | "gdpr" | "owner-terms" | "delete";

// Read-only view for end users. Admins edit these docs from
// /admin/settings → Compliance via ComplianceEditor; we don't ship a
// second edit surface here. The 'delete' tab is the GDPR right-to-erasure
// surface — sits alongside the privacy docs because that's what users
// look for when exercising it.
export default function PrivacyPage() {
  useHideMobileHeader();
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<Tab>("privacy");
  const { docs } = useComplianceDocs();
  const content = activeTab === "delete" ? "" : docs[activeTab];

  const tabs: { key: Tab; label: string }[] = [
    { key: "privacy", label: "Privacy Policy" },
    { key: "terms", label: "Terms of Use" },
    { key: "gdpr", label: "GDPR" },
    { key: "owner-terms", label: "Owner Terms" },
    { key: "delete", label: "Delete Account" },
  ];

  return (
    <>
      {/* Mobile Header */}
      <div className="md:hidden bg-card pt-6 px-5 flex items-center justify-between mb-4 sticky top-0 z-10 shadow-sm pb-4">
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
          <h1 className="text-xl font-bold text-foreground">Privacy & Terms</h1>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-5 md:px-8 mt-4 md:mt-6">
        <div className="flex gap-1 bg-secondary/50 p-1 rounded-xl w-fit overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 whitespace-nowrap",
                activeTab === tab.key
                  ? tab.key === "delete"
                    ? "bg-destructive text-destructive-foreground shadow-sm"
                    : "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-5 md:px-8 py-6">
        {activeTab === "delete" ? (
          <DeleteAccountSection />
        ) : (
          <div className="bg-card p-6 md:p-8 rounded-2xl shadow-sm border border-border">
            <div
              className="compliance-preview text-sm text-muted-foreground leading-relaxed"
              dangerouslySetInnerHTML={{ __html: sanitizeComplianceHtml(content) }}
            />
          </div>
        )}
      </div>
    </>
  );
}
