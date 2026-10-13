import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import {
  Moon,
  Sun,
  Monitor,
  Shield,
  LogOut,
  Image,
  Check,
  Eye,
  EyeOff,
  Lock,
  User,
  Mail,
  Phone,
  MapPin,
  Palette,
} from "lucide-react";
import { useState, useEffect } from "react";
import { EmailAuthProvider, reauthenticateWithCredential } from "firebase/auth";
import { apiRequest } from "@ui/lib/queryClient";
import { useToast } from "@ui/hooks/use-toast";
import { useAccentColor, ACCENT_COLORS } from "@/lib/accentStore";
import { useLocation } from "wouter";
import { useAuth } from "@ui/lib/useAuth";
import { useBannerSelection, saveBannerSelection } from "@ui/lib/bannerStore";
import { BANNER_IMAGE_OPTIONS } from "@shared/firestore-schema";
import { SignInMethodsDialog, GoogleIcon } from "@ui/components/common/SignInMethodsDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@ui/components/ui/dialog";
import { reauthErrorMessage } from "@ui/lib/authReauth";

// Profile Settings — the admin's personal account page. Holds the Profile and
// Appearance tabs that used to live inside /admin/settings; the main Settings
// page now keeps only platform-wide configuration (System, Integrations, Roles,
// Plans, Compliance, Documentation). Reached via the top-right avatar menu.
export default function AdminProfilePage() {
  const [, setLocation] = useLocation();
  const { profile, firebaseUser, signOut, refreshProfile } = useAuth();
  const { toast } = useToast();
  const hasPassword = (firebaseUser?.providerData ?? []).some((p) => p.providerId === "password");
  const fullName = `${profile?.firstName ?? ""} ${profile?.lastName ?? ""}`.trim();
  const initials = `${profile?.firstName?.[0] ?? ""}${profile?.lastName?.[0] ?? ""}`.toUpperCase();
  const roleLabel = profile?.roles?.includes("superadmin")
    ? "Super Admin"
    : profile?.platformRole
      ? profile.platformRole.charAt(0).toUpperCase() + profile.platformRole.slice(1)
      : "Platform Admin";
  const [accent, setAccent] = useAccentColor();
  // Remembers an avatar URL that failed to load (e.g. a stale Google photo
  // URL) so we render initials instead of a broken-image icon. Keyed on the
  // URL, so a later upload of a new photo is retried automatically.
  const [photoFailedSrc, setPhotoFailedSrc] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    const valid = ["Profile", "Appearance"];
    return requested && valid.includes(requested) ? requested : "Profile";
  });
  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    const stored = localStorage.getItem("theme");
    return (stored as "light" | "dark") || "system";
  });
  const [signInMethodsOpen, setSignInMethodsOpen] = useState(false);
  const [signInMethodsView, setSignInMethodsView] = useState<
    "list" | "add-password" | "change-password" | "change-email"
  >("change-password");
  const [profileSaveOpen, setProfileSaveOpen] = useState(false);
  const [profileSavePassword, setProfileSavePassword] = useState("");
  const [showProfileSavePassword, setShowProfileSavePassword] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState("");
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);

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

  const allBannerOptions = BANNER_IMAGE_OPTIONS;
  const { enabled: selectedBanners } = useBannerSelection();

  const toggleBanner = (src: string) => {
    const next = selectedBanners.includes(src)
      ? selectedBanners.filter((s) => s !== src)
      : [...selectedBanners, src];
    if (next.length === 0) {
      toast({
        title: "At least one banner required",
        description: "The dashboard needs at least one banner to cycle through.",
        variant: "destructive",
      });
      return;
    }
    saveBannerSelection(next).catch((err) =>
      toast({
        title: "Could not save banner selection",
        description: (err as Error)?.message ?? "Try again.",
        variant: "destructive",
      }),
    );
  };

  const handleLogout = async () => {
    await signOut();
    setLocation("/login");
  };

  const tabs = ["Profile", "Appearance"];

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-8 md:mb-2 mt-4 md:mt-0">
        <div className="md:hidden">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Profile Settings</h1>
          <p className="text-muted-foreground mt-1 text-sm">Manage your account and appearance</p>
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

      {/* Profile Tab */}
      {activeTab === "Profile" && (
        <div className="space-y-6">
          {/* Avatar & Name */}
          <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-4">Profile Information</h3>
            <div className="flex items-center gap-4 mb-6">
              <div className="w-16 h-16 bg-muted rounded-full overflow-hidden border-2 border-background shrink-0 flex items-center justify-center text-foreground font-semibold">
                {profile?.photoURL && profile.photoURL !== photoFailedSrc ? (
                  <img
                    src={profile.photoURL}
                    alt={fullName || "Admin"}
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                    onError={() => setPhotoFailedSrc(profile?.photoURL ?? null)}
                  />
                ) : (
                  <span>{initials || "A"}</span>
                )}
              </div>
              <div>
                <div className="font-semibold text-foreground">{fullName || "Admin"}</div>
                <div className="text-xs text-muted-foreground">{roleLabel}</div>
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
                <input
                  type="tel"
                  autoComplete="tel"
                  value={profileForm.phone}
                  onChange={(e) => setProfileForm((f) => ({ ...f, phone: e.target.value }))}
                  className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
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

          {/* Authentication */}
          <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-4">Authentication</h3>
            <div className="space-y-3">
              <button
                onClick={() => {
                  setSignInMethodsView(hasPassword ? "change-password" : "add-password");
                  setSignInMethodsOpen(true);
                }}
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
                onClick={() => {
                  setSignInMethodsView("change-email");
                  setSignInMethodsOpen(true);
                }}
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
              <button
                onClick={() => {
                  setSignInMethodsView("list");
                  setSignInMethodsOpen(true);
                }}
                className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition border border-border"
              >
                <div className="flex items-center gap-3">
                  <div className="bg-muted p-2 rounded-lg flex items-center justify-center">
                    <GoogleIcon />
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-medium text-foreground">Sign-in methods</div>
                    <div className="text-xs text-muted-foreground">
                      Manage Google and email + password sign-in
                    </div>
                  </div>
                </div>
              </button>
            </div>
          </div>

          <button
            onClick={handleLogout}
            className="w-full bg-card p-4 rounded-xl shadow-sm flex items-center justify-center gap-2 text-destructive font-semibold text-sm hover:bg-destructive/10 transition border border-border"
          >
            <LogOut size={16} className="rotate-180" />
            Log Out
          </button>
        </div>
      )}

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

          {/* Banner Wallpaper */}
          <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-2">
              <Image size={16} />
              Banner Wallpaper
            </h3>
            <p className="text-xs text-muted-foreground mb-3">
              Choose images for the dashboard banner carousel
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {allBannerOptions.map((opt) => {
                const active = selectedBanners.includes(opt.src);
                return (
                  <button
                    key={opt.src}
                    onClick={() => toggleBanner(opt.src)}
                    className={`relative group rounded-lg overflow-hidden border-2 transition-all aspect-video ${
                      active
                        ? "border-primary ring-2 ring-primary/20"
                        : "border-border hover:border-muted-foreground/40"
                    }`}
                  >
                    <img src={opt.src} alt={opt.label} className="w-full h-full object-cover" />
                    <div
                      className={`absolute inset-0 transition-all ${active ? "bg-black/20" : "bg-black/40 group-hover:bg-black/20"}`}
                    />
                    {active && (
                      <div className="absolute top-1.5 right-1.5 w-5 h-5 bg-primary rounded-full flex items-center justify-center">
                        <Check size={12} className="text-primary-foreground" />
                      </div>
                    )}
                    <span className="absolute bottom-1.5 left-2 text-[10px] font-medium text-white drop-shadow">
                      {opt.label}
                    </span>
                  </button>
                );
              })}
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

      <SignInMethodsDialog
        open={signInMethodsOpen}
        onOpenChange={setSignInMethodsOpen}
        initialView={signInMethodsView}
      />
    </div>
  );
}
