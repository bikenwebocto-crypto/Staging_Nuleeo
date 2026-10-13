import { useLocation } from "wouter";
import { useState, useEffect, useCallback } from "react";
import {
  User,
  LogOut,
  ChevronRight,
  Moon,
  Sun,
  Monitor,
  RefreshCw,
  CreditCard,
  Shield,
  Eye,
  EyeOff,
  Briefcase,
  Check,
  Lock,
  Building2,
  Home,
  ArrowRight,
  Palette,
  ShieldCheck,
  UserCog,
  Share2,
  ClipboardCheck,
  MailPlus,
  Bell,
  Trash2,
  Plus,
  Edit2,
  Scale,
  Wallet,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  type AuthError,
} from "firebase/auth";
import { Switch } from "@ui/components/ui/switch";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { PricingModal } from "@ui/components/common/PricingModal";
import { BankingSection } from "@ui/components/owner/BankingSection";
import { ProfileSettingsForm } from "@ui/components/common/ProfileSettingsForm";
import { DeleteAccountSection } from "@ui/components/common/DeleteAccountSection";
import { useComplianceDoc, type ComplianceDocKey } from "@ui/lib/complianceStore";
import { sanitizeComplianceHtml } from "@ui/lib/sanitizeHtml";
import { setFunctionalStorage } from "@ui/lib/cookieConsent";
import { cn } from "@ui/lib/utils";
import { useAuth } from "@ui/lib/useAuth";
import { usePlan } from "@ui/lib/usePlan";
import { usePlanLabels } from "@ui/lib/usePlanLabels";
import { useOneSignalSubscription, describePushUnavailable } from "@ui/lib/onesignal";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import { useSocialLinks } from "@ui/lib/socialStore";
import { SOCIAL_PLATFORM_KEYS, SOCIAL_PLATFORM_META } from "@shared/firestore-schema";
import { SOCIAL_ICONS } from "@ui/components/SocialIcons";

// Owner-side portfolio switcher data. Lives in the app's ActivePortfolio
// context (client/app/src/lib/activePortfolio.tsx), which this shared drawer
// can't import — so the app passes it in. Structurally a subset of
// AccessiblePortfolio, so the app can hand its query rows straight through.
// Only the mobile app's MobileHeader populates this; desktop already has the
// sidebar switcher and the platform/tenant surfaces leave it undefined.
export interface PortfolioSwitcherOption {
  ownerId: string;
  portfolioId: string;
  ownerName: string;
  ownerEmail: string;
  role: "self" | "legacy" | "legal" | "financial";
  isSelf: boolean;
}
export interface PortfolioSwitcherData {
  portfolios: PortfolioSwitcherOption[];
  activeOwnerId: string;
  // Mirror of ActivePortfolioContext.setActiveOwnerId — null means "self".
  onSelect: (ownerId: string | null) => void;
}

interface ProfileDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role?: "owner" | "tenant" | "admin";
  initialView?: string;
  // Path to navigate to after signOut. Apps choose: the user app sends signed-out
  // visitors to "/auth"; the admin platform sends them to "/login".
  signOutRedirect?: string;
  // If provided AND viewport is desktop (md+), tapping "Privacy & Terms"
  // navigates to this route instead of opening the in-drawer sub-view. Mobile
  // always uses the sub-view. The admin platform doesn't pass this — it has
  // no equivalent standalone page.
  privacyTermsHref?: string;
  // When set, the "Profile Settings" row navigates to this full settings page
  // (the same page desktop reaches via the avatar menu) instead of opening the
  // limited in-drawer profile form. This is how mobile reaches every account
  // setting — Notifications categories, Security (change email + sign-in
  // methods), and the full Appearance controls — at desktop parity. The user
  // app passes "/owner/settings" or "/tenant/settings"; hosts that don't mount
  // those routes (admin platform) omit it and keep the in-drawer sub-view.
  settingsHref?: string;
  // Owner-only portfolio switcher. When the owner has access to more than one
  // portfolio (their own + granted legacy/legal/financial), a "Switch Portfolio"
  // row appears that opens a list sub-view. Undefined (or a single portfolio)
  // hides the row entirely.
  portfolioSwitcher?: PortfolioSwitcherData;
}

type PrivacyTab = ComplianceDocKey | "delete";

function PrivacyTermsSubView({ signOutRedirect }: { signOutRedirect: string }) {
  const tabs: { key: PrivacyTab; label: string }[] = [
    { key: "privacy", label: "Privacy Policy" },
    { key: "terms", label: "Terms of Use" },
    { key: "gdpr", label: "GDPR" },
    { key: "owner-terms", label: "Owner Terms" },
    { key: "delete", label: "Delete Account" },
  ];
  const [activeTab, setActiveTab] = useState<PrivacyTab>("privacy");
  // Hooks can't be conditional — read the doc unconditionally; we just don't
  // render it when the Delete tab is active.
  const { html: content } = useComplianceDoc(activeTab === "delete" ? "privacy" : activeTab);

  return (
    <div className="px-5 mt-2">
      <div className="flex gap-1 bg-secondary/50 p-1 rounded-xl overflow-x-auto mb-4">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap",
              activeTab === tab.key
                ? tab.key === "delete"
                  ? "bg-destructive text-destructive-foreground shadow-sm"
                  : "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab === "delete" ? (
        <DeleteAccountSection signOutRedirect={signOutRedirect} />
      ) : (
        <div className="bg-card p-5 rounded-2xl shadow-sm border border-border max-h-[60vh] overflow-y-auto">
          <div
            className="compliance-preview text-sm text-muted-foreground leading-relaxed"
            dangerouslySetInnerHTML={{ __html: sanitizeComplianceHtml(content) }}
          />
        </div>
      )}
    </div>
  );
}

export function ProfileDrawer({
  open,
  onOpenChange,
  role = "owner",
  initialView,
  signOutRedirect = "/auth",
  privacyTermsHref,
  settingsHref,
  portfolioSwitcher,
}: ProfileDrawerProps) {
  const [, setLocation] = useLocation();
  const { profile, firebaseUser, signOut, refreshProfile } = useAuth();
  const { plan } = usePlan();
  const { config: planLabelsConfig } = usePlanLabels();
  const planLabel = planLabelsConfig.plans[plan]?.label ?? "Plan";
  const push = useOneSignalSubscription();
  // Master switch reflects what'll actually deliver to this device: the browser
  // must be subscribed AND the server-side preference must be on. Toggling
  // here writes both, so this surface stays in sync with /owner/settings and
  // /tenant/settings → Notifications.
  const pushMasterOn = push.subscribed && (profile?.notificationPrefs?.pushEnabled ?? true);
  const handlePushToggle = useCallback(
    async (next: boolean) => {
      if (!push.ready) return;
      if (next) await push.enable();
      else await push.disable();
      try {
        await apiRequest("PATCH", "/api/profile", { notificationPrefs: { pushEnabled: next } });
      } catch {
        // Non-fatal: server pref will resync next refreshProfile.
      }
    },
    [push],
  );
  const pushStatusLabel = !push.supported
    ? describePushUnavailable(push.unavailableReason).message
    : push.permission === "denied"
      ? "Blocked — enable in your browser settings"
      : pushMasterOn
        ? "On — you'll get alerts on this device"
        : "Tap to allow alerts on this device";
  const { links: socialLinks } = useSocialLinks();
  const activeSocials = SOCIAL_PLATFORM_KEYS.filter(
    (k) => (socialLinks[k] ?? "").trim().length > 0,
  );
  const isTenant = role === "tenant";
  const isAdmin = role === "admin";

  const [theme, setTheme] = useState(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("theme");
      if (stored) return stored;
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "light";
  });

  // accountType is the in-session view preference; seeded from the route role.
  // Real role membership lives on profile.roles; this just controls which dashboard
  // the user is currently looking at.
  const [accountType, setAccountType] = useState<"tenant" | "owner" | "admin">(role);

  const [themeMode, setThemeMode] = useState<"light" | "dark" | "system">(() => {
    if (typeof window === "undefined") return "system";
    const stored = localStorage.getItem("theme");
    return stored === "dark" || stored === "light" ? stored : "system";
  });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  // Only users with a password provider can change a password from here.
  // Google-only users have nothing to reauthenticate against — they need to
  // add a password via Sign-in methods first (handled elsewhere).
  const hasPasswordProvider = (firebaseUser?.providerData ?? []).some(
    (p) => p.providerId === "password",
  );

  function mapPasswordError(err: unknown): string {
    const code = (err as AuthError)?.code ?? "";
    switch (code) {
      case "auth/wrong-password":
      case "auth/invalid-credential":
        return "Current password is incorrect.";
      case "auth/too-many-requests":
        return "Too many attempts. Try again in a moment.";
      case "auth/weak-password":
        return "New password must be at least 6 characters.";
      case "auth/requires-recent-login":
        return "Please sign out and back in, then try again.";
      case "auth/network-request-failed":
        return "Network error. Check your connection and try again.";
      default:
        return (err as Error)?.message ?? "Something went wrong. Try again.";
    }
  }

  async function handleUpdatePassword() {
    setPasswordError("");
    if (!firebaseUser?.email) {
      setPasswordError("No email on file — sign out and back in, then retry.");
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError("New password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match.");
      return;
    }
    setPasswordBusy(true);
    try {
      const cred = EmailAuthProvider.credential(firebaseUser.email, currentPassword);
      await reauthenticateWithCredential(firebaseUser, cred);
      await updatePassword(firebaseUser, newPassword);
      setPasswordSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setPasswordError(mapPasswordError(err));
    } finally {
      setPasswordBusy(false);
    }
  }

  // Removed mock sub-views (profile, admin-profile, owner-profile, email-marketing,
  // social-media, support, compliance) — real pages exist for each; menu items
  // now navigate there directly so we don't ship hardcoded sample data in the drawer.
  type DrawerView =
    | "main"
    | "appearance"
    | "security"
    | "change-password"
    | "portfolio-roles"
    | "platform-roles"
    | "privacy-terms"
    | "banking-settings"
    | "portfolio-access"
    | "switch-portfolio"
    | "profile-settings";
  const [drawerView, setDrawerView] = useState<DrawerView>((initialView as DrawerView) || "main");

  // Owner-side portfolio switcher derived state. Only surfaced when there's
  // more than one portfolio to switch between (a lone "self" portfolio has
  // nothing to switch to, so the row stays hidden for the common case).
  const switcherPortfolios = portfolioSwitcher?.portfolios ?? [];
  const showPortfolioSwitcher = role === "owner" && switcherPortfolios.length > 1;
  const activeSwitcherPortfolio = switcherPortfolios.find(
    (p) => p.ownerId === portfolioSwitcher?.activeOwnerId,
  );
  const [ownerActivationOpen, setOwnerActivationOpen] = useState(false);
  const [activatingOwner, setActivatingOwner] = useState(false);

  // Banking state lives in the shared <BankingSection /> component — see
  // client/shared/components/owner/BankingSection.tsx. Don't dup it here.

  // Portfolio Access state — backed by config/portfolioAccessContacts via
  // /api/owner/access-contacts. We fetch on mount when the user opens the
  // portfolio-access view and refresh after every mutation; small enough
  // dataset (3 fixed slots) that React Query would be overkill here.
  type AccessContactRow = {
    id: string;
    type: string;
    name: string;
    email: string;
    status: string;
    permissions: string[];
  };
  const [accessContacts, setAccessContacts] = useState<AccessContactRow[]>([]);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessSaveError, setAccessSaveError] = useState<string | null>(null);
  const [accessSaving, setAccessSaving] = useState(false);
  const [showContactModal, setShowContactModal] = useState(false);
  const [activeContactType, setActiveContactType] = useState<string | null>(null);
  const [contactModalForm, setContactModalForm] = useState({ name: "", email: "" });
  const [isPricingOpen, setIsPricingOpen] = useState(false);

  const refreshAccessContacts = useCallback(async () => {
    setAccessLoading(true);
    try {
      const res = await apiRequest("GET", "/api/owner/access-contacts");
      const rows = (await res.json()) as Array<{
        id: string;
        type: string;
        name: string;
        email: string;
        status: string;
        permissions: string[];
      }>;
      setAccessContacts(rows);
    } catch (err) {
      // Surface only at write-time — initial load failures shouldn't block the
      // rest of the drawer. Log so it's debuggable.
      console.warn("[ProfileDrawer] access contacts fetch failed:", err);
    } finally {
      setAccessLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && initialView) setDrawerView(initialView as DrawerView);
    if (!open) setDrawerView("main");
  }, [open, initialView]);

  // Hydrate Portfolio Access from server when the view is opened. Owners
  // only; tenants/admins never see the sub-view (rendered only for owner role).
  useEffect(() => {
    if (open && drawerView === "portfolio-access" && role === "owner") {
      refreshAccessContacts();
    }
  }, [open, drawerView, role, refreshAccessContacts]);
  // Owner features are unlocked once the user upgrades from basic to a paid plan.
  const hasActivatedOwner = plan !== "basic";

  useEffect(() => {
    if (open) {
      const stored = localStorage.getItem("theme");
      setTheme(
        stored || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
      );
      setAccountType(role);
      setDrawerView("main");
    }
  }, [open, role]);

  const toggleTheme = () => {
    const newTheme = theme === "light" ? "dark" : "light";
    setTheme(newTheme);
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(newTheme);
    setFunctionalStorage("theme", newTheme);
  };

  const toggleAccountType = () => {
    // First time switching from tenant to owner — show activation drawer
    if (accountType === "tenant" && !hasActivatedOwner) {
      onOpenChange(false);
      setOwnerActivationOpen(true);
      return;
    }

    const newType = accountType === "tenant" ? "owner" : "tenant";
    setAccountType(newType);

    onOpenChange(false);

    if (newType === "tenant") {
      setLocation("/tenant");
    } else {
      setLocation("/owner");
    }
  };

  const activateOwnerView = async () => {
    if (activatingOwner) return;
    setActivatingOwner(true);
    try {
      await apiRequest("PATCH", "/api/profile", { ownerModeEnabled: true });
      await refreshProfile();
      setAccountType("owner");
      setOwnerActivationOpen(false);
      onOpenChange(false);
      setLocation("/owner");
    } catch {
      // Leave drawer open so the user can retry; button comes back out of busy state.
    } finally {
      setActivatingOwner(false);
    }
  };

  const handleLogout = async () => {
    onOpenChange(false);
    await signOut();
    setLocation(signOutRedirect);
  };

  const drawerTitles: Record<DrawerView, string | undefined> = {
    main: undefined,
    appearance: "Appearance",
    security: "Security",
    "change-password": "Security",
    "portfolio-roles": "Portfolio Roles",
    "platform-roles": "Platform Roles",
    "privacy-terms": "Privacy & Terms",
    "banking-settings": "Banking Settings",
    "portfolio-access": "Portfolio Access",
    "switch-portfolio": "Switch Portfolio",
    "profile-settings": "Profile Settings",
  };
  const drawerTitle = drawerTitles[drawerView];

  return (
    <>
      <ResponsiveDrawer
        open={open}
        onOpenChange={onOpenChange}
        title={drawerTitle}
        onBack={drawerView !== "main" ? () => setDrawerView("main") : undefined}
      >
        {/* Appearance Sub-View */}
        {drawerView === "appearance" && (
          <div className="px-5 mt-2">
            <div className="space-y-4">
              {/* Theme */}
              <div className="bg-card p-5 rounded-3xl border border-border shadow-sm">
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                  <Monitor size={16} /> Theme
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
                        setThemeMode(key);
                        if (key === "system") {
                          localStorage.removeItem("theme");
                          document.documentElement.classList.toggle(
                            "dark",
                            window.matchMedia("(prefers-color-scheme: dark)").matches,
                          );
                        } else {
                          setFunctionalStorage("theme", key);
                          document.documentElement.classList.toggle("dark", key === "dark");
                        }
                        setTheme(
                          key === "system"
                            ? window.matchMedia("(prefers-color-scheme: dark)").matches
                              ? "dark"
                              : "light"
                            : key,
                        );
                        window.dispatchEvent(new Event("theme-changed"));
                      }}
                      className={`flex-1 py-2.5 px-3 rounded-md flex items-center justify-center gap-2 text-sm font-medium transition-all ${
                        themeMode === key
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
          </div>
        )}

        {/* Change Password Sub-View */}
        {drawerView === "change-password" && (
          <div className="px-5 mt-2">
            <div className="bg-card p-5 rounded-3xl border border-border shadow-sm">
              {passwordSuccess ? (
                <div className="flex flex-col items-center py-6 gap-4">
                  <div className="w-16 h-16 rounded-full bg-success/15 flex items-center justify-center">
                    <Check size={32} className="text-success" />
                  </div>
                  <div className="text-center">
                    <h3 className="text-lg font-bold text-foreground">Password Updated</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Your password has been changed successfully.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setPasswordSuccess(false);
                      setDrawerView("main");
                    }}
                    className="w-full py-2.5 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition mt-2"
                  >
                    Done
                  </button>
                </div>
              ) : !hasPasswordProvider ? (
                <div className="flex flex-col items-center py-6 gap-4 text-center">
                  <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
                    <Lock size={28} className="text-muted-foreground" />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-foreground">
                      Set a password first
                    </h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Your account signs in with Google. Add a password from{" "}
                      <span className="font-medium text-foreground">Sign-in methods</span> to enable
                      password changes here.
                    </p>
                  </div>
                  <button
                    onClick={() => setDrawerView("main")}
                    className="w-full py-2.5 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition mt-2"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-1">
                    <Lock size={18} className="text-foreground" />
                    <h3 className="text-base font-semibold text-foreground">Change Password</h3>
                  </div>
                  <p className="text-xs text-muted-foreground mb-4">
                    Enter your current password and choose a new one
                  </p>

                  <div className="space-y-4">
                    <div>
                      <label className="text-sm font-medium text-foreground mb-1.5 block">
                        Current Password
                      </label>
                      <div className="relative">
                        <input
                          type={showCurrentPassword ? "text" : "password"}
                          value={currentPassword}
                          onChange={(e) => {
                            setCurrentPassword(e.target.value);
                            setPasswordError("");
                          }}
                          placeholder="Enter current password"
                          className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          {showCurrentPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-foreground mb-1.5 block">
                        New Password
                      </label>
                      <div className="relative">
                        <input
                          type={showNewPassword ? "text" : "password"}
                          value={newPassword}
                          onChange={(e) => {
                            setNewPassword(e.target.value);
                            setPasswordError("");
                          }}
                          placeholder="Enter new password"
                          className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowNewPassword(!showNewPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          {showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-foreground mb-1.5 block">
                        Confirm New Password
                      </label>
                      <div className="relative">
                        <input
                          type={showConfirmPassword ? "text" : "password"}
                          value={confirmPassword}
                          onChange={(e) => {
                            setConfirmPassword(e.target.value);
                            setPasswordError("");
                          }}
                          placeholder="Confirm new password"
                          className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                      {confirmPassword && newPassword !== confirmPassword && (
                        <p className="text-xs text-destructive mt-1">Passwords do not match</p>
                      )}
                    </div>
                  </div>

                  {passwordError && (
                    <p className="text-sm text-destructive mt-3 text-center" role="alert">
                      {passwordError}
                    </p>
                  )}

                  <div className="flex gap-3 mt-5">
                    <button
                      onClick={() => {
                        setCurrentPassword("");
                        setNewPassword("");
                        setConfirmPassword("");
                        setPasswordError("");
                        setDrawerView("main");
                      }}
                      className="flex-1 py-2.5 rounded-lg border border-border text-sm font-semibold text-foreground hover:bg-muted transition"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleUpdatePassword}
                      disabled={
                        passwordBusy ||
                        !currentPassword ||
                        !newPassword ||
                        !confirmPassword ||
                        newPassword !== confirmPassword
                      }
                      className="flex-1 py-2.5 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {passwordBusy ? "Updating…" : "Update Password"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Privacy & Terms Sub-View */}
        {drawerView === "privacy-terms" && (
          <PrivacyTermsSubView signOutRedirect={signOutRedirect} />
        )}

        {/* Admin Profile Sub-View */}
        {/* Portfolio Roles Sub-View */}
        {drawerView === "portfolio-roles" && (
          <div className="px-5 mt-2">
            <div className="bg-card p-5 rounded-3xl border border-border shadow-sm">
              <p className="text-xs text-muted-foreground mb-4">
                Configure what each role can access at the property level
              </p>
              <div className="space-y-3">
                {[
                  {
                    cat: "Property Management",
                    items: [
                      "View property details",
                      "Edit property information",
                      "Add / remove units",
                      "Transfer ownership",
                      "Delete property",
                    ],
                  },
                  { cat: "Tenant Management", items: ["View tenant list", "Add / remove tenants"] },
                  {
                    cat: "Financial",
                    items: ["View rent & payment history", "Record / process payments"],
                  },
                  {
                    cat: "Legal & Agreements",
                    items: ["View agreements", "Create / edit agreements", "Terminate agreements"],
                  },
                  {
                    cat: "Analytics & Insights",
                    items: ["View property analytics", "View portfolio overview", "Export data"],
                  },
                  {
                    cat: "Access & Permissions",
                    items: ["Invite users", "Manage role assignments", "View activity log"],
                  },
                ].map((g) => (
                  <div key={g.cat}>
                    <div className="text-xs font-bold text-foreground uppercase tracking-wider mb-2">
                      {g.cat}
                    </div>
                    {g.items.map((item) => (
                      <div
                        key={item}
                        className="text-sm text-muted-foreground py-1.5 pl-2 border-l-2 border-border ml-1 mb-1"
                      >
                        {item}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-4 text-center">
                Use the desktop settings page for full matrix editing
              </p>
            </div>
          </div>
        )}

        {/* Platform Roles Sub-View */}
        {drawerView === "platform-roles" && (
          <div className="px-5 mt-2">
            <div className="bg-card p-5 rounded-3xl border border-border shadow-sm">
              <p className="text-xs text-muted-foreground mb-4">
                Configure what each platform role can access in the admin panel
              </p>
              <div className="space-y-3">
                {[
                  {
                    cat: "User Management",
                    items: [
                      "View all users",
                      "Create / edit users",
                      "Suspend / deactivate users",
                      "Assign user roles",
                    ],
                  },
                  {
                    cat: "Platform Settings",
                    items: [
                      "View platform settings",
                      "Modify platform settings",
                      "Enable / disable maintenance mode",
                      "Manage platform branding",
                    ],
                  },
                  {
                    cat: "Financial Operations",
                    items: ["View all transactions", "Generate financial reports"],
                  },
                  {
                    cat: "Legal & Compliance",
                    items: ["View all agreements", "Manage compliance settings"],
                  },
                  {
                    cat: "Content & Communication",
                    items: [
                      "Manage email marketing",
                      "View activity log",
                      "Manage partner listings",
                    ],
                  },
                  {
                    cat: "Property & Unit Oversight",
                    items: ["View all properties", "Edit any property", "Delete properties"],
                  },
                ].map((g) => (
                  <div key={g.cat}>
                    <div className="text-xs font-bold text-foreground uppercase tracking-wider mb-2">
                      {g.cat}
                    </div>
                    {g.items.map((item) => (
                      <div
                        key={item}
                        className="text-sm text-muted-foreground py-1.5 pl-2 border-l-2 border-border ml-1 mb-1"
                      >
                        {item}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-4 text-center">
                Use the desktop settings page for full matrix editing
              </p>
            </div>
          </div>
        )}

        {/* Banking Settings Sub-View */}
        {drawerView === "banking-settings" && (
          <div className="px-5 mt-2">
            <BankingSection />
          </div>
        )}

        {/* Switch Portfolio Sub-View — mirrors the desktop sidebar switcher
            (DesktopSidebar.tsx) but in the drawer's card idiom. Selecting a
            portfolio flips the app-wide ActivePortfolio context, so we close
            the drawer afterwards to let the refreshed view show through. */}
        {drawerView === "switch-portfolio" && portfolioSwitcher && (
          <div className="px-5 mt-2">
            <p className="text-xs text-muted-foreground mb-4">
              Choose which portfolio you're managing. Your whole view updates to match.
            </p>
            <div className="bg-card rounded-3xl p-2 shadow-sm border border-border">
              {switcherPortfolios.map((p) => {
                const RoleIcon =
                  p.role === "self"
                    ? Wallet
                    : p.role === "legacy"
                      ? Shield
                      : p.role === "legal"
                        ? Scale
                        : CreditCard;
                const roleLabel =
                  p.role === "self"
                    ? "Owner"
                    : p.role === "legacy"
                      ? "Legacy"
                      : p.role === "legal"
                        ? "Legal"
                        : "Financial";
                const isActive = p.ownerId === portfolioSwitcher.activeOwnerId;
                return (
                  <button
                    key={p.ownerId}
                    type="button"
                    onClick={() => {
                      portfolioSwitcher.onSelect(p.isSelf ? null : p.ownerId);
                      onOpenChange(false);
                    }}
                    className={cn(
                      "w-full flex items-center gap-3 p-3.5 rounded-2xl text-left transition hover:bg-background",
                      isActive && "bg-background",
                    )}
                  >
                    <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center shrink-0">
                      <RoleIcon size={18} className="text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-mono font-semibold text-foreground truncate">
                          {p.portfolioId || "—"}
                        </span>
                        <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-secondary text-muted-foreground tracking-wide shrink-0">
                          {roleLabel}
                        </span>
                      </div>
                      <div className="text-[12px] text-muted-foreground truncate">
                        {p.ownerName || p.ownerEmail}
                      </div>
                    </div>
                    {isActive && <Check size={18} className="text-primary shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Profile Settings Sub-View */}
        {drawerView === "profile-settings" && (
          <div className="mt-2">
            <ProfileSettingsForm onSaved={() => setDrawerView("main")} />
          </div>
        )}

        {/* Portfolio Access Sub-View */}
        {drawerView === "portfolio-access" &&
          (() => {
            const contactTypes = [
              {
                id: "legacy",
                label: "Legacy Contact",
                description: "Designated contact for inheritance purposes.",
                icon: Shield,
                permissions: "VIEW ONLY",
                color: "text-info",
                bg: "bg-info/10",
              },
              {
                id: "legal",
                label: "Legal Contact",
                description: "Lawyer or legal representative.",
                icon: Scale,
                permissions: "VIEW & EDIT",
                color: "text-info",
                bg: "bg-info/10",
              },
              {
                id: "financial",
                label: "Financial Contact",
                description: "Accountant or financial advisor.",
                icon: CreditCard,
                permissions: "VIEW ONLY",
                color: "text-success",
                bg: "bg-success/10",
              },
            ];
            const handleOpenContactModal = (type: string) => {
              const existing = accessContacts.find((c) => c.type === type);
              if (existing) setContactModalForm({ name: existing.name, email: existing.email });
              else setContactModalForm({ name: "", email: "" });
              setActiveContactType(type);
              setAccessSaveError(null);
              setShowContactModal(true);
            };
            const handleSaveContact = async () => {
              if (!activeContactType || accessSaving) return;
              setAccessSaveError(null);
              setAccessSaving(true);
              try {
                await apiRequest("PUT", `/api/owner/access-contacts/${activeContactType}`, {
                  name: contactModalForm.name.trim(),
                  email: contactModalForm.email.trim(),
                });
                await refreshAccessContacts();
                setShowContactModal(false);
                setContactModalForm({ name: "", email: "" });
              } catch (err) {
                // Server returns 404 with a useful message when the email has no Olio
                // account yet ("Ask them to sign up at app.oliowallet.com first").
                setAccessSaveError(parseApiError(err, "Could not save contact"));
              } finally {
                setAccessSaving(false);
              }
            };
            const handleDeleteContact = async (type: string) => {
              try {
                await apiRequest("DELETE", `/api/owner/access-contacts/${type}`);
                await refreshAccessContacts();
              } catch (err) {
                console.warn("[ProfileDrawer] delete access contact failed:", err);
              }
            };
            return (
              <div className="px-5 mt-2">
                <p className="text-xs text-muted-foreground mb-4">
                  Manage who has access to your data and properties
                </p>
                {accessLoading && accessContacts.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-2">
                    Loading contacts…
                  </p>
                )}
                <div className="space-y-4">
                  {contactTypes.map((type) => {
                    const assignedContact = accessContacts.find((c) => c.type === type.id);
                    return (
                      <div
                        key={type.id}
                        className="bg-secondary/30 p-4 rounded-2xl border border-border"
                      >
                        <div className="flex items-start justify-between mb-1">
                          <div className="flex items-center gap-3">
                            <div
                              className={`w-10 h-10 rounded-full flex items-center justify-center ${type.bg}`}
                            >
                              <type.icon size={18} className={type.color} />
                            </div>
                            <div>
                              <h3 className="font-bold text-foreground text-sm">{type.label}</h3>
                              <p className="text-[12px] text-muted-foreground">
                                {type.description}
                              </p>
                            </div>
                          </div>
                          <span className="text-[10px] font-bold bg-secondary text-muted-foreground px-2 py-1 rounded-lg uppercase flex-shrink-0 mt-1">
                            {(() => {
                              // When the slot is filled, show what the server actually granted —
                              // tracks any backend change to ACCESS_PERMISSIONS_BY_TYPE. When the
                              // slot is empty, fall back to the static "this is what they'd get"
                              // preview so the user knows what assigning will do.
                              const perms = assignedContact?.permissions;
                              if (perms && perms.length > 0) {
                                return perms.includes("edit") ? "View & Edit" : "View Only";
                              }
                              return type.permissions;
                            })()}
                          </span>
                        </div>
                        {assignedContact ? (
                          <div className="mt-3 bg-background rounded-xl p-3 flex items-center justify-between border border-border">
                            <div className="flex items-center gap-2 overflow-hidden">
                              <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-muted-foreground font-bold text-xs flex-shrink-0">
                                {assignedContact.name.charAt(0)}
                              </div>
                              <div className="min-w-0">
                                <p className="text-sm font-bold text-foreground truncate">
                                  {assignedContact.name}
                                </p>
                                <p className="text-[11px] text-muted-foreground truncate">
                                  {assignedContact.email}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {(() => {
                                const status = (assignedContact.status ?? "active").toLowerCase();
                                const badgeClass =
                                  status === "active"
                                    ? "bg-success/15 text-success"
                                    : status === "pending"
                                      ? "bg-warning/15 text-warning"
                                      : "bg-secondary text-muted-foreground";
                                return (
                                  <span
                                    className={`text-[10px] px-2 py-0.5 rounded-md font-bold uppercase ${badgeClass} mr-1`}
                                  >
                                    {status}
                                  </span>
                                );
                              })()}
                              <button
                                onClick={() => handleOpenContactModal(type.id)}
                                className="p-1.5 text-muted-foreground hover:text-foreground transition rounded-lg hover:bg-secondary"
                              >
                                <Edit2 size={14} />
                              </button>
                              <button
                                onClick={() => handleDeleteContact(type.id)}
                                className="p-1.5 text-muted-foreground hover:text-destructive transition rounded-lg hover:bg-destructive/10"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleOpenContactModal(type.id)}
                            className="mt-3 w-full py-3 border border-dashed border-border rounded-xl text-muted-foreground text-sm font-medium hover:bg-background transition flex items-center justify-center gap-2"
                          >
                            <Plus size={16} /> Assign {type.label}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {showContactModal && activeContactType && (
                  <div className="mt-6 bg-secondary/30 rounded-2xl p-5 border border-border">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="font-semibold text-foreground text-sm">
                        {accessContacts.find((c) => c.type === activeContactType)
                          ? "Edit"
                          : "Assign"}{" "}
                        Contact
                      </h4>
                      <button
                        onClick={() => setShowContactModal(false)}
                        className="p-1.5 hover:bg-secondary rounded-lg transition"
                      >
                        <X size={16} className="text-muted-foreground" />
                      </button>
                    </div>
                    <div className="space-y-3 mb-4">
                      <div className="space-y-1.5">
                        <label className="text-xs font-bold text-muted-foreground uppercase ml-1">
                          Contact Name
                        </label>
                        <input
                          type="text"
                          value={contactModalForm.name}
                          onChange={(e) => {
                            setContactModalForm({ ...contactModalForm, name: e.target.value });
                            setAccessSaveError(null);
                          }}
                          placeholder="e.g. John Smith"
                          className="w-full bg-background border border-border rounded-xl px-4 py-3 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-bold text-muted-foreground uppercase ml-1">
                          Email Address
                        </label>
                        <input
                          type="email"
                          value={contactModalForm.email}
                          onChange={(e) => {
                            setContactModalForm({ ...contactModalForm, email: e.target.value });
                            setAccessSaveError(null);
                          }}
                          placeholder="john@example.com"
                          className="w-full bg-background border border-border rounded-xl px-4 py-3 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                      </div>
                    </div>
                    {accessSaveError && (
                      <p className="text-sm text-destructive mb-3 text-center" role="alert">
                        {accessSaveError}
                      </p>
                    )}
                    <button
                      onClick={handleSaveContact}
                      disabled={accessSaving || !contactModalForm.name || !contactModalForm.email}
                      className="w-full bg-primary text-primary-foreground font-bold py-3.5 rounded-xl active:scale-[0.98] transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      <Check size={18} /> {accessSaving ? "Saving…" : "Save Contact"}
                    </button>
                  </div>
                )}
              </div>
            );
          })()}

        {/* Main View */}
        {drawerView === "main" && (
          <>
            <div className="pt-2" />

            <div className="px-5 space-y-4 mt-2">
              {/* Settings Tabs */}
              {isAdmin && (
                <div className="bg-card rounded-3xl p-2 shadow-sm border border-border">
                  <button
                    type="button"
                    onClick={() => setDrawerView("appearance")}
                    className="w-full text-left"
                  >
                    <MenuItem icon={Palette} label="Appearance" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDrawerView("change-password")}
                    className="w-full text-left"
                  >
                    <MenuItem icon={ShieldCheck} label="Security" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      setLocation("/admin/profile");
                    }}
                    className="w-full text-left"
                  >
                    <MenuItem icon={UserCog} label="Profile" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      setLocation("/admin/email-marketing");
                    }}
                    className="w-full text-left"
                  >
                    <MenuItem icon={MailPlus} label="Email Marketing" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      setLocation("/admin/social-media");
                    }}
                    className="w-full text-left"
                  >
                    <MenuItem icon={Share2} label="Social Media" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      setLocation("/admin/settings?tab=Compliance");
                    }}
                    className="w-full text-left"
                  >
                    <MenuItem icon={ClipboardCheck} label="Compliance" />
                  </button>
                  {/* Full platform settings page — the only mobile entry to the
                      System (Maintenance), Integrations, role-matrix, Owner
                      Plans and Documentation tabs, which the desktop sidebar
                      reaches but the bottom nav omits. */}
                  <button
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      setLocation("/admin/settings");
                    }}
                    className="w-full text-left"
                  >
                    <MenuItem icon={SlidersHorizontal} label="Platform Settings" isLast />
                  </button>
                </div>
              )}

              {/* Menu Group 1 */}
              {!isAdmin && (
                <div className="bg-card rounded-3xl p-2 shadow-sm border border-border ">
                  <button
                    type="button"
                    onClick={() => {
                      // Mirror desktop: the avatar menu's "Profile Settings"
                      // opens the full /owner|tenant/settings page (all tabs).
                      // When the host supplies that route, navigate there so
                      // mobile reaches every account setting at parity; else
                      // fall back to the limited in-drawer profile form.
                      if (settingsHref) {
                        onOpenChange(false);
                        setLocation(settingsHref);
                      } else {
                        setDrawerView("profile-settings");
                      }
                    }}
                    className="w-full text-left"
                  >
                    <MenuItem icon={User} label="Profile Settings" />
                  </button>

                  {!isAdmin && (
                    <div className="flex items-center justify-between p-3.5 hover:bg-background rounded-2xl transition">
                      <label
                        htmlFor="profile-drawer-theme-toggle"
                        className="flex items-center gap-4 cursor-pointer flex-1"
                      >
                        {theme === "dark" ? (
                          <Moon size={20} className="text-foreground" strokeWidth={1.75} />
                        ) : (
                          <Sun size={20} className="text-foreground" strokeWidth={1.75} />
                        )}
                        <span className="font-medium text-foreground text-[15px]">
                          {theme === "dark" ? "Dark Mode" : "Light Mode"}
                        </span>
                      </label>
                      <Switch
                        id="profile-drawer-theme-toggle"
                        checked={theme === "dark"}
                        onCheckedChange={toggleTheme}
                      />
                    </div>
                  )}

                  {(push.supported || push.unavailableReason === "setup-incomplete") && (
                    <div className="flex items-center justify-between p-3.5 rounded-2xl">
                      <div className="flex items-center gap-4 min-w-0">
                        <Bell size={20} className="text-foreground" strokeWidth={1.75} />
                        <div className="flex flex-col min-w-0">
                          <span className="font-medium text-foreground text-[15px]">
                            Push Notifications
                          </span>
                          <span className="text-[12px] text-muted-foreground mt-0.5 truncate">
                            {pushStatusLabel}
                          </span>
                        </div>
                      </div>
                      {!push.supported ? (
                        <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-muted text-muted-foreground shrink-0">
                          {describePushUnavailable(push.unavailableReason).badge}
                        </span>
                      ) : push.permission === "denied" ? (
                        <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-warning/15 text-warning shrink-0">
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
                  )}

                  {!isAdmin && (
                    <>
                      <button
                        type="button"
                        onClick={toggleAccountType}
                        className="w-full text-left"
                      >
                        {accountType === "tenant" && !hasActivatedOwner ? (
                          <MenuItem
                            icon={Building2}
                            label="Own a property?"
                            badge="New"
                            badgeClass="bg-primary text-primary-foreground px-3"
                          />
                        ) : (
                          <MenuItem
                            icon={RefreshCw}
                            label="Switch Account View"
                            badge={accountType === "tenant" ? "Tenant" : "Owner"}
                            badgeClass={
                              accountType === "tenant"
                                ? "bg-destructive text-destructive-foreground px-3"
                                : "bg-success text-success-foreground px-3"
                            }
                          />
                        )}
                      </button>

                      {showPortfolioSwitcher && (
                        <button
                          type="button"
                          onClick={() => setDrawerView("switch-portfolio")}
                          className="w-full text-left"
                        >
                          <MenuItem
                            icon={Wallet}
                            label="Switch Portfolio"
                            subText={
                              activeSwitcherPortfolio
                                ? activeSwitcherPortfolio.isSelf
                                  ? "Your portfolio"
                                  : activeSwitcherPortfolio.ownerName ||
                                    activeSwitcherPortfolio.portfolioId
                                : undefined
                            }
                          />
                        </button>
                      )}

                      {role === "owner" && (
                        <button
                          type="button"
                          onClick={() => setDrawerView("banking-settings")}
                          className="w-full text-left"
                        >
                          <MenuItem icon={CreditCard} label="Banking Settings" />
                        </button>
                      )}

                      {role === "owner" && (
                        <button
                          type="button"
                          onClick={() => setDrawerView("portfolio-access")}
                          className="w-full text-left"
                        >
                          <MenuItem icon={Briefcase} label="Portfolio Access" isLast />
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}

              {role === "owner" && (
                <div className="bg-card rounded-3xl p-4 shadow-sm border border-border">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{planLabel}</p>
                      {plan !== "business" && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          Tap upgrade for more units + features
                        </p>
                      )}
                    </div>
                    {plan !== "business" && (
                      <button
                        onClick={() => setIsPricingOpen(true)}
                        className="px-4 py-1.5 text-xs font-bold border border-border rounded-lg text-foreground hover:bg-muted transition"
                      >
                        UPGRADE
                      </button>
                    )}
                  </div>
                </div>
              )}

              {!isAdmin && (
                <div className="bg-card rounded-3xl p-2 shadow-sm border border-border ">
                  <button
                    type="button"
                    onClick={() => setDrawerView("change-password")}
                    className="w-full text-left"
                  >
                    <MenuItem icon={Shield} label="Change Password" />
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      if (
                        privacyTermsHref &&
                        typeof window !== "undefined" &&
                        window.matchMedia("(min-width: 768px)").matches
                      ) {
                        onOpenChange(false);
                        setLocation(privacyTermsHref);
                      } else {
                        setDrawerView("privacy-terms");
                      }
                    }}
                    className="w-full text-left"
                  >
                    <MenuItem icon={Eye} label="Privacy & Terms" isLast />
                  </button>
                </div>
              )}

              {/* Logout Button */}
              <button
                onClick={handleLogout}
                className="w-full bg-card p-4 rounded-3xl shadow-sm flex items-center justify-center gap-2 text-destructive font-bold hover:bg-destructive/10 transition border border-border mt-6"
              >
                <LogOut size={20} className="rotate-180" />
                Log Out
              </button>

              {activeSocials.length > 0 && (
                <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                  {activeSocials.map((key) => {
                    const { Icon } = SOCIAL_ICONS[key];
                    const meta = SOCIAL_PLATFORM_META[key];
                    return (
                      <a
                        key={key}
                        href={socialLinks[key]}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={meta.label}
                        className="w-9 h-9 rounded-full bg-secondary/60 flex items-center justify-center text-muted-foreground/70 hover:bg-secondary hover:text-foreground transition"
                      >
                        <Icon className="w-4 h-4" />
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </ResponsiveDrawer>

      {/* Owner Activation Drawer */}
      <ResponsiveDrawer
        open={ownerActivationOpen}
        onOpenChange={setOwnerActivationOpen}
        title="Activate Landlord View"
        footer={
          <div className="space-y-2.5">
            <button
              onClick={activateOwnerView}
              disabled={activatingOwner}
              className="w-full bg-primary text-primary-foreground font-semibold py-3 rounded-2xl hover:bg-primary/90 transition active:scale-[0.98] flex items-center justify-center gap-2 text-[15px] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {activatingOwner ? "Activating…" : "Activate Landlord View"}
              {!activatingOwner && <ArrowRight size={16} />}
            </button>
            <button
              onClick={() => setOwnerActivationOpen(false)}
              disabled={activatingOwner}
              className="w-full text-muted-foreground font-medium py-2.5 rounded-2xl hover:bg-muted/50 transition text-sm disabled:opacity-60"
            >
              Maybe later
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-2xl overflow-hidden -mx-1">
            <img src="/landlord-hero.jpg" alt="Landlord" className="w-full object-contain" />
          </div>
          <p className="text-sm text-muted-foreground">
            Unlock property management tools to list, manage, and track your own properties.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-muted/50 border border-border rounded-2xl p-4 flex flex-col items-center gap-2 text-center">
              <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                <Home size={18} className="text-muted-foreground" />
              </div>
              <span className="text-sm font-medium text-foreground">Manage your portfolio</span>
            </div>
            <div className="bg-muted/50 border border-border rounded-2xl p-4 flex flex-col items-center gap-2 text-center">
              <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                <Building2 size={18} className="text-muted-foreground" />
              </div>
              <span className="text-sm font-medium text-foreground">Rent your property</span>
            </div>
            <div className="bg-muted/50 border border-border rounded-2xl p-4 flex flex-col items-center gap-2 text-center">
              <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                <CreditCard size={18} className="text-muted-foreground" />
              </div>
              <span className="text-sm font-medium text-foreground">Collect rent</span>
            </div>
            <div className="bg-muted/50 border border-border rounded-2xl p-4 flex flex-col items-center gap-2 text-center">
              <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                <Briefcase size={18} className="text-muted-foreground" />
              </div>
              <span className="text-sm font-medium text-foreground">Track your income</span>
            </div>
          </div>
        </div>
      </ResponsiveDrawer>

      <PricingModal open={isPricingOpen} onOpenChange={setIsPricingOpen} />
    </>
  );
}

function MenuItem({
  icon: Icon,
  label,
  badge,
  badgeClass,
  isLast,
  rightElement,
  subText,
  leftElement,
}: {
  icon: any;
  label: string;
  badge?: string;
  badgeClass?: string;
  isLast?: boolean;
  rightElement?: React.ReactNode;
  subText?: string;
  leftElement?: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-center justify-between p-3.5 cursor-pointer hover:bg-background rounded-2xl transition`}
    >
      <div className="flex items-center gap-4">
        {leftElement ? (
          leftElement
        ) : (
          <Icon size={20} className="text-foreground " strokeWidth={1.75} />
        )}
        <div className="flex flex-col">
          <span className="font-medium text-foreground text-[15px]">{label}</span>
          {subText && <span className="text-[13px] text-muted-foreground mt-0.5">{subText}</span>}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {rightElement ? (
          rightElement
        ) : (
          <>
            {badge && (
              <span
                className={`text-[11px] font-bold px-2.5 py-1 rounded-full text-center ${
                  badgeClass
                    ? badgeClass
                    : badge === "On"
                      ? "bg-success text-success-foreground"
                      : badge === "Off"
                        ? "bg-secondary text-muted-foreground "
                        : "bg-destructive text-destructive-foreground"
                }`}
              >
                {badge}
              </span>
            )}
            <ChevronRight size={16} className="text-muted-foreground/70 " strokeWidth={1.5} />
          </>
        )}
      </div>
    </div>
  );
}
