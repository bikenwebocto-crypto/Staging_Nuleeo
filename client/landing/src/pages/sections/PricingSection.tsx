import { useState } from "react";
import { motion } from "framer-motion";
import { Check, X } from "lucide-react";
import { appUrl } from "@/lib/appUrl";
import { usePlanLabels } from "@/lib/planLabelsPublic";
import type { OwnerPlanKey } from "@shared/firestore-schema";

// Static per-tier copy (highlights + featured flag) keyed by internal plan
// key. The display *name* / *description* / *price* / *cta* come from the
// admin-editable `config/planLabels` doc via usePlanLabels() so renames on
// /admin/owner-plans propagate to landing in realtime.
//
// Business is sales-led \u2014 separate "Contact sales" card.
interface CardCopy {
  highlights: string[];
  featured: boolean;
}
const CARD_COPY: Record<OwnerPlanKey, CardCopy> = {
  basic: {
    highlights: ["Market Insights", "Real Estate Network", "Up to 2 units", "Email support"],
    featured: false,
  },
  advance: {
    highlights: [
      "Everything in Starter",
      "Tenants & rent tracking",
      "Documents & Agreements",
      "Collect Rent (Stripe)",
      "Up to 5 units",
    ],
    featured: true,
  },
  pro: {
    highlights: [
      "Everything in Growth",
      "Up to 20 units",
      "Smart Calculator",
      "Full AI + PDF analysis",
      "Property + Portfolio briefings",
      "Tenant notifications",
    ],
    featured: false,
  },
  business: {
    highlights: ["Everything in Pro", "Unlimited units"],
    featured: false,
  },
};

const PLAN_ORDER: readonly OwnerPlanKey[] = ["basic", "advance", "pro", "business"];

function formatPrice(amount: number | null): { price: string; period: string } {
  if (amount == null) return { price: "Quote", period: "" };
  if (amount === 0) return { price: "Free", period: "" };
  return { price: `\u20AC${amount}`, period: "/yr" };
}

type FeatureValue = boolean | string;

// Keyed by internal plan key (basic/advance/pro/business) but column headers
// in the rendered table use the live display names from usePlanLabels().
interface ComparisonFeature {
  name: string;
  basic: FeatureValue;
  advance: FeatureValue;
  pro: FeatureValue;
  business: FeatureValue;
}

const comparisonFeatures: ComparisonFeature[] = [
  { name: "Add Properties", basic: true, advance: true, pro: true, business: true },
  { name: "Tenants", basic: false, advance: true, pro: true, business: true },
  { name: "Rent Tracking", basic: false, advance: true, pro: true, business: true },
  { name: "Market Insights", basic: true, advance: true, pro: true, business: true },
  { name: "Real Estate Network", basic: true, advance: true, pro: true, business: true },
  { name: "Documents", basic: false, advance: true, pro: true, business: true },
  { name: "Smart Calculator", basic: true, advance: true, pro: true, business: true },
  { name: "Agreements", basic: false, advance: true, pro: true, business: true },
  { name: "Property History", basic: true, advance: true, pro: true, business: true },
  { name: "Property Briefing", basic: false, advance: true, pro: true, business: true },
  { name: "Portfolio Briefing", basic: false, advance: true, pro: true, business: true },
  { name: "AI + PDF Analysis", basic: false, advance: true, pro: true, business: true },
  {
    name: "Collect Rent (Stripe)",
    basic: false,
    advance: "Optional",
    pro: "Optional",
    business: "Optional",
  },
  { name: "Notifications to Tenant", basic: false, advance: true, pro: true, business: true },
  { name: "Analytics", basic: false, advance: "Limited", pro: true, business: true },
];

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.12 } },
};

const item = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5 } },
};

function FeatureCell({ value }: { value: FeatureValue }) {
  if (value === true)
    return <Check size={18} className="text-green-500 mx-auto" role="img" aria-label="Included" />;
  if (value === false)
    return <X size={18} className="text-red-500 mx-auto" role="img" aria-label="Not included" />;
  return <span className="text-foreground text-sm">{value}</span>;
}

export default function PricingSection() {
  const [showComparison, setShowComparison] = useState(false);
  const labels = usePlanLabels();

  return (
    <section id="pricing" className="py-24 md:py-32 bg-secondary/50">
      <div className="max-w-7xl mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl md:text-5xl font-bold text-foreground tracking-tight">
            Simple, transparent pricing
          </h2>
          <p className="text-muted-foreground text-lg mt-4">Start free, upgrade as you grow</p>
        </motion.div>

        {/* Plan Cards — 4 tiers from config/planLabels (admin-editable, realtime) */}
        <motion.div
          variants={container}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true }}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-7xl mx-auto items-start px-4 md:px-0"
        >
          {PLAN_ORDER.map((key) => {
            const meta = labels.plans[key];
            const copy = CARD_COPY[key];
            const { price, period } = formatPrice(meta.yearlyAmount);
            return (
              <motion.div
                key={key}
                variants={item}
                className={`bg-card rounded-2xl p-6 md:p-7 border transition-shadow relative text-center md:text-left max-w-sm mx-auto md:max-w-none w-full ${
                  copy.featured
                    ? "ring-2 ring-black dark:ring-white shadow-xl md:scale-105"
                    : "border-border shadow-sm hover:shadow-md"
                }`}
              >
                {copy.featured && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-black dark:bg-white text-white dark:text-black text-xs font-semibold px-3 py-1 rounded-full">
                    Most Popular
                  </span>
                )}

                <h3 className="text-xl font-bold text-foreground">{meta.label}</h3>
                <p className="text-muted-foreground text-sm mt-1">{meta.description}</p>

                <div className="mt-6 mb-6">
                  <span className="text-4xl font-bold text-foreground">{price}</span>
                  {period && <span className="text-muted-foreground text-sm">{period}</span>}
                </div>

                <ul className="space-y-3 mb-8 inline-flex flex-col items-start">
                  {copy.highlights.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm text-foreground">
                      <Check size={16} className="text-green-500 flex-shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>

                <button
                  // /contact doesn't exist yet — send Business signups through
                  // the same /auth funnel as the other tiers until a sales
                  // contact route is built.
                  onClick={() => window.location.assign(appUrl("/auth"))}
                  className={`w-full py-3 rounded-full font-semibold transition-all active:scale-[0.98] ${
                    copy.featured
                      ? "bg-black dark:bg-white text-white dark:text-black hover:opacity-90"
                      : "border-2 border-black dark:border-white text-foreground hover:bg-secondary"
                  }`}
                >
                  {meta.ctaLabel || "Get started"}
                </button>
              </motion.div>
            );
          })}
        </motion.div>

        {/* Toggle comparison table */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="text-center mt-12"
        >
          <button
            onClick={() => setShowComparison(!showComparison)}
            className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
          >
            {showComparison ? "Hide" : "View"} full feature comparison
          </button>
        </motion.div>

        {/* Comparison Table */}
        {showComparison && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="mt-8 max-w-5xl mx-auto overflow-x-auto"
          >
            <div className="min-w-[720px]">
              <table className="w-full">
                <thead>
                  <tr className="border-b-2 border-border">
                    <th className="text-left py-4 pr-4 text-sm font-semibold text-foreground w-[36%]">
                      Feature
                    </th>
                    {PLAN_ORDER.map((key) => (
                      <th
                        key={key}
                        className="py-4 px-3 text-center text-sm font-bold text-foreground uppercase tracking-wider"
                      >
                        {labels.plans[key]?.label ?? key}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparisonFeatures.map((feature, i) => (
                    <tr
                      key={feature.name}
                      className={`border-b border-border/50 ${i % 2 === 0 ? "bg-card/50" : ""}`}
                    >
                      <td className="py-3.5 pr-4 text-sm text-foreground">{feature.name}</td>
                      {PLAN_ORDER.map((key) => (
                        <td key={key} className="py-3.5 px-3 text-center">
                          <FeatureCell value={feature[key]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                  {/* Units row */}
                  <tr className="border-t border-border">
                    <td className="py-3.5 pr-4 text-sm text-foreground font-semibold">Units</td>
                    {PLAN_ORDER.map((key) => {
                      const cap = labels.plans[key]?.unitCap;
                      return (
                        <td key={key} className="py-3.5 px-3 text-center text-sm text-foreground">
                          {cap == null ? "Unlimited" : `Up to ${cap}`}
                        </td>
                      );
                    })}
                  </tr>
                  {/* Subscription row */}
                  <tr className="border-t-2 border-border">
                    <td className="py-4 pr-4 text-sm font-semibold text-foreground">
                      Subscription
                    </td>
                    {PLAN_ORDER.map((key) => {
                      const amount = labels.plans[key]?.yearlyAmount;
                      const text =
                        amount == null ? "Quote" : amount === 0 ? "Free" : `\u20AC${amount}/yr`;
                      return (
                        <td
                          key={key}
                          className="py-4 px-3 text-center text-sm font-bold text-foreground"
                        >
                          {text}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </motion.div>
        )}
      </div>
    </section>
  );
}
