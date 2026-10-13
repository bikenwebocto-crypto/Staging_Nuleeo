import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation, Link } from "wouter";
import { AddPropertyDrawer } from "@/components/owner/AddPropertyDrawer";
import {
  useOwnerProperties,
  useOwnerTransactions,
  useOwnerSummary,
  useResolveRepair,
} from "@/lib/ownerQueries";
import { useActivePortfolio } from "@/lib/activePortfolio";
import useEmblaCarousel from "embla-carousel-react";
import { BarChart2, Plus, Building, Users, Store, TrendingUp, Check } from "lucide-react";
import aptExterior from "@/assets/images/apt-exterior.jpg";
import { formatCurrencyCompact, formatDateTime } from "@ui/lib/format";
import { activityVisual, isRepairReport } from "@/lib/activityVisual";
import { RepairStatusBadge } from "@/components/common/RepairStatusBadge";
import { useToast } from "@ui/hooks/use-toast";
import { TableEmptyState } from "@ui/components/ui/data-table";
import { PropertyImage } from "@ui/components/common/PropertyImage";

export default function OwnerDashboard() {
  const [location, setLocation] = useLocation();
  const [isAddPropertyOpen, setIsAddPropertyOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  // Data State
  const { data: summary, isError: summaryError, refetch: refetchSummary } = useOwnerSummary();
  const {
    data: propertiesData,
    isError: propertiesError,
    refetch: refetchProperties,
  } = useOwnerProperties();
  const {
    data: transactionsData,
    isError: transactionsError,
    refetch: refetchTransactions,
  } = useOwnerTransactions();
  const { isSelf } = useActivePortfolio();
  const { toast } = useToast();
  const properties = propertiesData ?? [];
  const transactions = transactionsData ?? [];

  // Owner marks a tenant-reported maintenance issue resolved from the activity
  // widget. Owner-self only (the endpoint is ownerId-gated); the Resolve button
  // below is shown only when isSelf and the report is still pending.
  const resolveRepair = useResolveRepair();
  const markResolved = (id: string) => {
    resolveRepair.mutate(id, {
      onSuccess: () =>
        toast({
          title: "Marked resolved",
          description: "Your tenant has been notified the issue is fixed.",
        }),
      onError: (err) =>
        toast({
          title: "Couldn't update report",
          description: err.message || "Please try again.",
          variant: "destructive",
        }),
    });
  };

  const dashboardError = summaryError || propertiesError || transactionsError;
  const retryAll = () => {
    refetchSummary();
    refetchProperties();
    refetchTransactions();
  };

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleScroll = () => {
      if (scrollRef.current) {
        setScrolled(scrollRef.current.scrollTop > 20);
      }
    };

    const element = scrollRef.current;
    if (element) {
      element.addEventListener("scroll", handleScroll);
    }

    return () => {
      if (element) {
        element.removeEventListener("scroll", handleScroll);
      }
    };
  }, []);

  // Calculations
  const monthlyRents = summary?.monthlyRevenue ?? 0;
  const propertiesValue = summary?.portfolioValue ?? 0;
  const equityInvested = summary?.equityInvested ?? 0;
  const occupancyRate = summary?.occupancyRate ?? 0;
  const unitCount = summary?.unitCount ?? 0;
  const isTenantView = false; // Always false on Owner Dashboard

  const headerStats = [
    {
      label: "Portfolio Value",
      value: formatCurrencyCompact(propertiesValue),
      sublabel: "Current Market Value",
    },
    {
      label: "Monthly Rents",
      value: formatCurrencyCompact(monthlyRents),
      sublabel: "Active Rents",
    },
    {
      label: "Equity Invested",
      value: formatCurrencyCompact(equityInvested),
      sublabel: "Total Initial Cost",
    },
  ];

  // Embla Carousel for the mobile values header — loops infinitely so the
  // slides cycle Portfolio Value → Monthly Rents → Equity Invested → back.
  const [headerEmblaRef, headerEmblaApi] = useEmblaCarousel({ loop: true, align: "start" });
  const [selectedStat, setSelectedStat] = useState(0);

  // Keep the dot indicators in sync with the active slide.
  useEffect(() => {
    if (!headerEmblaApi) return;
    const onSelect = () => setSelectedStat(headerEmblaApi.selectedScrollSnap());
    headerEmblaApi.on("select", onSelect);
    headerEmblaApi.on("reInit", onSelect);
    onSelect();
    return () => {
      headerEmblaApi.off("select", onSelect);
      headerEmblaApi.off("reInit", onSelect);
    };
  }, [headerEmblaApi]);

  const autoplay = useCallback(() => {
    if (!headerEmblaApi) return;
    headerEmblaApi.scrollNext();
  }, [headerEmblaApi]);

  useEffect(() => {
    if (!headerEmblaApi) return;
    let intervalId = setInterval(autoplay, 5000);

    // Pause briefly on interaction, then resume the loop.
    const onPointerDown = () => clearInterval(intervalId);
    const onPointerUp = () => {
      clearInterval(intervalId);
      intervalId = setInterval(autoplay, 5000);
    };
    headerEmblaApi.on("pointerDown", onPointerDown);
    headerEmblaApi.on("pointerUp", onPointerUp);

    return () => {
      clearInterval(intervalId);
      headerEmblaApi.off("pointerDown", onPointerDown);
      headerEmblaApi.off("pointerUp", onPointerUp);
    };
  }, [headerEmblaApi, autoplay]);

  return (
    <>
      <div ref={scrollRef} className="flex-1 relative h-full flex flex-col">
        <AddPropertyDrawer open={isAddPropertyOpen} onOpenChange={setIsAddPropertyOpen} />

        {dashboardError && (
          <div className="mx-6 md:mx-8 mt-6 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 p-4 flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold">We couldn't load all of your portfolio data.</p>
              <p className="text-xs opacity-80 mt-0.5">Check your connection or try again.</p>
            </div>
            <button
              onClick={retryAll}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* ================= MOBILE HEADER ================= */}
        <div className="md:hidden">
          <div className="pt-[calc(var(--mobile-header-clearance)+2rem)] pb-16 px-6 relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-[60vh] z-0 overflow-hidden pointer-events-none [mask-image:linear-gradient(to_bottom,black_60%,transparent_100%)]">
              {/* Accent gradient — shades of the selected appearance color
                  (--brand-accent, set by accentStore), replacing the skyline
                  photo. Mixed toward near-black so the white hero text stays
                  legible across every accent option. */}
              <div
                className="absolute inset-0"
                style={{
                  background:
                    "linear-gradient(165deg, color-mix(in srgb, var(--brand-accent) 70%, #05070c) 0%, color-mix(in srgb, var(--brand-accent) 42%, #05070c) 55%, color-mix(in srgb, var(--brand-accent) 24%, #05070c) 100%)",
                }}
              />
            </div>

            <div className="relative z-10 mb-10">
              <div className="overflow-hidden" ref={headerEmblaRef}>
                <div className="flex touch-pan-y">
                  {headerStats.map((stat, i) => (
                    <div
                      key={i}
                      className="flex-[0_0_100%] min-w-0 flex flex-col items-center justify-center"
                    >
                      <p className="text-white/60 text-sm font-medium mb-1">{stat.label}</p>
                      <h1 className="text-5xl font-bold text-white tracking-tight mb-2">
                        {stat.value}
                      </h1>
                      <p className="text-white/40 text-xs font-medium tracking-wide">
                        {stat.sublabel}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Slide indicators — one dot per stat */}
              <div className="flex items-center justify-center gap-2 mt-5">
                {headerStats.map((stat, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => headerEmblaApi?.scrollTo(i)}
                    aria-label={`Show ${stat.label}`}
                    aria-current={i === selectedStat}
                    className={`h-1.5 rounded-full transition-all ${
                      i === selectedStat ? "w-5 bg-white" : "w-1.5 bg-white/40"
                    }`}
                  />
                ))}
              </div>
            </div>

            {!isTenantView && (
              <div className="grid grid-cols-3 gap-2 relative z-10 px-2">
                {[
                  {
                    label: "Olio Insights",
                    icon: BarChart2,
                    action: () => setLocation("/insights"),
                  },
                  {
                    label: "Marketplace",
                    icon: Store,
                    action: () => setLocation("/marketplace"),
                  },
                  { label: "Network", icon: Users, action: () => setLocation("/network") },
                ].map((item) => (
                  <button
                    key={item.label}
                    onClick={item.action}
                    className="flex flex-col items-center gap-2 group"
                  >
                    <div className="w-14 h-14 rounded-full bg-white/5 backdrop-blur-md border border-white/10 flex items-center justify-center text-white group-active:bg-white/10 transition-all">
                      <item.icon size={22} strokeWidth={1.5} />
                    </div>
                    <span className="text-white/70 text-[10px] font-medium tracking-wide">
                      {item.label}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ================= HERO BANNER (Desktop only) ================= */}
        {/* shrink-0: the parent is `h-full flex flex-col`, which otherwise
            compresses this fixed-height banner (its overflow-hidden then clips
            the figures down to a thin strip). */}
        <div className="hidden md:block shrink-0 mx-8 mt-8 rounded-2xl overflow-hidden relative h-[180px]">
          <img
            src="/banner-skyline.jpg"
            alt="Skyline"
            className="absolute inset-0 w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-black/60 via-black/40 to-transparent" />
          <div className="relative z-10 h-full grid grid-cols-3 items-center px-8">
            <div>
              <p className="text-white/70 text-xs font-semibold uppercase tracking-[0.2em] mb-2">
                Portfolio Value
              </p>
              <h2 className="text-4xl font-bold text-white tracking-tight mb-3">
                {formatCurrencyCompact(propertiesValue)}
              </h2>
              <div className="flex items-center gap-4">
                <span className="text-white/50 text-sm">{unitCount} units managed</span>
              </div>
            </div>
            <div className="border-l border-white/20 pl-8">
              <p className="text-white/70 text-xs font-semibold uppercase tracking-[0.2em] mb-2">
                Monthly Revenue
              </p>
              <h2 className="text-4xl font-bold text-white tracking-tight mb-3">
                {formatCurrencyCompact(monthlyRents)}
              </h2>
            </div>
            <div className="border-l border-white/20 pl-8">
              <p className="text-white/70 text-xs font-semibold uppercase tracking-[0.2em] mb-2">
                Occupancy Rate
              </p>
              <h2 className="text-4xl font-bold text-white tracking-tight mb-3">
                {Math.round(occupancyRate)}%
              </h2>
            </div>
          </div>
        </div>

        {/* ================= STATS (Mobile only) ================= */}

        {/* ================= CONTENT ================= */}
        <div className="md:hidden -mt-6 relative z-20 bg-background dark:bg-card rounded-t-[1.5rem] pt-6" />
        <div className="p-6 md:p-8 pb-[var(--mobile-nav-clearance)] md:pb-8 relative z-20 bg-background dark:bg-card md:bg-transparent md:dark:bg-transparent flex-1">
          {/* Main Feed */}
          <div className="space-y-6 md:space-y-8">
            {/* Portfolio Updates */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-foreground">Portfolio Updates</h2>
                <Link href="/owner/activity">
                  <span className="text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition">
                    View all
                  </span>
                </Link>
              </div>

              <div className="bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl border border-border/60 rounded-2xl overflow-hidden shadow-sm">
                {transactions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <TrendingUp size={32} className="mb-3 opacity-30" />
                    <p className="text-sm font-medium">No activity yet</p>
                    <p className="text-xs mt-1 opacity-70">
                      Transactions will appear here once you add properties
                    </p>
                  </div>
                ) : (
                  transactions.slice(0, 5).map((tx) => {
                    const propertyLabel = tx.propertyAddress;
                    const formattedDate = formatDateTime(tx.timestamp);
                    const { Icon, className: iconClass } = activityVisual(tx.type, {
                      solid: true,
                    });
                    // Tenant-reported maintenance issue: show its Pending /
                    // Resolved badge, plus an inline Resolve action while it's
                    // pending (owner-self only).
                    const repair = isRepairReport(tx);
                    const canResolve = repair && isSelf && tx.status === "pending";
                    return (
                      <div
                        key={tx.id}
                        className="flex items-center justify-between p-4 border-b border-border/40 last:border-0 hover:bg-secondary/30 transition cursor-pointer group"
                      >
                        <div className="flex items-center gap-3 md:gap-4 min-w-0 flex-1">
                          <div
                            className={`w-10 h-10 rounded-full flex items-center justify-center border flex-shrink-0 ${iconClass}`}
                          >
                            <Icon size={18} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <p className="text-sm font-medium text-foreground truncate min-w-0">
                                {tx.name}
                              </p>
                              {tx.type === "income" &&
                                tx.source !== "prepaid" &&
                                tx.name.toLowerCase().includes("rent") && (
                                  <span className="text-[9px] bg-blue-500/10 text-blue-500 dark:text-blue-400 px-1.5 py-0.5 rounded uppercase font-bold tracking-wider whitespace-nowrap shrink-0">
                                    Auto Record
                                  </span>
                                )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate">
                              {propertyLabel
                                ? `${propertyLabel} · ${formattedDate}`
                                : formattedDate}
                            </p>
                          </div>
                        </div>
                        {/* Amounts are intentionally NOT shown in this dashboard
                            preview — only on the full Activity page. Repairs keep
                            their status badge (a status, not an amount). */}
                        {repair ? (
                          <div className="flex items-center gap-2 shrink-0 pl-3">
                            <RepairStatusBadge status={tx.status} />
                            {canResolve ? (
                              <button
                                onClick={() => markResolved(tx.id)}
                                disabled={resolveRepair.isPending}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-foreground text-background hover:opacity-90 transition disabled:opacity-50"
                              >
                                <Check size={12} />
                                Resolve
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            {/* Properties Overview */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-foreground">Properties</h2>
                <Link href="/properties">
                  <span className="text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition">
                    View all
                  </span>
                </Link>
              </div>

              {properties.length === 0 ? (
                <div className="bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl border border-border/60 rounded-2xl">
                  <TableEmptyState
                    icon={<Building size={24} className="opacity-50" />}
                    title="No properties yet"
                    description={
                      isSelf
                        ? "Add your first property to start tracking value, rent and activity."
                        : "This portfolio has no properties."
                    }
                    action={
                      isSelf ? (
                        <button
                          onClick={() => setIsAddPropertyOpen(true)}
                          className="bg-primary text-primary-foreground hover:opacity-90 px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition"
                        >
                          <Plus size={14} /> Add Property
                        </button>
                      ) : undefined
                    }
                  />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 md:gap-4">
                  {properties.slice(0, 4).map((property) => (
                    <Link
                      key={property.id}
                      href={`/properties/${property.id}`}
                      className="group block bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl border border-border/60 rounded-2xl p-3 hover:border-border transition cursor-pointer shadow-sm"
                    >
                      <div className="aspect-video w-full rounded-lg bg-secondary overflow-hidden mb-3 relative">
                        <PropertyImage
                          src={property.image}
                          alt={property.address}
                          iconSize={28}
                          className="group-hover:scale-105 transition duration-500"
                        />
                        <div
                          className={`absolute top-2 right-2 bg-card/90 dark:bg-card/90 backdrop-blur px-2 py-0.5 rounded text-[10px] font-bold ${property.tenancyState === "pending" ? "text-orange-600 dark:text-orange-400" : "text-foreground"}`}
                        >
                          {property.tenancyState === "occupied"
                            ? "Occupied"
                            : property.tenancyState === "pending"
                              ? "Pending"
                              : "Vacant"}
                        </div>
                      </div>
                      <h3 className="text-sm font-semibold text-foreground truncate">
                        {property.address}
                      </h3>
                      {/* Hide rent for vacant or zero-rent properties so we
                          never advertise €0/mo income. */}
                      {property.tenancyState !== "vacant" && (property.rentAmount ?? 0) > 0 && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Rent: {formatCurrencyCompact(property.rentAmount)}/mo
                        </p>
                      )}
                    </Link>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
