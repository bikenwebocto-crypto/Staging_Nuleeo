import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Search, Plus, Calculator, User, Eye, LogOut, Moon, Sun, LifeBuoy } from "lucide-react";
import { ProfileDrawer } from "@ui/components/common/ProfileDrawer";
import { CommandPalette, type SearchItem } from "@ui/components/common/CommandPalette";
import { useAuth } from "@ui/lib/useAuth";
import { setFunctionalStorage } from "@ui/lib/cookieConsent";

// Minimal menu shape used to derive the page title from the current URL.
// Each app's mockData has more fields; we only need path+label here.
export interface HeaderTitleItem {
  path: string;
  label: string;
}

interface DesktopHeaderProps {
  role?: "owner" | "tenant" | "admin";
  actions?: React.ReactNode;
  // Items the header consults to derive the page title from the current URL.
  // Per-app: see client/<app>/src/lib/navItems.ts.
  menuItems: HeaderTitleItem[];
  // Path to navigate to after sign-out. Defaults to "/auth" (user app);
  // the admin platform should pass "/login".
  signOutRedirect?: string;
  // When set, renders a calculator icon button that links here.
  calculatorHref?: string;
  // App-specific buttons rendered immediately after the calculator and before
  // the search box (e.g. the user app's notifications bell). Kept as a slot so
  // shared header doesn't have to know about app-only hooks.
  headerExtras?: React.ReactNode;
  // Items powering the global Cmd/Ctrl-K command palette. When omitted, the
  // header search bar is hidden entirely so apps that don't supply data don't
  // ship a dead input.
  searchItems?: SearchItem[];
  // Forwarded to ProfileDrawer — when set, the drawer's Privacy & Terms item
  // navigates to this route on desktop instead of opening the in-drawer
  // sub-view. User app passes "/profile/privacy"; admin platform doesn't.
  privacyTermsHref?: string;
}

// Supplementary title map for routes not covered by sidebar menu items
const extraTitles: Record<string, string> = {
  "/profile/settings": "Settings",
  "/profile/portfolio-access": "Portfolio Access",
  "/tenant/settings": "Settings",
  "/payment-channels": "Payment Channels",
  "/marketplace": "Marketplace",
  "/faq": "FAQ",
  "/privacy": "Privacy Policy",
  "/profile/privacy": "Privacy & Terms",
  "/tenant/privacy": "Privacy & Terms",
  "/owner/privacy": "Privacy & Terms",
  "/admin/calculator": "Smart Calculator",
  "/admin/profile": "Profile Settings",
};

export function DesktopHeader({
  role = "owner",
  actions,
  menuItems,
  signOutRedirect = "/auth",
  calculatorHref,
  headerExtras,
  searchItems,
  privacyTermsHref,
}: DesktopHeaderProps) {
  const [location, setLocation] = useLocation();
  const { profile, signOut } = useAuth();
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [profileInitialView, setProfileInitialView] = useState<string | undefined>(undefined);
  // Remembers an avatar URL that failed to load (e.g. a stale Google photo
  // URL) so we render initials instead of a broken-image icon. Keyed on the
  // URL, so a later upload of a new photo is retried automatically.
  const [photoFailedSrc, setPhotoFailedSrc] = useState<string | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const showSearch = Array.isArray(searchItems) && searchItems.length > 0;

  useEffect(() => {
    if (!showSearch) return;
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsPaletteOpen((v) => !v);
      }
    }
    // Mobile headers (no Cmd-K) tap their search input and dispatch this
    // event so the palette can open without prop-drilling across layouts.
    function onOpenRequest() {
      setIsPaletteOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("command-palette:open", onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("command-palette:open", onOpenRequest);
    };
  }, [showSearch]);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    }
    if (showUserMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showUserMenu]);

  useEffect(() => {
    function onThemeChanged() {
      const stored = localStorage.getItem("theme");
      if (stored === "light" || stored === "dark") setTheme(stored);
      else setTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    }
    window.addEventListener("theme-changed", onThemeChanged);
    return () => window.removeEventListener("theme-changed", onThemeChanged);
  }, []);

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(next);
    setFunctionalStorage("theme", next);
    window.dispatchEvent(new Event("theme-changed"));
  };

  // Get current page title from menu items, then fall back to extra titles map
  const currentItem = menuItems.find((item) => {
    const isTopLevel = ["/", "/tenant", "/admin", "/owner"].includes(item.path);
    return location === item.path || (!isTopLevel && location.startsWith(item.path + "/"));
  });
  const pageTitle = currentItem?.label || extraTitles[location] || "Dashboard";

  // Prefer the user's own avatar (e.g. their Google profile picture, saved on
  // first sign-in). Fall back to null so the initials placeholder renders.
  const getProfileImage = () => profile?.photoURL ?? null;

  const getProfileName = () => {
    const full = `${profile?.firstName ?? ""} ${profile?.lastName ?? ""}`.trim();
    if (full) return full;
    if (role === "admin") return "Admin";
    if (role === "tenant") return "Tenant";
    return "Owner";
  };

  const getInitials = () => {
    const first = profile?.firstName?.[0] ?? "";
    const last = profile?.lastName?.[0] ?? "";
    const initials = `${first}${last}`.toUpperCase();
    if (initials) return initials;
    if (role === "admin") return "A";
    if (role === "tenant") return "T";
    return "O";
  };

  const getRoleLabel = () => {
    if (role === "admin") return "Platform Admin";
    if (role === "tenant") return "Tenant";
    return "Owner";
  };

  const profileImage = getProfileImage();

  return (
    <>
      <ProfileDrawer
        open={isProfileOpen}
        onOpenChange={(o) => {
          setIsProfileOpen(o);
          if (!o) setProfileInitialView(undefined);
        }}
        role={role}
        initialView={profileInitialView}
        signOutRedirect={signOutRedirect}
        privacyTermsHref={privacyTermsHref}
      />
      {showSearch && (
        <CommandPalette open={isPaletteOpen} onOpenChange={setIsPaletteOpen} items={searchItems!} />
      )}

      <div className="hidden md:flex items-center h-16 min-h-16 flex-shrink-0 px-6 bg-white/60 dark:bg-white/[0.06] backdrop-blur-xl border-b border-border/30 dark:border-white/[0.08] sticky top-0 z-40 gap-4">
        {/* Page Title */}
        <h1 className="text-lg font-semibold text-foreground">{pageTitle}</h1>

        {/* Page Actions */}
        {actions && <div className="flex items-center gap-2">{actions}</div>}

        <div className="flex-1" />

        {/* Quick-create action (admin + owner) */}
        {(role === "admin" || role === "owner") && (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("open-admin-create"))}
            className="w-9 h-9 rounded-full flex items-center justify-center border border-border hover:bg-muted/60 transition text-muted-foreground hover:text-foreground"
          >
            <Plus size={18} strokeWidth={2} />
          </button>
        )}

        {/* Calculator shortcut */}
        {calculatorHref && (
          <Link href={calculatorHref}>
            <button
              className="w-9 h-9 rounded-full flex items-center justify-center border border-border hover:bg-muted/60 transition text-muted-foreground hover:text-foreground"
              aria-label="Smart Calculator"
            >
              <Calculator size={17} strokeWidth={2} />
            </button>
          </Link>
        )}

        {/* App-specific extras (notifications bell, etc.) */}
        {headerExtras}

        {/* Search */}
        {showSearch && (
          <button
            type="button"
            onClick={() => setIsPaletteOpen(true)}
            className="flex items-center bg-muted/60 hover:bg-muted rounded-full h-10 px-4 w-72 border border-transparent hover:border-border transition text-left"
            aria-label="Open search (Cmd-K)"
          >
            <Search size={15} className="text-muted-foreground mr-2 flex-shrink-0" />
            <span className="text-sm text-muted-foreground/70 font-medium flex-1 truncate">
              Search…
            </span>
            <kbd className="ml-2 flex items-center gap-0.5 text-[10px] font-mono text-muted-foreground/70 bg-background/70 border border-border/60 rounded px-1.5 py-0.5">
              <span className="text-xs">⌘</span>K
            </kbd>
          </button>
        )}

        {/* Divider */}
        <div className="w-px h-7 bg-border/60 mx-1" />

        {/* Profile */}
        <div className="relative" ref={userMenuRef}>
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-2.5 pl-1 pr-2 py-1 rounded-lg hover:bg-muted/60 transition group"
          >
            <div className="w-10 h-10 rounded-full overflow-hidden border border-border flex-shrink-0">
              {profileImage && profileImage !== photoFailedSrc ? (
                <img
                  src={profileImage}
                  alt="Profile"
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                  onError={() => setPhotoFailedSrc(profileImage)}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-primary text-primary-foreground font-bold text-xs">
                  {getInitials()}
                </div>
              )}
            </div>
            <div className="flex flex-col items-start">
              <span className="text-sm font-medium text-foreground leading-tight">
                {getProfileName()}
              </span>
              <span className="text-[10px] text-muted-foreground leading-tight">
                {getRoleLabel()}
              </span>
            </div>
          </button>

          {showUserMenu && (
            <div className="absolute right-0 top-full mt-2 w-52 bg-card rounded-xl border border-border shadow-lg py-1.5 z-50">
              <button
                onClick={() => {
                  setShowUserMenu(false);
                  if (role === "tenant") setLocation("/tenant/settings");
                  else if (role === "owner") setLocation("/owner/settings");
                  else setLocation("/admin/profile");
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted/60 transition"
              >
                <User size={16} className="text-muted-foreground" />
                Profile Settings
              </button>
              {role !== "admin" && (
                <button
                  onClick={() => {
                    setShowUserMenu(false);
                    // Desktop popup → go to the standalone page when the host
                    // provides one. Falls back to opening the drawer sub-view
                    // for hosts (admin platform) that don't have an equivalent
                    // page route.
                    if (privacyTermsHref) {
                      setLocation(privacyTermsHref);
                    } else {
                      setProfileInitialView("privacy-terms");
                      setIsProfileOpen(true);
                    }
                  }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted/60 transition"
                >
                  <Eye size={16} className="text-muted-foreground" />
                  Privacy & Terms
                </button>
              )}
              <button
                onClick={toggleTheme}
                className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted/60 transition"
                role="switch"
                aria-checked={theme === "dark"}
                aria-label="Toggle dark mode"
              >
                <span className="flex items-center gap-3">
                  {theme === "dark" ? (
                    <Moon size={16} className="text-muted-foreground" />
                  ) : (
                    <Sun size={16} className="text-muted-foreground" />
                  )}
                  {theme === "dark" ? "Dark Mode" : "Light Mode"}
                </span>
                <span
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    theme === "dark" ? "bg-foreground" : "bg-muted-foreground/30"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform ${
                      theme === "dark" ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </span>
              </button>
              <a
                href="mailto:support@oliowallet.com"
                onClick={() => setShowUserMenu(false)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted/60 transition"
              >
                <LifeBuoy size={16} className="text-muted-foreground" />
                Need help?
              </a>
              <div className="mx-3 my-1 border-t border-border/60" />
              <button
                onClick={async () => {
                  setShowUserMenu(false);
                  await signOut();
                  setLocation(signOutRedirect);
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 transition"
              >
                <LogOut size={16} className="rotate-180" />
                Log Out
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
