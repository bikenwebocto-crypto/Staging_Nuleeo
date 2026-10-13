import { useState, useRef, useEffect, useMemo } from "react";

import { ProfileDrawer } from "@ui/components/common/ProfileDrawer";
import { ReportProblemDrawer } from "@/components/tenant/ReportProblemDrawer";
import { MakePaymentDrawer } from "@/components/tenant/MakePaymentDrawer";
import {
  useTenantUnits,
  useTenantActivity,
  useTenantOutstanding,
  tenantActivityDisplayType,
  monthsPerPeriod,
  type TenantRentedUnit,
  type TenantActivity,
} from "@/lib/tenantQueries";
import { apiRequest } from "@ui/lib/queryClient";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { formatCurrency, formatDateNumeric, formatDateTime } from "@ui/lib/format";
import useEmblaCarousel from "embla-carousel-react";
import { History, Home, Search, Mail, Sparkles } from "lucide-react";
import { pickFallbackImage } from "@/lib/fallbackImage";
import { activityVisual, isRepairReport } from "@/lib/activityVisual";
import { RepairStatusBadge } from "@/components/common/RepairStatusBadge";

function formatDueDate(iso: string | null): string {
  if (!iso) return "No date scheduled";
  const formatted = formatDateNumeric(iso);
  return formatted === "—" ? "No date scheduled" : formatted;
}

// The amount actually owed on the next due date — a WHOLE billing period. A
// quarterly lease owes 3× the monthly rent, a yearly lease 12× — matching what
// the payment drawer and the card-checkout endpoint charge. Showing the bare
// monthly figure here understated the headline for non-monthly leases.
function rentDueAmount(unit: TenantRentedUnit): number {
  return unit.rentAmount * monthsPerPeriod(unit.paymentFrequency);
}

function rentPeriodSuffix(unit: TenantRentedUnit): string {
  return unit.paymentFrequency === "yearly"
    ? " / year"
    : unit.paymentFrequency === "quarterly"
      ? " / quarter"
      : "";
}

// Status pill rendered over the (dark) property image. Gives the tenant a
// durable on-screen paid / due / overdue signal — previously the only cue was a
// plan-gated, mutable push, and paymentStatus was fetched but never shown.
function RentStatusPill({ status }: { status: TenantRentedUnit["paymentStatus"] }) {
  const map = {
    paid: { label: "Paid", cls: "bg-emerald-500/90 text-white" },
    overdue: { label: "Overdue", cls: "bg-red-500/90 text-white" },
    pending: { label: "Due", cls: "bg-white/20 text-white backdrop-blur-sm" },
  } as const;
  const { label, cls } = map[status] ?? map.pending;
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${cls}`}
    >
      {label}
    </span>
  );
}

function formatActivityDate(iso: string): string {
  return formatDateTime(iso);
}

export default function TenantDashboard() {
  const [emblaRef] = useEmblaCarousel({ loop: false, align: "start" });
  const [desktopEmblaRef, desktopEmblaApi] = useEmblaCarousel({ loop: true, align: "start" });
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [, setScrolled] = useState(false);
  const [paymentTarget, setPaymentTarget] = useState<TenantRentedUnit | null>(null);
  const [reportTarget, setReportTarget] = useState<TenantRentedUnit | null>(null);
  const [finalizeBanner, setFinalizeBanner] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const { data: rentedUnits = [], isLoading: unitsLoading } = useTenantUnits();
  const { data: activity = [] } = useTenantActivity();
  const { data: outstanding = [] } = useTenantOutstanding();

  // After redirect from Stripe Checkout, finalize the payment server-side and
  // strip the query params so a refresh doesn't re-fire the call.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("payment") !== "success") return;
    const sessionId = params.get("session_id");
    if (!sessionId) return;
    // unit identifies the owner's connected account so the server can retrieve
    // the direct-charge session in that account's context (it lives there, not
    // on the platform). Set alongside session_id in the Checkout success_url.
    const unitId = params.get("unit");
    let cancelled = false;
    (async () => {
      try {
        await apiRequest("POST", "/api/tenant/payment/finalize", { sessionId, unitId });
        if (cancelled) return;
        setFinalizeBanner({ kind: "success", message: "Payment confirmed — thank you!" });
        queryClient.invalidateQueries({ queryKey: ["/api/tenant/activity"] });
      } catch (e) {
        if (cancelled) return;
        setFinalizeBanner({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not finalize payment",
        });
      }
    })();
    const url = new URL(window.location.href);
    url.searchParams.delete("payment");
    url.searchParams.delete("session_id");
    url.searchParams.delete("unit");
    window.history.replaceState({}, "", url.toString());
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  const unitsWithImages = useMemo<(TenantRentedUnit & { image: string })[]>(
    () => rentedUnits.map((u) => ({ ...u, image: u.image ?? pickFallbackImage(u.unitId) })),
    [rentedUnits],
  );

  const activitiesByTenantId = useMemo(() => {
    const map = new Map<string, TenantActivity[]>();
    activity.forEach((a) => {
      if (!a.tenantId) return;
      const arr = map.get(a.tenantId) ?? [];
      arr.push(a);
      map.set(a.tenantId, arr);
    });
    return map;
  }, [activity]);

  // Desktop carousel auto-scroll + index tracking
  const [desktopSlide, setDesktopSlide] = useState(0);
  useEffect(() => {
    if (!desktopEmblaApi) return;
    const onSelect = () => setDesktopSlide(desktopEmblaApi.selectedScrollSnap());
    desktopEmblaApi.on("select", onSelect);
    const interval = setInterval(() => {
      desktopEmblaApi.scrollNext();
    }, 4000);
    return () => {
      clearInterval(interval);
      desktopEmblaApi.off("select", onSelect);
    };
  }, [desktopEmblaApi]);

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

  const showEmpty = !unitsLoading && unitsWithImages.length === 0;

  return (
    <>
      <ProfileDrawer
        open={isProfileOpen}
        onOpenChange={setIsProfileOpen}
        role="tenant"
        privacyTermsHref="/tenant/privacy"
        settingsHref="/tenant/settings"
      />
      <MakePaymentDrawer
        open={!!paymentTarget}
        onOpenChange={(o) => !o && setPaymentTarget(null)}
        unit={paymentTarget}
      />
      {reportTarget && (
        <ReportProblemDrawer
          open={!!reportTarget}
          onOpenChange={(o) => !o && setReportTarget(null)}
          unitId={reportTarget.unitId}
          propertyId={reportTarget.propertyId}
          unitLabel={reportTarget.name}
        />
      )}

      {/* Both alerts share ONE fixed, vertically-stacked container so a payment
          confirmation and an outstanding-balance notice never overlap at the
          same coordinates. Colours keep their dark: variants (these float over
          the dark photo hero, where the bright dark-mode status tokens would
          lose contrast). */}
      {(finalizeBanner || outstanding.length > 0) && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] max-w-md w-[calc(100%-2rem)] space-y-2">
          {finalizeBanner && (
            <div
              role="status"
              className={`flex items-start gap-3 p-3.5 rounded-2xl shadow-lg border backdrop-blur ${
                finalizeBanner.kind === "success"
                  ? "bg-green-500/15 border-green-500/30 text-green-600 dark:text-green-300"
                  : "bg-red-500/15 border-red-500/30 text-red-600 dark:text-red-300"
              }`}
            >
              <div className="flex-1 text-sm font-medium">{finalizeBanner.message}</div>
              <button
                onClick={() => setFinalizeBanner(null)}
                aria-label="Dismiss notification"
                className="opacity-60 hover:opacity-100 text-xs font-bold"
              >
                ✕
              </button>
            </div>
          )}
          {outstanding.map((o) => (
            <div
              key={o.tenantId}
              role="status"
              className="flex items-start gap-3 p-3.5 rounded-2xl shadow-lg border backdrop-blur bg-amber-500/15 border-amber-500/30 text-amber-700 dark:text-amber-300"
            >
              <div className="flex-1 text-sm font-medium">
                Final rent balance of {formatCurrency(o.amount)} on {o.propertyName} is still due.
                Please arrange payment with your landlord.
              </div>
            </div>
          ))}
        </div>
      )}

      <div
        ref={scrollRef}
        className="flex-1 relative overflow-y-auto overflow-x-hidden h-full md:bg-background"
      >
        {/* Mobile backdrop — accent gradient in shades of the selected
            appearance color (--brand-accent, set by accentStore), replacing the
            faded property photo. Fades into the page background lower down so
            the scrolling content below reads normally. */}
        <div className="fixed top-0 left-0 right-0 h-full md:hidden z-0 overflow-hidden pointer-events-none bg-white dark:bg-black">
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to bottom, color-mix(in srgb, var(--brand-accent) 60%, #06070c) 0%, color-mix(in srgb, var(--brand-accent) 34%, #06070c) 32%, transparent 72%)",
            }}
          />
        </div>

        {/* Loading skeleton — units are in flight. Mirrors the hero + activity
            layout so the screen never flashes blank (or the "Welcome" empty
            state) before the tenant's unit resolves. */}
        {unitsLoading && (
          <>
            {/* Desktop */}
            <div className="hidden md:grid md:grid-cols-2 gap-6 relative z-10 px-8 pb-10 pt-4">
              <div className="rounded-[2rem] w-full min-h-[420px] bg-muted animate-pulse" />
              <div className="bg-card/60 dark:bg-white/[0.06] backdrop-blur-xl border border-border/50 dark:border-white/[0.08] rounded-2xl p-5">
                <div className="h-4 w-28 bg-muted rounded animate-pulse mb-5" />
                <div className="space-y-4">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-muted animate-pulse shrink-0" />
                      <div className="flex-1 space-y-1.5">
                        <div className="h-3 w-1/2 bg-muted rounded animate-pulse" />
                        <div className="h-2.5 w-1/3 bg-muted rounded animate-pulse" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {/* Mobile */}
            <div className="md:hidden relative z-10 px-5 mt-[var(--mobile-header-clearance)]">
              <div className="rounded-[2.5rem] w-full min-h-[360px] bg-muted animate-pulse" />
              <div className="mt-6 space-y-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-muted animate-pulse shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 w-1/2 bg-muted rounded animate-pulse" />
                      <div className="h-2.5 w-1/3 bg-muted rounded animate-pulse" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Desktop: Empty state when no units */}
        {showEmpty && (
          <div className="hidden md:grid md:grid-cols-2 gap-6 relative z-10 px-8 pb-10 pt-4">
            <div className="rounded-[2rem] w-full relative overflow-hidden shadow-[0_16px_64px_rgba(0,0,0,0.3)] min-h-[420px] bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-900 border border-white/10">
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.06),transparent_60%)]" />
              <div className="relative z-10 p-8 flex flex-col h-full items-center justify-center text-center">
                <div className="relative mb-6">
                  <div className="absolute inset-0 bg-white/10 blur-2xl rounded-full" />
                  <div className="relative w-20 h-20 rounded-2xl bg-gradient-to-br from-white/20 to-white/5 border border-white/20 flex items-center justify-center">
                    <Home size={32} className="text-white" />
                  </div>
                  <Sparkles size={16} className="absolute -top-1 -right-1 text-amber-300" />
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">Welcome to Olio Wallet</h2>
                <p className="text-white/60 text-sm max-w-sm mb-7 leading-relaxed">
                  You're not renting any units yet. As soon as your landlord adds you to a property,
                  you'll see your rent, payment history, and maintenance updates right here.
                </p>
                <div className="w-full max-w-xs space-y-3">
                  <button
                    onClick={() => setLocation("/tenant/agreements")}
                    className="w-full bg-white text-neutral-900 font-bold py-3.5 rounded-2xl hover:bg-white/90 shadow-md transition active:scale-[0.98] text-[15px] flex items-center justify-center gap-2"
                  >
                    <Mail size={16} />
                    Got an invite?
                  </button>
                </div>
              </div>
            </div>
            <div className="bg-card/60 dark:bg-white/[0.06] backdrop-blur-xl border border-border/50 dark:border-white/[0.08] rounded-2xl p-5 max-h-[520px] overflow-y-auto">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-foreground text-sm tracking-tight">
                  Recent Activity
                </h3>
              </div>
              <div className="flex flex-col items-center justify-center py-16 text-center px-4">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-muted to-muted/50 border border-border/40 flex items-center justify-center mb-4">
                  <History size={22} className="text-muted-foreground" />
                </div>
                <p className="text-foreground text-sm font-semibold">Your activity feed</p>
                <p className="text-muted-foreground text-xs mt-1.5 max-w-[240px] leading-relaxed">
                  Rent payments, maintenance reports and lease updates will appear here once you
                  join a property.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Desktop: Carousel + Merged Activity side by side */}
        {unitsWithImages.length > 0 && (
          <div className="hidden md:grid md:grid-cols-2 gap-6 relative z-10 px-8 pb-10 pt-4">
            {/* Left: Auto-scrolling infinite carousel */}
            <div className="overflow-hidden rounded-[2rem]" ref={desktopEmblaRef}>
              <div className="flex">
                {unitsWithImages.map((unit) => (
                  <div key={unit.unitId} className="flex-[0_0_100%] min-w-0">
                    <div className="rounded-[2rem] w-full relative overflow-hidden min-h-[420px]">
                      <img
                        src={unit.image}
                        alt={unit.name}
                        className="absolute inset-0 w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-black/30" />
                      <div className="relative z-10 p-7 flex flex-col h-full">
                        <div className="mb-6">
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-white/60 text-sm font-medium tracking-wide uppercase">
                              Next Rent Due
                            </p>
                            <RentStatusPill status={unit.paymentStatus} />
                          </div>
                          <h1 className="text-[2.75rem] font-bold tracking-tight leading-none text-white">
                            {formatCurrency(rentDueAmount(unit))}
                            <span className="text-lg font-semibold text-white/70">
                              {rentPeriodSuffix(unit)}
                            </span>
                          </h1>
                          <p className="text-white/60 text-sm font-medium tracking-wide mt-1">
                            {formatDueDate(unit.nextPaymentDate)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-white/80 font-medium mt-8 mb-6">
                          <Home size={16} />
                          <span>{unit.name}</span>
                        </div>
                        <div className="mt-2 space-y-3">
                          <button
                            onClick={() => setPaymentTarget(unit)}
                            className="w-full bg-white text-neutral-900 font-bold py-3.5 rounded-2xl hover:bg-white/90 shadow-md transition active:scale-[0.98] text-[15px]"
                          >
                            Make a Payment
                          </button>
                          <button
                            onClick={() => setReportTarget(unit)}
                            className="w-full bg-white/10 backdrop-blur-xl text-white font-bold py-3.5 rounded-2xl border border-white/20 hover:bg-white/20 shadow-sm transition active:scale-[0.98] text-[15px]"
                          >
                            Report a Problem
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {/* Carousel dots */}
              {unitsWithImages.length > 1 && (
                <div className="flex justify-center gap-1.5 mt-4">
                  {unitsWithImages.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => desktopEmblaApi?.scrollTo(i)}
                      className={`w-2 h-2 rounded-full transition-all ${i === desktopSlide ? "bg-foreground w-5" : "bg-muted-foreground/30"}`}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Right: Merged Recent Activity */}
            <div className="bg-card/60 dark:bg-white/[0.06] backdrop-blur-xl border border-border/50 dark:border-white/[0.08] rounded-2xl p-5 max-h-[520px] overflow-y-auto">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-foreground text-sm tracking-tight">
                  Recent Activity
                </h3>
                <button
                  onClick={() => setLocation("/tenant/activity")}
                  className="text-xs text-muted-foreground hover:text-foreground transition font-medium"
                >
                  View all
                </button>
              </div>
              <div className="space-y-1 flex-1">
                {activity.length > 0 ? (
                  activity.map((tx) => {
                    const display = formatActivityDate(tx.timestamp);
                    // Tenant-relative: the ledger stores rent as the owner's
                    // income, but the tenant pays it — render via the shared
                    // mapper so this preview matches the full Activity page
                    // (rent = expense, maintenance = neutral, never income).
                    const dtype = tenantActivityDisplayType(tx);
                    const { Icon, className: iconClass } = activityVisual(dtype, {
                      solid: true,
                    });
                    return (
                      <div
                        key={tx.id}
                        className="flex items-center justify-between py-3 border-b border-border/20 last:border-0"
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-9 h-9 rounded-full flex items-center justify-center text-xs overflow-hidden border ${iconClass}`}
                          >
                            <Icon size={16} />
                          </div>
                          <div className="flex flex-col">
                            <span className="font-semibold text-xs text-foreground line-clamp-1">
                              {tx.name}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11px] text-muted-foreground">{display}</span>
                              {tx.unitName && (
                                <>
                                  <span className="text-muted-foreground/40">·</span>
                                  <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                                    {tx.unitName}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        {/* Amount omitted here — dashboard preview only; the full
                            Activity page shows amounts. Repair keeps its status. */}
                        <div className="flex flex-col items-end">
                          {isRepairReport(tx) ? <RepairStatusBadge status={tx.status} /> : null}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-center py-4 text-muted-foreground text-xs">
                    No recent activity.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Mobile: Empty state when no units */}
        {showEmpty && (
          <div className="md:hidden relative z-10 px-5 mt-[var(--mobile-header-clearance)]">
            <div className="w-full flex flex-col min-h-[calc(var(--app-vh)-5rem)]">
              <div className="rounded-[2.5rem] w-full relative overflow-hidden shadow-[0_16px_64px_rgba(0,0,0,0.3)] min-h-[360px] shrink-0 bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-900 border border-white/10">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.06),transparent_60%)]" />
                <div className="relative z-10 p-7 flex flex-col h-full items-center justify-center text-center">
                  <div className="relative mb-5">
                    <div className="absolute inset-0 bg-white/10 blur-2xl rounded-full" />
                    <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-white/20 to-white/5 border border-white/20 flex items-center justify-center">
                      <Home size={26} className="text-white" />
                    </div>
                    <Sparkles size={14} className="absolute -top-1 -right-1 text-amber-300" />
                  </div>
                  <h2 className="text-xl font-bold text-white mb-2">Welcome to Olio Wallet</h2>
                  <p className="text-white/60 text-sm max-w-xs mb-6 leading-relaxed">
                    You're not renting any units yet. When your landlord adds you to a property,
                    your rent and updates show up here.
                  </p>
                  <div className="w-full space-y-3">
                    <button
                      onClick={() => setLocation("/tenant/agreements")}
                      className="w-full bg-white text-neutral-900 font-bold py-3.5 rounded-2xl hover:bg-white/90 shadow-md transition active:scale-[0.98] text-[15px] flex items-center justify-center gap-2"
                    >
                      <Mail size={16} />
                      Got an invite?
                    </button>
                  </div>
                </div>
              </div>

              {/* Empty activity section */}
              <div className="bg-black/30 dark:bg-white/10 backdrop-blur-xl border border-white/20 rounded-t-3xl pt-4 px-5 mt-4 flex-1 pb-[var(--mobile-nav-clearance)]">
                <div className="flex justify-center mb-4">
                  <div className="w-10 h-1 bg-white/30 rounded-full" />
                </div>
                <div className="mb-6">
                  <h3 className="font-bold text-white text-[1.2rem] tracking-tight">
                    Latest Activity
                  </h3>
                </div>
                <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                  <div className="w-14 h-14 rounded-2xl bg-white/10 border border-white/15 flex items-center justify-center mb-4">
                    <History size={22} className="text-white/60" />
                  </div>
                  <p className="text-white text-sm font-semibold">Your activity feed</p>
                  <p className="text-white/50 text-xs mt-1.5 max-w-[240px] leading-relaxed">
                    Rent payments, maintenance reports and lease updates will appear here once you
                    join a property.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Mobile: Swipeable cards + activity */}
        {unitsWithImages.length > 0 && (
          <div
            className={`md:hidden relative z-10 mt-[var(--mobile-header-clearance)] ${unitsWithImages.length === 1 ? "px-5" : "pl-5"}`}
          >
            <div
              className="w-full max-w-2xl overflow-visible"
              ref={unitsWithImages.length > 1 ? emblaRef : undefined}
            >
              <div className={unitsWithImages.length > 1 ? "flex touch-pan-y" : "flex flex-col"}>
                {unitsWithImages.map((unit) => {
                  const unitActivities = activitiesByTenantId.get(unit.tenantId) ?? [];
                  return (
                    <div
                      key={unit.unitId}
                      className={`flex flex-col min-h-[calc(var(--app-vh)-5rem)] ${
                        unitsWithImages.length > 1
                          ? "flex-[0_0_90%] min-w-0 pr-4 last:pr-5"
                          : "w-full"
                      }`}
                    >
                      {/* Property Card */}
                      <div className="rounded-[2.5rem] w-full relative overflow-hidden shadow-[0_16px_64px_rgba(0,0,0,0.3)] min-h-[340px] shrink-0">
                        <img
                          src={unit.image}
                          alt={unit.name}
                          className="absolute inset-0 w-full h-full object-cover"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-black/30" />
                        <div className="relative z-10 p-7 flex flex-col h-full">
                          <div className="mb-6">
                            <div className="flex items-center justify-between mb-1">
                              <p className="text-white/60 text-sm font-medium tracking-wide uppercase">
                                Next Rent Due
                              </p>
                              <RentStatusPill status={unit.paymentStatus} />
                            </div>
                            <h1 className="text-[2.75rem] font-bold tracking-tight leading-none text-white">
                              {formatCurrency(rentDueAmount(unit))}
                              <span className="text-lg font-semibold text-white/70">
                                {rentPeriodSuffix(unit)}
                              </span>
                            </h1>
                            <p className="text-white/60 text-sm font-medium tracking-wide mt-1">
                              {formatDueDate(unit.nextPaymentDate)}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 text-sm text-white/80 font-medium mt-8 mb-6">
                            <Home size={16} />
                            <span>{unit.name}</span>
                          </div>
                          <div className="mt-2 space-y-3">
                            <button
                              onClick={() => setPaymentTarget(unit)}
                              className="w-full bg-white text-neutral-900 font-bold py-3.5 rounded-2xl hover:bg-white/90 shadow-md transition active:scale-[0.98] text-[15px]"
                            >
                              Make a Payment
                            </button>
                            <button
                              onClick={() => setReportTarget(unit)}
                              className="w-full bg-white/10 backdrop-blur-xl text-white font-bold py-3.5 rounded-2xl border border-white/20 hover:bg-white/20 shadow-sm transition active:scale-[0.98] text-[15px]"
                            >
                              Report a Problem
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Activity drawer for this unit */}
                      <div className="bg-black/30 dark:bg-white/10 backdrop-blur-xl border border-white/20 rounded-t-3xl pt-4 px-5 mt-4 flex-1 pb-[var(--mobile-nav-clearance)]">
                        <div className="flex justify-center mb-4">
                          <div className="w-10 h-1 bg-white/30 rounded-full" />
                        </div>
                        <div className="mb-6 flex items-center justify-between">
                          <h3 className="font-bold text-white text-[1.2rem] tracking-tight">
                            Latest Activity
                          </h3>
                          <button
                            onClick={() => setLocation("/tenant/activity")}
                            className="text-xs text-white/60 hover:text-white transition font-medium"
                          >
                            View all
                          </button>
                        </div>
                        <div className="space-y-3">
                          {unitActivities.length > 0 ? (
                            unitActivities.map((tx) => {
                              const display = formatActivityDate(tx.timestamp);
                              // Tenant-relative sign (see the shared mapper): rent is
                              // the owner's income but the tenant's expense.
                              const dtype = tenantActivityDisplayType(tx);
                              // solid: bold filled circle + white glyph, matching
                              // the owner dashboard and the Activity page (reads
                              // cleanly on the photo card too).
                              const { Icon, className: iconClass } = activityVisual(dtype, {
                                solid: true,
                              });
                              return (
                                <div
                                  key={tx.id}
                                  className="flex items-center justify-between p-4 rounded-2xl border border-white/10 bg-white/5"
                                >
                                  <div className="flex items-center gap-4">
                                    <div
                                      className={`w-10 h-10 rounded-full flex items-center justify-center text-lg border ${iconClass}`}
                                    >
                                      <Icon size={18} strokeWidth={1.75} />
                                    </div>
                                    <div className="flex flex-col">
                                      <span className="font-semibold text-sm text-white line-clamp-1">
                                        {tx.name}
                                      </span>
                                      <span className="text-xs text-white/50">{display}</span>
                                    </div>
                                  </div>
                                  {/* Amount omitted — dashboard preview only; full
                                      Activity page shows amounts. Repair keeps status. */}
                                  {isRepairReport(tx) ? (
                                    <RepairStatusBadge status={tx.status} onDark />
                                  ) : null}
                                </div>
                              );
                            })
                          ) : (
                            <div className="text-center py-8 text-white/50 text-sm">
                              No recent activity for this property.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
