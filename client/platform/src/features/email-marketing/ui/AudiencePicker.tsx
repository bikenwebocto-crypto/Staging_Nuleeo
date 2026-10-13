// Rich audience picker for email campaigns — mirrors the layout of the
// notification-marketing page so admins get the same mental model across
// both surfaces. Owns no remote state: parent component holds the audience
// shape and reacts to onChange.

import { useEffect, useMemo, useState } from "react";
import { Loader2, Lock, Search, User as UserIcon, X } from "lucide-react";
import type { OwnerPlanKey } from "@shared/firestore-schema";
import { useAdminUsers, type AdminUserRow } from "@/lib/adminQueries";
import { fetchAudienceCount } from "../api/campaigns";
import type { MarketingAudienceFilter } from "../api/types";

export type AudienceKind = "filter" | "user";
type RoleOpt = MarketingAudienceFilter["role"];
type StatusOpt = MarketingAudienceFilter["status"];

const ROLE_LABEL: Record<RoleOpt, string> = {
  all: "Owners + Tenants",
  owners: "Owners",
  tenants: "Tenants",
};

// Labels match the admin Users page: schema "pending" reads as "Inactive"
// (user exists but hasn't activated yet). Server still receives the raw key.
const STATUS_LABEL: Record<StatusOpt, string> = {
  any: "Any status",
  active: "Active",
  suspended: "Suspended",
  invited: "Invited",
  pending: "Inactive",
};

const PLAN_OPTIONS: ReadonlyArray<{ key: OwnerPlanKey; label: string }> = [
  { key: "basic", label: "Starter" },
  { key: "advance", label: "Growth" },
  { key: "pro", label: "Pro" },
  { key: "business", label: "Business" },
];

type RangeKey = "portfolioAccessRange" | "propertiesRange" | "rentedRange" | "peopleAssignedRange";

interface RangeState {
  min: string;
  max: string;
}

const EMPTY_RANGE: RangeState = { min: "", max: "" };

const RANGE_FIELDS: ReadonlyArray<{ key: RangeKey; label: string }> = [
  { key: "portfolioAccessRange", label: "Portfolios with access" },
  { key: "propertiesRange", label: "Properties owned" },
  { key: "rentedRange", label: "Properties rented" },
  { key: "peopleAssignedRange", label: "People assigned" },
];

export interface AudienceValue {
  kind: AudienceKind;
  filter: MarketingAudienceFilter;
  // For "user" mode the parent only persists targetUserId, but we keep the
  // full user row here so the picker can render name/email/status without a
  // second lookup once the campaign is saved.
  user: AdminUserRow | null;
}

export interface AudiencePickerProps {
  value: AudienceValue;
  onChange: (next: AudienceValue) => void;
  disabled?: boolean;
  // When true, hides the role-locking explainer because the parent already
  // showed "this is sent / scheduled — audience is read-only".
  readOnly?: boolean;
  // When set, the picker shows a small live preview of the resolved audience
  // size. Disabled while the campaign is non-editable to avoid useless calls.
  showCount?: boolean;
}

const DEFAULT_FILTER: MarketingAudienceFilter = {
  role: "all",
  status: "active",
};

export function AudiencePicker({
  value,
  onChange,
  disabled,
  readOnly,
  showCount = true,
}: AudiencePickerProps) {
  const filter = value.filter;
  const setFilter = (next: MarketingAudienceFilter) => onChange({ ...value, filter: next });

  const [ranges, setRanges] = useState<Record<RangeKey, RangeState>>(() =>
    rangesFromFilter(filter),
  );

  // Reset the locally edited ranges whenever the campaign id (and therefore
  // the prop) actually changes. Keying off the kind+filter object identity
  // would over-fire, so we resync only when the parent hands us a new range
  // shape via prop updates from the campaign load.
  useEffect(() => {
    setRanges(rangesFromFilter(filter));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filter.portfolioAccessRange?.min,
    filter.portfolioAccessRange?.max,
    filter.propertiesRange?.min,
    filter.propertiesRange?.max,
    filter.rentedRange?.min,
    filter.rentedRange?.max,
    filter.peopleAssignedRange?.min,
    filter.peopleAssignedRange?.max,
  ]);

  const ownerOnlyActive =
    (filter.plans?.length ?? 0) > 0 ||
    rangeActive(ranges.portfolioAccessRange) ||
    rangeActive(ranges.propertiesRange) ||
    rangeActive(ranges.rentedRange) ||
    rangeActive(ranges.peopleAssignedRange);

  // When an owner-only filter is in play we always send "owners" upstream
  // and lock the Role dropdown — tenants would never match anyway.
  const effectiveRole: RoleOpt = ownerOnlyActive ? "owners" : filter.role;

  const togglePlan = (key: OwnerPlanKey) => {
    const current = filter.plans ?? [];
    const next = current.includes(key) ? current.filter((p) => p !== key) : [...current, key];
    setFilter({ ...filter, plans: next.length > 0 ? next : undefined });
  };

  const updateRange = (key: RangeKey, side: "min" | "max", val: string) => {
    const next: Record<RangeKey, RangeState> = {
      ...ranges,
      [key]: { ...ranges[key], [side]: val },
    };
    setRanges(next);
    const parsed = parseRange(next[key]);
    setFilter({ ...filter, [key]: parsed ?? undefined });
  };

  const clearOwnerFilters = () => {
    setRanges({
      portfolioAccessRange: EMPTY_RANGE,
      propertiesRange: EMPTY_RANGE,
      rentedRange: EMPTY_RANGE,
      peopleAssignedRange: EMPTY_RANGE,
    });
    setFilter({
      ...filter,
      plans: undefined,
      portfolioAccessRange: undefined,
      propertiesRange: undefined,
      rentedRange: undefined,
      peopleAssignedRange: undefined,
    });
  };

  // ── Specific-user picker ─────────────────────────────────────────────────
  const { data: allUsers = [], isLoading: usersLoading } = useAdminUsers();
  const [userSearch, setUserSearch] = useState("");

  const ownerTenantUsers = useMemo(
    () => allUsers.filter((u) => u.rawRoles.includes("owner") || u.rawRoles.includes("tenant")),
    [allUsers],
  );

  const filteredUserOptions = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (q.length < 2) return [];
    return ownerTenantUsers
      .filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
      .slice(0, 6);
  }, [ownerTenantUsers, userSearch]);

  // ── Audience-size preview ────────────────────────────────────────────────
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);

  useEffect(() => {
    if (!showCount || value.kind !== "filter") {
      setAudienceCount(null);
      return;
    }
    const payload: MarketingAudienceFilter = { ...filter, role: effectiveRole };
    const handle = setTimeout(async () => {
      setCountLoading(true);
      try {
        const n = await fetchAudienceCount(payload);
        setAudienceCount(n);
      } catch {
        setAudienceCount(null);
      } finally {
        setCountLoading(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [
    showCount,
    value.kind,
    effectiveRole,
    filter.status,
    filter.emailContains,
    filter.plans,
    filter.portfolioAccessRange?.min,
    filter.portfolioAccessRange?.max,
    filter.propertiesRange?.min,
    filter.propertiesRange?.max,
    filter.rentedRange?.min,
    filter.rentedRange?.max,
    filter.peopleAssignedRange?.min,
    filter.peopleAssignedRange?.max,
  ]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Audience</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Admins and employees never receive marketing emails. Recipients who unsubscribed are
            auto-skipped.
          </p>
        </div>
        <div className="flex bg-muted rounded-lg p-1 gap-1 text-xs">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...value, kind: "filter" })}
            className={`px-3 py-1.5 rounded-md font-medium transition disabled:cursor-not-allowed ${
              value.kind === "filter"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Filter
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...value, kind: "user" })}
            className={`px-3 py-1.5 rounded-md font-medium transition disabled:cursor-not-allowed ${
              value.kind === "user"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Specific user
          </button>
        </div>
      </div>

      {value.kind === "filter" ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Role">
              <div className="relative">
                <select
                  value={effectiveRole}
                  disabled={ownerOnlyActive || disabled}
                  onChange={(e) => setFilter({ ...filter, role: e.target.value as RoleOpt })}
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {(Object.keys(ROLE_LABEL) as RoleOpt[]).map((k) => (
                    <option key={k} value={k}>
                      {ROLE_LABEL[k]}
                    </option>
                  ))}
                </select>
                {ownerOnlyActive && (
                  <Lock
                    size={12}
                    className="absolute right-8 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                  />
                )}
              </div>
              {ownerOnlyActive && !readOnly && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Locked to Owners — the filters below only apply to owners.
                </p>
              )}
            </Field>
            <Field label="Status">
              <select
                value={filter.status}
                disabled={disabled}
                onChange={(e) => setFilter({ ...filter, status: e.target.value as StatusOpt })}
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
              >
                {(Object.keys(STATUS_LABEL) as StatusOpt[]).map((k) => (
                  <option key={k} value={k}>
                    {STATUS_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Email contains (optional)">
            <input
              type="text"
              value={filter.emailContains ?? ""}
              disabled={disabled}
              onChange={(e) =>
                setFilter({
                  ...filter,
                  emailContains: e.target.value || undefined,
                })
              }
              placeholder="e.g. @gmail.com"
              className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
            />
          </Field>

          {/* Owner-only filters. Applying any of these auto-locks Role
               to Owners (see effectiveRole). */}
          <div className="pt-2 border-t border-border/60 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Owner filters
              </p>
              {ownerOnlyActive && !disabled && (
                <button
                  type="button"
                  onClick={clearOwnerFilters}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              )}
            </div>

            <Field label="Plan">
              <div className="flex flex-wrap gap-2">
                {PLAN_OPTIONS.map((p) => {
                  const on = filter.plans?.includes(p.key) ?? false;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      disabled={disabled}
                      onClick={() => togglePlan(p.key)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition disabled:opacity-50 ${
                        on
                          ? "bg-foreground text-background border-foreground"
                          : "bg-background text-foreground border-input hover:border-foreground/40"
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                Leave empty to include every plan.
              </p>
            </Field>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {RANGE_FIELDS.map(({ key, label }) => (
                <Field key={key} label={label}>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      disabled={disabled}
                      value={ranges[key].min}
                      onChange={(e) => updateRange(key, "min", e.target.value)}
                      placeholder="Min"
                      className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                    />
                    <span className="text-muted-foreground text-xs shrink-0">to</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      disabled={disabled}
                      value={ranges[key].max}
                      onChange={(e) => updateRange(key, "max", e.target.value)}
                      placeholder="Max"
                      className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                    />
                  </div>
                </Field>
              ))}
            </div>
          </div>

          {showCount && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1">
              {countLoading ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Counting…
                </>
              ) : audienceCount === null ? (
                <span>—</span>
              ) : (
                <span>
                  <span className="font-semibold text-foreground">{audienceCount}</span>{" "}
                  {audienceCount === 1 ? "user matches" : "users match"} this filter.
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {value.user ? (
            <div className="flex items-center justify-between bg-background border border-input rounded-lg px-3 py-2.5">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <UserIcon size={16} className="text-primary" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">
                    {value.user.name}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {value.user.email} · {value.user.roles.join(", ")} · {value.user.status}
                  </div>
                </div>
              </div>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => {
                    onChange({ ...value, user: null });
                    setUserSearch("");
                  }}
                  className="text-muted-foreground hover:text-foreground p-1 shrink-0"
                  title="Clear"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          ) : (
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="text"
                value={userSearch}
                disabled={disabled}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder={
                  usersLoading ? "Loading users…" : "Search owners and tenants by name or email…"
                }
                className="w-full pl-9 pr-3 py-2.5 bg-background border border-input rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
              />
              {filteredUserOptions.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-card border border-border rounded-lg shadow-lg z-10 overflow-hidden">
                  {filteredUserOptions.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => {
                        onChange({ ...value, user: u });
                        setUserSearch("");
                      }}
                      className="flex flex-col w-full px-3 py-2 text-left hover:bg-secondary transition-colors"
                    >
                      <span className="text-sm font-medium text-foreground">{u.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {u.email} · {u.roles.join(", ")} · {u.status}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
      </label>
      {children}
    </div>
  );
}

function rangeActive(r: RangeState): boolean {
  return r.min.trim() !== "" || r.max.trim() !== "";
}

function parseRange(r: RangeState): { min?: number; max?: number } | null {
  const out: { min?: number; max?: number } = {};
  const min = r.min.trim();
  const max = r.max.trim();
  if (min !== "") {
    const n = Number(min);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
    out.min = n;
  }
  if (max !== "") {
    const n = Number(max);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
    out.max = n;
  }
  if (out.min === undefined && out.max === undefined) return null;
  if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
    // A reversed range (fat-fingered bounds) previously returned null, which
    // updateRange turned into `undefined` — silently DROPPING the constraint and
    // WIDENING the send audience. Swap instead so the band still narrows, which
    // is the admin's obvious intent for two numeric bounds.
    return { min: out.max, max: out.min };
  }
  return out;
}

function rangesFromFilter(filter: MarketingAudienceFilter): Record<RangeKey, RangeState> {
  const pick = (r?: { min?: number; max?: number }): RangeState => ({
    min: r?.min !== undefined ? String(r.min) : "",
    max: r?.max !== undefined ? String(r.max) : "",
  });
  return {
    portfolioAccessRange: pick(filter.portfolioAccessRange),
    propertiesRange: pick(filter.propertiesRange),
    rentedRange: pick(filter.rentedRange),
    peopleAssignedRange: pick(filter.peopleAssignedRange),
  };
}

export const DEFAULT_AUDIENCE: AudienceValue = {
  kind: "filter",
  filter: DEFAULT_FILTER,
  user: null,
};
