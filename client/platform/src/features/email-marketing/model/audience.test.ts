import { describe, it, expect } from "vitest";
import { audienceSummary, filterSummary } from "./audience";
import type { EmailCampaign, MarketingAudienceFilter } from "../api/types";

// The "campaign" arg of audienceSummary only ever reads
// audience / filter / targetUserId. Shape the test fixtures to that
// surface so we don't have to mock the full EmailCampaign type.
type CampaignShape = Pick<EmailCampaign, "audience" | "filter" | "targetUserId">;

describe("audienceSummary", () => {
  it("renders 'Specific user' when targetUserId is set (highest priority)", () => {
    const campaign: CampaignShape = { targetUserId: "uid-123" };
    expect(audienceSummary(campaign)).toBe("Specific user");
  });

  it("targetUserId beats filter (discriminated union — exactly one branch)", () => {
    const campaign: CampaignShape = {
      targetUserId: "uid-123",
      filter: { role: "owners", status: "active" },
    };
    // Even if both set (shouldn't happen — server rejects, but be
    // defensive), the user-mode summary wins because it's the most
    // specific.
    expect(audienceSummary(campaign)).toBe("Specific user");
  });

  it("targetUserId beats legacy audience enum", () => {
    const campaign: CampaignShape = {
      targetUserId: "uid-123",
      audience: "all",
    };
    expect(audienceSummary(campaign)).toBe("Specific user");
  });

  it("renders the filter summary when filter is set", () => {
    const campaign: CampaignShape = {
      filter: { role: "owners", status: "active" },
    };
    expect(audienceSummary(campaign)).toContain("Owners");
  });

  it("filter beats legacy audience enum", () => {
    const campaign: CampaignShape = {
      filter: { role: "tenants", status: "active" },
      audience: "all",
    };
    // The filter says tenants — that's what should render.
    expect(audienceSummary(campaign)).toContain("Tenants");
  });

  it("falls back to legacy audience enum when only it is set", () => {
    expect(audienceSummary({ audience: "all" })).toBe("Owners + Tenants");
    expect(audienceSummary({ audience: "owners" })).toBe("Owners");
    expect(audienceSummary({ audience: "tenants" })).toBe("Tenants");
  });

  it("renders em-dash when nothing is set (empty draft)", () => {
    expect(audienceSummary({})).toBe("—");
  });
});

describe("filterSummary", () => {
  it("renders just the role for the simplest filter", () => {
    const filter: MarketingAudienceFilter = { role: "owners", status: "active" };
    const out = filterSummary(filter);
    // Role + status are both present in this simplest case.
    expect(out).toContain("Owners");
    expect(out).toContain("active");
  });

  it("omits status when set to 'any'", () => {
    const filter: MarketingAudienceFilter = { role: "owners", status: "any" };
    const out = filterSummary(filter);
    expect(out).toContain("Owners");
    expect(out).not.toContain("any");
  });

  it("counts plans when present", () => {
    const filter: MarketingAudienceFilter = {
      role: "owners",
      status: "active",
      plans: ["pro", "business"],
    };
    expect(filterSummary(filter)).toContain("2 plans");
  });

  it("singularizes plan count when 1", () => {
    const filter: MarketingAudienceFilter = {
      role: "owners",
      status: "active",
      plans: ["pro"],
    };
    const out = filterSummary(filter);
    expect(out).toContain("1 plan");
    expect(out).not.toContain("1 plans");
  });

  it("counts active range filters (singular vs plural)", () => {
    const oneRange: MarketingAudienceFilter = {
      role: "owners",
      status: "active",
      propertiesRange: { min: 1, max: 10 },
    };
    expect(filterSummary(oneRange)).toContain("1 range filter");
    expect(filterSummary(oneRange)).not.toContain("1 range filters");

    const multiRange: MarketingAudienceFilter = {
      role: "owners",
      status: "active",
      propertiesRange: { min: 1, max: 10 },
      rentedRange: { min: 0, max: 5 },
      peopleAssignedRange: { min: 1, max: 3 },
    };
    expect(filterSummary(multiRange)).toContain("3 range filters");
  });

  it("includes emailContains as a quoted token", () => {
    const filter: MarketingAudienceFilter = {
      role: "all",
      status: "active",
      emailContains: "gmail",
    };
    expect(filterSummary(filter)).toContain('email ~ "gmail"');
  });

  it("composes everything with the · separator", () => {
    const filter: MarketingAudienceFilter = {
      role: "owners",
      status: "active",
      plans: ["pro", "business"],
      propertiesRange: { min: 1, max: 10 },
      emailContains: "test",
    };
    const out = filterSummary(filter);
    // All the modifiers should appear, joined by " · ".
    expect(out).toContain("Owners");
    expect(out).toContain("active");
    expect(out).toContain("2 plans");
    expect(out).toContain("1 range filter");
    expect(out).toContain('email ~ "test"');
    expect(out.includes(" · ")).toBe(true);
  });

  it("doesn't crash on a minimal-fields filter", () => {
    // status undefined → no status token; no plans → no plan token; etc.
    const filter = { role: "owners" } as MarketingAudienceFilter;
    expect(() => filterSummary(filter)).not.toThrow();
    expect(filterSummary(filter)).toContain("Owners");
  });
});
