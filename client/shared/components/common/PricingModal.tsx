import { ResponsiveDrawer } from "./ResponsiveDrawer";
import { Check, Star, X } from "lucide-react";
import { useState, useEffect } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { usePlan } from "@ui/lib/usePlan";
import { useProducts, createCheckoutSession, createPortalLink } from "@ui/lib/stripe";
import { usePlanLabels } from "@ui/lib/usePlanLabels";
import { usePlanSource } from "@ui/lib/usePlanSource";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { useBillingScope } from "@ui/lib/billingScope";
import { apiRequest } from "@ui/lib/queryClient";
import type { OwnerPlanKey, OwnerPlanPrivilegeKey } from "@shared/firestore-schema";

interface PricingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Four owner plans. 'basic'/'advance'/'pro' are Stripe-backed; 'business' is
// sales-led (mailto contact, no checkout).
type Slot = OwnerPlanKey;
const SLOTS: Slot[] = ["basic", "advance", "pro", "business"];

const SALES_EMAIL = "support@oliowallet.com";

// Tier ordering for upgrade/downgrade detection. No downgrades between paid
// tiers are offered; the only "down" move is cancelling a paid plan to Starter.
const RANK: Record<Slot, number> = { basic: 0, advance: 1, pro: 2, business: 3 };

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

// Headline feature bullets shown on every plan card. Each row maps to a
// privilege key — whether it renders as "included" or "not included" comes
// from the realtime privileges matrix (config/privileges), so admin toggles
// in /admin/settings propagate to every card without a redeploy.
const FEATURE_BULLETS: { key: OwnerPlanPrivilegeKey; on: string; off: string }[] = [
  { key: "analytics.basic", on: "Analytics", off: "No analytics" },
  { key: "documents.upload", on: "Documents included", off: "No documents" },
  { key: "contracts.create", on: "Agreements & contracts", off: "No contracts" },
  { key: "calculator.access", on: "Smart Calculator", off: "No calculator" },
  { key: "briefing.property", on: "Briefing PDFs", off: "No briefings" },
  { key: "analytics.history", on: "Property History", off: "No property history" },
];

function formatMoney(amount: number | null | undefined): string {
  if (amount == null) return "—";
  return `€${amount.toFixed(2)}`;
}

export function PricingModal({ open, onOpenChange }: PricingModalProps) {
  const { plan, refreshPlan } = usePlan();
  const { plans: pricedPlans } = useProducts();
  const { config: labelsConfig } = usePlanLabels();
  const { canOwnerPlan } = usePrivileges();
  // Where the current plan came from (paid sub vs gift) — decides whether an
  // upgrade swaps the existing subscription or starts a fresh checkout. Fetched
  // when the modal opens.
  const { info: planSource, refresh: refreshPlanSource } = usePlanSource(open);
  // Plans are portfolio-scoped: only the portfolio owner can change the plan.
  // For granted contacts viewing someone else's portfolio, the modal renders
  // in read-only mode with a notice naming the owner.
  const { canManageBilling, ownerName } = useBillingScope();

  const currentSlot: Slot = plan;

  const [pendingPlan, setPendingPlan] = useState<Exclude<Slot, "basic"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);
  // Set when a paid Growth owner is confirming the in-app Pro upgrade (which
  // charges immediately, so it gets an explicit confirm step — unlike Checkout,
  // which has its own confirmation page).
  const [confirmUpgrade, setConfirmUpgrade] = useState<Exclude<Slot, "basic"> | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Reset transient state whenever the modal closes so it reopens clean.
  useEffect(() => {
    if (!open) {
      setConfirmUpgrade(null);
      setSuccessMsg(null);
      setError(null);
      setPendingPlan(null);
    }
  }, [open]);
  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: false, align: "center", startIndex: 1 });
  const [selectedSlide, setSelectedSlide] = useState(1);

  useEffect(() => {
    if (!emblaApi) return;
    const onSelect = () => setSelectedSlide(emblaApi.selectedScrollSnap());
    emblaApi.on("select", onSelect);
    return () => {
      emblaApi.off("select", onSelect);
    };
  }, [emblaApi]);

  const openPortal = async () => {
    try {
      setOpeningPortal(true);
      const url = await createPortalLink();
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open billing portal");
      setOpeningPortal(false);
    }
  };

  const handlePlanSelect = async (slot: Slot) => {
    if (slot === currentSlot || pendingPlan || upgrading) return;
    if (!canManageBilling) return;
    setError(null);

    // Business is sales-led — no Stripe product, just open an email to sales.
    if (slot === "business") {
      window.location.assign(
        `mailto:${SALES_EMAIL}?subject=${encodeURIComponent("Olio Business plan enquiry")}`,
      );
      return;
    }

    // Need to know whether the current plan is a paid subscription or a gift —
    // an upgrade swaps the former and starts a fresh checkout for the latter.
    const src = planSource ?? (await refreshPlanSource());
    const source = src?.source ?? "none";

    // Starter (basic) = cancelling a paid plan. Allowed, effective at the next
    // renewal, via the Customer Portal (cancel_at_period_end). Gifted/free
    // owners have nothing to cancel — the card is disabled for them.
    if (slot === "basic") {
      if (source === "paid") await openPortal();
      return;
    }

    // No paid downgrades (e.g. Pro → Growth) — the card is disabled, but guard
    // here too.
    if (RANK[slot] < RANK[currentSlot]) return;

    // Paid Growth owner upgrading to Pro: swap their existing subscription
    // server-side (discounted first cycle + fresh 12-month term). Confirm first
    // because it charges immediately with no Stripe checkout page in between.
    if (source === "paid" && currentSlot === "advance" && slot === "pro") {
      setConfirmUpgrade("pro");
      return;
    }

    // Everyone else upgrading (gifted Growth → Pro, or Starter → a paid tier):
    // a brand-new subscription at full price via Stripe Checkout.
    const priced = pricedPlans.find((p) => p.plan === slot);
    if (!priced) {
      setError("Plan not available — please try again in a moment");
      return;
    }
    setPendingPlan(slot);
    try {
      const url = await createCheckoutSession(priced.priceId);
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start checkout");
      setPendingPlan(null);
    }
  };

  // Confirmed in-app paid Growth → Pro upgrade.
  const doConfirmUpgrade = async () => {
    setUpgrading(true);
    setError(null);
    try {
      const res = await apiRequest("POST", "/api/owner/plan/upgrade", { to: "pro" });
      const data = (await res.json()) as { renewsAt: string | null };
      await refreshPlan();
      await refreshPlanSource();
      setConfirmUpgrade(null);
      const proLabel = labelsConfig.plans.pro?.label ?? "Pro";
      const proYearly = labelsConfig.plans.pro?.yearlyAmount ?? null;
      setSuccessMsg(
        data.renewsAt && proYearly != null
          ? `You're on ${proLabel}! Renews ${formatDate(data.renewsAt)} at ${formatMoney(proYearly)}/year.`
          : `You're on ${proLabel}!`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upgrade failed — please try again");
    } finally {
      setUpgrading(false);
    }
  };

  // Resolve realtime display data for a slot. Price comes from the admin-
  // editable planLabels doc (yearlyAmount) — this is the canonical figure
  // owners see on the pricing modal and landing page. Stripe priceId is
  // still used to start checkout, but Stripe price strings are not shown.
  const dataFor = (slot: Slot) => {
    const meta = labelsConfig.plans[slot];
    const yearly = meta?.yearlyAmount ?? null;
    const monthly = yearly != null ? yearly / 12 : null;
    return {
      label: meta?.label ?? slot,
      description: meta?.description ?? "",
      unitCap: meta?.unitCap ?? null,
      yearly,
      monthly,
      ctaLabel: meta?.ctaLabel ?? `Get ${meta?.label ?? slot}`,
    };
  };

  const unitCapBullet = (cap: number | null): string =>
    cap == null ? "Unlimited Units" : `Up to ${cap} Units`;

  // Visual variant per slot — keeps the existing hierarchy: light cards for
  // Starter/Growth, dark recommended card for Pro, and a premium dark+violet
  // card for Business.
  const variantFor = (slot: Slot): "light" | "dark-pro" | "dark-business" => {
    if (slot === "pro") return "dark-pro";
    if (slot === "business") return "dark-business";
    return "light";
  };

  const PlanCard = ({ slot }: { slot: Slot }) => {
    const d = dataFor(slot);
    const variant = variantFor(slot);
    const isCurrent = currentSlot === slot;
    const isFree = slot === "basic";
    const isDark = variant !== "light";

    const containerBase = "rounded-2xl p-6 border-2 transition relative flex flex-col h-full";
    const containerByVariant =
      variant === "dark-pro"
        ? `bg-primary text-primary-foreground border-primary ${isCurrent ? "ring-4 ring-info/30" : "hover:shadow-xl"}`
        : variant === "dark-business"
          ? `bg-primary text-primary-foreground border-primary ${isCurrent ? "ring-4 ring-info/30" : "hover:shadow-xl"}`
          : `bg-card ${isCurrent ? "border-info ring-4 ring-info/10" : "border-border hover:border-info/40"}`;

    const titleColor = isDark ? "text-primary-foreground" : "text-foreground";
    const subduedText = isDark ? "text-primary-foreground/70" : "text-muted-foreground";
    const billedPillClass = isDark
      ? "bg-primary-foreground/10 text-primary-foreground/80"
      : "bg-secondary text-muted-foreground";

    // Source/rank-aware CTA. No paid downgrades are offered; the only "down"
    // move is cancelling a paid plan to Starter (effective next renewal).
    const source = planSource?.source ?? "none";
    const isCancelToBasic = slot === "basic" && currentSlot !== "basic" && source === "paid";
    const blocked =
      !isCurrent &&
      ((RANK[slot] < RANK[currentSlot] && slot !== "basic") || // no paid downgrades
        (slot === "basic" && currentSlot !== "basic" && source !== "paid")); // nothing to cancel

    const ctaText = isCurrent
      ? "Current Plan"
      : isCancelToBasic
        ? "Cancel plan"
        : blocked
          ? "Not available"
          : d.ctaLabel;
    const ctaDisabled = isCurrent || !canManageBilling || blocked || upgrading;
    const ctaClass = isCurrent
      ? isDark
        ? "bg-primary-foreground/10 text-primary-foreground/70 cursor-default"
        : "bg-secondary text-muted-foreground/70 cursor-default"
      : slot === "basic"
        ? "bg-primary text-primary-foreground hover:bg-primary/90"
        : slot === "business"
          ? "bg-info text-info-foreground hover:bg-info/90 shadow-lg shadow-info/30"
          : variant === "dark-pro"
            ? "bg-info text-info-foreground hover:bg-info/90 shadow-lg shadow-info/30"
            : "bg-info text-info-foreground hover:bg-info/90 shadow-lg shadow-info/20";

    return (
      <div className={`${containerBase} ${containerByVariant}`}>
        {/* Top badge: Current vs Recommended (Pro only) */}
        {isCurrent ? (
          <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-info text-info-foreground text-xs font-bold px-3 py-1 rounded-full">
            Current Plan
          </div>
        ) : slot === "pro" ? (
          <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-warning text-warning-foreground text-xs font-bold px-3 py-1 rounded-full flex items-center gap-1">
            <Star size={10} fill="currentColor" /> Recommended
          </div>
        ) : slot === "business" ? (
          <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-info text-info-foreground text-xs font-bold px-3 py-1 rounded-full">
            Sales-led
          </div>
        ) : null}

        <div className="mb-6 relative z-10">
          <h3 className={`text-xl font-bold ${titleColor}`}>{d.label}</h3>
          <div className="flex items-baseline gap-1 mt-2">
            {isFree ? (
              <span className={`text-3xl font-bold ${titleColor}`}>Free</span>
            ) : d.monthly != null ? (
              <>
                <span className={`text-3xl font-bold ${titleColor}`}>{formatMoney(d.monthly)}</span>
                <span className={`${subduedText} text-sm`}>/mo</span>
              </>
            ) : (
              <span className={`text-3xl font-bold ${titleColor}`}>Custom</span>
            )}
          </div>
          {d.yearly != null && d.yearly > 0 && (
            <p
              className={`text-xs mt-1 font-medium ${billedPillClass} inline-block px-2 py-1 rounded`}
            >
              Billed annually at {formatMoney(d.yearly)}
            </p>
          )}
          {d.yearly == null && !isFree && (
            <p
              className={`text-xs mt-1 font-medium ${billedPillClass} inline-block px-2 py-1 rounded`}
            >
              Custom pricing
            </p>
          )}
          <p
            className={`text-sm mt-2 ${isDark ? "text-muted-foreground/70" : "text-muted-foreground"}`}
          >
            {d.description}
          </p>
        </div>

        <ul className="space-y-3 mb-8 flex-1 relative z-10">
          {/* Unit cap is always-on the first bullet, derived from the realtime label config */}
          <li
            className={`flex items-center gap-2 text-sm ${isDark ? "text-primary-foreground" : "text-foreground"}`}
          >
            {isDark ? (
              <div className="w-5 h-5 rounded-full bg-info flex items-center justify-center flex-shrink-0">
                <Check size={12} strokeWidth={3} />
              </div>
            ) : (
              <Check size={16} className="text-success" />
            )}
            {unitCapBullet(d.unitCap)}
          </li>

          {FEATURE_BULLETS.map(({ key, on, off }) => {
            const included = canOwnerPlan(key, slot);
            if (included) {
              return (
                <li
                  key={key}
                  className={`flex items-center gap-2 text-sm ${isDark ? "text-primary-foreground" : "text-foreground"}`}
                >
                  {isDark ? (
                    <div className="w-5 h-5 rounded-full bg-info flex items-center justify-center flex-shrink-0">
                      <Check size={12} strokeWidth={3} />
                    </div>
                  ) : (
                    <Check size={16} className="text-success" />
                  )}
                  {on}
                </li>
              );
            }
            return (
              <li
                key={key}
                className={`flex items-center gap-2 text-sm ${isDark ? "text-muted-foreground/60" : "text-muted-foreground/70"}`}
              >
                <X size={16} /> {off}
              </li>
            );
          })}
        </ul>

        <button
          onClick={() => handlePlanSelect(slot)}
          disabled={ctaDisabled}
          className={`w-full py-2.5 rounded-xl font-bold transition relative z-10 ${ctaClass} ${ctaDisabled && !isCurrent ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          {ctaText}
        </button>

        {/* Decorative blobs for the dark cards */}
        {variant === "dark-pro" && (
          <>
            <div className="absolute top-0 right-0 w-64 h-64 bg-info/20 rounded-full blur-3xl -mr-16 -mt-16 pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-40 h-40 bg-primary-foreground/10 rounded-full blur-3xl -ml-10 -mb-10 pointer-events-none" />
          </>
        )}
        {variant === "dark-business" && (
          <>
            <div className="absolute top-0 right-0 w-64 h-64 bg-info/20 rounded-full blur-3xl -mr-16 -mt-16 pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-40 h-40 bg-primary-foreground/10 rounded-full blur-3xl -ml-10 -mb-10 pointer-events-none" />
          </>
        )}
      </div>
    );
  };

  const planContent = (
    <>
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-foreground mb-1">Choose your plan</h2>
        <p className="text-muted-foreground text-sm">
          Upgrade to unlock more features and grow your portfolio.
        </p>
      </div>

      {/* Mobile Carousel */}
      <div className="md:hidden -mx-5">
        <div className="overflow-hidden" ref={emblaRef}>
          <div className="flex">
            {SLOTS.map((slot) => (
              <div key={slot} className="flex-[0_0_85%] min-w-0 px-2 pt-4">
                <PlanCard slot={slot} />
              </div>
            ))}
          </div>
        </div>
        <div className="flex justify-center gap-1.5 mt-5">
          {SLOTS.map((_, i) => (
            <button
              key={i}
              onClick={() => emblaApi?.scrollTo(i)}
              className={`h-1.5 rounded-full transition-all ${i === selectedSlide ? "bg-info w-6" : "bg-muted-foreground/30 w-1.5"}`}
            />
          ))}
        </div>
      </div>

      {/* Desktop Grid — 4 plans, 4 columns at lg+ */}
      <div className="hidden md:grid md:grid-cols-2 lg:grid-cols-4 gap-5">
        {SLOTS.map((slot) => (
          <PlanCard key={slot} slot={slot} />
        ))}
      </div>
    </>
  );

  const confirmContent = (() => {
    const proLabel = labelsConfig.plans.pro?.label ?? "Pro";
    const proYearly = labelsConfig.plans.pro?.yearlyAmount ?? null;
    // The actual first-cycle charge: the configured intro discount when it's a
    // real saving, otherwise the full Pro price (admin may disable the discount).
    const discount = labelsConfig.proUpgradeFirstCycleAmount;
    const discounted =
      discount != null && discount > 0 && proYearly != null && discount < proYearly;
    const firstCharge = discounted ? discount : proYearly;
    return (
      <div className="max-w-md mx-auto text-center py-4">
        <h2 className="text-2xl font-bold text-foreground mb-2">Upgrade to {proLabel}</h2>
        <p className="text-muted-foreground text-sm mb-4">
          You'll be charged{" "}
          <span className="font-semibold text-foreground">{formatMoney(firstCharge)}</span> today
          for a full year of {proLabel}. Your Growth time ends now and a fresh 12-month term starts
          today.
          {proYearly != null && discounted && (
            <>
              {" "}
              It renews in 12 months at{" "}
              <span className="font-semibold text-foreground">{formatMoney(proYearly)}/year</span>.
            </>
          )}
        </p>
        <p className="text-xs text-muted-foreground/80 mb-6">
          No refund for unused Growth time. You can cancel anytime — cancellation takes effect at
          your next renewal.
        </p>
        {error && (
          <div className="mb-4 bg-destructive/10 text-destructive text-sm rounded-xl px-4 py-3">
            {error}
          </div>
        )}
        <div className="flex gap-3">
          <button
            onClick={() => setConfirmUpgrade(null)}
            disabled={upgrading}
            className="flex-1 py-2.5 rounded-xl font-bold bg-secondary text-foreground hover:bg-secondary/80 transition disabled:opacity-60"
          >
            Not now
          </button>
          <button
            onClick={doConfirmUpgrade}
            disabled={upgrading}
            className="flex-1 py-2.5 rounded-xl font-bold bg-info text-info-foreground hover:bg-info/90 transition disabled:opacity-60"
          >
            {upgrading ? "Processing…" : `Confirm & pay ${formatMoney(firstCharge)}`}
          </button>
        </div>
      </div>
    );
  })();

  return (
    <ResponsiveDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Plans"
      desktopMaxWidth="max-w-7xl"
    >
      {!confirmUpgrade && !canManageBilling && (
        <div className="mb-4 bg-warning/10 text-warning text-sm rounded-xl px-4 py-3">
          Only the portfolio owner{ownerName ? ` (${ownerName})` : ""} can change this plan.
          Features unlock for everyone with access to this portfolio.
        </div>
      )}
      {!confirmUpgrade && error && (
        <div className="mb-4 bg-destructive/10 text-destructive text-sm rounded-xl px-4 py-3">
          {error}
        </div>
      )}
      {!confirmUpgrade && successMsg && (
        <div className="mb-4 bg-success/10 text-success text-sm rounded-xl px-4 py-3 text-center">
          {successMsg}
        </div>
      )}
      {!confirmUpgrade && (pendingPlan || openingPortal) && (
        <div className="mb-4 bg-info/10 text-info text-sm rounded-xl px-4 py-3 text-center">
          {openingPortal
            ? "Opening billing portal..."
            : `Redirecting to checkout for ${pendingPlan ? (labelsConfig.plans[pendingPlan]?.label ?? pendingPlan) : ""}...`}
        </div>
      )}
      {confirmUpgrade ? confirmContent : planContent}
    </ResponsiveDrawer>
  );
}
