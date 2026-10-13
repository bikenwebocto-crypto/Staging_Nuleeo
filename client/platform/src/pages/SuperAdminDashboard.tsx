import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import {
  useAdminDashboard,
  useAdminSuggestionRequests,
  type DashboardRange,
} from "@/lib/adminQueries";
import { useAccentColor } from "@/lib/accentStore";
import { formatCurrencyCompact } from "@ui/lib/format";
import { useBannerSelection } from "@ui/lib/bannerStore";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { AdminListError } from "@/components/common/AdminListStates";
import { Skeleton } from "@ui/components/common/Skeleton";
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import {
  TrendingUp,
  Users,
  Building,
  ArrowUpRight,
  Activity,
  Map,
  BarChart3,
  Info,
  UserPlus,
} from "lucide-react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from "recharts";
import MarkerClusterGroup from "react-leaflet-cluster";

// Fix for default leaflet icons
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

// Custom div icon for styled markers
const createCustomIcon = (color: string) =>
  L.divIcon({
    className: "custom-icon",
    html: `<div style="background-color: ${color}; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 4px rgba(0,0,0,0.4);"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

export default function SuperAdminDashboard() {
  const [accent] = useAccentColor();
  const { canPlatform } = usePrivileges();
  // Plain admins (e.g. support, marketing) can land on this page via the
  // sidebar, but they shouldn't see platform-wide financials. Mask the
  // money — replace numbers with em-dash and hide the revenue chart —
  // while keeping the rest of the dashboard (counts, map, activity)
  // accessible so they have a usable landing page.
  const canSeeFinancials = canPlatform("finance.viewAll");
  const fmtMoney = (n: number) => (canSeeFinancials ? formatCurrencyCompact(n) : "—");
  // Money for the map-pin popup: em-dash when the admin can't see financials
  // (server already zeroes these), "N/A" when the figure genuinely isn't set
  // (0/missing), else the formatted amount. Keeps "you may not look" distinct
  // from "there's nothing here".
  const moneyOrNA = (n: number | null | undefined) =>
    !canSeeFinancials ? "—" : n && n > 0 ? formatCurrencyCompact(n) : "N/A";
  const { enabled: bannerImages } = useBannerSelection();
  const [bannerIdx, setBannerIdx] = useState(0);
  const [bannerPaused, setBannerPaused] = useState(false);
  const [timeRange, setTimeRange] = useState<DashboardRange>("1m");
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains("dark"));
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("theme-changed", check);
    return () => {
      obs.disconnect();
      window.removeEventListener("theme-changed", check);
    };
  }, []);

  useEffect(() => {
    if (bannerImages.length === 0 || bannerPaused) return;
    const t = setInterval(() => setBannerIdx((i) => (i + 1) % bannerImages.length), 5000);
    return () => clearInterval(t);
  }, [bannerImages.length, bannerPaused]);

  // Keep bannerIdx valid when an admin toggles a banner off.
  useEffect(() => {
    if (bannerIdx >= bannerImages.length && bannerImages.length > 0) {
      setBannerIdx(0);
    }
  }, [bannerIdx, bannerImages.length]);

  const [, setLocation] = useLocation();
  const [rentalView, setRentalView] = useState<"cities" | "countries">("cities");

  const { data: dashboardData, isLoading, isError, refetch } = useAdminDashboard(timeRange);

  // Human label that re-labels each stat card's trend bubble so it
  // aligns with the time-range pill. Lifetime keeps the legacy
  // MoM/YoY copy; every other range becomes a "vs prior <window>"
  // delta. `chartWindowLabel` does the same job for the three
  // time-series charts (whose bucket size the server picks to match
  // the range).
  const isLifetime = timeRange === "all";
  const vsPriorLabel: string = (
    {
      "1d": "vs prior day",
      "1w": "vs prior week",
      "1m": "vs prior month",
      "1q": "vs prior quarter",
      "1y": "vs prior year",
      all: "vs last year",
    } satisfies Record<DashboardRange, string>
  )[timeRange];
  const chartWindowLabel: string = (
    {
      "1d": "Last 24 hours",
      "1w": "Last 7 days",
      "1m": "Last 30 days",
      "1q": "Last 13 weeks",
      "1y": "Last 12 months",
      all: "Last 12 months",
    } satisfies Record<DashboardRange, string>
  )[timeRange];
  const { data: investmentLeads = [] } = useAdminSuggestionRequests();
  const newLeadsCount = investmentLeads.filter((l) => l.status === "new").length;
  const adminStats = dashboardData?.stats ?? {
    arr: 0,
    mrr: 0,
    totalRealEstateValue: 0,
    activeSubscriptions: 0,
    totalProperties: 0,
    totalUsers: 0,
    totalAgreements: 0,
    totalOwners: 0,
    totalTenants: 0,
    dualRoleUsers: 0,
    propertiesRented: 0,
    propertiesAvailable: 0,
  };
  const trends = dashboardData?.trends ?? {
    arrYoY: 0,
    mrrMoM: 0,
    subscriptionsThisMonth: 0,
    propertiesThisMonth: 0,
    usersThisMonth: 0,
    agreementsThisMonth: 0,
    aumYoY: 0,
  };
  const cityRentals = dashboardData?.avgRental.cities ?? [];
  const countryRentals = dashboardData?.avgRental.countries ?? [];

  const revenueData = dashboardData?.monthlySeries ?? [];
  const weeklyActivity = dashboardData?.weeklyActivity ?? [];
  const unitGrowthData = dashboardData?.unitGrowth ?? [];

  const totalUsers = adminStats.totalUsers;
  const ownerPct = totalUsers > 0 ? Math.round((adminStats.totalOwners / totalUsers) * 100) : 0;

  const totalProps = adminStats.propertiesRented + adminStats.propertiesAvailable;
  const rentedPct =
    totalProps > 0 ? Math.round((adminStats.propertiesRented / totalProps) * 100) : 0;

  const [usersLocationView, setUsersLocationView] = useState<"cities" | "countries">("cities");
  const [propertiesLocationView, setPropertiesLocationView] = useState<"cities" | "countries">(
    "cities",
  );

  const usersByCities = dashboardData?.topUsers.cities ?? [];
  const usersByCountries = dashboardData?.topUsers.countries ?? [];
  const propertiesByCities = dashboardData?.topProperties.cities ?? [];
  const propertiesByCountries = dashboardData?.topProperties.countries ?? [];

  const mapProperties = dashboardData?.mapMarkers ?? [];

  // First load (no cached data yet): show a skeleton dashboard instead of a
  // grid full of zeros, so a slow API doesn't read as "everything is empty".
  if (isLoading && !dashboardData) {
    return (
      <div className={`${PAGE_CONTAINER_CLASSNAME} space-y-6`}>
        <Skeleton className="h-[180px] w-full rounded-2xl hidden md:block" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Skeleton className="h-72 w-full rounded-2xl" />
          <Skeleton className="h-72 w-full rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className={`${PAGE_CONTAINER_CLASSNAME} space-y-6`}>
      {/* When the dashboard query fails, surface a retry banner above the
            widgets so a load error doesn't read as a real all-zero platform. */}
      {isError && (
        <AdminListError onRetry={() => refetch()} message="We couldn't load the dashboard." />
      )}

      {/* ── Row 1: AUM Banner Hero ── */}
      <div className="hidden md:block">
        <div
          className="relative overflow-hidden rounded-2xl p-7 shadow-lg h-[180px]"
          onMouseEnter={() => setBannerPaused(true)}
          onMouseLeave={() => setBannerPaused(false)}
        >
          <div className="absolute inset-0">
            {bannerImages.map((src, i) => (
              <img
                key={src}
                src={src}
                alt=""
                className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-1000 ${i === bannerIdx ? "opacity-100" : "opacity-0"}`}
              />
            ))}
            <div className="absolute inset-0 bg-black/40" />
          </div>
          {/* Dot indicator — only shown when there's more than one banner enabled. */}
          {bannerImages.length > 1 && (
            <div className="absolute bottom-3 right-4 z-10 flex items-center gap-1.5">
              {bannerImages.map((src, i) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => setBannerIdx(i)}
                  aria-label={`Show banner ${i + 1} of ${bannerImages.length}`}
                  className={`h-1.5 rounded-full transition-all ${i === bannerIdx ? "w-4 bg-white" : "w-1.5 bg-white/40 hover:bg-white/60"}`}
                />
              ))}
            </div>
          )}
          <div className="relative z-10">
            <span className="text-white text-xs font-medium uppercase tracking-widest">
              Total Assets Under Management
            </span>
            <h2 className="text-4xl font-bold text-white tracking-tight mt-3 mb-3">
              {fmtMoney(adminStats.totalRealEstateValue)}
            </h2>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <span className="text-white text-sm">
                  {adminStats.totalProperties.toLocaleString()} units managed
                </span>
              </div>
              <div className="flex items-center bg-white/10 backdrop-blur-sm rounded-full p-0.5 text-xs font-medium">
                {(
                  [
                    ["1d", "1 day"],
                    ["1w", "1 week"],
                    ["1m", "1 month"],
                    ["1q", "1 quarter"],
                    ["1y", "1 year"],
                    ["all", "Lifetime"],
                  ] as const
                ).map(([range, label]) => (
                  <button
                    key={range}
                    onClick={() => setTimeRange(range)}
                    className={`px-3 py-1.5 rounded-full transition-all whitespace-nowrap ${timeRange === range ? "bg-white text-black shadow-sm" : "text-white/70 hover:text-white"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Mobile: AUM Hero ── */}
      <div className="md:hidden">
        <div className="rounded-2xl p-5 relative overflow-hidden">
          <div className="absolute inset-0">
            {bannerImages[bannerIdx] && (
              <img src={bannerImages[bannerIdx]} alt="" className="w-full h-full object-cover" />
            )}
            <div className="absolute inset-0 bg-black/50" />
          </div>
          <div className="relative z-10">
            <p className="text-white text-xs font-medium uppercase tracking-widest mb-2">
              Total Real Estate Value
            </p>
            <h3 className="text-2xl font-bold text-white tracking-tight mb-2">
              {fmtMoney(adminStats.totalRealEstateValue)}
            </h3>
            <div className="flex items-center bg-white/10 backdrop-blur-sm rounded-full p-0.5 text-[11px] font-medium overflow-x-auto no-scrollbar w-fit max-w-full mt-3">
              {(
                [
                  ["1d", "1 day"],
                  ["1w", "1 week"],
                  ["1m", "1 month"],
                  ["1q", "1 quarter"],
                  ["1y", "1 year"],
                  ["all", "Lifetime"],
                ] as const
              ).map(([range, label]) => (
                <button
                  key={range}
                  onClick={() => setTimeRange(range)}
                  className={`px-2.5 py-1 rounded-full transition-all whitespace-nowrap shrink-0 ${timeRange === range ? "bg-white text-black shadow-sm" : "text-white/70 hover:text-white"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Row 2: Stat Cards ── */}
      <div className="hidden md:grid grid-cols-7 gap-4">
        {(
          [
            // Growth % is masked alongside the absolute figure — a
            // percentage would otherwise leak the same growth
            // signal. At Lifetime the cards use the legacy
            // MoM/YoY labels; with a range, every trend is a
            // "vs prior <window>" delta so the labels switch in
            // lockstep with the pill.
            {
              title: "ANNUAL REVENUE",
              value: fmtMoney(adminStats.arr),
              trend: canSeeFinancials ? `${trends.arrYoY >= 0 ? "+" : ""}${trends.arrYoY}%` : "",
              sub: canSeeFinancials ? (isLifetime ? "vs last year" : vsPriorLabel) : "",
            },
            {
              title: "MONTHLY REVENUE",
              value: fmtMoney(adminStats.mrr),
              trend: canSeeFinancials ? `${trends.mrrMoM >= 0 ? "+" : ""}${trends.mrrMoM}%` : "",
              sub: canSeeFinancials ? (isLifetime ? "vs last month" : vsPriorLabel) : "",
            },
            {
              title: "SUBSCRIPTIONS",
              value: adminStats.activeSubscriptions.toLocaleString(),
              trend: isLifetime
                ? `+${trends.subscriptionsThisMonth}`
                : `${trends.subscriptionsThisMonth >= 0 ? "+" : ""}${trends.subscriptionsThisMonth}%`,
              sub: isLifetime ? "this month" : vsPriorLabel,
            },
            {
              title: "PROPERTIES",
              value: adminStats.totalProperties.toLocaleString(),
              trend: isLifetime
                ? `+${trends.propertiesThisMonth}`
                : `${trends.propertiesThisMonth >= 0 ? "+" : ""}${trends.propertiesThisMonth}%`,
              sub: isLifetime ? "this month" : vsPriorLabel,
            },
            {
              title: "USERS",
              value: adminStats.totalUsers.toLocaleString(),
              trend: isLifetime
                ? `+${trends.usersThisMonth}`
                : `${trends.usersThisMonth >= 0 ? "+" : ""}${trends.usersThisMonth}%`,
              sub: isLifetime ? "this month" : vsPriorLabel,
            },
            {
              title: "AGREEMENTS",
              value: adminStats.totalAgreements.toLocaleString(),
              trend: isLifetime
                ? `+${trends.agreementsThisMonth}`
                : `${trends.agreementsThisMonth >= 0 ? "+" : ""}${trends.agreementsThisMonth}%`,
              sub: isLifetime ? "this month" : vsPriorLabel,
            },
          ] as Array<{ title: string; value: string; trend: string; sub: string }>
        ).map((s, i) => (
          <div
            key={i}
            className="bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl p-5 rounded-2xl border border-border/60 shadow-sm hover:shadow-md transition-all"
          >
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
              {s.title}
            </span>
            <div className="flex items-end justify-between mt-2">
              <h3 className="text-2xl font-bold text-foreground tracking-tight">{s.value}</h3>
            </div>
            {s.trend && (
              <div className="flex items-center gap-1.5 mt-2">
                <ArrowUpRight size={12} style={{ color: accent }} />
                <span className="text-xs font-semibold" style={{ color: accent }}>
                  {s.trend}
                </span>
                <span className="text-[10px] text-muted-foreground ml-1">{s.sub}</span>
              </div>
            )}
          </div>
        ))}

        {/* Marketplace Leads — clickable, jumps to /admin/investment-leads */}
        <button
          type="button"
          onClick={() => setLocation("/admin/investment-leads")}
          className="text-left bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl p-5 rounded-2xl border border-border/60 shadow-sm hover:shadow-md hover:border-primary/40 transition-all group"
        >
          <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
            MARKETPLACE LEADS
          </span>
          <div className="flex items-end justify-between mt-2">
            <h3 className="text-2xl font-bold text-foreground tracking-tight">
              {newLeadsCount.toLocaleString()}
            </h3>
            <UserPlus
              size={16}
              className="text-muted-foreground/60 group-hover:text-primary transition-colors"
            />
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            <span className="text-xs font-semibold text-primary">View leads</span>
            <ArrowUpRight size={12} className="text-primary" />
            <span className="text-[10px] text-muted-foreground ml-1">new requests</span>
          </div>
        </button>
      </div>

      {/* ── Mobile Stats ── */}
      <div className="md:hidden grid grid-cols-2 gap-3">
        {(
          [
            {
              label: "ARR",
              value: fmtMoney(adminStats.arr),
              trend: canSeeFinancials ? `${trends.arrYoY >= 0 ? "+" : ""}${trends.arrYoY}%` : "",
            },
            {
              label: "MRR",
              value: fmtMoney(adminStats.mrr),
              trend: canSeeFinancials ? `${trends.mrrMoM >= 0 ? "+" : ""}${trends.mrrMoM}%` : "",
            },
            {
              label: "Subscriptions",
              value: adminStats.activeSubscriptions,
              trend: isLifetime
                ? `+${trends.subscriptionsThisMonth}`
                : `${trends.subscriptionsThisMonth >= 0 ? "+" : ""}${trends.subscriptionsThisMonth}%`,
            },
            {
              label: "Properties",
              value: adminStats.totalProperties.toLocaleString(),
              trend: isLifetime
                ? `+${trends.propertiesThisMonth}`
                : `${trends.propertiesThisMonth >= 0 ? "+" : ""}${trends.propertiesThisMonth}%`,
            },
            {
              label: "Users",
              value: adminStats.totalUsers.toLocaleString(),
              trend: isLifetime
                ? `+${trends.usersThisMonth}`
                : `${trends.usersThisMonth >= 0 ? "+" : ""}${trends.usersThisMonth}%`,
            },
            {
              label: "Agreements",
              value: adminStats.totalAgreements.toLocaleString(),
              trend: isLifetime
                ? `+${trends.agreementsThisMonth}`
                : `${trends.agreementsThisMonth >= 0 ? "+" : ""}${trends.agreementsThisMonth}%`,
            },
          ] as Array<{ label: string; value: string | number; trend: string }>
        ).map((s, i) => (
          <div
            key={i}
            className="bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl rounded-2xl border border-border/60 shadow-sm p-4"
          >
            <span className="text-xs text-muted-foreground font-medium">{s.label}</span>
            <h3 className="text-xl font-bold text-foreground mt-1">{s.value}</h3>
            <span className="text-xs font-medium" style={{ color: accent }}>
              {s.trend}
            </span>
          </div>
        ))}

        <button
          type="button"
          onClick={() => setLocation("/admin/investment-leads")}
          className="col-span-2 text-left bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl rounded-2xl border border-border/60 shadow-sm p-4 flex items-center justify-between hover:border-primary/40 transition"
        >
          <div>
            <span className="text-xs text-muted-foreground font-medium flex items-center gap-1.5">
              <UserPlus size={12} className="text-primary" />
              Marketplace Leads
            </span>
            <h3 className="text-xl font-bold text-foreground mt-1">
              {newLeadsCount.toLocaleString()}
            </h3>
            <span className="text-xs font-medium text-primary">new requests</span>
          </div>
          <ArrowUpRight size={20} className="text-primary" />
        </button>
      </div>

      {/* ── Row 3: Map + Top Properties + Avg Rental ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-2 bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl rounded-2xl border border-border/60 shadow-sm flex flex-col h-[350px] overflow-hidden">
          <div className="flex-1 relative z-0">
            <div className="absolute top-3 right-3 z-[400] bg-card/95 backdrop-blur-md px-3 py-2 rounded-xl shadow-lg border border-border/50 flex items-center gap-2">
              <span className="text-lg font-bold text-foreground">
                {adminStats.totalProperties.toLocaleString()}
              </span>
              <span className="text-[10px] text-muted-foreground">units</span>
            </div>
            <div className={`w-full h-full ${isDark ? "map-dark-mode" : ""}`}>
              <MapContainer
                center={[35.0, 33.2]}
                zoom={8}
                className="w-full h-full"
                zoomControl={false}
                attributionControl={false}
              >
                <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />
                <MarkerClusterGroup
                  chunkedLoading
                  maxClusterRadius={50}
                  spiderfyOnMaxZoom
                  showCoverageOnHover={false}
                  iconCreateFunction={(cluster: any) => {
                    const count = cluster.getChildCount();
                    let dim = 36,
                      fontSize = 12;
                    if (count > 100) {
                      dim = 52;
                      fontSize = 14;
                    } else if (count > 30) {
                      dim = 44;
                      fontSize = 13;
                    }
                    return L.divIcon({
                      html: `<div style="background: ${accent}; color: white; width: ${dim}px; height: ${dim}px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: ${fontSize}px; box-shadow: 0 2px 8px ${accent}73, 0 0 0 4px ${accent}33; border: 2px solid white;">${count}</div>`,
                      className: "custom-cluster-icon",
                      iconSize: L.point(dim, dim),
                      iconAnchor: L.point(dim / 2, dim / 2),
                    });
                  }}
                >
                  {mapProperties.map((property) =>
                    property.lat && property.lng ? (
                      <Marker
                        key={property.id}
                        position={[property.lat, property.lng]}
                        icon={createCustomIcon(accent)}
                      >
                        <Popup className="font-sans min-w-[200px] !p-0 overflow-hidden rounded-lg border-0 shadow-lg">
                          {/* Photo header — clicking it opens this property's
                              page (the admin units list, deep-linked to the
                              row's edit drawer). Falls back to an "N/A" tile
                              when there's no real photo. */}
                          <button
                            type="button"
                            onClick={() => setLocation(`/admin/units?property=${property.id}`)}
                            title="Open property page"
                            className="group block h-24 w-full relative cursor-pointer"
                          >
                            {property.image && property.image.startsWith("http") ? (
                              <img
                                src={property.image}
                                alt={property.address}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full bg-secondary flex flex-col items-center justify-center gap-1 text-muted-foreground">
                                <Building size={20} className="opacity-40" />
                                <span className="text-[10px] font-semibold tracking-wide">N/A</span>
                              </div>
                            )}
                            {/* Hover affordance so the tile reads as clickable. */}
                            <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/20">
                              <span className="flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 text-[10px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
                                <ArrowUpRight size={12} /> View property
                              </span>
                            </span>
                          </button>
                          {/* Just Value + Rent — "N/A" when unset, "—" when
                              masked from non-finance admins (moneyOrNA). */}
                          <div className="p-3">
                            <div className="flex justify-between items-center gap-3 text-xs">
                              <span className="text-muted-foreground">Value</span>
                              <span className="font-bold text-foreground">
                                {moneyOrNA(property.value)}
                              </span>
                            </div>
                            <div className="mt-1 flex justify-between items-center gap-3 text-xs">
                              <span className="text-muted-foreground">Rent</span>
                              <span className="font-bold text-blue-600 dark:text-blue-400">
                                {moneyOrNA(property.rentAmount)}
                              </span>
                            </div>
                          </div>
                        </Popup>
                      </Marker>
                    ) : null,
                  )}
                </MarkerClusterGroup>
              </MapContainer>
            </div>
          </div>
        </div>

        {/* Top Properties by Location */}
        <div className="bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl p-5 rounded-2xl border border-border/60 shadow-sm flex flex-col h-[350px]">
          <div className="flex justify-between items-center mb-3">
            <div>
              <h3 className="font-semibold text-foreground text-sm">Top Properties</h3>
              <p className="text-xs text-muted-foreground mt-0.5">By location</p>
            </div>
            <div className="bg-secondary p-0.5 rounded-lg flex text-[11px] font-medium">
              <button
                onClick={() => setPropertiesLocationView("cities")}
                className={`px-2.5 py-1 rounded-md transition-colors ${propertiesLocationView === "cities" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"}`}
              >
                Cities
              </button>
              <button
                onClick={() => setPropertiesLocationView("countries")}
                className={`px-2.5 py-1 rounded-md transition-colors ${propertiesLocationView === "countries" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"}`}
              >
                Countries
              </button>
            </div>
          </div>
          <div className="space-y-0 overflow-y-auto flex-1">
            {(propertiesLocationView === "cities" ? propertiesByCities : propertiesByCountries).map(
              (item, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between py-2.5 border-b border-border/30 last:border-0"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground/60 w-4 font-medium">
                      {i + 1}
                    </span>
                    <span className="text-sm font-medium text-foreground">{item.name}</span>
                  </div>
                  <span className="text-sm font-bold" style={{ color: accent }}>
                    {item.count.toLocaleString()}
                  </span>
                </div>
              ),
            )}
          </div>
        </div>

        {/* Avg. Rental Price */}
        <div className="bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl p-5 rounded-2xl border border-border/60 shadow-sm flex flex-col h-[350px]">
          <div className="flex justify-between items-center mb-3">
            <div>
              <h3 className="font-semibold text-foreground text-sm">Avg. Rental Price</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Based on active leases</p>
            </div>
            <div className="bg-secondary p-0.5 rounded-lg flex text-[11px] font-medium">
              <button
                onClick={() => setRentalView("cities")}
                className={`px-2.5 py-1 rounded-md transition-colors ${rentalView === "cities" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"}`}
              >
                Cities
              </button>
              <button
                onClick={() => setRentalView("countries")}
                className={`px-2.5 py-1 rounded-md transition-colors ${rentalView === "countries" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"}`}
              >
                Countries
              </button>
            </div>
          </div>
          <div className="space-y-0 overflow-y-auto flex-1">
            {(rentalView === "cities" ? cityRentals : countryRentals).map((item, i) => (
              <div
                key={i}
                className="flex items-center justify-between py-2.5 border-b border-border/30 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground/60 w-4 font-medium">{i + 1}</span>
                  <span className="text-sm font-medium text-foreground">{item.name}</span>
                </div>
                <span className="text-sm font-bold" style={{ color: accent }}>
                  {fmtMoney(item.price)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Row 4: Users + Top Users + Avg Rental ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* User Breakdown */}
        <div className="bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl p-5 rounded-2xl border border-border/60 shadow-sm flex flex-col">
          <h3 className="font-semibold text-foreground text-sm mb-4">Users</h3>
          <div className="flex items-baseline gap-1.5 mb-5">
            <span className="text-3xl font-bold text-foreground tracking-tight">
              {totalUsers.toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground">total</span>
          </div>
          <div className="flex items-center gap-4 mb-4">
            <div className="relative w-28 h-28 shrink-0">
              <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                <circle cx="18" cy="18" r="14" fill="none" stroke="var(--border)" strokeWidth="4" />
                <circle
                  cx="18"
                  cy="18"
                  r="14"
                  fill="none"
                  stroke="var(--foreground)"
                  strokeWidth="4"
                  strokeDasharray={`${ownerPct * 0.88} ${88 - ownerPct * 0.88}`}
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xs font-bold text-foreground">{ownerPct}%</span>
              </div>
            </div>
            <div className="space-y-2.5 flex-1">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-foreground" />
                  <span className="font-medium">Owners</span>
                </div>
                <span className="text-muted-foreground font-medium">{adminStats.totalOwners}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/40" />
                  <span className="font-medium">Tenants</span>
                </div>
                <span className="text-muted-foreground font-medium">{adminStats.totalTenants}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Top Users by Location */}
        <div className="bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl p-5 rounded-2xl border border-border/60 shadow-sm">
          <div className="flex justify-between items-center mb-3">
            <div>
              <h3 className="font-semibold text-foreground text-sm">Top Users</h3>
              <p className="text-xs text-muted-foreground mt-0.5">By location</p>
            </div>
            <div className="bg-secondary p-0.5 rounded-lg flex text-[11px] font-medium">
              <button
                onClick={() => setUsersLocationView("cities")}
                className={`px-2.5 py-1 rounded-md transition-colors ${usersLocationView === "cities" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"}`}
              >
                Cities
              </button>
              <button
                onClick={() => setUsersLocationView("countries")}
                className={`px-2.5 py-1 rounded-md transition-colors ${usersLocationView === "countries" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"}`}
              >
                Countries
              </button>
            </div>
          </div>
          <div className="space-y-0">
            {(usersLocationView === "cities" ? usersByCities : usersByCountries).map((item, i) => (
              <div
                key={i}
                className="flex items-center justify-between py-2.5 border-b border-border/30 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground/60 w-4 font-medium">{i + 1}</span>
                  <span className="text-sm font-medium text-foreground">{item.name}</span>
                </div>
                <span className="text-sm font-bold" style={{ color: accent }}>
                  {item.count.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Property Breakdown */}
        <div className="bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl p-5 rounded-2xl border border-border/60 shadow-sm flex flex-col">
          <h3 className="font-semibold text-foreground text-sm mb-4">Properties</h3>
          <div className="flex items-baseline gap-1.5 mb-5">
            <span className="text-3xl font-bold text-foreground tracking-tight">
              {totalProps.toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground">total</span>
          </div>
          <div className="flex items-center gap-4 mb-4">
            <div className="relative w-28 h-28 shrink-0">
              <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                <circle cx="18" cy="18" r="14" fill="none" stroke="var(--border)" strokeWidth="4" />
                <circle
                  cx="18"
                  cy="18"
                  r="14"
                  fill="none"
                  stroke="var(--foreground)"
                  strokeWidth="4"
                  strokeDasharray={`${rentedPct * 0.88} ${88 - rentedPct * 0.88}`}
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xs font-bold text-foreground">{rentedPct}%</span>
              </div>
            </div>
            <div className="space-y-2.5 flex-1">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-foreground" />
                  <span className="font-medium">Rented</span>
                </div>
                <span className="text-muted-foreground font-medium">
                  {adminStats.propertiesRented.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/40" />
                  <span className="font-medium">Available</span>
                </div>
                <span className="text-muted-foreground font-medium">
                  {adminStats.propertiesAvailable.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
          <div className="mt-auto pt-3 border-t border-border/50">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: accent }} />
              <span className="text-[11px] text-muted-foreground">
                <strong className="text-foreground">{rentedPct}%</strong> occupancy rate
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Row 5: Trends ── */}
      <div
        className={`grid grid-cols-1 ${canSeeFinancials ? "lg:grid-cols-3" : "lg:grid-cols-2"} gap-4`}
      >
        {/* Platform revenue + volume, last 6 months — financial detail,
              gated to admins with finance.viewAll. */}
        {canSeeFinancials && (
          <div className="bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl p-5 rounded-2xl border border-border/60 shadow-sm flex flex-col">
            <div className="flex justify-between items-start mb-3">
              <div>
                <h3 className="font-semibold text-foreground text-sm">Platform revenue</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {chartWindowLabel} · commission + volume
                </p>
              </div>
              <BarChart3 size={16} className="text-muted-foreground/60" />
            </div>
            <div
              className="flex-1 h-[200px]"
              role="img"
              aria-label={`Area chart: platform revenue (commission and volume) over ${chartWindowLabel}`}
            >
              {revenueData.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                  No data yet
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={revenueData} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={accent} stopOpacity={0.4} />
                        <stop offset="100%" stopColor={accent} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="month"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    />
                    <RechartsTooltip
                      cursor={{ stroke: "var(--border)" }}
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid var(--border)",
                        background: "var(--card)",
                        color: "var(--foreground)",
                      }}
                      formatter={(v, name) => [
                        formatCurrencyCompact(Number(v)),
                        name === "revenue" ? "Commission" : "Volume",
                      ]}
                    />
                    <Area
                      type="monotone"
                      dataKey="volume"
                      stroke="var(--muted-foreground)"
                      strokeOpacity={0.4}
                      fill="var(--muted-foreground)"
                      fillOpacity={0.05}
                    />
                    <Area type="monotone" dataKey="revenue" stroke={accent} fill="url(#revFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        )}

        {/* Weekly activity */}
        <div className="bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl p-5 rounded-2xl border border-border/60 shadow-sm flex flex-col">
          <div className="flex justify-between items-start mb-3">
            <div>
              <h3 className="font-semibold text-foreground text-sm">Activity</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {chartWindowLabel} · new tx + properties + agreements
              </p>
            </div>
            <Activity size={16} className="text-muted-foreground/60" />
          </div>
          <div
            className="flex-1 h-[200px]"
            role="img"
            aria-label={`Bar chart: weekly platform activity (new transactions, properties, and agreements) over ${chartWindowLabel}`}
          >
            {weeklyActivity.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                No data yet
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={weeklyActivity} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="day"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    allowDecimals={false}
                  />
                  <RechartsTooltip
                    cursor={{ fill: "var(--secondary)" }}
                    contentStyle={{
                      borderRadius: 12,
                      border: "1px solid var(--border)",
                      background: "var(--card)",
                      color: "var(--foreground)",
                    }}
                  />
                  <Bar dataKey="value" fill={accent} radius={[4, 4, 0, 0]} maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Unit growth */}
        <div className="bg-card dark:bg-white/[0.06] dark:backdrop-blur-xl p-5 rounded-2xl border border-border/60 shadow-sm flex flex-col">
          <div className="flex justify-between items-start mb-3">
            <div>
              <h3 className="font-semibold text-foreground text-sm">Unit growth</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Cumulative · {chartWindowLabel.toLowerCase()}
              </p>
            </div>
            <TrendingUp size={16} className="text-muted-foreground/60" />
          </div>
          <div
            className="flex-1 h-[200px]"
            role="img"
            aria-label={`Area chart: cumulative unit growth over ${chartWindowLabel.toLowerCase()}`}
          >
            {unitGrowthData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                No data yet
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={unitGrowthData}
                  margin={{ top: 5, right: 0, left: -20, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="unitFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={accent} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={accent} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="month"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    allowDecimals={false}
                  />
                  <RechartsTooltip
                    cursor={{ stroke: "var(--border)" }}
                    contentStyle={{
                      borderRadius: 12,
                      border: "1px solid var(--border)",
                      background: "var(--card)",
                      color: "var(--foreground)",
                    }}
                    formatter={(v) => [Number(v).toLocaleString(), "Units"]}
                  />
                  <Area type="monotone" dataKey="units" stroke={accent} fill="url(#unitFill)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
