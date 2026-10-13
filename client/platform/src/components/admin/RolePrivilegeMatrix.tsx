// Renders one of the three role-privilege matrices (portfolio, platform,
// ownerPlan). Used by AdminPortfolioRolesPage, AdminPlatformRolesPage, and
// AdminOwnerPlansPage. Owns its own draft state — saving writes the relevant
// slice of `config/privileges` while preserving the other two (the server
// merges over defaults, so sending only one slice is safe).
//
// For kind="ownerPlan" the matrix also hosts a "Limits & Fees" section at
// the top with three input rows (Unit cap, Commission %, Min commission €).
// Those rows persist to `config/planLabels` (unit cap) and
// `config/platformFees` (commissions) — both PUTs fire alongside the
// privileges save when the user clicks "Save changes".

import { Fragment, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import {
  PORTFOLIO_ROLES,
  PLATFORM_ROLES,
  OWNER_PLANS,
  PORTFOLIO_PRIVILEGE_CATALOG,
  PLATFORM_PRIVILEGE_CATALOG,
  OWNER_PLAN_PRIVILEGE_CATALOG,
  PORTFOLIO_PRIVILEGE_LOCKS,
  DEFAULT_PRIVILEGES_CONFIG,
  DEFAULT_PLAN_LABELS,
  DEFAULT_PLATFORM_FEES_CONFIG,
  type PortfolioGrants,
  type PlatformGrants,
  type OwnerPlanGrants,
  type PortfolioRoleKey,
  type PlatformRoleKey,
  type OwnerPlanKey,
  type PrivilegesConfig,
  type PlanLabel,
  type PlanLabelsConfig,
  type RentCommissionTier,
  type PlatformFeesConfig,
} from "@shared/firestore-schema";

const PORTFOLIO_ROLE_LABEL: Record<PortfolioRoleKey, string> = {
  owner: "Owner",
  legacyOwner: "Legacy Owner",
  legal: "Legal",
  financial: "Financial",
  tenant: "Tenant",
};

const PLATFORM_ROLE_LABEL: Record<PlatformRoleKey, string> = {
  admin: "Admin",
  manager: "Manager",
  legal: "Legal",
  financial: "Financial",
  support: "Support",
  sales: "Sales",
  marketing: "Marketing",
};

// Internal plan keys map to the new four-tier display names (see image in
// /admin/owner-plans). Editable values for these labels live in
// `config/planLabels` — this matrix uses the canonical names for
// readability of the privilege grid.
const OWNER_PLAN_LABEL: Record<OwnerPlanKey, string> = {
  basic: "Starter",
  advance: "Growth",
  pro: "Pro",
  business: "Business",
};

interface Props {
  kind: "portfolio" | "platform" | "ownerPlan";
  // The role-privilege toggle grid writes PUT /api/privileges-config, which the
  // server gates to superadmin only. When false the grid renders read-only so a
  // delegated admin isn't shown toggles + a Save that always 403s.
  canEditPrivileges: boolean;
  // The Limits & Fees inputs (ownerPlan only) write plan-labels + platform-fees,
  // gated server-side to platform.modifySettings. When false they're read-only.
  canEditLimits: boolean;
}

export function RolePrivilegeMatrix({ kind, canEditPrivileges, canEditLimits }: Props) {
  const { config: live } = usePrivileges();

  // One draft state per kind keeps each page independent, even when all three
  // are open in different tabs.
  const liveSlice =
    kind === "portfolio" ? live.portfolio : kind === "platform" ? live.platform : live.ownerPlan;
  const catalogForKind =
    kind === "portfolio"
      ? PORTFOLIO_PRIVILEGE_CATALOG
      : kind === "platform"
        ? PLATFORM_PRIVILEGE_CATALOG
        : OWNER_PLAN_PRIVILEGE_CATALOG;
  const [draft, setDraft] = useState<PortfolioGrants | PlatformGrants | OwnerPlanGrants>(liveSlice);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const seed = Object.fromEntries(catalogForKind.map((c) => [c.category, true]));
    if (kind === "ownerPlan") seed["Limits & Fees"] = true;
    return seed;
  });

  // Owner-plan-only: unitCap (from planLabels) + commissions (from
  // platformFees). null until first fetch — render falls back to defaults so
  // inputs always have something to show.
  const [planLabels, setPlanLabels] = useState<Record<OwnerPlanKey, PlanLabel> | null>(null);
  const [draftPlanLabels, setDraftPlanLabels] = useState<Record<OwnerPlanKey, PlanLabel> | null>(
    null,
  );
  const [platformFees, setPlatformFees] = useState<Record<OwnerPlanKey, RentCommissionTier> | null>(
    null,
  );
  const [draftPlatformFees, setDraftPlatformFees] = useState<Record<
    OwnerPlanKey,
    RentCommissionTier
  > | null>(null);
  // Single cross-plan figure: the discounted first-cycle price for a paid
  // Growth→Pro upgrade. null = no intro discount (charge full Pro price).
  const [proUpgrade, setProUpgrade] = useState<number | null>(null);
  const [draftProUpgrade, setDraftProUpgrade] = useState<number | null>(null);

  useEffect(() => {
    if (kind !== "ownerPlan") return;
    let active = true;
    (async () => {
      try {
        const [lRes, fRes] = await Promise.all([
          apiRequest("GET", "/api/admin/plan-labels"),
          apiRequest("GET", "/api/admin/platform-fees"),
        ]);
        const l = (await lRes.json()) as PlanLabelsConfig;
        const f = (await fRes.json()) as PlatformFeesConfig;
        if (!active) return;
        setPlanLabels(l.plans);
        setDraftPlanLabels(l.plans);
        setProUpgrade(l.proUpgradeFirstCycleAmount);
        setDraftProUpgrade(l.proUpgradeFirstCycleAmount);
        setPlatformFees(f.rentCommission);
        setDraftPlatformFees(f.rentCommission);
      } catch {
        // Leave drafts null — UI will fall back to defaults.
      }
    })();
    return () => {
      active = false;
    };
  }, [kind]);

  // Re-seed the draft when the live snapshot changes (another admin saves,
  // or the snapshot arrives after first paint). Mid-edit changes get reset —
  // an explicit "you have unsaved changes" prompt would be a follow-up.
  useEffect(() => {
    setDraft(liveSlice);
  }, [liveSlice]);

  const privilegesDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(liveSlice),
    [draft, liveSlice],
  );
  const labelsDirty =
    kind === "ownerPlan" && planLabels && draftPlanLabels
      ? JSON.stringify(draftPlanLabels) !== JSON.stringify(planLabels) ||
        draftProUpgrade !== proUpgrade
      : false;
  const feesDirty =
    kind === "ownerPlan" && platformFees && draftPlatformFees
      ? JSON.stringify(draftPlatformFees) !== JSON.stringify(platformFees)
      : false;
  const dirty = privilegesDirty || labelsDirty || feesDirty;

  const togglePrivilege = (privilege: string, role: string) => {
    setDraft((prev: any) => ({
      ...prev,
      [privilege]: { ...prev[privilege], [role]: !prev[privilege][role] },
    }));
  };

  const toggleCategory = (cat: string) => {
    setExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  const setUnitCap = (plan: OwnerPlanKey, raw: string) => {
    setDraftPlanLabels((cur) => {
      if (!cur) return cur;
      const trimmed = raw.trim();
      const unitCap =
        trimmed === ""
          ? null
          : Number.isFinite(parseInt(trimmed, 10))
            ? parseInt(trimmed, 10)
            : null;
      return { ...cur, [plan]: { ...cur[plan], unitCap } };
    });
  };
  const setPlanLabel = (plan: OwnerPlanKey, raw: string) => {
    setDraftPlanLabels((cur) => (cur ? { ...cur, [plan]: { ...cur[plan], label: raw } } : cur));
  };
  const setPlanDescription = (plan: OwnerPlanKey, raw: string) => {
    setDraftPlanLabels((cur) =>
      cur ? { ...cur, [plan]: { ...cur[plan], description: raw } } : cur,
    );
  };
  // Prices (yearly + Pro-upgrade) are FIXED in code and shown read-only — no
  // setters. Only names/descriptions/unit caps/commission are editable here.
  const setCommissionPercent = (plan: OwnerPlanKey, raw: string) => {
    setDraftPlatformFees((cur) => {
      if (!cur) return cur;
      const n = parseFloat(raw);
      return {
        ...cur,
        [plan]: { ...cur[plan], percent: Number.isFinite(n) ? n : 0 },
      };
    });
  };
  const setCommissionMin = (plan: OwnerPlanKey, raw: string) => {
    setDraftPlatformFees((cur) => {
      if (!cur) return cur;
      const n = parseFloat(raw);
      const cents = Number.isFinite(n) ? Math.round(n * 100) : 0;
      return { ...cur, [plan]: { ...cur[plan], minAmountCents: cents } };
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const reqs: Promise<unknown>[] = [];

      if (privilegesDirty) {
        const body: Partial<PrivilegesConfig> = {
          portfolio: kind === "portfolio" ? (draft as PortfolioGrants) : live.portfolio,
          platform: kind === "platform" ? (draft as PlatformGrants) : live.platform,
          ownerPlan: kind === "ownerPlan" ? (draft as OwnerPlanGrants) : live.ownerPlan,
        };
        reqs.push(apiRequest("PUT", "/api/privileges-config", body));
      }

      // Plan labels save: display name, description, yearly price, and
      // unit cap all live in the same `config/planLabels` doc. Re-fetch
      // first so concurrent edits in another tab don't get overwritten.
      if (labelsDirty && draftPlanLabels) {
        const freshRes = await apiRequest("GET", "/api/admin/plan-labels");
        const fresh = (await freshRes.json()) as PlanLabelsConfig;
        const merged: Record<OwnerPlanKey, PlanLabel> = { ...fresh.plans };
        (Object.keys(draftPlanLabels) as OwnerPlanKey[]).forEach((plan) => {
          merged[plan] = {
            ...fresh.plans[plan],
            label: draftPlanLabels[plan].label,
            description: draftPlanLabels[plan].description,
            yearlyAmount: draftPlanLabels[plan].yearlyAmount,
            unitCap: draftPlanLabels[plan].unitCap,
          };
        });
        reqs.push(
          apiRequest("PUT", "/api/admin/plan-labels", {
            plans: merged,
            proUpgradeFirstCycleAmount: draftProUpgrade,
          }),
        );
      }

      if (feesDirty && draftPlatformFees) {
        reqs.push(
          apiRequest("PUT", "/api/admin/platform-fees", {
            rentCommission: draftPlatformFees,
          }),
        );
      }

      await Promise.all(reqs);

      // Refresh local mirrors so dirty flags reset.
      if (kind === "ownerPlan") {
        const [lRes, fRes] = await Promise.all([
          apiRequest("GET", "/api/admin/plan-labels"),
          apiRequest("GET", "/api/admin/platform-fees"),
        ]);
        const l = (await lRes.json()) as PlanLabelsConfig;
        const f = (await fRes.json()) as PlatformFeesConfig;
        setPlanLabels(l.plans);
        setDraftPlanLabels(l.plans);
        setProUpgrade(l.proUpgradeFirstCycleAmount);
        setDraftProUpgrade(l.proUpgradeFirstCycleAmount);
        setPlatformFees(f.rentCommission);
        setDraftPlatformFees(f.rentCommission);
      }

      setSavedAt(Date.now());
    } catch (err) {
      setError(parseApiError(err, "Failed to save"));
    } finally {
      setSaving(false);
    }
  };

  const resetToDefaults = () => {
    setDraft(
      kind === "portfolio"
        ? DEFAULT_PRIVILEGES_CONFIG.portfolio
        : kind === "platform"
          ? DEFAULT_PRIVILEGES_CONFIG.platform
          : DEFAULT_PRIVILEGES_CONFIG.ownerPlan,
    );
    if (kind === "ownerPlan" && draftPlanLabels) {
      const next: Record<OwnerPlanKey, PlanLabel> = { ...draftPlanLabels };
      (Object.keys(next) as OwnerPlanKey[]).forEach((plan) => {
        next[plan] = {
          ...next[plan],
          label: DEFAULT_PLAN_LABELS.plans[plan].label,
          description: DEFAULT_PLAN_LABELS.plans[plan].description,
          yearlyAmount: DEFAULT_PLAN_LABELS.plans[plan].yearlyAmount,
          unitCap: DEFAULT_PLAN_LABELS.plans[plan].unitCap,
        };
      });
      setDraftPlanLabels(next);
      setDraftProUpgrade(DEFAULT_PLAN_LABELS.proUpgradeFirstCycleAmount);
    }
    if (kind === "ownerPlan") {
      setDraftPlatformFees({ ...DEFAULT_PLATFORM_FEES_CONFIG.rentCommission });
    }
  };
  const discard = () => {
    setDraft(liveSlice);
    if (planLabels) setDraftPlanLabels(planLabels);
    setDraftProUpgrade(proUpgrade);
    if (platformFees) setDraftPlatformFees(platformFees);
  };

  // The privilege grid writes /api/privileges-config (superadmin); the
  // Limits & Fees write plan-labels/platform-fees (platform.modifySettings).
  // Surface an explicit read-only reason instead of showing controls that 403.
  const privilegeNote = canEditPrivileges
    ? null
    : "Read-only — only a superadmin can change role privileges.";
  let ownerPlanNote: string | null = null;
  if (!canEditPrivileges && !canEditLimits) {
    ownerPlanNote =
      "Read-only — changing role privileges requires superadmin, and changing plan limits & fees requires the Manage settings privilege.";
  } else if (!canEditPrivileges) {
    ownerPlanNote =
      "Role privileges are read-only (superadmin only). You can still edit Limits & Fees.";
  } else if (!canEditLimits) {
    ownerPlanNote =
      "Limits & Fees are read-only (requires the Manage settings privilege). You can still edit role privileges.";
  }

  if (kind === "portfolio") {
    return (
      <Matrix
        catalog={PORTFOLIO_PRIVILEGE_CATALOG}
        roles={PORTFOLIO_ROLES}
        roleLabel={PORTFOLIO_ROLE_LABEL}
        draft={draft as PortfolioGrants}
        togglePrivilege={togglePrivilege}
        locks={PORTFOLIO_PRIVILEGE_LOCKS}
        expanded={expanded}
        toggleCategory={toggleCategory}
        dirty={dirty}
        saving={saving}
        savedAt={savedAt}
        error={error}
        save={save}
        resetToDefaults={resetToDefaults}
        discard={discard}
        title="Portfolio Role Privileges"
        subtitle="Configure what each property-level role can access within a portfolio. Changes apply in realtime to all signed-in users once saved."
        readOnlyPrivileges={!canEditPrivileges}
        readOnlyNote={privilegeNote}
      />
    );
  }
  if (kind === "platform") {
    return (
      <Matrix
        catalog={PLATFORM_PRIVILEGE_CATALOG}
        roles={PLATFORM_ROLES}
        roleLabel={PLATFORM_ROLE_LABEL}
        draft={draft as PlatformGrants}
        togglePrivilege={togglePrivilege}
        expanded={expanded}
        toggleCategory={toggleCategory}
        dirty={dirty}
        saving={saving}
        savedAt={savedAt}
        error={error}
        save={save}
        resetToDefaults={resetToDefaults}
        discard={discard}
        title="Platform Role Privileges"
        subtitle="Configure what each platform role can access across the system. Changes apply in realtime to all signed-in users once saved."
        readOnlyPrivileges={!canEditPrivileges}
        readOnlyNote={privilegeNote}
      />
    );
  }

  const limitsFees = (
    <LimitsAndFeesSection
      draftPlanLabels={draftPlanLabels}
      draftPlatformFees={draftPlatformFees}
      draftProUpgrade={draftProUpgrade}
      expanded={!!expanded["Limits & Fees"]}
      toggleSection={() => toggleCategory("Limits & Fees")}
      setPlanLabel={setPlanLabel}
      setPlanDescription={setPlanDescription}
      setUnitCap={setUnitCap}
      setCommissionPercent={setCommissionPercent}
      setCommissionMin={setCommissionMin}
      readOnly={!canEditLimits}
    />
  );

  return (
    <Matrix
      catalog={OWNER_PLAN_PRIVILEGE_CATALOG}
      roles={OWNER_PLANS}
      roleLabel={OWNER_PLAN_LABEL}
      draft={draft as OwnerPlanGrants}
      togglePrivilege={togglePrivilege}
      expanded={expanded}
      toggleCategory={toggleCategory}
      dirty={dirty}
      saving={saving}
      savedAt={savedAt}
      error={error}
      save={save}
      resetToDefaults={resetToDefaults}
      discard={discard}
      title="Owner Plan Privileges"
      subtitle="Configure what each owner subscription plan unlocks, plus unit caps and platform commission. Changes apply in realtime once saved."
      prependSection={limitsFees}
      readOnlyPrivileges={!canEditPrivileges}
      readOnlyNote={ownerPlanNote}
    />
  );
}

interface MatrixViewProps<R extends string> {
  catalog: { category: string; privileges: { key: string; label: string }[] }[];
  roles: readonly R[];
  roleLabel: Record<R, string>;
  draft: Record<string, Record<string, boolean>>;
  togglePrivilege: (privilege: string, role: string) => void;
  // Cells (role → privilege keys) that are force-ON and un-toggleable. Only
  // the portfolio matrix passes this (platform/ownerPlan have no locks).
  locks?: Partial<Record<R, readonly string[]>>;
  expanded: Record<string, boolean>;
  toggleCategory: (cat: string) => void;
  dirty: boolean;
  saving: boolean;
  savedAt: number | null;
  error: string | null;
  save: () => void;
  resetToDefaults: () => void;
  discard: () => void;
  title: string;
  subtitle: string;
  prependSection?: React.ReactNode;
  // When true the privilege toggle grid + Reset are disabled (the viewer can't
  // save /api/privileges-config). `readOnlyNote`, when set, explains why.
  readOnlyPrivileges: boolean;
  readOnlyNote?: string | null;
}

function Matrix<R extends string>({
  catalog,
  roles,
  roleLabel,
  draft,
  togglePrivilege,
  locks,
  expanded,
  toggleCategory,
  dirty,
  saving,
  savedAt,
  error,
  save,
  resetToDefaults,
  discard,
  title,
  subtitle,
  prependSection,
  readOnlyPrivileges,
  readOnlyNote,
}: MatrixViewProps<R>) {
  return (
    <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-1">{title}</h3>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {readOnlyNote && (
        <div className="mb-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          {readOnlyNote}
        </div>
      )}

      {/* Desktop: the full privileges × roles matrix in one table. */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2 pr-4 text-muted-foreground font-medium min-w-[200px]">
                Privilege
              </th>
              {roles.map((role) => (
                <th
                  key={role}
                  className="text-center py-2 px-2 text-muted-foreground font-medium whitespace-nowrap"
                >
                  {roleLabel[role]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {prependSection}
            {catalog.map((cat) => (
              // Fragment keyed by category — `<>` shorthand can't take a key,
              // and the inner <tr key> doesn't satisfy React because the
              // returned child is the fragment, not the <tr>.
              <Fragment key={cat.category}>
                <tr>
                  <td
                    colSpan={roles.length + 1}
                    className="pt-4 pb-2 cursor-pointer select-none"
                    onClick={() => toggleCategory(cat.category)}
                  >
                    <div className="flex items-center gap-2 text-xs font-bold text-foreground uppercase tracking-wider">
                      {expanded[cat.category] ? (
                        <ChevronDown size={14} />
                      ) : (
                        <ChevronRight size={14} />
                      )}
                      {cat.category}
                    </div>
                  </td>
                </tr>
                {expanded[cat.category] &&
                  cat.privileges.map((priv) => (
                    <tr
                      key={priv.key}
                      className="border-b border-border/50 hover:bg-muted/30 transition"
                    >
                      <td className="py-2.5 pr-4 text-foreground">{priv.label}</td>
                      {roles.map((role) => {
                        // Locked cells (e.g. the owner's "Manage banking")
                        // are permanently ON and can't be toggled off — the
                        // server already enforces this; here we just reflect it.
                        const locked = !!locks?.[role]?.includes(priv.key);
                        const checked = locked || !!draft[priv.key]?.[role];
                        return (
                          <td key={role} className="text-center py-2.5 px-2">
                            <button
                              onClick={() => {
                                if (locked || readOnlyPrivileges) return;
                                togglePrivilege(priv.key, role);
                              }}
                              disabled={locked || readOnlyPrivileges}
                              title={
                                locked
                                  ? "Always on for the portfolio owner"
                                  : readOnlyPrivileges
                                    ? "Read-only — only a superadmin can change role privileges"
                                    : undefined
                              }
                              className={`w-5 h-5 rounded border-2 inline-flex items-center justify-center transition ${
                                checked
                                  ? "bg-primary border-primary text-primary-foreground"
                                  : "border-border hover:border-muted-foreground"
                              } ${locked || readOnlyPrivileges ? "opacity-60 cursor-not-allowed" : ""}`}
                            >
                              {checked && <Check size={12} />}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: one card per role with labelled, 44px-tap toggles. The wide
          matrix table was unusable on phones (20px checkboxes in a horizontal
          scroll). The owner-plan limits/fees grid (prependSection) stays a
          compact horizontally-scrollable table — it is inherently 2D. */}
      <div className="md:hidden space-y-4">
        {prependSection && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium whitespace-nowrap">
                    Plan
                  </th>
                  {roles.map((role) => (
                    <th
                      key={role}
                      className="text-center py-2 px-2 text-muted-foreground font-medium whitespace-nowrap"
                    >
                      {roleLabel[role]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>{prependSection}</tbody>
            </table>
          </div>
        )}
        {roles.map((role) => (
          <div key={role} className="rounded-xl border border-border overflow-hidden">
            <div className="px-4 py-3 bg-muted/40 border-b border-border font-semibold text-sm text-foreground">
              {roleLabel[role]}
            </div>
            <div>
              {catalog.map((cat) => (
                <div key={cat.category} className="border-b border-border/50 last:border-0">
                  <button
                    type="button"
                    onClick={() => toggleCategory(cat.category)}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    {expanded[cat.category] ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                    {cat.category}
                  </button>
                  {expanded[cat.category] &&
                    cat.privileges.map((priv) => {
                      const locked = !!locks?.[role]?.includes(priv.key);
                      const checked = locked || !!draft[priv.key]?.[role];
                      return (
                        <div
                          key={priv.key}
                          className="flex items-center justify-between gap-3 pl-4 pr-1 border-t border-border/40"
                        >
                          <span className="text-sm text-foreground py-2">{priv.label}</span>
                          <button
                            type="button"
                            onClick={() => {
                              if (locked || readOnlyPrivileges) return;
                              togglePrivilege(priv.key, role);
                            }}
                            disabled={locked || readOnlyPrivileges}
                            aria-pressed={checked}
                            aria-label={`${priv.label} — ${roleLabel[role]}`}
                            title={
                              locked
                                ? "Always on for the portfolio owner"
                                : readOnlyPrivileges
                                  ? "Read-only — only a superadmin can change role privileges"
                                  : undefined
                            }
                            className="shrink-0 w-11 h-11 inline-flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
                          >
                            <span
                              className={`w-5 h-5 rounded border-2 inline-flex items-center justify-center transition ${
                                checked
                                  ? "bg-primary border-primary text-primary-foreground"
                                  : "border-border"
                              } ${locked || readOnlyPrivileges ? "opacity-60" : ""}`}
                            >
                              {checked && <Check size={12} />}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 pt-4 border-t border-border flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          {dirty ? (
            <span className="text-warning font-medium">Unsaved changes</span>
          ) : savedAt ? (
            <span className="text-success font-medium">Saved</span>
          ) : (
            <span className="text-muted-foreground">No changes</span>
          )}
          {error && <span className="text-destructive">· {error}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={resetToDefaults}
            disabled={readOnlyPrivileges}
            title={
              readOnlyPrivileges
                ? "Read-only — only a superadmin can change role privileges"
                : undefined
            }
            className="px-3 py-1.5 text-xs rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Reset to defaults
          </button>
          <button
            onClick={discard}
            disabled={!dirty}
            className="px-3 py-1.5 text-xs rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Discard
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="px-4 py-1.5 text-xs font-semibold rounded-md bg-foreground text-background hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Limits & Fees rows for the Owner Plan matrix. Rendered as additional
// tbody rows inside the privileges table so the 4-plan column alignment is
// preserved.
function LimitsAndFeesSection({
  draftPlanLabels,
  draftPlatformFees,
  draftProUpgrade,
  expanded,
  toggleSection,
  setPlanLabel,
  setPlanDescription,
  setUnitCap,
  setCommissionPercent,
  setCommissionMin,
  readOnly,
}: {
  draftPlanLabels: Record<OwnerPlanKey, PlanLabel> | null;
  draftPlatformFees: Record<OwnerPlanKey, RentCommissionTier> | null;
  // Pro-upgrade first-cycle price — FIXED in code, shown read-only here.
  draftProUpgrade: number | null;
  expanded: boolean;
  toggleSection: () => void;
  setPlanLabel: (plan: OwnerPlanKey, raw: string) => void;
  setPlanDescription: (plan: OwnerPlanKey, raw: string) => void;
  setUnitCap: (plan: OwnerPlanKey, raw: string) => void;
  setCommissionPercent: (plan: OwnerPlanKey, raw: string) => void;
  setCommissionMin: (plan: OwnerPlanKey, raw: string) => void;
  // Server gates plan-labels/platform-fees writes to platform.modifySettings.
  readOnly: boolean;
}) {
  const labels = draftPlanLabels ?? DEFAULT_PLAN_LABELS.plans;
  const fees = draftPlatformFees ?? DEFAULT_PLATFORM_FEES_CONFIG.rentCommission;

  return (
    <>
      <tr>
        <td
          colSpan={OWNER_PLANS.length + 1}
          className="pt-2 pb-2 cursor-pointer select-none"
          onClick={toggleSection}
        >
          <div className="flex items-center gap-2 text-xs font-bold text-foreground uppercase tracking-wider">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Limits &amp; Fees
          </div>
        </td>
      </tr>
      {expanded && (
        <>
          <tr className="border-b border-border/50 hover:bg-muted/30 transition">
            <td className="py-2.5 pr-4 text-foreground">Display name</td>
            {OWNER_PLANS.map((plan) => (
              <td key={plan} className="text-center py-2 px-2">
                <input
                  type="text"
                  value={labels[plan]?.label ?? ""}
                  onChange={(e) => setPlanLabel(plan, e.target.value)}
                  disabled={readOnly}
                  className="w-28 px-2 py-1 rounded-md border border-border bg-card text-xs text-center font-semibold focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </td>
            ))}
          </tr>
          <tr className="border-b border-border/50 hover:bg-muted/30 transition">
            <td className="py-2.5 pr-4 text-foreground">Description</td>
            {OWNER_PLANS.map((plan) => (
              <td key={plan} className="text-center py-2 px-2">
                <textarea
                  value={labels[plan]?.description ?? ""}
                  onChange={(e) => setPlanDescription(plan, e.target.value)}
                  disabled={readOnly}
                  rows={2}
                  className="w-40 px-2 py-1 rounded-md border border-border bg-card text-xs text-left resize-none focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </td>
            ))}
          </tr>
          {/* Prices are FIXED in code (DEFAULT_PLAN_LABELS) — shown read-only,
              never editable by an admin, regardless of the modifySettings
              privilege. See withFixedPlanPrices(). */}
          <tr className="border-b border-border/50 hover:bg-muted/30 transition">
            <td className="py-2.5 pr-4 text-foreground">
              Yearly (€)
              <span className="block text-[10px] text-muted-foreground">Fixed price</span>
            </td>
            {OWNER_PLANS.map((plan) => {
              const amount = labels[plan]?.yearlyAmount ?? null;
              const display = amount === null ? "Quote" : amount === 0 ? "Free" : `€${amount}`;
              return (
                <td key={plan} className="text-center py-2 px-2">
                  <span className="text-xs font-semibold text-foreground tabular-nums">
                    {display}
                  </span>
                </td>
              );
            })}
          </tr>
          <tr className="border-b border-border/50 hover:bg-muted/30 transition">
            <td className="py-2.5 pr-4 text-foreground">
              Pro upgrade — 1st year (€)
              <span className="block text-[10px] text-muted-foreground">
                Paid Growth→Pro · fixed price
              </span>
            </td>
            {OWNER_PLANS.map((plan) => (
              <td key={plan} className="text-center py-2 px-2">
                {plan === "pro" ? (
                  <span className="text-xs font-semibold text-foreground tabular-nums">
                    {draftProUpgrade === null ? "No discount" : `€${draftProUpgrade}`}
                  </span>
                ) : null}
              </td>
            ))}
          </tr>
          <tr className="border-b border-border/50 hover:bg-muted/30 transition">
            <td className="py-2.5 pr-4 text-foreground">Unit cap (blank = unlimited)</td>
            {OWNER_PLANS.map((plan) => (
              <td key={plan} className="text-center py-2 px-2">
                <input
                  type="number"
                  min={0}
                  value={labels[plan]?.unitCap ?? ""}
                  placeholder="∞"
                  onChange={(e) => setUnitCap(plan, e.target.value)}
                  disabled={readOnly}
                  className="w-16 px-1.5 py-1 rounded-md border border-border bg-card text-xs text-center focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </td>
            ))}
          </tr>
          <tr className="border-b border-border/50 hover:bg-muted/30 transition">
            <td className="py-2.5 pr-4 text-foreground">Commission % on rent</td>
            {OWNER_PLANS.map((plan) => (
              <td key={plan} className="text-center py-2 px-2">
                <div className="relative inline-block">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    value={fees[plan]?.percent ?? 0}
                    onChange={(e) => setCommissionPercent(plan, e.target.value)}
                    disabled={readOnly}
                    className="w-20 pl-2 pr-5 py-1 rounded-md border border-border bg-card text-xs text-center focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                    %
                  </span>
                </div>
              </td>
            ))}
          </tr>
          <tr className="border-b border-border/50 hover:bg-muted/30 transition">
            <td className="py-2.5 pr-4 text-foreground">Min commission (€)</td>
            {OWNER_PLANS.map((plan) => {
              const euros = ((fees[plan]?.minAmountCents ?? 0) / 100).toString();
              return (
                <td key={plan} className="text-center py-2 px-2">
                  <div className="relative inline-block">
                    <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                      €
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={euros}
                      onChange={(e) => setCommissionMin(plan, e.target.value)}
                      disabled={readOnly}
                      className="w-20 pl-5 pr-2 py-1 rounded-md border border-border bg-card text-xs text-center focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                </td>
              );
            })}
          </tr>
        </>
      )}
    </>
  );
}
