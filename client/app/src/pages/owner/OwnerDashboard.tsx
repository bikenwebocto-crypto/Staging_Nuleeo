import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { FileText, Landmark, Plus, Receipt, type LucideIcon } from "lucide-react";

import { AddPropertyDrawer } from "@/components/owner/AddPropertyDrawer";
import { RecordActivityDialog } from "@/components/owner/RecordActivityDialog";
import { BusinessDashboard } from "@/components/owner/dashboard/BusinessDashboard";
import { useWorkspace } from "@/lib/workspaces";
import { useActivePortfolioPlan } from "@/lib/useActivePortfolioPlan";
import { useCanOwnerPlan } from "@ui/lib/usePrivileges";
import { openBriefing } from "@ui/lib/briefing";
import {
  AttentionCard,
  ByOwnerCard,
  PortfolioCard,
  SummaryCards,
  TransactionsCard,
} from "@/components/owner/dashboard/cards";
import { buildDashboardModel } from "@/lib/dashboardModel";
import {
  useAccessiblePortfolios,
  useOwnerAgreements,
  useOwnerInsightsTransactions,
  useOwnerProperties,
  useOwnerSummary,
  useOwnerTenants,
  useResolveRepair,
} from "@/lib/ownerQueries";
import { useActivePortfolio } from "@/lib/activePortfolio";

import { useToast } from "@ui/hooks/use-toast";
import { formatCurrencyCompact } from "@ui/lib/format";

/*
 * ----------------------------------------------------------------------------
 * PORTFOLIO VALUE HERO
 * ----------------------------------------------------------------------------
 */

type OwnershipSegment = {
  id: string;
  label: string;
  value: number;
};

/* Colours repeat if a portfolio has more owners than colours. */
const OWNERSHIP_COLORS = ["#73C2CD", "#E2F645", "#7D8287", "#F4F4F2"];

function OwnershipSplit({ segments, loading }: { segments: OwnershipSegment[]; loading: boolean }) {
  const visibleSegments = segments.filter((segment) => segment.value > 0);
  const total = visibleSegments.reduce((sum, segment) => sum + segment.value, 0);

  if (loading && total === 0) {
    return <div className="h-2.5 w-full animate-pulse rounded-full bg-[#1C2325]" />;
  }

  if (total === 0) {
    return null;
  }

  const summaryLabel = visibleSegments
    .map((segment) => `${segment.label} ${((segment.value / total) * 100).toFixed(1)}%`)
    .join(", ");

  return (
    <div className="flex flex-col gap-2.5">
      <div
        role="img"
        aria-label={`Ownership split: ${summaryLabel}`}
        className="flex h-2.5 gap-0.5 overflow-hidden rounded-full"
      >
        {visibleSegments.map((segment, index) => (
          <div
            key={segment.id}
            className="min-w-1"
            style={{
              flexGrow: segment.value,
              flexBasis: 0,
              backgroundColor: OWNERSHIP_COLORS[index % OWNERSHIP_COLORS.length],
            }}
          />
        ))}
      </div>

      <dl className="flex flex-wrap gap-x-4 gap-y-2">
        {visibleSegments.map((segment, index) => (
          <div key={segment.id} className="min-w-[110px] flex-1">
            <dt className="flex items-center gap-1.5 text-xs text-[#A3A7AB]">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: OWNERSHIP_COLORS[index % OWNERSHIP_COLORS.length],
                }}
              />
              <span className="truncate">{segment.label}</span>
            </dt>

            <dd className="mt-0.5 text-[15px] font-semibold tabular-nums text-[#F4F4F2]">
              {formatCurrencyCompact(segment.value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PortfolioAction({
  icon: Icon,
  label,
  primary = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  primary?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="group disabled:cursor-not-allowed disabled:opacity-50 flex flex-col items-center gap-2 text-xs font-medium text-[#F4F4F2]"
    >
      <span
        className={
          primary
            ? "flex h-12 w-12 items-center justify-center rounded-full bg-white text-[#060A0B] transition group-hover:brightness-95"
            : "flex h-12 w-12 items-center justify-center rounded-full bg-[#1C2325] text-[#F4F4F2] transition group-hover:bg-[#2A3134]"
        }
      >
        <Icon size={20} aria-hidden="true" />
      </span>

      <span className="text-center">{label}</span>
    </button>
  );
}

function PortfolioValueHero({
  portfolioValue,
  portfolioGrowth,
  propertyCount,
  unitCount,
  ownershipSegments,
  loading,
  onAddAsset,
  onRecordActivity,
  onConnectBank,
  onBriefing,
}: {
  portfolioValue: number;
  portfolioGrowth?: number | null;
  propertyCount: number;
  unitCount: number;
  ownershipSegments: OwnershipSegment[];
  loading: boolean;
  onAddAsset?: () => void;
  onRecordActivity?: () => void;
  onConnectBank?: () => void;
  onBriefing?: () => void;
}) {
  return (
    <section aria-label="Portfolio value" className="flex min-w-0 flex-col gap-5 px-1 py-2">
      <div>
        <p className="text-sm font-medium text-[#A3A7AB]">Portfolio value</p>

        <h1 className="mt-2 text-5xl font-bold leading-none tracking-[-0.03em] text-[#F4F4F2] tabular-nums md:text-7xl">
          {formatCurrencyCompact(portfolioValue)}
        </h1>

        <div className="mt-3 flex flex-wrap items-center gap-2.5 text-xs text-[#A3A7AB]">
          {portfolioGrowth != null && (
            <span className="rounded-full bg-[#7BD88F]/15 px-2.5 py-1 font-semibold text-[#7BD88F]">
              {portfolioGrowth >= 0 ? "+" : ""}
              {formatCurrencyCompact(portfolioGrowth)}
              {" this month"}
            </span>
          )}

          <span>
            {propertyCount} {propertyCount === 1 ? "property" : "properties"}
          </span>

          <span className="h-1 w-1 rounded-full bg-[#7D8287]" />

          <span>
            {unitCount} {unitCount === 1 ? "unit" : "units"}
          </span>
        </div>
      </div>

      <OwnershipSplit segments={ownershipSegments} loading={loading} />

      <div className="mt-auto grid grid-cols-4 gap-2">
        <PortfolioAction icon={Plus} label="Add asset" primary onClick={onAddAsset} />
        <PortfolioAction icon={Receipt} label="Record activity" onClick={onRecordActivity} />
        <PortfolioAction icon={Landmark} label="Connect bank" onClick={onConnectBank} />
        <PortfolioAction icon={FileText} label="Briefing" onClick={onBriefing} />
      </div>
    </section>
  );
}

// /owner renders the dashboard of the ACTIVE WORKSPACE. Real-estate workspaces
// wrap the active portfolio (all queries below are already portfolio-scoped
// and authorized server-side); business workspaces get their own dashboard.
export default function OwnerDashboard() {
  const { activeWorkspace } = useWorkspace();
  if (activeWorkspace?.type === "business") {
    return <BusinessDashboard workspace={activeWorkspace} />;
  }
  return <RealEstateDashboard />;
}

function RealEstateDashboard() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [isAddPropertyOpen, setIsAddPropertyOpen] = useState(false);
  const [isRecordActivityOpen, setIsRecordActivityOpen] = useState(false);

  /*
   * --------------------------------------------------------------------------
   * DATA
   * --------------------------------------------------------------------------
   */

  const {
    data: summary,
    isError: summaryError,
    isLoading: summaryLoading,
    refetch: refetchSummary,
  } = useOwnerSummary();

  const {
    data: propertiesData,
    isError: propertiesError,
    isLoading: propertiesLoading,
    refetch: refetchProperties,
  } = useOwnerProperties();

  const {
    data: transactionsData,
    isError: transactionsError,
    isLoading: transactionsLoading,
    refetch: refetchTransactions,
  } = useOwnerInsightsTransactions();

  const {
    data: tenantsData,
    isError: tenantsError,
    isLoading: tenantsLoading,
    refetch: refetchTenants,
  } = useOwnerTenants();

  const {
    data: agreementsData,
    isError: agreementsError,
    isLoading: agreementsLoading,
    refetch: refetchAgreements,
  } = useOwnerAgreements();

  const { data: portfolios = [] } = useAccessiblePortfolios();

  const { isSelf, canEdit, activeOwnerId, activePortfolioDocId, setActiveOwnerId } =
    useActivePortfolio();
  const { plan: activePlan } = useActivePortfolioPlan();
  const canPrintBriefing = useCanOwnerPlan(activePlan)("briefing.portfolio");

  const properties = useMemo(() => propertiesData ?? [], [propertiesData]);

  /*
   * Keep the timestamp stable for the lifetime of this dashboard render.
   * This prevents the dashboard model from recalculating against a moving
   * "now" value on every render.
   */
  const [nowMs] = useState(() => Date.now());

  const model = useMemo(
    () =>
      buildDashboardModel({
        summary,
        properties,
        transactions: transactionsData ?? [],
        tenants: tenantsData ?? [],
        agreements: agreementsData ?? [],
        nowMs,
      }),
    [summary, properties, transactionsData, tenantsData, agreementsData, nowMs],
  );

  const portfolioGrowth = summary?.portfolioGrowth;

  /*
   * Ownership split: the same breakdown ByOwnerCard renders — one segment per
   * owning company, plus personally-owned value.
   */
  const ownershipSegments = useMemo<OwnershipSegment[]>(
    () => [
      ...model.byOwner.companies.map((c) => ({
        id: "co:" + c.name,
        label: c.name,
        value: c.value,
      })),
      { id: "personal", label: "Personally owned", value: model.byOwner.individualValue },
    ],
    [model.byOwner],
  );

  const dashboardLoading =
    summaryLoading ||
    propertiesLoading ||
    transactionsLoading ||
    tenantsLoading ||
    agreementsLoading;

  /*
   * --------------------------------------------------------------------------
   * PORTFOLIO FILTER
   * --------------------------------------------------------------------------
   */

  const ownerOptions = useMemo(
    () =>
      portfolios.map((portfolio) => ({
        value: portfolio.ownerId,
        label: portfolio.isSelf ? "My portfolio" : portfolio.ownerName,
      })),
    [portfolios],
  );

  /*
   * --------------------------------------------------------------------------
   * ERROR HANDLING
   * --------------------------------------------------------------------------
   */

  const dashboardError =
    summaryError || propertiesError || transactionsError || tenantsError || agreementsError;

  const retryAll = () => {
    refetchSummary();
    refetchProperties();
    refetchTransactions();
    refetchTenants();
    refetchAgreements();
  };

  /*
   * --------------------------------------------------------------------------
   * NEEDS ATTENTION
   * --------------------------------------------------------------------------
   */

  const scrollToAttention = () => {
    document.getElementById("needs-attention")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  /*
   * --------------------------------------------------------------------------
   * REPAIR RESOLUTION
   * --------------------------------------------------------------------------
   */

  const resolveRepair = useResolveRepair();

  const markResolved = (id: string) => {
    resolveRepair.mutate(id, {
      onSuccess: () => {
        toast({
          title: "Marked resolved",
          description: "Your tenant has been notified the issue is fixed.",
        });
      },
      onError: (error) => {
        toast({
          title: "Couldn't update report",
          description: error.message || "Please try again.",
          variant: "destructive",
        });
      },
    });
  };

  const generateBriefing = async () => {
    if (!canPrintBriefing) {
      toast({
        title: "Portfolio briefing is a premium feature",
        description: "Upgrade your plan to download your portfolio briefing as a PDF.",
      });
      return;
    }
    const r = await openBriefing("portfolio", {
      ownerId: activeOwnerId,
      isSelf,
      portfolioDocId: activePortfolioDocId,
    });
    if (!r.ok) toast({ title: "Briefing failed", description: r.error, variant: "destructive" });
  };

  /*
   * --------------------------------------------------------------------------
   * RENDER
   * --------------------------------------------------------------------------
   */

  return (
    <>
      <AddPropertyDrawer open={isAddPropertyOpen} onOpenChange={setIsAddPropertyOpen} />
      <RecordActivityDialog open={isRecordActivityOpen} onOpenChange={setIsRecordActivityOpen} />

      <main className="w-full min-h-full">
        {/* ------------------------------------------------------------------
            ERROR MESSAGE
            ------------------------------------------------------------------ */}

        {dashboardError && (
          <div className="mx-6 md:mx-8 mt-4 md:mt-6">
            <div
              className="
                flex items-start justify-between gap-4
                rounded-xl
                border border-amber-500/30
                bg-amber-500/10
                px-4 py-3
                text-amber-900
                dark:text-amber-200
              "
            >
              <div>
                <p className="text-sm font-semibold">
                  We couldn't load all of your portfolio data.
                </p>

                <p className="mt-0.5 text-xs opacity-80">Check your connection or try again.</p>
              </div>

              <button
                type="button"
                onClick={retryAll}
                className="
                  shrink-0
                  rounded-lg
                  bg-amber-600
                  px-3 py-1.5
                  text-xs font-semibold
                  text-white
                  transition
                  hover:bg-amber-700
                "
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------------
            DASHBOARD CONTENT

            IMPORTANT:
            The old skyline/hero/banner has intentionally been removed.

            The Figma dashboard starts directly with the dashboard cards.
            The application-level header remains responsible for:
            - Dashboard/Home title
            - Search
            - Actions
            - User profile
            ------------------------------------------------------------------ */}

        <div
          className="
            w-full
            px-5 py-5
            sm:px-6 sm:py-6
            lg:px-8 lg:py-7
            pb-[var(--mobile-nav-clearance)]
            md:pb-8
          "
        >
          <div className="mx-auto w-full max-w-[1440px]">
            {/* ==============================================================
                PORTFOLIO VALUE + KPI / SUMMARY CARDS
                ============================================================== */}

            <div
              className="
                grid
                grid-cols-1
                items-stretch
                gap-5
                xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]
              "
            >
              <PortfolioValueHero
                portfolioValue={summary?.portfolioValue ?? 0}
                portfolioGrowth={portfolioGrowth}
                propertyCount={model.propertyCount}
                unitCount={model.unitCount}
                ownershipSegments={ownershipSegments}
                loading={dashboardLoading}
                // Mutations are owner-self only (server-enforced); hide the
                // entry points for granted read-only viewers.
                onAddAsset={isSelf ? () => setIsAddPropertyOpen(true) : undefined}
                onRecordActivity={canEdit ? () => setIsRecordActivityOpen(true) : undefined}
                onConnectBank={isSelf ? () => setLocation("/banking") : undefined}
                onBriefing={() => void generateBriefing()}
              />

              <section aria-label="Dashboard summary" className="min-w-0">
                <SummaryCards
                  model={model}
                  loading={dashboardLoading}
                  onViewAttention={scrollToAttention}
                />
              </section>
            </div>

            {/* ==============================================================
                PORTFOLIO + OWNER
                ============================================================== */}

            <section
              className="
                mt-5
                grid
                grid-cols-1
                gap-5
                xl:grid-cols-3
              "
              aria-label="Portfolio overview"
            >
              {/* Portfolio = 2/3 */}
              <div className="min-w-0 xl:col-span-2">
                <PortfolioCard
                  model={model}
                  loading={dashboardLoading}
                  ownerOptions={ownerOptions}
                  ownerId={activeOwnerId}
                  onOwnerChange={setActiveOwnerId}
                />
              </div>

              {/* By Owner = 1/3 */}
              <div className="min-w-0 xl:col-span-1">
                <ByOwnerCard model={model} loading={dashboardLoading} />
              </div>
            </section>

            {/* ==============================================================
                TRANSACTIONS + NEEDS ATTENTION
                ============================================================== */}

            <section
              className="
                mt-5
                grid
                grid-cols-1
                gap-5
                xl:grid-cols-3
              "
              aria-label="Activity and attention"
            >
              {/* Transactions = 2/3 */}
              <div className="min-w-0 xl:col-span-2">
                <TransactionsCard
                  model={model}
                  loading={dashboardLoading}
                  isSelf={isSelf}
                  isResolving={resolveRepair.isPending}
                  onResolve={markResolved}
                />
              </div>

              {/* Needs Attention = 1/3 */}
              <div id="needs-attention" className="min-w-0 scroll-mt-6 xl:col-span-1">
                <AttentionCard model={model} loading={dashboardLoading} />
              </div>
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
