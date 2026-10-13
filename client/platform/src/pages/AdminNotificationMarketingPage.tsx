// Route shell for /admin/notification-marketing. Sends OneSignal pushes to
// filtered owners/tenants (or a specific user), and triggers password-reset
// pushes. Gated on `comm.email` — same privilege as /admin/email-marketing.

import { useEffect, useMemo, useState } from "react";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { ForbiddenView } from "@ui/components/ForbiddenView";
import { useToast } from "@ui/hooks/use-toast";
import { useAdminUsers, type AdminUserRow } from "@/lib/adminQueries";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import type { OwnerPlanKey } from "@shared/firestore-schema";
import {
  Bell,
  Eye,
  KeyRound,
  Loader2,
  Lock,
  Search,
  Send,
  User as UserIcon,
  X,
} from "lucide-react";

type AudienceKind = "filter" | "user";
type RoleOpt = "all" | "owners" | "tenants";
type StatusOpt = "any" | "active" | "suspended" | "invited" | "pending";

const ROLE_LABEL: Record<RoleOpt, string> = {
  all: "Owners + Tenants",
  owners: "Owners",
  tenants: "Tenants",
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
  if (out.min !== undefined && out.max !== undefined && out.min > out.max) return null;
  return out;
}

function rangeActive(r: RangeState): boolean {
  return r.min.trim() !== "" || r.max.trim() !== "";
}
// Labels match the admin Users page: schema "pending" reads as "Inactive"
// (user exists but hasn't activated yet). Server still receives the raw key.
const STATUS_LABEL: Record<StatusOpt, string> = {
  any: "Any status",
  active: "Active",
  suspended: "Suspended",
  invited: "Invited",
  pending: "Inactive",
};

interface SendResult {
  ok: boolean;
  attempted: number;
  delivered: number;
  failed: number;
  failures: Array<{ userId: string; email: string; error: string }>;
}

interface PasswordResetResult {
  ok: boolean;
  recipients: number;
  warning?: string;
}

export default function AdminNotificationMarketingPage() {
  const { canPlatform } = usePrivileges();
  const allowed = canPlatform("comm.email");

  const { toast } = useToast();
  const { data: allUsers = [], isLoading: usersLoading } = useAdminUsers();

  const [audienceKind, setAudienceKind] = useState<AudienceKind>("filter");
  const [role, setRole] = useState<RoleOpt>("all");
  const [status, setStatus] = useState<StatusOpt>("active");
  const [emailContains, setEmailContains] = useState("");
  // Owner-only filters. When any of these is active, the audience is
  // restricted to owners (tenants can't have a plan / portfolio / etc.).
  const [plans, setPlans] = useState<OwnerPlanKey[]>([]);
  const [ranges, setRanges] = useState<Record<RangeKey, RangeState>>({
    portfolioAccessRange: EMPTY_RANGE,
    propertiesRange: EMPTY_RANGE,
    rentedRange: EMPTY_RANGE,
    peopleAssignedRange: EMPTY_RANGE,
  });

  const ownerOnlyActive =
    plans.length > 0 ||
    rangeActive(ranges.portfolioAccessRange) ||
    rangeActive(ranges.propertiesRange) ||
    rangeActive(ranges.rentedRange) ||
    rangeActive(ranges.peopleAssignedRange);
  // When an owner-only filter is in play we always send "owners" upstream
  // and lock the Role dropdown — tenants would never match anyway.
  const effectiveRole: RoleOpt = ownerOnlyActive ? "owners" : role;

  const togglePlan = (key: OwnerPlanKey) =>
    setPlans((prev) => (prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]));

  const updateRange = (key: RangeKey, side: "min" | "max", val: string) =>
    setRanges((prev) => ({
      ...prev,
      [key]: { ...prev[key], [side]: val },
    }));

  // Specific-user picker — only owners/tenants are valid targets. Admin and
  // employee accounts never appear in the list, mirroring the server gate.
  const [userSearch, setUserSearch] = useState("");
  const [selectedUser, setSelectedUser] = useState<AdminUserRow | null>(null);

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [url, setUrl] = useState("");

  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [lastResult, setLastResult] = useState<SendResult | null>(null);

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

  const buildFilterPayload = useMemo(
    () => () => {
      const payload: Record<string, unknown> = {
        role: effectiveRole,
        status,
        emailContains: emailContains.trim() || undefined,
      };
      if (plans.length > 0) payload.plans = plans;
      for (const { key } of RANGE_FIELDS) {
        const parsed = parseRange(ranges[key]);
        if (parsed) payload[key] = parsed;
      }
      return payload;
    },
    [effectiveRole, status, emailContains, plans, ranges],
  );

  // Refresh the audience-size preview whenever filters change. Debounced so
  // typing in the email box doesn't hammer the backend.
  useEffect(() => {
    if (audienceKind !== "filter" || !allowed) {
      setAudienceCount(null);
      return;
    }
    const handle = setTimeout(async () => {
      setCountLoading(true);
      try {
        const res = await apiRequest(
          "POST",
          "/api/admin/notifications/audience-count",
          buildFilterPayload(),
        );
        const data = (await res.json()) as { count: number };
        setAudienceCount(data.count);
      } catch (err) {
        setAudienceCount(null);
      } finally {
        setCountLoading(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [audienceKind, allowed, buildFilterPayload]);

  if (!allowed) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <ForbiddenView
          title="Notification marketing locked"
          message="Your platform role doesn't include the 'Manage email marketing' privilege. An admin can grant it in Settings → Platform Roles."
        />
      </div>
    );
  }

  const canSend =
    title.trim().length > 0 &&
    message.trim().length > 0 &&
    (audienceKind === "filter" || !!selectedUser);

  const handleSend = async () => {
    if (!canSend || sending) return;
    setSending(true);
    setLastResult(null);
    try {
      const audience =
        audienceKind === "user" && selectedUser
          ? { kind: "user" as const, userId: selectedUser.id }
          : {
              kind: "filter" as const,
              filter: buildFilterPayload(),
            };
      const res = await apiRequest("POST", "/api/admin/notifications/send", {
        audience,
        title: title.trim(),
        message: message.trim(),
        url: url.trim() || undefined,
      });
      const data = (await res.json()) as SendResult;
      setLastResult(data);
      toast({
        title: "Push sent",
        description: `${data.delivered}/${data.attempted} delivered${data.failed ? ` · ${data.failed} failed` : ""}.`,
      });
    } catch (err) {
      toast({
        title: "Failed to send",
        description: parseApiError(err),
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  const handlePasswordReset = async () => {
    if (!selectedUser || resetting) return;
    setResetting(true);
    try {
      const res = await apiRequest("POST", "/api/admin/notifications/password-reset", {
        userId: selectedUser.id,
      });
      const data = (await res.json()) as PasswordResetResult;
      toast({
        title: data.recipients > 0 ? "Reset push sent" : "Sent — no active devices",
        description:
          data.warning ?? `${selectedUser.name} will see a push to reset their password.`,
      });
    } catch (err) {
      toast({
        title: "Failed to send reset push",
        description: parseApiError(err),
        variant: "destructive",
      });
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-6 mt-4 md:mt-0">
        <div className="md:hidden mb-4">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            Notification Marketing
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Push notifications to owners and tenants on demand.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
          {/* ── Compose column ─────────────────────────────────────────────── */}
          <div className="space-y-6">
            {/* Audience selector */}
            <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-foreground">Audience</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Admins and employees never receive marketing pushes.
                  </p>
                </div>
                <div className="flex bg-muted rounded-lg p-1 gap-1 text-xs">
                  <button
                    onClick={() => setAudienceKind("filter")}
                    className={`px-3 py-1.5 rounded-md font-medium transition ${
                      audienceKind === "filter"
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Filter
                  </button>
                  <button
                    onClick={() => setAudienceKind("user")}
                    className={`px-3 py-1.5 rounded-md font-medium transition ${
                      audienceKind === "user"
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Specific user
                  </button>
                </div>
              </div>

              {audienceKind === "filter" ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <Field label="Role">
                      <div className="relative">
                        <select
                          value={effectiveRole}
                          onChange={(e) => setRole(e.target.value as RoleOpt)}
                          disabled={ownerOnlyActive}
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
                      {ownerOnlyActive && (
                        <p className="text-[11px] text-muted-foreground mt-1">
                          Locked to Owners — the filters below only apply to owners.
                        </p>
                      )}
                    </Field>
                    <Field label="Status">
                      <select
                        value={status}
                        onChange={(e) => setStatus(e.target.value as StatusOpt)}
                        className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
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
                      value={emailContains}
                      onChange={(e) => setEmailContains(e.target.value)}
                      placeholder="e.g. @gmail.com"
                      className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </Field>

                  {/* Owner-only filters. Applying any of these auto-locks
                       Role to Owners (see effectiveRole). */}
                  <div className="pt-2 border-t border-border/60 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Owner filters
                      </p>
                      {ownerOnlyActive && (
                        <button
                          type="button"
                          onClick={() => {
                            setPlans([]);
                            setRanges({
                              portfolioAccessRange: EMPTY_RANGE,
                              propertiesRange: EMPTY_RANGE,
                              rentedRange: EMPTY_RANGE,
                              peopleAssignedRange: EMPTY_RANGE,
                            });
                          }}
                          className="text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          Clear
                        </button>
                      )}
                    </div>

                    <Field label="Plan">
                      <div className="flex flex-wrap gap-2">
                        {PLAN_OPTIONS.map((p) => {
                          const on = plans.includes(p.key);
                          return (
                            <button
                              key={p.key}
                              type="button"
                              onClick={() => togglePlan(p.key)}
                              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
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
                              value={ranges[key].min}
                              onChange={(e) => updateRange(key, "min", e.target.value)}
                              placeholder="Min"
                              className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                            />
                            <span className="text-muted-foreground text-xs shrink-0">to</span>
                            <input
                              type="number"
                              inputMode="numeric"
                              min={0}
                              value={ranges[key].max}
                              onChange={(e) => updateRange(key, "max", e.target.value)}
                              placeholder="Max"
                              className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                            />
                          </div>
                        </Field>
                      ))}
                    </div>
                  </div>

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
                </div>
              ) : (
                <div className="space-y-3">
                  {selectedUser ? (
                    <div className="flex items-center justify-between bg-background border border-input rounded-lg px-3 py-2.5">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <UserIcon size={16} className="text-primary" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground truncate">
                            {selectedUser.name}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {selectedUser.email} · {selectedUser.roles.join(", ")} ·{" "}
                            {selectedUser.status}
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setSelectedUser(null);
                          setUserSearch("");
                        }}
                        className="text-muted-foreground hover:text-foreground p-1 shrink-0"
                        title="Clear"
                      >
                        <X size={16} />
                      </button>
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
                        onChange={(e) => setUserSearch(e.target.value)}
                        placeholder={
                          usersLoading
                            ? "Loading users…"
                            : "Search owners and tenants by name or email…"
                        }
                        className="w-full pl-9 pr-3 py-2.5 bg-background border border-input rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                      {filteredUserOptions.length > 0 && (
                        <div className="absolute left-0 right-0 top-full mt-1 bg-card border border-border rounded-lg shadow-lg z-10 overflow-hidden">
                          {filteredUserOptions.map((u) => (
                            <button
                              key={u.id}
                              onClick={() => {
                                setSelectedUser(u);
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

                  {selectedUser && (
                    <button
                      onClick={handlePasswordReset}
                      disabled={resetting}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-border text-sm font-medium hover:bg-muted transition disabled:opacity-50"
                    >
                      {resetting ? (
                        <Loader2 size={15} className="animate-spin" />
                      ) : (
                        <KeyRound size={15} />
                      )}
                      Send password-reset push
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Compose */}
            <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
              <h2 className="text-sm font-semibold text-foreground">Notification</h2>
              <Field label="Title">
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. New feature in your Olio Wallet"
                  maxLength={200}
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </Field>
              <Field label="Message">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Short message body shown in the notification…"
                  rows={4}
                  maxLength={2000}
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none"
                />
              </Field>
              <Field label="Link (optional)">
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://app.oliowallet.com/..."
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </Field>

              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={handleSend}
                  disabled={!canSend || sending}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                  {sending ? "Sending…" : "Send push"}
                </button>
                {audienceKind === "filter" && audienceCount !== null && (
                  <span className="text-xs text-muted-foreground">
                    → {audienceCount} {audienceCount === 1 ? "recipient" : "recipients"}
                  </span>
                )}
              </div>

              {lastResult && (
                <div className="mt-2 border-t border-border pt-3 space-y-2">
                  <div className="text-xs text-muted-foreground">
                    Last send: attempted{" "}
                    <span className="font-semibold text-foreground">{lastResult.attempted}</span> ·
                    delivered{" "}
                    <span className="font-semibold text-foreground">{lastResult.delivered}</span>
                    {lastResult.failed > 0 && (
                      <>
                        {" "}
                        · failed{" "}
                        <span className="font-semibold text-red-500">{lastResult.failed}</span>
                      </>
                    )}
                  </div>
                  {lastResult.attempted > lastResult.delivered && lastResult.failed === 0 && (
                    <p className="text-xs text-muted-foreground/80">
                      Some users had no active push subscription — they haven&apos;t enabled browser
                      notifications yet.
                    </p>
                  )}
                  {lastResult.failures.length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                        Failure details
                      </summary>
                      <ul className="mt-2 space-y-1 text-muted-foreground/80">
                        {lastResult.failures.map((f) => (
                          <li key={f.userId}>
                            {f.email}: {f.error}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── Preview column ─────────────────────────────────────────────── */}
          <div>
            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden lg:sticky lg:top-8">
              <div className="px-4 py-3 border-b border-border flex items-center gap-2 bg-muted/30">
                <Eye size={14} className="text-muted-foreground" />
                <span className="text-xs font-semibold text-muted-foreground">Preview</span>
              </div>
              <div className="p-5">
                <div className="bg-background border border-border rounded-xl p-4 shadow-sm">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 bg-foreground flex items-center justify-center">
                      {/* Same-origin path: the platform site serves its own
                          /icon-192.png. The cross-origin app.oliowallet.com URL
                          is blocked here by the platform CSP img-src ('self'),
                          which showed an empty dark box instead of the logo. */}
                      <img
                        src="/icon-192.png"
                        alt="Olio Wallet"
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-foreground">Olio Wallet</span>
                        <span className="text-[10px] text-muted-foreground">now</span>
                      </div>
                      <div className="text-sm font-semibold text-foreground mt-1 break-words">
                        {title.trim() || "Notification title"}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 break-words">
                        {message.trim() || "Notification body preview will appear here."}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 text-xs text-muted-foreground space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <Bell size={12} /> Delivered via OneSignal Web Push.
                  </div>
                  <div>
                    Recipients must have opened app.oliowallet.com and allowed notifications. Users
                    with no active subscription are skipped silently.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
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
