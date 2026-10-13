import { useState, useEffect, useMemo } from "react";
import { Download, Lock, Loader2, LineChart, Sparkles } from "lucide-react";
import { useToast } from "@ui/hooks/use-toast";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import {
  useOwnerSummary,
  useOwnerProperties,
  useOwnerInsightsTransactions,
  useOwnerTenants,
  useOwnerAgreements,
} from "@/lib/ownerQueries";
import { computeInsights } from "@/lib/portfolioInsights";
import { PricingModal } from "@ui/components/common/PricingModal";
import { useActivePortfolioPlan } from "@/lib/useActivePortfolioPlan";
import { useCanOwnerPlan, useCanPortfolio } from "@ui/lib/usePrivileges";
import { useAuth } from "@ui/lib/useAuth";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { PageHeader } from "@ui/components/common/PageHeader";
import { SectionNav } from "./insights/ui";
import { OverviewSection } from "./insights/OverviewSection";
import { ProjectionsSection } from "./insights/ProjectionsSection";
import { PropertiesSection } from "./insights/PropertiesSection";
import { TenantsSection } from "./insights/TenantsSection";
import { CashflowSection } from "./insights/CashflowSection";

const WINDOW_OPTIONS = [30, 60, 90, 120, 365] as const;
const NAV_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "projections", label: "Projections" },
  { id: "properties", label: "Properties" },
  { id: "tenants", label: "Tenants" },
  { id: "cashflow", label: "Cash flow" },
];

export default function PortfolioAnalyticsPage() {
  const { plan: userPlan } = useActivePortfolioPlan();
  const canPlan = useCanOwnerPlan(userPlan);
  const { data: summary, isError: summaryError, refetch: refetchSummary } = useOwnerSummary();
  const {
    data: properties = [],
    isError: propertiesError,
    refetch: refetchProperties,
  } = useOwnerProperties();
  const {
    data: transactions = [],
    isError: transactionsError,
    refetch: refetchTransactions,
  } = useOwnerInsightsTransactions();
  const { data: tenants = [], refetch: refetchTenants } = useOwnerTenants();
  const { data: agreements = [], refetch: refetchAgreements } = useOwnerAgreements();

  const [windowDays, setWindowDays] = useState<number>(90);
  const windowLabel = windowDays === 365 ? "1Y" : `${windowDays}D`;
  // Capture "now" once so the memo isn't busted every render.
  const [nowMs] = useState(() => Date.now());

  const analyticsError = summaryError || propertiesError || transactionsError;
  const retryAll = () => {
    refetchSummary();
    refetchProperties();
    refetchTransactions();
    refetchTenants();
    refetchAgreements();
  };

  // Plan gating is TWO-tier: analytics.advanced unlocks the deep analytics;
  // analytics.history additionally unlocks the forward-looking Projections.
  const advancedLocked = !canPlan("analytics.advanced");
  const proLocked = !canPlan("analytics.history");

  const { profile } = useAuth();
  const canPortfolio = useCanPortfolio(profile?.id, undefined);
  const canExport = canPortfolio("analytics.export");
  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const { toast } = useToast();

  const insights = useMemo(
    () =>
      computeInsights({
        summary,
        properties,
        transactions,
        tenants,
        agreements,
        windowDays,
        nowMs,
      }),
    [summary, properties, transactions, tenants, agreements, windowDays, nowMs],
  );

  // Scroll-spy: highlight the nav chip for the section currently in view.
  const [activeSection, setActiveSection] = useState("overview");
  useEffect(() => {
    if (advancedLocked) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (vis[0]) setActiveSection(vis[0].target.id);
      },
      { rootMargin: "-15% 0px -75% 0px", threshold: [0, 0.25, 0.6, 1] },
    );
    NAV_SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, [advancedLocked, proLocked]);

  const handleExport = async () => {
    if (!canExport) {
      setIsPricingOpen(true);
      return;
    }
    setIsExporting(true);
    try {
      const res = await apiRequest("GET", "/api/owner/analytics/export");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `olio-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      toast({
        title: "Export failed",
        description: parseApiError(err, "Export failed"),
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const navRight = (
    <>
      <div className="flex gap-1">
        {WINDOW_OPTIONS.map((d) => (
          <button
            key={d}
            onClick={() => setWindowDays(d)}
            className={`px-2.5 py-1 rounded-full text-xs font-semibold transition ${
              windowDays === d
                ? "bg-foreground text-background"
                : "bg-secondary text-muted-foreground hover:text-foreground"
            }`}
          >
            {d === 365 ? "1Y" : `${d}D`}
          </button>
        ))}
      </div>
      <button
        onClick={handleExport}
        disabled={isExporting}
        title={canExport ? "Export transactions as CSV" : "Export is a premium feature"}
        className="px-3 py-1.5 rounded-full text-xs font-medium border border-border text-muted-foreground hover:text-foreground transition inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
      >
        {isExporting ? (
          <Loader2 size={14} className="animate-spin" />
        ) : canExport ? (
          <Download size={14} />
        ) : (
          <Lock size={14} />
        )}
        <span className="hidden sm:inline">{isExporting ? "Exporting…" : "Export"}</span>
      </button>
    </>
  );

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <PageHeader title="Olio Insights" subtitle="Financial performance & insights" />

      {analyticsError && (
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 p-4 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold">We couldn't load your analytics data.</p>
            <p className="text-xs opacity-80 mt-0.5">
              Charts and totals below may be empty or out of date.
            </p>
          </div>
          <button
            onClick={retryAll}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {advancedLocked ? (
        <UpgradeCard
          tier="advanced"
          onUpgrade={() => setIsPricingOpen(true)}
          title="Unlock Olio Insights"
          body="Upgrade to Pro for projections, property rankings, tenant payment scores, cash-flow analytics and exportable reports."
        />
      ) : (
        <>
          <SectionNav sections={NAV_SECTIONS} active={activeSection} right={navRight} />
          <div className="space-y-10">
            <OverviewSection
              b={insights}
              summary={summary}
              properties={properties}
              tenants={tenants}
              windowLabel={windowLabel}
            />
            {proLocked ? (
              <section>
                <UpgradeCard
                  tier="pro"
                  onUpgrade={() => setIsPricingOpen(true)}
                  title="Forecasts & projections"
                  body="Upgrade to unlock forward income projections, projected cash flow, cap-rate forecasts and the lease-renewal calendar."
                />
              </section>
            ) : (
              <ProjectionsSection b={insights} />
            )}
            <PropertiesSection
              b={insights}
              summary={summary}
              properties={properties}
              windowLabel={windowLabel}
            />
            <TenantsSection b={insights} />
            <CashflowSection b={insights} windowLabel={windowLabel} />
          </div>
        </>
      )}

      <PricingModal open={isPricingOpen} onOpenChange={setIsPricingOpen} />
    </div>
  );
}

function UpgradeCard({
  tier,
  title,
  body,
  onUpgrade,
}: {
  tier: "advanced" | "pro";
  title: string;
  body: string;
  onUpgrade: () => void;
}) {
  const Icon = tier === "pro" ? Sparkles : LineChart;
  return (
    <div className="bg-card p-8 rounded-2xl shadow-sm border border-border max-w-lg mx-auto text-center my-8">
      <div className="w-16 h-16 bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 rounded-full flex items-center justify-center mx-auto mb-4">
        <Icon size={30} />
      </div>
      <h3 className="text-xl font-bold text-foreground mb-2">{title}</h3>
      <p className="text-muted-foreground mb-6">{body}</p>
      <button
        onClick={onUpgrade}
        className="w-full bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700 transition shadow-lg shadow-blue-500/30"
      >
        Upgrade to Pro
      </button>
    </div>
  );
}
