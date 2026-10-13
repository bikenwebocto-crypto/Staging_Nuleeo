import {
  Moon,
  Sun,
  Monitor,
  Shield,
  LogOut,
  Check,
  Eye,
  EyeOff,
  Lock,
  User,
  Mail,
  Phone,
  MapPin,
  Palette,
  CreditCard,
  Bell,
  MessageSquare,
  Wrench,
  Building2,
  TrendingUp,
  Megaphone,
} from "lucide-react";
import { useState, useEffect } from "react";
import { EmailAuthProvider, reauthenticateWithCredential, type AuthError } from "firebase/auth";
import { Switch } from "@ui/components/ui/switch";
import { useAccentColor, ACCENT_COLORS } from "@/lib/accentStore";
import { AvatarUploader } from "@ui/components/common/AvatarUploader";
import { PhoneInput } from "@ui/components/common/PhoneInput";
import { SignInMethodsDialog, GoogleIcon } from "@ui/components/common/SignInMethodsDialog";
import { useLocation } from "wouter";
import { useAuth } from "@ui/lib/useAuth";
import { useOneSignalSubscription, describePushUnavailable } from "@ui/lib/onesignal";
import type { NotificationPrefs } from "@shared/firestore-schema";
import { apiRequest } from "@ui/lib/queryClient";
import { useToast } from "@ui/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@ui/components/ui/dialog";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { TableFiltersCard, FilterPills } from "@ui/components/ui/data-table";
import { PageHeader } from "@ui/components/common/PageHeader";

export default function OwnerSettingsPage() {
  const [, setLocation] = useLocation();
  const { profile, firebaseUser, signOut, refreshProfile } = useAuth();
  const { toast } = useToast();
  const [accent, setAccent] = useAccentColor();
  const [activeTab, setActiveTab] = useState("Profile");

  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    const stored = localStorage.getItem("theme");
    return (stored as "light" | "dark") || "system";
  });
  // Notification preferences: missing keys default to true (opt-in).
  // No `documents` toggle for owners — owners receive no document-category
  // push (documents go to the tenant); lease responses arrive under
  // propertyActivity. Listing it here would be an inert switch.
  const prefsFromProfile = (
    p: typeof profile,
  ): Required<
    Pick<
      NotificationPrefs,
      | "pushEnabled"
      | "rentPayments"
      | "messages"
      | "maintenance"
      | "propertyActivity"
      | "rentIncrease"
      | "marketingPush"
    >
  > => ({
    pushEnabled: p?.notificationPrefs?.pushEnabled ?? true,
    rentPayments: p?.notificationPrefs?.rentPayments ?? true,
    messages: p?.notificationPrefs?.messages ?? true,
    maintenance: p?.notificationPrefs?.maintenance ?? true,
    propertyActivity: p?.notificationPrefs?.propertyActivity ?? true,
    rentIncrease: p?.notificationPrefs?.rentIncrease ?? true,
    marketingPush: p?.notificationPrefs?.marketingPush ?? true,
  });
  const [notifPrefs, setNotifPrefs] = useState(() => prefsFromProfile(profile));
  const push = useOneSignalSubscription();
  // The user only gets pushes on this device when BOTH the browser is
  // subscribed AND their server-side preference says yes. Reflect that in the
  // master switch so it never lies about delivery capability.
  const pushMasterOn = push.subscribed && notifPrefs.pushEnabled;
  async function handlePushMasterToggle(next: boolean) {
    if (next) await push.enable();
    else await push.disable();
    await updateNotifPref("pushEnabled", next);
  }

  useEffect(() => {
    setNotifPrefs(prefsFromProfile(profile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    profile?.notificationPrefs?.pushEnabled,
    profile?.notificationPrefs?.rentPayments,
    profile?.notificationPrefs?.messages,
    profile?.notificationPrefs?.maintenance,
    profile?.notificationPrefs?.propertyActivity,
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

  // Sign-in methods (password change + Google link/unlink)
  const [signInMethodsOpen, setSignInMethodsOpen] = useState(false);
  const [signInMethodsView, setSignInMethodsView] = useState<
    "list" | "add-password" | "change-password" | "change-email"
  >("list");
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

  // Owner mode opt-out. Lets an account that activated the owner experience
  // drop back to tenant-only. Hidden for legacy users who never explicitly
  // opted in (ownerModeEnabled === undefined) — we don't want to surprise an
  // existing paid user by letting them disable their UI without realizing it.
  const ownerModeExplicitlyOn = profile?.ownerModeEnabled === true;
  const [disabledSaving, setDisabledSaving] = useState(false);
  async function handleDisableOwnerMode() {
    setDisabledSaving(true);
    try {
      await apiRequest("PATCH", "/api/profile", { ownerModeEnabled: false });
      await refreshProfile();
      toast({
        title: "Owner mode turned off",
        description: "You're back on the tenant experience.",
      });
      setLocation("/tenant");
    } catch (err: any) {
      toast({
        title: "Could not turn off owner mode",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    } finally {
      setDisabledSaving(false);
    }
  }

  // Profile save dialog
  const [profileSaveOpen, setProfileSaveOpen] = useState(false);
  const [profileSavePassword, setProfileSavePassword] = useState("");
  const [showProfileSavePassword, setShowProfileSavePassword] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState("");
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);

  // Controlled profile form. The reauth dialog gates the actual PATCH.
  const [profileForm, setProfileForm] = useState({
    firstName: profile?.firstName ?? "",
    lastName: profile?.lastName ?? "",
    phone: profile?.phone ?? "",
    address: profile?.address ?? "",
  });
  useEffect(() => {
    setProfileForm({
      firstName: profile?.firstName ?? "",
      lastName: profile?.lastName ?? "",
      phone: profile?.phone ?? "",
      address: profile?.address ?? "",
    });
  }, [profile?.firstName, profile?.lastName, profile?.phone, profile?.address]);

  function reauthErrorMessage(err: unknown): string {
    const code = (err as AuthError)?.code ?? "";
    switch (code) {
      case "auth/wrong-password":
      case "auth/invalid-credential":
        return "Incorrect password. Please try again.";
      case "auth/too-many-requests":
        return "Too many attempts. Try again in a moment.";
      case "auth/network-request-failed":
        return "Network error. Check your connection and try again.";
      default:
        return (err as Error)?.message ?? "Something went wrong. Please try again.";
    }
  }

  async function handleConfirmAndSave() {
    if (profileSaving) return;
    setProfileSaveError("");
    setProfileSaving(true);
    try {
      if (hasPassword) {
        if (!firebaseUser?.email) throw new Error("No email on account.");
        const cred = EmailAuthProvider.credential(firebaseUser.email, profileSavePassword);
        await reauthenticateWithCredential(firebaseUser, cred);
      }
      await apiRequest("PATCH", "/api/profile", {
        firstName: profileForm.firstName.trim(),
        lastName: profileForm.lastName.trim(),
        phone: profileForm.phone.trim(),
        address: profileForm.address.trim(),
      });
      await refreshProfile();
      setProfileSaved(true);
      setTimeout(() => setProfileSaveOpen(false), 1500);
    } catch (err) {
      setProfileSaveError(reauthErrorMessage(err));
    } finally {
      setProfileSaving(false);
    }
  }

  const handleLogout = async () => {
    await signOut();
    setLocation("/auth");
  };

  // Portfolio Access and Banking each live in the main sidebar at
  // /portfolio-access and /banking. The remaining tabs here are all
  // user-account settings.
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

          {/* Accent Color */}
          <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-2">
              <Palette size={16} />
              Accent Color
            </h3>
            <p className="text-xs text-muted-foreground mb-3">
              Choose a highlight color for the dashboard
            </p>
            <div className="flex flex-wrap gap-3">
              {ACCENT_COLORS.map((c) => (
                <button
                  key={c.hex}
                  onClick={() => setAccent(c.hex)}
                  className={`group relative w-9 h-9 rounded-full transition-all ${
                    accent === c.hex
                      ? "ring-2 ring-offset-2 ring-offset-background"
                      : "hover:scale-110"
                  }`}
                  style={
                    { backgroundColor: c.hex, "--tw-ring-color": c.hex } as React.CSSProperties
                  }
                  title={c.name}
                >
                  {accent === c.hex && (
                    <Check size={16} className="absolute inset-0 m-auto text-white drop-shadow" />
                  )}
                </button>
              ))}
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
              Get alerts on this device for portfolio activity
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
                  key: "rentPayments" as const,
                  icon: CreditCard,
                  title: "Rent payments",
                  desc: "Payments received, late, or failed",
                },
                {
                  key: "rentIncrease" as const,
                  icon: TrendingUp,
                  title: "Rent increases",
                  desc: "Scheduled indexation increases on your leases",
                },
                {
                  key: "messages" as const,
                  icon: MessageSquare,
                  title: "Messages",
                  desc: "New messages from your tenants and Olio Support",
                },
                {
                  key: "maintenance" as const,
                  icon: Wrench,
                  title: "Maintenance requests",
                  desc: "New and updated maintenance tickets",
                },
                {
                  key: "propertyActivity" as const,
                  icon: Building2,
                  title: "Property activity",
                  desc: "Lease responses, move-outs, and plan changes",
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
          <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-4">Profile Information</h3>
            <div className="flex items-center gap-4 mb-6">
              <AvatarUploader
                fallbackInitial={
                  `${profile?.firstName?.[0] ?? ""}${profile?.lastName?.[0] ?? ""}`.toUpperCase() ||
                  "O"
                }
              />
              <div>
                <div className="font-semibold text-foreground">
                  {`${profile?.firstName ?? ""} ${profile?.lastName ?? ""}`.trim() ||
                    "Property Owner"}
                </div>
                <div className="text-xs text-muted-foreground">Property Owner</div>
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
                    value={profileForm.firstName}
                    onChange={(e) => setProfileForm((f) => ({ ...f, firstName: e.target.value }))}
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
                    value={profileForm.lastName}
                    onChange={(e) => setProfileForm((f) => ({ ...f, lastName: e.target.value }))}
                    className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground flex items-center gap-2">
                  <Mail size={14} className="text-muted-foreground" />
                  Email Address
                </label>
                <input
                  type="email"
                  value={firebaseUser?.email ?? profile?.email ?? ""}
                  disabled
                  readOnly
                  className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted/60 text-muted-foreground text-sm focus:outline-none cursor-not-allowed"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground flex items-center gap-2">
                  <Phone size={14} className="text-muted-foreground" />
                  Phone Number
                </label>
                <PhoneInput
                  autoComplete="tel"
                  value={profileForm.phone}
                  onChange={(phone) => setProfileForm((f) => ({ ...f, phone }))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground flex items-center gap-2">
                  <MapPin size={14} className="text-muted-foreground" />
                  Location
                </label>
                <input
                  type="text"
                  autoComplete="street-address"
                  value={profileForm.address}
                  onChange={(e) => setProfileForm((f) => ({ ...f, address: e.target.value }))}
                  className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
            <div className="flex justify-end mt-6">
              <button
                onClick={() => {
                  setProfileSavePassword("");
                  setProfileSaveError("");
                  setShowProfileSavePassword(false);
                  setProfileSaved(false);
                  if (hasPassword) {
                    setProfileSaveOpen(true);
                  } else {
                    // Google-only users have no password to reauth against;
                    // save directly and toast on success.
                    (async () => {
                      setProfileSaving(true);
                      try {
                        await apiRequest("PATCH", "/api/profile", {
                          firstName: profileForm.firstName.trim(),
                          lastName: profileForm.lastName.trim(),
                          phone: profileForm.phone.trim(),
                          address: profileForm.address.trim(),
                        });
                        await refreshProfile();
                        toast({
                          title: "Profile updated",
                          description: "Your changes have been saved.",
                        });
                      } catch (err: any) {
                        toast({
                          title: "Could not save changes",
                          description: err?.message ?? "Please try again.",
                          variant: "destructive",
                        });
                      } finally {
                        setProfileSaving(false);
                      }
                    })();
                  }
                }}
                disabled={profileSaving}
                className="px-5 py-2.5 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {profileSaving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>

          {ownerModeExplicitlyOn && (
            <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <Building2 size={16} className="text-muted-foreground" />
                    Landlord View
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Turn off to return to the tenant-only experience. You can re-activate anytime
                    from Tenant Settings.
                  </div>
                </div>
                <button
                  onClick={handleDisableOwnerMode}
                  disabled={disabledSaving}
                  className="text-xs font-semibold px-4 py-2 rounded-full border border-border text-foreground hover:bg-muted transition shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {disabledSaving ? "Turning off…" : "Turn off"}
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
                onClick={() => setLocation("/owner/privacy")}
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

      {/* Sign-in methods (password + Google) */}
      <SignInMethodsDialog
        open={signInMethodsOpen}
        onOpenChange={setSignInMethodsOpen}
        initialView={signInMethodsView}
      />

      {/* Profile Save Password Confirmation Dialog */}
      <Dialog
        open={profileSaveOpen}
        onOpenChange={(open) => {
          setProfileSaveOpen(open);
          if (!open) {
            setProfileSavePassword("");
            setProfileSaveError("");
            setShowProfileSavePassword(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <Lock size={20} />
              Confirm Password
            </DialogTitle>
            <DialogDescription>
              Enter your password to save changes to your profile information.
            </DialogDescription>
          </DialogHeader>
          {profileSaved ? (
            <div className="flex flex-col items-center py-6 gap-3">
              <div className="w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                <Check size={24} className="text-emerald-600 dark:text-emerald-400" />
              </div>
              <p className="text-sm font-medium text-foreground">Profile updated successfully</p>
            </div>
          ) : (
            <>
              <div className="space-y-4 mt-2">
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      type={showProfileSavePassword ? "text" : "password"}
                      value={profileSavePassword}
                      onChange={(e) => {
                        setProfileSavePassword(e.target.value);
                        setProfileSaveError("");
                      }}
                      placeholder="Enter your password"
                      className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 pr-10"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && profileSavePassword && !profileSaving) {
                          void handleConfirmAndSave();
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowProfileSavePassword(!showProfileSavePassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showProfileSavePassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  {profileSaveError && (
                    <p className="text-xs text-destructive mt-1.5">{profileSaveError}</p>
                  )}
                </div>
              </div>
              <div className="flex gap-3 mt-4">
                <button
                  onClick={() => setProfileSaveOpen(false)}
                  disabled={profileSaving}
                  className="flex-1 py-2.5 rounded-lg border border-border text-sm font-semibold text-foreground hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleConfirmAndSave()}
                  disabled={!profileSavePassword || profileSaving}
                  className="flex-1 py-2.5 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {profileSaving ? "Saving…" : "Confirm & Save"}
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
