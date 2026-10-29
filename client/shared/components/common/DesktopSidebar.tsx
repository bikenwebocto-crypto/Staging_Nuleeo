import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@ui/lib/utils";
import { Logo } from "@ui/components/Logo";
import { PricingModal } from "@ui/components/common/PricingModal";
import { usePlan } from "@ui/lib/usePlan";
import { usePlanLabels } from "@ui/lib/usePlanLabels";
import { useSocialLinks } from "@ui/lib/socialStore";
import {
  SOCIAL_PLATFORM_KEYS,
  SOCIAL_PLATFORM_META,
  type OwnerPlanKey,
} from "@shared/firestore-schema";
import { SOCIAL_ICONS } from "@ui/components/SocialIcons";

// Minimal nav item shape the sidebar needs. Each app's full menu config carries
// additional fields (privilege, etc); the caller filters those out before passing.
export interface SidebarMenuItem {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  label: string;
  path: string;
  // Optional unread/notification count. When > 0 a count pill renders at the
  // right of the row (e.g. unread messages). Omitted/0 → no pill.
  badge?: number;
}

export interface DesktopSidebarProps {
  role?: "owner" | "tenant" | "admin";
  // Pre-filtered nav items. Caller decides visibility (e.g. platform filters
  // by privilege; app passes role-specific lists).
  items: SidebarMenuItem[];
  // If set, the brand block becomes a clickable link to this path (e.g. admin
  // clicks the logo to return to /admin).
  brandHref?: string;
  // Optional slot rendered between the brand and the nav (e.g. portfolio
  // switcher on the user app's owner side).
  topSlot?: ReactNode;
  // Optional slot rendered above the social links (e.g. switch-mode button
  // on the user app).
  bottomSlot?: ReactNode;
  // Fired on nav item hover/focus — the user app uses this to prefetch the
  // route's data so navigation feels instant.
  onItemHover?: (path: string) => void;
  // Override the plan badge — pass the ACTIVE PORTFOLIO's plan from the user
  // app wrapper so the badge reflects the portfolio being viewed, not the
  // caller's own subscription. Platform (no active portfolio) omits this and
  // falls back to the caller's plan.
  currentPlan?: OwnerPlanKey;
  // Extra classes for the sidebar container (e.g. platform's translucent bg).
  className?: string;
}

// Shared desktop sidebar chrome used by app/ and platform/. Per-product extras
// (portfolio switcher, switch-mode, create modal) are owned by the calling
// wrapper and passed in via slots/props so we don't duplicate the chrome.
export function DesktopSidebar({
  role = "owner",
  items,
  brandHref,
  topSlot,
  bottomSlot,
  onItemHover,
  currentPlan,
  className,
}: DesktopSidebarProps) {
  const [location] = useLocation();
  const { plan: userPlan } = usePlan();
  const { config: planLabels } = usePlanLabels();
  const effectivePlan = currentPlan ?? userPlan;
  // Use the admin-editable display label (config/planLabels) so the badge
  // matches the Plans modal and Banking page (e.g. "advance" → "Growth"),
  // never the raw internal key.
  const planLabel = planLabels.plans[effectivePlan]?.label ?? "Starter";
  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const { links: socialLinks } = useSocialLinks();
  const activeSocials = SOCIAL_PLATFORM_KEYS.filter(
    (k) => (socialLinks[k] ?? "").trim().length > 0,
  );

  const brand = (
    <div
      className={cn(
        "flex items-center gap-3 mb-4 px-2",
        brandHref && "cursor-pointer hover:bg-secondary/50 p-2 rounded-xl transition-colors",
      )}
    >
      <Logo variant="wordmark" className="h-7 w-auto" />
    </div>
  );

  return (
    <>
      <PricingModal open={isPricingOpen} onOpenChange={setIsPricingOpen} />

      <div
        className={cn(
          "hidden md:flex flex-col bg-card h-dvh sticky top-0 z-50 p-4 border-r border-border dark:border-transparent overflow-hidden w-64",
          className,
        )}
      >
        {brandHref ? <Link href={brandHref}>{brand}</Link> : brand}

        {topSlot}

        <nav className="flex-1 min-h-0 overflow-y-auto space-y-0.5 -mx-2 px-2">
          {items
            .filter((item) => item.label !== "Ask Olio")
            .map((item) => {
              // Active: exact match, or nested route (skip top-level role roots
              // to avoid false matches against e.g. /owner vs /owner/agreements).
              const isTopLevel = ["/", "/tenant", "/admin", "/owner"].includes(item.path);
              const isActive =
                location === item.path || (!isTopLevel && location.startsWith(item.path + "/"));

              const itemClasses = cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 font-medium text-sm cursor-pointer group",
                isActive
                  ? "bg-(--brand-accent-subtle) text-foreground shadow-sm ring-1 ring-inset ring-(--brand-accent-border)"
                  : "text-muted-foreground hover:bg-secondary dark:hover:bg-secondary hover:text-foreground",
              );

              // Active rows are an accent-tinted chip with a full-contrast
              // (text-foreground) label; the icon takes the brand accent so the
              // personalization reads at a glance while the label stays legible
              // for every hue. Inactive icons inherit the muted row color and
              // brighten on hover with the label.
              const iconEl = (
                <item.icon
                  size={18}
                  strokeWidth={2}
                  className={cn("transition-colors shrink-0", isActive && "text-(--brand-accent)")}
                />
              );

              if (item.label === "Professional Advice") {
                return (
                  <div
                    key={item.label}
                    onClick={() => window.dispatchEvent(new CustomEvent("open-olio-chat"))}
                    className={itemClasses}
                  >
                    {iconEl}
                    {item.label}
                  </div>
                );
              }

              return (
                <Link key={item.label} href={item.path}>
                  <div
                    className={itemClasses}
                    onMouseEnter={onItemHover ? () => onItemHover(item.path) : undefined}
                    onFocus={onItemHover ? () => onItemHover(item.path) : undefined}
                  >
                    {iconEl}
                    <span className="flex-1 truncate">{item.label}</span>
                    {(item.badge ?? 0) > 0 && (
                      <span
                        className={cn(
                          "ml-auto shrink-0 min-w-[18px] h-[18px] px-1.5 rounded-full text-[10px] font-bold leading-[18px] text-center",
                          "bg-primary text-primary-foreground",
                        )}
                      >
                        {item.badge! > 99 ? "99+" : item.badge}
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
        </nav>

        {role === "owner" && (
          <div className="mt-auto pt-6 border-t border-border">
            <div
              onClick={() => setIsPricingOpen(true)}
              className="bg-secondary/30 border border-border rounded-xl p-3 cursor-pointer hover:bg-secondary transition group"
            >
              <div className="flex justify-between items-start mb-1">
                <h4 className="font-semibold text-foreground text-xs">{planLabel + " Plan"}</h4>
                {userPlan === "basic" && (
                  <span className="text-[10px] font-bold bg-primary text-primary-foreground px-1.5 py-0.5 rounded">
                    UPGRADE
                  </span>
                )}
              </div>
              <div className="w-full bg-secondary h-1 rounded-full overflow-hidden mt-2">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-500",
                    userPlan === "pro"
                      ? "w-full bg-(--brand-accent)"
                      : userPlan === "advance"
                        ? "w-2/3 bg-(--brand-accent)"
                        : "w-1/3 bg-muted-foreground",
                  )}
                />
              </div>
            </div>
          </div>
        )}

        <div className="mt-auto pt-4">
          {bottomSlot}

          <div
            className={cn(
              "pt-4",
              bottomSlot && "mt-3",
              role !== "owner" && "border-t border-border",
            )}
          >
            <div className="px-2 flex flex-col items-center gap-2">
              {activeSocials.length > 0 && (
                <div className="flex gap-2 flex-wrap justify-center">
                  {activeSocials.map((key) => {
                    const { Icon } = SOCIAL_ICONS[key];
                    const meta = SOCIAL_PLATFORM_META[key];
                    const url = socialLinks[key];
                    return (
                      <a
                        key={key}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={meta.label}
                        className="w-7 h-7 rounded-full bg-secondary/60 flex items-center justify-center text-muted-foreground/70 hover:bg-secondary hover:text-foreground transition"
                      >
                        <Icon className="w-3.5 h-3.5" />
                      </a>
                    );
                  })}
                </div>
              )}
              <span className="text-[11px] text-muted-foreground/60 font-medium tracking-wide">
                Olio Wallet v1.0
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
