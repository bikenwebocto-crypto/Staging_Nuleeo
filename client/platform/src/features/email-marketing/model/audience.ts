import type { EmailCampaign, EmailCampaignAudience, MarketingAudienceFilter } from "../api/types";

export const AUDIENCES: readonly EmailCampaignAudience[] = ["all", "owners", "tenants"];

// "all" includes owners + tenants only; admin-only/staff accounts are excluded
// from marketing audiences by design (server/services/audiences.ts). The label
// matches that behavior so the dropdown doesn't promise more than it delivers.
export const AUDIENCE_LABELS: Record<EmailCampaignAudience, string> = {
  all: "Owners + Tenants",
  owners: "Owners",
  tenants: "Tenants",
};

const ROLE_LABEL: Record<MarketingAudienceFilter["role"], string> = {
  all: "Owners + Tenants",
  owners: "Owners",
  tenants: "Tenants",
};

// One-line human label for any campaign — used by the list table, the stats
// header, and the preview pane. Handles all three audience-encoding paths
// (filter / specific user / legacy) so the UI can render an old campaign
// alongside a brand-new filter-based one without branching at every site.
export function audienceSummary(
  campaign: Pick<EmailCampaign, "audience" | "filter" | "targetUserId">,
): string {
  if (campaign.targetUserId) return "Specific user";
  if (campaign.filter) return filterSummary(campaign.filter);
  if (campaign.audience) return AUDIENCE_LABELS[campaign.audience];
  return "—";
}

// Human-readable summary of a MarketingAudienceFilter. Lists the headline
// role and tacks on any active modifiers so admins can verify their targeting
// at a glance without re-opening the campaign.
export function filterSummary(filter: MarketingAudienceFilter): string {
  const bits: string[] = [ROLE_LABEL[filter.role] ?? "Users"];
  if (filter.status && filter.status !== "any") {
    bits.push(filter.status);
  }
  if (filter.plans && filter.plans.length > 0) {
    bits.push(`${filter.plans.length} plan${filter.plans.length === 1 ? "" : "s"}`);
  }
  const ranges: Array<keyof MarketingAudienceFilter> = [
    "portfolioAccessRange",
    "propertiesRange",
    "rentedRange",
    "peopleAssignedRange",
  ];
  const active = ranges.filter((k) => filter[k]).length;
  if (active > 0) bits.push(`${active} range filter${active === 1 ? "" : "s"}`);
  if (filter.emailContains) bits.push(`email ~ "${filter.emailContains}"`);
  return bits.join(" · ");
}
