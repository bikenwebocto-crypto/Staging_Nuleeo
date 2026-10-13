import { AvatarUploader } from "@ui/components/common/AvatarUploader";
import { PhoneInput } from "@ui/components/common/PhoneInput";
import {
  Moon,
  Sun,
  Monitor,
  Shield,
  LogOut,
  Lock,
  Eye,
  User,
  Mail,
  Phone,
  Home,
  ArrowRight,
  RefreshCw,
  Building2,
  CreditCard,
  Briefcase,
  Bell,
  MessageSquare,
  Wrench,
  FileText,
  TrendingUp,
  Receipt,
  Megaphone,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Switch } from "@ui/components/ui/switch";
import { useLocation } from "wouter";
import { SignInMethodsDialog, GoogleIcon } from "@ui/components/common/SignInMethodsDialog";
import { PricingModal } from "@ui/components/common/PricingModal";
import { useAuth } from "@ui/lib/useAuth";
import { usePlan } from "@ui/lib/usePlan";
import { useOneSignalSubscription, describePushUnavailable } from "@ui/lib/onesignal";
import { apiRequest } from "@ui/lib/queryClient";
import { useToast } from "@ui/hooks/use-toast";
import type { NotificationPrefs } from "@shared/firestore-schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@ui/components/ui/dialog";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { TableFiltersCard, FilterPills } from "@ui/components/ui/data-table";
import { PageHeader } from "@ui/components/common/PageHeader";

export default function TenantSettingsPage() {
  const [, setLocation] = useLocation();
  const { profile, firebaseUser, signOut, refreshProfile } = useAuth();
  const { plan } = usePlan();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("Profile");

  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    const stored = localStorage.getItem("theme");
    return (stored as "light" | "dark") || "system";
  });
  // Notification preferences: missing keys default to true (opt-in).
  // rentPayments + propertyActivity are tenant-directed too (owner-verified
  // offline-payment confirmations, and new-lease / tenancy-ended events), so
  // they get their own toggles below — without them tenants couldn't mute
  // those categories individually.
  const prefsFromProfile = (
    p: typeof profile,
  ): Required<
    Pick<
      NotificationPrefs,
      | "pushEnabled"
      | "rentReminders"
      | "rentPayments"
      | "propertyActivity"
      | "messages"
      | "maintenance"
      | "documents"
      | "rentIncrease"
      | "marketingPush"
    >
  > => ({
    pushEnabled: p?.notificationPrefs?.pushEnabled ?? true,
    rentReminders: p?.notificationPrefs?.rentReminders ?? true,
    rentPayments: p?.notificationPrefs?.rentPayments ?? true,
    propertyActivity: p?.notificationPrefs?.propertyActivity ?? true,
    messages: p?.notificationPrefs?.messages ?? true,
    maintenance: p?.notificationPrefs?.maintenance ?? true,
    documents: p?.notificationPrefs?.documents ?? true,
    rentIncrease: p?.notificationPrefs?.rentIncrease ?? true,
    marketingPush: p?.notificationPrefs?.marketingPush ?? true,
  });
  const [notifPrefs, setNotifPrefs] = useState(() => prefsFromProfile(profile));
  const [signInMethodsOpen, setSignInMethodsOpen] = useState(false);
  const [signInMethodsView, setSignInMethodsView] = useState<
    "list" | "add-password" | "change-password" | "change-email"
  >("list");
  // Sign-in providers linked to this account (password + Google link/unlink).
  // Mirrors the owner Security tab so both personas show the same options.
  const providerIds = firebaseUser?.providerData.map((p) => p.providerId) ?? [];
  const hasPassword = providerIds.includes("password");
  const hasGoogle = providerIds.includes("google.com");
  const googleEmail =
    firebaseUser?.providerData.find((p) => p.providerId === "google.com")?.email ?? null;
  const openPasswordDialog = () => {
    setSignInMethodsView(hasPassword ? "change-password" : "add-password");
    setSignInMethodsOpen(true);
  };
  const openSignInMethods = () => {
    setSignInMethodsView("list");
    setSignInMethodsOpen(true);
  };
  const openEmailDialog = () => {
    setSignInMethodsView("change-email");
    setSignInMethodsOpen(true);
  };
  const [profileSaving, setProfileSaving] = useState(false);
  // Owner experience is an explicit opt-in stored on the user doc. New users
  // are tenant-only until they flip this from the Landlord View card below.
  // Legacy fallback: existing users without the field who already have the
  // owner role OR a paid plan keep their owner UI without re-enabling.
  const landlordActivated =
    profile?.ownerModeEnabled ?? (!!profile?.roles?.includes("owner") || plan !== "basic");
  const [activateDialogOpen, setActivateDialogOpen] = useState(false);
  const [activateSaving, setActivateSaving] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);

  const [formData, setFormData] = useState({
    firstName: profile?.firstName ?? "",
    lastName: profile?.lastName ?? "",
    email: profile?.email ?? "",
    phone: profile?.phone ?? "",
    location: profile?.address ?? "",
  });

  // Sync form when the profile loads/changes (e.g. after refreshProfile()).
  useEffect(() => {
    setFormData({
      firstName: profile?.firstName ?? "",
      lastName: profile?.lastName ?? "",
      email: profile?.email ?? "",
      phone: profile?.phone ?? "",
      location: profile?.address ?? "",
    });
  }, [profile?.firstName, profile?.lastName, profile?.email, profile?.phone, profile?.address]);

  useEffect(() => {
    setNotifPrefs(prefsFromProfile(profile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    profile?.notificationPrefs?.pushEnabled,
    profile?.notificationPrefs?.rentReminders,
    profile?.notificationPrefs?.rentPayments,
    profile?.notificationPrefs?.propertyActivity,
    profile?.notificationPrefs?.messages,
    profile?.notificationPrefs?.maintenance,
    profile?.notificationPrefs?.documents,
    profile?.notificationPrefs?.rentIncrease,
    profile?.notificationPrefs?.marketingPush,
  ]);

  async function updateNotifPref<K extends keyof typeof notifPrefs>(key: K, value: boolean) {
    const previous = notifPrefs;
    setNotifPrefs({ ...previous, [key]: value });
    try {
      await apiRequest("PATCH", "/api/profile", {
        notificationPrefs: { [key]: value },
      });
      await refreshProfile();
    } catch (err: any) {
      setNotifPrefs(previous);
      toast({
        title: "Could not save preference",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    }
  }

  const push = useOneSignalSubscription();
  // The user only gets pushes on this device when BOTH the browser is
  // subscribed AND their server-side preference says yes.
  const pushMasterOn = push.subscribed && notifPrefs.pushEnabled;
  async function handlePushMasterToggle(next: boolean) {
    if (next) await push.enable();
    else await push.disable();
    await updateNotifPref("pushEnabled", next);
  }

  async function handleSaveProfile() {
    const firstName = formData.firstName.trim();
    const lastName = formData.lastName.trim();
    if (!firstName) {
      toast({
        title: "First name required",
        description: "Please enter your first name.",
        variant: "destructive",
      });
      return;
    }
    setProfileSaving(true);
    try {
      await apiRequest("PATCH", "/api/profile", {
        firstName,
        lastName,
        phone: formData.phone.trim(),
      });
      await refreshProfile();
      toast({ title: "Profile updated", description: "Your changes have been saved." });
    } catch (err: any) {
      toast({
        title: "Could not save changes",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    } finally {
      setProfileSaving(false);
    }
  }

  const handleLogout = async () => {
    await signOut();
    setLocation("/auth");
  };

  async function handleActivateOwnerMode() {
    setActivateSaving(true);
    try {
      await apiRequest("PATCH", "/api/profile", { ownerModeEnabled: true });
      await refreshProfile();
      setActivateDialogOpen(false);
      toast({
        title: "Landlord view activated",
        description: "Switch between Tenant and Owner from the sidebar anytime.",
      });
      setLocation("/owner");
    } catch (err: any) {
      toast({
        title: "Could not activate",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    } finally {
      setActivateSaving(false);
    }
  }

  const tabs = ["Profile", "Security", "Notifications", "Appearance"];

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <PageHeader title="Settings" subtitle="Configure your experience" />

      {/* Pill Tabs */}
      <TableFiltersCard>
        <FilterPills
          // Settings tabs are primary navigation — wrap to extra rows on
          // narrow screens so none scroll off-screen behind the hidden
          // scrollbar (Notifications/Appearance were unreachable on mobile).
          className="flex-wrap"
          options={tabs.map((t) => ({ id: t, label: t }))}
          value={activeTab}
          onChange={setActiveTab}
        />
      </TableFiltersCard>

      {/* Appearance Tab */}
      {activeTab === "Appearance" && (
        <div className="space-y-6">
          {/* Theme Selector */}
          <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
              <Monitor size={16} />
              Theme
            </h3>
            <div className="flex p-1 bg-muted rounded-lg gap-1">
              {[
                { key: "light" as const, icon: Sun, label: "Light" },
                { key: "dark" as const, icon: Moon, label: "Dark" },
                { key: "system" as const, icon: Monitor, label: "System" },
              ].map(({ key, icon: Icon, label }) => (
                <button
                  key={key}
                  onClick={() => {
                    setTheme(key);
                    if (key === "system") {
                      localStorage.removeItem("theme");
                      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
                        document.documentElement.classList.add("dark");
                      } else {
                        document.documentElement.classList.remove("dark");
                      }
                    } else {
                      localStorage.setItem("theme", key);
                      document.documentElement.classList.toggle("dark", key === "dark");
                    }
                    window.dispatchEvent(new Event("theme-changed"));
                  }}
                  className={`flex-1 py-2.5 px-3 rounded-md flex items-center justify-center gap-2 text-sm font-medium transition-all ${
                    theme === key
                      ? "bg-foreground text-background shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Security Tab */}
      {activeTab === "Security" && (
        <div className="space-y-6">
          <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-4">Authentication</h3>
            <div className="space-y-3">
              <button
                type="button"
                onClick={openPasswordDialog}
                className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition border border-border"
              >
                <div className="flex items-center gap-3">
                  <div className="bg-muted p-2 rounded-lg">
                    <Shield size={16} className="text-foreground" />
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-medium text-foreground">
                      {hasPassword ? "Change Password" : "Add Password"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {hasPassword
                        ? "Update your account password"
                        : "Set a password to sign in with email"}
                    </div>
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={openEmailDialog}
                className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition border border-border"
              >
                <div className="flex items-center gap-3">
                  <div className="bg-muted p-2 rounded-lg">
                    <Mail size={16} className="text-foreground" />
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-medium text-foreground">Change Email</div>
                    <div className="text-xs text-muted-foreground">
                      {firebaseUser?.email ?? profile?.email ?? "Update your sign-in email"}
                    </div>
                  </div>
                </div>
              </button>
              {hasGoogle ? (
                <div
                  className="w-full flex items-center justify-between p-3 rounded-lg border border-border hover:bg-muted/50 transition cursor-pointer"
                  onClick={openSignInMethods}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openSignInMethods();
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="bg-muted p-2 rounded-lg flex items-center justify-center">
                      <GoogleIcon />
                    </div>
                    <div className="text-left min-w-0">
                      <div className="text-sm font-medium text-foreground flex items-center gap-2">
                        Google
                        <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                          Connected
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {googleEmail ?? "Signed in with Google"}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={openSignInMethods}
                  className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition border border-border"
                >
                  <div className="flex items-center gap-3">
                    <div className="bg-muted p-2 rounded-lg flex items-center justify-center">
                      <GoogleIcon />
                    </div>
                    <div className="text-left">
                      <div className="text-sm font-medium text-foreground">Connect Google</div>
                      <div className="text-xs text-muted-foreground">
                        Link a Google account to sign in
                      </div>
                    </div>
                  </div>
                </button>
              )}
            </div>
          </div>

          <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-4">Privacy</h3>
            <div className="space-y-3">
              <button
                onClick={() => setLocation("/tenant/privacy")}
                className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition border border-border"
              >
                <div className="flex items-center gap-3">
                  <div className="bg-muted p-2 rounded-lg">
                    <Eye size={16} className="text-foreground" />
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-medium text-foreground">Privacy & Terms</div>
                    <div className="text-xs text-muted-foreground">
                      View privacy policy and terms of service
                    </div>
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notifications Tab */}
      {activeTab === "Notifications" && (
        <div className="space-y-6">
          <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-2">
              <Bell size={16} />
              Push Notifications
            </h3>
            <p className="text-xs text-muted-foreground mb-4">
              Get alerts on this device for important updates
            </p>
            <div className="flex items-center justify-between p-3 rounded-lg border border-border">
              <div className="min-w-0 pr-3">
                <div className="text-sm font-medium text-foreground">Enable push notifications</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {!push.supported
                    ? describePushUnavailable(push.unavailableReason).message
                    : push.permission === "denied"
                      ? "Blocked — enable notifications for app.oliowallet.com in your browser settings, then refresh"
                      : pushMasterOn
                        ? "On — you'll get alerts on this device"
                        : "Master toggle for all alerts below"}
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
                  onCheckedChange={handlePushMasterToggle}
                  disabled={!push.ready}
                />
              )}
            </div>
          </div>

          <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-4">
              What you'll be notified about
            </h3>
            <div className={`space-y-3 ${pushMasterOn ? "" : "opacity-50 pointer-events-none"}`}>
              {[
                {
                  key: "rentReminders" as const,
                  icon: CreditCard,
                  title: "Rent reminders",
                  desc: "Upcoming and overdue rent payments",
                },
                {
                  key: "rentPayments" as const,
                  icon: Receipt,
                  title: "Payment confirmations",
                  desc: "When your landlord confirms a rent payment you've made",
                },
                {
                  key: "rentIncrease" as const,
                  icon: TrendingUp,
                  title: "Rent increases",
                  desc: "Advance notice when your rent is scheduled to change",
                },
                {
                  key: "propertyActivity" as const,
                  icon: Home,
                  title: "Tenancy updates",
                  desc: "New leases assigned to you and tenancy changes",
                },
                {
                  key: "messages" as const,
                  icon: MessageSquare,
                  title: "Messages",
                  desc: "New messages from your landlord and Olio Support",
                },
                // "Maintenance updates" gates the tenant push sent from
                // server/routes/adminContent.ts when an admin changes the status
                // of a property maintenance ticket (category: "maintenance").
                {
                  key: "maintenance" as const,
                  icon: Wrench,
                  title: "Maintenance updates",
                  desc: "Status changes on your maintenance requests",
                },
                {
                  key: "documents" as const,
                  icon: FileText,
                  title: "Lease & documents",
                  desc: "New documents shared with you",
                },
                {
                  key: "marketingPush" as const,
                  icon: Megaphone,
                  title: "Promotions & announcements",
                  desc: "Occasional product news and offers (separate from the alerts above)",
                },
              ].map(({ key, icon: Icon, title, desc }) => (
                <div
                  key={key}
                  className="flex items-center justify-between p-3 rounded-lg border border-border"
                >
                  <div className="flex items-center gap-3">
                    <div className="bg-muted p-2 rounded-lg">
                      <Icon size={16} className="text-foreground" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-foreground">{title}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
                    </div>
                  </div>
                  <Switch
                    checked={notifPrefs[key]}
                    onCheckedChange={(v) => updateNotifPref(key, v)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Profile Tab */}
      {activeTab === "Profile" && (
        <div className="space-y-6">
          {/* Profile Information */}
          <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-4">Profile Information</h3>
            <div className="flex items-center gap-4 mb-6">
              <AvatarUploader
                fallbackInitial={
                  `${profile?.firstName?.[0] ?? ""}${profile?.lastName?.[0] ?? ""}`.toUpperCase() ||
                  "T"
                }
              />
              <div>
                <div className="font-semibold text-foreground">
                  {`${formData.firstName} ${formData.lastName}`.trim() || "Tenant"}
                </div>
                <div className="text-xs text-muted-foreground">Tenant</div>
              </div>
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground flex items-center gap-2">
                    <User size={14} className="text-muted-foreground" />
                    First Name
                  </label>
                  <input
                    type="text"
                    autoComplete="given-name"
                    value={formData.firstName}
                    onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                    className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground flex items-center gap-2">
                    <User size={14} className="text-muted-foreground" />
                    Last Name
                  </label>
                  <input
                    type="text"
                    autoComplete="family-name"
                    value={formData.lastName}
                    onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                    className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground flex items-center gap-2">
                  <Mail size={14} className="text-muted-foreground" />
                  Email Address
                  <Lock size={12} className="text-muted-foreground ml-auto" />
                </label>
                <input
                  type="email"
                  value={formData.email}
                  readOnly
                  disabled
                  aria-readonly="true"
                  className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-muted-foreground text-sm cursor-not-allowed"
                />
                <p className="text-xs text-muted-foreground">
                  Your email is used to sign in and can't be changed here.
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground flex items-center gap-2">
                  <Phone size={14} className="text-muted-foreground" />
                  Phone Number
                </label>
                <PhoneInput
                  value={formData.phone}
                  onChange={(phone) => setFormData({ ...formData, phone })}
                />
              </div>
            </div>
            <div className="flex justify-end mt-6">
              <button
                onClick={handleSaveProfile}
                disabled={profileSaving}
                className="px-5 py-2.5 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {profileSaving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>

          {/* Landlord View */}
          {landlordActivated ? (
            <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                    <Building2 size={18} className="text-foreground" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-foreground">Landlord View</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Switch to manage your properties
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setLocation("/owner")}
                  className="flex items-center gap-2 text-xs font-semibold px-4 py-2 bg-foreground text-background rounded-full hover:opacity-90 transition shrink-0"
                >
                  <RefreshCw size={14} />
                  Switch View
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-base font-bold text-foreground">Own a Property?</div>
                  <div className="text-sm text-muted-foreground mt-0.5">Activate Landlord View</div>
                </div>
                <button
                  onClick={() => setActivateDialogOpen(true)}
                  className="text-xs font-semibold px-4 py-2 bg-foreground text-background rounded-full hover:opacity-90 transition shrink-0"
                >
                  Activate
                </button>
              </div>
            </div>
          )}

          <button
            onClick={handleLogout}
            className="w-full bg-destructive text-destructive-foreground p-4 rounded-xl shadow-sm flex items-center justify-center gap-2 font-semibold text-sm hover:bg-destructive/90 transition"
          >
            <LogOut size={16} className="rotate-180" />
            Log Out
          </button>
        </div>
      )}

      {/* Activate Landlord View Dialog */}
      <Dialog open={activateDialogOpen} onOpenChange={setActivateDialogOpen}>
        <DialogContent className="sm:max-w-md rounded-2xl p-0 overflow-hidden">
          <div className="p-5 pb-0">
            <DialogHeader>
              <DialogTitle className="text-foreground text-lg">Activate Landlord View</DialogTitle>
            </DialogHeader>
          </div>

          <div className="px-5">
            <div className="rounded-xl overflow-hidden mb-4">
              <img src="/landlord-hero.jpg" alt="Landlord" className="w-full object-contain" />
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Turn on Landlord View to add and manage your own properties. The free Starter plan
              gets you started; upgrade later for advanced features.
            </p>
            <div className="grid grid-cols-2 gap-3 mb-2">
              {[
                { icon: Home, label: "Manage your portfolio" },
                { icon: Building2, label: "Rent your property" },
                { icon: CreditCard, label: "Collect rent" },
                { icon: Briefcase, label: "Track your income" },
              ].map(({ icon: Icon, label }) => (
                <div
                  key={label}
                  className="bg-muted/50 border border-border rounded-2xl p-4 flex flex-col items-center gap-2 text-center"
                >
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                    <Icon size={18} className="text-muted-foreground" />
                  </div>
                  <span className="text-sm font-medium text-foreground">{label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="px-5 pb-5 space-y-3">
            <button
              onClick={handleActivateOwnerMode}
              disabled={activateSaving}
              className="w-full py-3 rounded-xl bg-foreground text-background text-sm font-semibold hover:opacity-90 transition flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {activateSaving ? "Activating…" : "Activate Landlord View"}
              {!activateSaving && <ArrowRight size={16} />}
            </button>
            <button
              onClick={() => {
                setActivateDialogOpen(false);
                setPricingOpen(true);
              }}
              className="w-full py-2 text-sm text-muted-foreground hover:text-foreground transition"
            >
              See plans first
            </button>
            <button
              onClick={() => setActivateDialogOpen(false)}
              className="w-full py-2 text-sm text-muted-foreground hover:text-foreground transition"
            >
              Maybe later
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <PricingModal open={pricingOpen} onOpenChange={setPricingOpen} />

      <SignInMethodsDialog
        open={signInMethodsOpen}
        onOpenChange={setSignInMethodsOpen}
        initialView={signInMethodsView}
      />
    </div>
  );
}
