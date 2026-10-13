import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import {
  Check,
  Eye,
  EyeOff,
  Lock,
  Mail,
  Plug,
  ChevronRight,
  AlertTriangle,
  Bell,
  Send,
  Gauge,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { EmailAuthProvider, reauthenticateWithCredential } from "firebase/auth";
import { Switch } from "@ui/components/ui/switch";
import { apiRequest } from "@ui/lib/queryClient";
import { useToast } from "@ui/hooks/use-toast";
import { useLocation } from "wouter";
import { useAuth } from "@ui/lib/useAuth";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { useOneSignalSubscription, describePushUnavailable } from "@ui/lib/onesignal";
import { reauthErrorMessage } from "@ui/lib/authReauth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@ui/components/ui/dialog";
import { OwnerPlansLiveStatus } from "@/components/admin/OwnerPlansLiveStatus";
import { RolePrivilegeMatrix } from "@/components/admin/RolePrivilegeMatrix";
import { ComplianceEditor } from "@/components/admin/ComplianceEditor";
import { PlatformDocumentation } from "@/components/admin/PlatformDocumentation";
import { useSystemConfig, saveSystemConfig } from "@ui/lib/systemStore";
import { FEATURE_FLAGS, type FeatureFlag } from "@shared/firestore-schema";

export default function AdminSettingsPage() {
  const [, setLocation] = useLocation();
  const { profile, firebaseUser, refreshProfile } = useAuth();
  const { toast } = useToast();
  const hasPassword = (firebaseUser?.providerData ?? []).some((p) => p.providerId === "password");
  const { canPlatform } = usePrivileges();
  const showIntegrations = canPlatform("comm.email");
  const showRolesAndPlans = canPlatform("platform.viewSettings");
  const showCompliance = canPlatform("legal.compliance");
  // viewSettings only gates VIEWING the tabs; the writes are gated tighter
  // (privilege matrices = superadmin; plan limits/fees = platform.modifySettings).
  // Pass the real write-gates down so the matrices render read-only rather than
  // showing editable controls + a Save that always 403s. (isSuperadmin is
  // declared below alongside the maintenance-mode gate.)
  const canModifyPlanSettings = canPlatform("platform.modifySettings");

  // Staff push opt-in. On platform.oliowallet.com the shared hook resolves the
  // STAFF OneSignal app (web push binds one origin per app), so enabling here
  // subscribes this browser to the app the server's notifyStaff() addresses.
  // Mirrors the tenant/owner toggle in ProfileDrawer: flip the browser
  // subscription AND persist the pushEnabled pref (notifyStaff honors the
  // master opt-out).
  const push = useOneSignalSubscription();
  const pushMasterOn = push.subscribed && (profile?.notificationPrefs?.pushEnabled ?? true);
  const handlePushToggle = useCallback(
    async (next: boolean) => {
      if (!push.ready) return;
      if (next) await push.enable();
      else await push.disable();
      try {
        await apiRequest("PATCH", "/api/profile", { notificationPrefs: { pushEnabled: next } });
        await refreshProfile();
      } catch {
        // Non-fatal: the server pref resyncs on the next profile load.
      }
    },
    [push, refreshProfile],
  );
  const pushStatusLabel = !push.supported
    ? describePushUnavailable(push.unavailableReason).message
    : push.permission === "denied"
      ? "Blocked — enable notifications in your browser settings"
      : pushMasterOn
        ? "On — you'll get staff alerts on this device"
        : "Off — turn on to get new-ticket, signup, and platform alerts";
  const [activeTab, setActiveTab] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("tab");
    const valid = [
      "System",
      "Integrations",
      "Portfolio Roles",
      "Platform Roles",
      "Owner Plans",
      "Compliance",
      "Documentation",
    ];
    return requested && valid.includes(requested) ? requested : "System";
  });
  useEffect(() => {
    const onTabChange = (e: Event) => {
      const tab = (e as CustomEvent).detail;
      if (tab) setActiveTab(tab);
    };
    window.addEventListener("settings-tab", onTabChange);
    return () => window.removeEventListener("settings-tab", onTabChange);
  }, []);
  // Appearance + Profile moved to their own page (/admin/profile). Forward any
  // old deep links (e.g. ?tab=Profile, ?tab=Appearance) there so bookmarks and
  // shared URLs keep working.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (requested === "Appearance" || requested === "Profile") {
      setLocation(`/admin/profile?tab=${requested}`);
    }
  }, [setLocation]);
  // Maintenance mode is persisted at config/system (Firestore). The toggle
  // is superadmin-only; the user app subscribes to the same doc via
  // onSnapshot and locks all non-superadmin sessions when enabled.
  const { config: systemConfig, loading: systemConfigLoading } = useSystemConfig();
  const maintenanceMode = systemConfig.maintenanceMode.enabled;
  const isSuperadmin = profile?.roles?.includes("superadmin") ?? false;
  const [maintenancePasswordOpen, setMaintenancePasswordOpen] = useState(false);
  const [maintenancePassword, setMaintenancePassword] = useState("");
  const [showMaintenancePassword, setShowMaintenancePassword] = useState(false);
  const [maintenancePasswordError, setMaintenancePasswordError] = useState("");

  const [maintenanceSaving, setMaintenanceSaving] = useState(false);
  async function persistMaintenanceMode(nextEnabled: boolean) {
    await saveSystemConfig({
      maintenanceMode: {
        enabled: nextEnabled,
        message: systemConfig.maintenanceMode.message,
      },
    });
    toast({
      title: nextEnabled ? "Maintenance mode enabled" : "Maintenance mode disabled",
      description: nextEnabled
        ? "Non-admin users will see the maintenance screen."
        : "All users can access Olio again.",
    });
  }
  async function handleMaintenanceConfirm() {
    if (maintenanceSaving) return;
    setMaintenancePasswordError("");
    setMaintenanceSaving(true);
    try {
      if (hasPassword) {
        if (!firebaseUser?.email) throw new Error("No email on account.");
        const cred = EmailAuthProvider.credential(firebaseUser.email, maintenancePassword);
        await reauthenticateWithCredential(firebaseUser, cred);
      }
      await persistMaintenanceMode(!maintenanceMode);
      setMaintenancePasswordOpen(false);
      setMaintenancePassword("");
    } catch (err) {
      setMaintenancePasswordError(reauthErrorMessage(err));
    } finally {
      setMaintenanceSaving(false);
    }
  }

  const tabs = [
    "System",
    ...(showIntegrations ? ["Integrations"] : []),
    ...(showRolesAndPlans ? ["Portfolio Roles", "Platform Roles", "Owner Plans"] : []),
    ...(showCompliance ? ["Compliance"] : []),
    "Documentation",
  ];

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-8 md:mb-2 mt-4 md:mt-0">
        <div className="md:hidden">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-1 text-sm">Configure your experience</p>
        </div>
      </div>

      {/* Pill Tabs */}
      <div className="bg-card p-4 rounded-xl border border-border shadow-sm mb-6 space-y-4">
        <div className="relative">
          <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-card to-transparent z-10" />
          <div className="flex gap-2 overflow-x-auto hide-scrollbar">
            {tabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
                  activeTab === tab
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* System Tab */}
      {activeTab === "System" && (
        <div className="space-y-6">
          {/* Staff push opt-in — subscribes THIS browser to the platform
              OneSignal app so the server's notifyStaff() alerts (new support
              tickets, new signups, platform-payment failures) can reach it.
              Shown to all staff; only renders where the browser supports web
              push. */}
          {(push.supported || push.unavailableReason === "setup-incomplete") && (
            <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
              <h3 className="text-sm font-semibold text-foreground mb-4">Notifications</h3>
              <div className="flex items-center justify-between">
                <div className="flex items-start gap-3">
                  <Bell className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
                  <div>
                    <div className="text-sm font-medium text-foreground">Push notifications</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{pushStatusLabel}</div>
                  </div>
                </div>
                {!push.supported ? (
                  <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-muted text-muted-foreground shrink-0">
                    {describePushUnavailable(push.unavailableReason).badge}
                  </span>
                ) : push.permission === "denied" ? (
                  <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 shrink-0">
                    BLOCKED
                  </span>
                ) : (
                  <Switch
                    checked={pushMasterOn}
                    onCheckedChange={handlePushToggle}
                    disabled={!push.ready}
                  />
                )}
              </div>
            </div>
          )}
          {/* Preferences is superadmin-only: its sole control is Maintenance
              Mode. (A non-functional "Platform Notifications" toggle used to
              live here — removed, since it persisted nothing and admins receive
              no per-category push today.) */}
          {isSuperadmin && (
            <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
              <h3 className="text-sm font-semibold text-foreground mb-4">Preferences</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">Maintenance Mode</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {maintenanceMode
                        ? "Olio is currently locked — non-admin users see the maintenance screen."
                        : "Temporarily disable access for all users"}
                    </div>
                  </div>
                  <Switch
                    checked={maintenanceMode}
                    disabled={systemConfigLoading || maintenanceSaving}
                    onCheckedChange={() => {
                      setMaintenancePassword("");
                      setMaintenancePasswordError("");
                      setShowMaintenancePassword(false);
                      if (hasPassword) {
                        setMaintenancePasswordOpen(true);
                      } else {
                        // Google-only admins are already strongly authenticated;
                        // skip the password prompt and persist directly.
                        void (async () => {
                          setMaintenanceSaving(true);
                          try {
                            await persistMaintenanceMode(!maintenanceMode);
                          } catch (err) {
                            toast({
                              title: "Failed to update maintenance mode",
                              description: err instanceof Error ? err.message : "Unknown error",
                              variant: "destructive",
                            });
                          } finally {
                            setMaintenanceSaving(false);
                          }
                        })();
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          )}
          {isSuperadmin && <FeatureFlagsCard />}
        </div>
      )}

      {/* Integrations Tab */}
      {activeTab === "Integrations" && showIntegrations && (
        <IntegrationsTab onNavigate={setLocation} />
      )}

      {/* Portfolio Roles Tab */}
      {activeTab === "Portfolio Roles" && showRolesAndPlans && (
        <RolePrivilegeMatrix
          kind="portfolio"
          canEditPrivileges={isSuperadmin}
          canEditLimits={false}
        />
      )}

      {/* Platform Roles Tab */}
      {activeTab === "Platform Roles" && showRolesAndPlans && (
        <RolePrivilegeMatrix
          kind="platform"
          canEditPrivileges={isSuperadmin}
          canEditLimits={false}
        />
      )}

      {/* Owner Plans Tab */}
      {activeTab === "Owner Plans" && showRolesAndPlans && (
        <RolePrivilegeMatrix
          kind="ownerPlan"
          canEditPrivileges={isSuperadmin}
          canEditLimits={canModifyPlanSettings}
        />
      )}

      {/* Compliance Tab */}
      {activeTab === "Compliance" && showCompliance && <ComplianceEditor />}

      {/* Documentation Tab */}
      {activeTab === "Documentation" && <PlatformDocumentation />}

      {/* Maintenance Mode Password Dialog */}
      <Dialog
        open={maintenancePasswordOpen}
        onOpenChange={(open) => {
          setMaintenancePasswordOpen(open);
          if (!open) {
            setMaintenancePassword("");
            setMaintenancePasswordError("");
            setShowMaintenancePassword(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <Lock size={20} />
              {maintenanceMode ? "Disable" : "Enable"} Maintenance Mode
            </DialogTitle>
            <DialogDescription>
              Enter your admin password to {maintenanceMode ? "disable" : "enable"} maintenance
              mode.
              {!maintenanceMode && " This will temporarily block access for all users."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                Admin Password
              </label>
              <div className="relative">
                <input
                  type={showMaintenancePassword ? "text" : "password"}
                  value={maintenancePassword}
                  onChange={(e) => {
                    setMaintenancePassword(e.target.value);
                    setMaintenancePasswordError("");
                  }}
                  placeholder="Enter your password"
                  className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 pr-10"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && maintenancePassword && !maintenanceSaving) {
                      void handleMaintenanceConfirm();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowMaintenancePassword(!showMaintenancePassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showMaintenancePassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {maintenancePasswordError && (
                <p className="text-xs text-destructive mt-1.5">{maintenancePasswordError}</p>
              )}
            </div>
          </div>

          <div className="flex gap-3 mt-4">
            <button
              onClick={() => setMaintenancePasswordOpen(false)}
              disabled={maintenanceSaving}
              className="flex-1 py-2.5 rounded-lg border border-border text-sm font-semibold text-foreground hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleMaintenanceConfirm()}
              disabled={!maintenancePassword || maintenanceSaving}
              className="flex-1 py-2.5 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {maintenanceSaving ? "Confirming…" : "Confirm"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Runtime kill-switches (config/featureFlags). Superadmin-only. config/
// featureFlags is NOT client-readable (deny-by-default), so this reads via
// GET /api/feature-flags and writes via PUT — not a Firestore onSnapshot.
const FLAG_META: Record<FeatureFlag, { label: string; description: string }> = {
  rentCheckout: {
    label: "Rent checkout",
    description: "Tenant card rent payments via Stripe Checkout.",
  },
  connectOnboarding: {
    label: "Stripe Connect onboarding",
    description: "Owners starting or refreshing Connect onboarding.",
  },
  planUpgrades: { label: "Plan upgrades", description: "Owner plan upgrade / checkout." },
  askOlio: { label: "AskOlio (AI)", description: "The AI assistant." },
  rentIndexation: {
    label: "Rent indexation",
    description: "The daily automatic rent-increase sweep.",
  },
};

function FeatureFlagsCard() {
  const { toast } = useToast();
  const [flags, setFlags] = useState<Record<string, boolean> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingFlag, setSavingFlag] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/feature-flags");
        const json = (await res.json()) as { flags: Record<string, boolean> };
        if (!cancelled) setFlags(json.flags);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load feature flags");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(flag: FeatureFlag, next: boolean) {
    if (savingFlag) return;
    setSavingFlag(flag);
    const prev = flags;
    setFlags((f) => (f ? { ...f, [flag]: next } : f)); // optimistic
    try {
      const res = await apiRequest("PUT", "/api/feature-flags", { flags: { [flag]: next } });
      const json = (await res.json()) as { flags: Record<string, boolean> };
      setFlags(json.flags);
      toast({
        title: next ? `${FLAG_META[flag].label} enabled` : `${FLAG_META[flag].label} disabled`,
        description: next ? undefined : "This capability is now switched off for everyone.",
      });
    } catch (err) {
      setFlags(prev); // revert
      toast({
        title: "Failed to update feature flag",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSavingFlag(null);
    }
  }

  return (
    <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
      <h3 className="text-sm font-semibold text-foreground mb-1">Feature flags</h3>
      <p className="text-xs text-muted-foreground mb-4">
        Runtime kill-switches. Turn a capability OFF to stop the bleeding during an incident — takes
        effect within ~30s, no deploy. All default to on.
      </p>
      {error && <p className="text-xs text-destructive mb-3">{error}</p>}
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : flags ? (
        <div className="space-y-4">
          {FEATURE_FLAGS.map((flag) => (
            <div key={flag} className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-foreground">{FLAG_META[flag].label}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {FLAG_META[flag].description}
                </div>
              </div>
              <Switch
                checked={flags[flag] !== false}
                disabled={savingFlag !== null}
                onCheckedChange={(next) => void toggle(flag, next)}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface EmailIntegrationStatus {
  provider: string;
  connected: boolean;
  apiKey: boolean;
  from: boolean;
  webhookSecret: boolean;
  unsubscribeSecret: boolean;
}

function IntegrationsTab({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [status, setStatus] = useState<EmailIntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/admin/integrations/email/status");
        const json = (await res.json()) as EmailIntegrationStatus;
        if (!cancelled) setStatus(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load status");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const allReady = status?.connected && status.webhookSecret && status.unsubscribeSecret;
  const headline = !status
    ? "Checking…"
    : allReady
      ? "Resend is fully configured — sends, webhooks, and one-click unsubscribe all live."
      : status.connected && status.webhookSecret && !status.unsubscribeSecret
        ? "Send + webhooks ready. Unsubscribe secret missing — campaigns will ship without one-click unsubscribe links."
        : status.connected
          ? "Sending is configured. Webhook secret missing — delivery + open + click events will be ignored."
          : "Not connected — set the Resend secrets below to start sending campaigns.";

  return (
    <div className="space-y-6">
      <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-start gap-3">
            <div className="bg-muted p-2.5 rounded-lg">
              <Plug size={18} className="text-foreground" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Resend — Email Marketing</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Transactional + marketing email delivery with Svix-signed event webhooks.
              </p>
            </div>
          </div>
          {loading ? (
            <span className="text-xs text-muted-foreground">Checking…</span>
          ) : status?.connected ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
              <Check size={12} /> Connected
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full">
              <AlertTriangle size={12} /> Not configured
            </span>
          )}
        </div>

        {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

        <p className="text-xs text-muted-foreground mb-4">{headline}</p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-5">
          <SecretChip label="API key" present={status?.apiKey} />
          <SecretChip label='"From" address' present={status?.from} />
          <SecretChip label="Webhook secret" present={status?.webhookSecret} />
          <SecretChip label="Unsubscribe secret" present={status?.unsubscribeSecret} />
        </div>

        <EmailQuotaWidget />

        {!allReady && (
          <div className="bg-muted/50 border border-border rounded-lg p-3 mb-4">
            <p className="text-xs font-semibold text-foreground mb-1.5">Set the missing secrets</p>
            <p className="text-[11px] text-muted-foreground mb-2">
              Run from the project root (one-time per environment):
            </p>
            <pre className="text-[11px] font-mono bg-card border border-border rounded p-2 overflow-x-auto leading-relaxed">
              {`firebase functions:secrets:set RESEND_API_KEY --project olio-wallet
firebase functions:secrets:set RESEND_FROM --project olio-wallet           # e.g. "Olio <noreply@oliowallet.com>"
firebase functions:secrets:set RESEND_WEBHOOK_SECRET --project olio-wallet # whsec_... from Resend dashboard
firebase functions:secrets:set UNSUBSCRIBE_SECRET --project olio-wallet    # openssl rand -hex 32`}
            </pre>
          </div>
        )}

        <button
          onClick={() => onNavigate("/admin/email-marketing")}
          className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition border border-border"
        >
          <div className="flex items-center gap-3">
            <div className="bg-muted p-2 rounded-lg">
              <Mail size={16} className="text-foreground" />
            </div>
            <div className="text-left">
              <div className="text-sm font-medium text-foreground">Go to Email Marketing</div>
              <div className="text-xs text-muted-foreground">
                Compose, schedule, and review campaigns
              </div>
            </div>
          </div>
          <ChevronRight size={16} className="text-muted-foreground" />
        </button>
      </div>

      <OneSignalCard />

      <OwnerPlansLiveStatus />
    </div>
  );
}

interface PushIntegrationStatus {
  provider: string;
  connected: boolean;
  appId: boolean;
  restApiKey: boolean;
}

function OneSignalCard() {
  const { toast } = useToast();
  const [status, setStatus] = useState<PushIntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testEmail, setTestEmail] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/admin/integrations/push/status");
        const json = (await res.json()) as PushIntegrationStatus;
        if (!cancelled) setStatus(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load status");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const headline = !status
    ? "Checking…"
    : status.connected
      ? "OneSignal is configured — pushes can be sent to any user who has allowed notifications on app.oliowallet.com."
      : status.appId
        ? "App ID detected, but REST API Key missing. Set the secret below to enable sends."
        : "Not configured — set the OneSignal secrets below.";

  const sendTest = async () => {
    const to = testEmail.trim().toLowerCase();
    if (!to) {
      toast({ title: "Enter a target email first", variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      const res = await apiRequest("POST", "/api/admin/push/test", { targetEmail: to });
      const json = (await res.json()) as {
        ok: boolean;
        notificationId: string;
        recipients: number;
        warning?: string;
      };
      if (json.warning) {
        toast({
          title: "Sent — but no active subscriptions",
          description: json.warning,
          variant: "destructive",
        });
      } else {
        toast({
          title: `Push delivered to ${json.recipients} device(s)`,
          description: `Notification id ${json.notificationId.slice(0, 8)}…`,
        });
      }
    } catch (err) {
      toast({
        title: "Test push failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-start gap-3">
          <div className="bg-muted p-2.5 rounded-lg">
            <Bell size={18} className="text-foreground" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">OneSignal — Web Push</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Browser push notifications for app.oliowallet.com via the OneSignal REST API.
            </p>
          </div>
        </div>
        {loading ? (
          <span className="text-xs text-muted-foreground">Checking…</span>
        ) : status?.connected ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
            <Check size={12} /> Connected
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full">
            <AlertTriangle size={12} /> Not configured
          </span>
        )}
      </div>

      {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

      <p className="text-xs text-muted-foreground mb-4">{headline}</p>

      <div className="grid grid-cols-2 gap-2 mb-5">
        <SecretChip label="App ID" present={status?.appId} />
        <SecretChip label="REST API Key" present={status?.restApiKey} />
      </div>

      {!status?.restApiKey && (
        <div className="bg-muted/50 border border-border rounded-lg p-3 mb-4">
          <p className="text-xs font-semibold text-foreground mb-1.5">Set the REST API Key</p>
          <p className="text-[11px] text-muted-foreground mb-2">
            From OneSignal → Settings → Keys & IDs, then run from the project root:
          </p>
          <pre className="text-[11px] font-mono bg-card border border-border rounded p-2 overflow-x-auto leading-relaxed">
            {`firebase functions:secrets:set ONESIGNAL_REST_API_KEY --project olio-wallet`}
          </pre>
        </div>
      )}

      <div className="border-t border-border pt-4">
        <p className="text-xs font-semibold text-foreground mb-1.5">Send test push</p>
        <p className="text-[11px] text-muted-foreground mb-3">
          Target user must have already opened app.oliowallet.com and allowed notifications.
        </p>
        <div className="flex gap-2">
          <input
            type="email"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            placeholder="user@example.com"
            disabled={sending || !status?.connected}
            className="flex-1 px-3 py-2 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
          />
          <button
            onClick={sendTest}
            disabled={sending || !testEmail || !status?.connected}
            className="px-4 py-2 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            <Send size={14} />
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Resend free-tier usage widget. Reads /api/admin/email-quota and
// renders today's + this-month's totals against the free-tier ceiling
// (100/day, 3,000/month). Color escalates as we approach the wall:
//   <75%   neutral muted gray
//   75-94% amber warning
//   >=95%  red — sends about to break
// This is operational telemetry, not a feature ad — keep it compact.
interface EmailQuotaSnapshot {
  dailyUsed: number;
  dailyLimit: number;
  monthlyUsed: number;
  monthlyLimit: number;
  dailyDate: string;
  monthlyMonth: string;
  percentDaily: number;
  percentMonthly: number;
}

function quotaTone(percent: number): {
  bar: string;
  text: string;
  border: string;
  bg: string;
} {
  if (percent >= 95) {
    return {
      bar: "bg-red-500",
      text: "text-red-700 dark:text-red-400",
      border: "border-red-500/30",
      bg: "bg-red-500/5",
    };
  }
  if (percent >= 75) {
    return {
      bar: "bg-amber-500",
      text: "text-amber-700 dark:text-amber-400",
      border: "border-amber-500/30",
      bg: "bg-amber-500/5",
    };
  }
  return {
    bar: "bg-foreground/60",
    text: "text-muted-foreground",
    border: "border-border",
    bg: "bg-muted/30",
  };
}

function EmailQuotaWidget() {
  const [data, setData] = useState<EmailQuotaSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/admin/email-quota");
        const json = (await res.json()) as EmailQuotaSnapshot;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load quota");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="mb-5 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Gauge size={12} /> Checking Resend usage…
        </span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mb-5 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <AlertTriangle size={12} /> Couldn't load Resend usage{error ? `: ${error}` : ""}
        </span>
      </div>
    );
  }

  const daily = quotaTone(data.percentDaily);
  const monthly = quotaTone(data.percentMonthly);
  const worst = data.percentDaily >= data.percentMonthly ? data.percentDaily : data.percentMonthly;
  const headline =
    worst >= 95
      ? "Quota almost exhausted — sends will fail within hours."
      : worst >= 75
        ? "Approaching free-tier cap — consider upgrading Resend."
        : "Free-tier usage well within limits.";

  return (
    <div className={`mb-5 rounded-lg border ${quotaTone(worst).border} ${quotaTone(worst).bg} p-3`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Gauge size={12} /> Resend free-tier usage
        </span>
        <span className={`text-[11px] font-medium ${quotaTone(worst).text}`}>{headline}</span>
      </div>
      <div className="space-y-2">
        <QuotaBar
          label="Today"
          subLabel={data.dailyDate}
          used={data.dailyUsed}
          limit={data.dailyLimit}
          percent={data.percentDaily}
          tone={daily}
        />
        <QuotaBar
          label="This month"
          subLabel={data.monthlyMonth}
          used={data.monthlyUsed}
          limit={data.monthlyLimit}
          percent={data.percentMonthly}
          tone={monthly}
        />
      </div>
    </div>
  );
}

function QuotaBar({
  label,
  subLabel,
  used,
  limit,
  percent,
  tone,
}: {
  label: string;
  subLabel: string;
  used: number;
  limit: number;
  percent: number;
  tone: ReturnType<typeof quotaTone>;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="font-medium text-foreground">
          {label}
          <span className="ml-1.5 text-muted-foreground">({subLabel})</span>
        </span>
        <span className={`tabular-nums ${tone.text}`}>
          {used.toLocaleString()} / {limit.toLocaleString()} emails ({percent}%)
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full ${tone.bar} transition-all`}
          style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
        />
      </div>
    </div>
  );
}

function SecretChip({ label, present }: { label: string; present: boolean | undefined }) {
  const ready = present === true;
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${
        ready
          ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-700"
          : "bg-muted/40 border-border text-muted-foreground"
      }`}
    >
      {ready ? <Check size={12} /> : <AlertTriangle size={12} />}
      <span className="font-medium">{label}</span>
    </div>
  );
}
