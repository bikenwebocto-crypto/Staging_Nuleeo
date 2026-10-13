import { useEffect, Suspense } from "react";
import type { ComponentType, ReactNode } from "react";
import { lazyWithReload } from "@ui/lib/lazyWithReload";
import { Switch, Route, Redirect, useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@ui/lib/queryClient";
import { TooltipProvider } from "@ui/components/ui/tooltip";
import { Toaster } from "@ui/components/ui/toaster";
import { ThemeProvider } from "@ui/components/ThemeProvider";
import { Logo } from "@ui/components/Logo";
import { AuthProvider, useAuth } from "@ui/lib/useAuth";
import { PrivilegesProvider, useCanOwnerPlan } from "@ui/lib/usePrivileges";
import { usePlan } from "@ui/lib/usePlan";
import { useActivePortfolioPlan } from "@/lib/useActivePortfolioPlan";
import { useSystemConfig } from "@ui/lib/systemStore";
import { RequireAuth } from "@ui/components/RequireAuth";
import { ProfileLoadError } from "@ui/components/ProfileLoadError";
import { MaintenanceScreen } from "@ui/components/MaintenanceScreen";
import { prefetchForRole } from "@/lib/prefetch";
import { isOwnerExperience } from "@/lib/isOwner";
import { ActivePortfolioProvider } from "@/lib/activePortfolio";
import { ensureOneSignal, loginOneSignal, logoutOneSignal } from "@ui/lib/onesignal";
import { AppLayout } from "@/components/common/AppLayout";
import { RoleSelectionModal } from "@/components/common/RoleSelectionModal";
import { TermsReconsentModal } from "@/components/common/TermsReconsentModal";

// Route components are lazy-loaded so the initial bundle stays small. Each page
// becomes its own chunk; Suspense renders the fallback while the chunk loads.
//
// We also bucket each loader by the persona that actually reaches it (owner /
// tenant) so PreloadRoutes can warm ONLY the chunks the current user is likely
// to hit — warming every chunk for everyone dragged heavy vendor code
// (recharts via the owner-only /insights page) onto tenants and low-end
// clients, negating the code-split savings. Routes stay fully lazy + reachable
// either way; bucketing only changes WHAT we prefetch in the background.
type PreloadBucket = "owner" | "tenant";
type PreloadLoader = () => Promise<unknown>;
// A few page chunks pull in heavy vendor libs (e.g. recharts on /insights). We
// never speculatively prefetch these — they load on real navigation only — so a
// user who never opens that page never pays for the megabytes.
const heavyLoaders = new Set<PreloadLoader>();
const ownerLoaders: PreloadLoader[] = [];
const tenantLoaders: PreloadLoader[] = [];

function lazyRoute<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
  opts: { buckets?: PreloadBucket[]; heavy?: boolean } = {},
) {
  const buckets = opts.buckets ?? ["owner", "tenant"]; // shared/common by default
  if (opts.heavy) heavyLoaders.add(loader);
  if (buckets.includes("owner")) ownerLoaders.push(loader);
  if (buckets.includes("tenant")) tenantLoaders.push(loader);
  return lazyWithReload(loader);
}

// Auth / public pages aren't bucketed: an authenticated session never navigates
// to them, and the unauthenticated entry (Home) is the first chunk loaded
// anyway, so there's nothing to gain from pre-warming them.
const NotFound = lazyWithReload(() => import("@/pages/common/not-found"));
const Home = lazyWithReload(() => import("@/pages/auth/Home"));
const AuthActionPage = lazyWithReload(() => import("@/pages/auth/AuthActionPage"));
const AuthImpersonatePage = lazyWithReload(() => import("@/pages/auth/AuthImpersonatePage"));

const OwnerDashboard = lazyRoute(() => import("@/pages/owner/OwnerDashboard"), {
  buckets: ["owner"],
});
const OwnerAgreementsPage = lazyRoute(() => import("@/pages/owner/OwnerAgreementsPage"), {
  buckets: ["owner"],
});
const OwnerSettingsPage = lazyRoute(() => import("@/pages/owner/OwnerSettingsPage"), {
  buckets: ["owner"],
});
const OwnerOnboarding = lazyWithReload(() => import("@/pages/owner/OwnerOnboarding"));
const PropertiesPage = lazyRoute(() => import("@/pages/owner/PropertiesPage"), {
  buckets: ["owner"],
});
const PropertyDetailsPage = lazyRoute(() => import("@/pages/owner/PropertyDetailsPage"), {
  buckets: ["owner"],
});
const TenantsPage = lazyRoute(() => import("@/pages/owner/TenantsPage"), { buckets: ["owner"] });
// /insights pulls in recharts — owner-only AND heavy, so it is never prefetched.
const PortfolioAnalyticsPage = lazyRoute(() => import("@/pages/owner/PortfolioAnalyticsPage"), {
  buckets: ["owner"],
  heavy: true,
});
const PortfolioAccessPage = lazyRoute(() => import("@/pages/owner/PortfolioAccessPage"), {
  buckets: ["owner"],
});
const BankingPage = lazyRoute(() => import("@/pages/owner/BankingPage"), { buckets: ["owner"] });

const TenantDashboard = lazyRoute(() => import("@/pages/tenant/TenantDashboard"), {
  buckets: ["tenant"],
});
const TenantAgreementsPage = lazyRoute(() => import("@/pages/tenant/TenantAgreementsPage"), {
  buckets: ["tenant"],
});
const TenantSettingsPage = lazyRoute(() => import("@/pages/tenant/TenantSettingsPage"), {
  buckets: ["tenant"],
});

// Common pages — reached by both personas, so they stay in both buckets.
const ActivityPage = lazyRoute(() => import("@/pages/common/ActivityPage"));
const MessagesPage = lazyRoute(() => import("@/pages/common/MessagesPage"));
const ExpertPage = lazyRoute(() => import("@/pages/common/ExpertPage"));
const PaymentChannelsPage = lazyRoute(() => import("@/pages/common/PaymentChannelsPage"));
const CalculatorPage = lazyRoute(() => import("@/pages/common/CalculatorPage"));
const ProfileSettingsPage = lazyRoute(() => import("@/pages/common/ProfileSettingsPage"));
const FAQPage = lazyRoute(() => import("@/pages/common/FAQPage"));
const PrivacyPage = lazyRoute(() => import("@/pages/common/PrivacyPage"));
// Legal pages are pre-auth/low-traffic; don't bucket them for background warming.
const LegalPage = lazyWithReload(() => import("@/pages/common/LegalPage"));
const LegalIndexPage = lazyWithReload(() => import("@/pages/common/LegalIndexPage"));
const NetworkPage = lazyRoute(() => import("@/pages/common/NetworkPage"));
const AskOlioPage = lazyRoute(() => import("@/pages/common/AskOlioPage"));
// Marketplace is owner-only (tenants get redirected), so bucket it owner.
const MarketplacePage = lazyRoute(() => import("@/pages/MarketplacePage"), { buckets: ["owner"] });
const MarketplaceListingDetailPage = lazyRoute(
  () => import("@/pages/MarketplaceListingDetailPage"),
  {
    buckets: ["owner"],
  },
);
const PublicPropertyPage = lazyWithReload(() => import("@/pages/PublicPropertyPage"));

// Warm the route chunks the current user is likely to hit, in the background
// after the app mounts, so first-time navigation is instant. Three guards keep
// this from hurting the people it's meant to help:
//   1. Run only once auth has resolved, and pick the bucket by persona — owners
//      get owner+common chunks, tenants get tenant+common, and we never warm
//      the other persona's pages (or, for signed-out visitors, anything).
//   2. Never warm `heavy` chunks (recharts/maps): those load on real navigation
//      only, so a user who never opens them never downloads them.
//   3. Skip entirely on Data Saver or slow connections (2g/slow-2g) — on those
//      clients speculative downloads compete with what the user actually wants.
// Either way every route stays lazy + reachable; this only changes the
// background prefetch.
function PreloadRoutes() {
  const { firebaseUser, profile, loading } = useAuth();
  const { plan, loading: planLoading } = usePlan();

  useEffect(() => {
    // Wait for auth + plan to resolve so we know which persona to warm. Mirror
    // the gating used by HomeRedirect / PrefetchUserData.
    if (loading || planLoading || !firebaseUser || !profile) return;
    if (!shouldPreloadOnThisConnection()) return;

    const loaders = isOwnerExperience(profile, plan) ? ownerLoaders : tenantLoaders;
    scheduleIdle(() => {
      for (const load of loaders) {
        if (heavyLoaders.has(load)) continue; // never speculatively pull heavy vendor chunks
        load().catch(() => {
          // Ignore preload failures — the real navigation will surface any error.
        });
      }
    });
  }, [loading, planLoading, firebaseUser, profile, plan]);

  return null;
}

// True unless the client signalled Data Saver or a slow cellular link. The
// Network Information API is not in all browsers (Safari/Firefox lack it); when
// absent we assume a capable connection and preload as before.
function shouldPreloadOnThisConnection(): boolean {
  const conn = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  if (!conn) return true;
  if (conn.saveData) return false;
  if (conn.effectiveType === "2g" || conn.effectiveType === "slow-2g") return false;
  return true;
}

function scheduleIdle(cb: () => void) {
  const win = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  if (win.requestIdleCallback) {
    win.requestIdleCallback(cb, { timeout: 2000 });
  } else {
    window.setTimeout(cb, 300);
  }
}

// Boots the OneSignal Web SDK and keeps its `external_id` aligned with the
// current Firebase user. The SDK is lazy-loaded on first mount; OneSignal.login
// associates the browser subscription with the Firebase UID so the server can
// address pushes by uid.
function OneSignalBridge() {
  const { firebaseUser, loading } = useAuth();
  useEffect(() => {
    ensureOneSignal();
  }, []);
  useEffect(() => {
    if (loading) return;
    if (firebaseUser) loginOneSignal(firebaseUser.uid);
    else logoutOneSignal();
  }, [loading, firebaseUser]);
  return null;
}

// While the user has app.oliowallet.com open and signed in, ping /api/heartbeat
// so the platform admin can render a "currently in the app" green dot on the
// users table. Fires immediately on sign-in and every 60s thereafter, but only
// while the tab is visible — a hidden tab doesn't count as "live". The server
// rate-limits to 1/30s per user, so a runaway loop can't accumulate writes.
function HeartbeatBridge() {
  const { firebaseUser } = useAuth();
  useEffect(() => {
    if (!firebaseUser) return;
    let cancelled = false;
    const beat = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      void apiRequest("POST", "/api/heartbeat").catch(() => {});
    };
    beat();
    const id = window.setInterval(beat, 60_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") beat();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [firebaseUser]);
  return null;
}

// Once the user is authenticated, prefetch the API data each page in their role
// will need. Fired immediately (no idle delay) the moment auth resolves, so the
// requests overlap with the post-login redirect — by the time the user lands on
// /tenant or /owner, data is usually already cached.
function PrefetchUserData() {
  const { firebaseUser, profile, loading } = useAuth();
  const { plan, loading: planLoading } = usePlan();

  useEffect(() => {
    if (loading || planLoading || !firebaseUser || !profile) return;
    const isOwner = isOwnerExperience(profile, plan);
    prefetchForRole(isOwner ? "owner" : "tenant");
  }, [loading, planLoading, firebaseUser, profile, plan]);

  return null;
}

function RouteFallback() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-neutral-950 text-neutral-400">
      Loading…
    </div>
  );
}

// Each page now mounts its own AppLayout, so this fallback shows during the
// lazy chunk fetch only — rare for the user's own persona (those chunks are
// pre-warmed by PreloadRoutes), expected for heavy pages like /insights which
// we intentionally never speculatively prefetch.
function PageFallback() {
  return (
    <div className="min-h-[var(--app-vh)] flex items-center justify-center bg-background text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
    </div>
  );
}

// Default landing on `/`. Reads role + plan from the auth profile and routes:
//   owner role | non-basic plan → /owner
//   else → /tenant
//
// Note: app.oliowallet.com is intentionally siloed from platform.oliowallet.com.
// Even superadmins land on owner/tenant pages here; staff work happens on the
// platform subdomain, which they must visit and sign in to separately. Never
// auto-jump between subdomains — the user subdomain treats every account purely
// by its owner/tenant identity.
//
// Unauthenticated users get sent to /auth.
function HomeRedirect() {
  const { firebaseUser, profile, loading, profileError } = useAuth();
  const { plan, loading: planLoading } = usePlan();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (loading || planLoading) return;
    if (!firebaseUser) {
      setLocation("/auth");
      return;
    }
    if (!profile) return; // wait for profile to load before deciding

    const isOwner = isOwnerExperience(profile, plan);
    setLocation(isOwner ? "/owner" : "/tenant");
  }, [loading, planLoading, firebaseUser, profile, plan, setLocation]);

  // Signed in but /api/me failed — show a retry UI instead of spinning forever.
  if (!loading && firebaseUser && !profile && profileError) {
    return <ProfileLoadError />;
  }

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-neutral-950 text-neutral-400">
      <Logo variant="symbol" color="white" className="h-16 w-auto" />
      <Loader2 className="mt-6 h-6 w-6 animate-spin text-neutral-500" aria-label="Loading" />
      <div className="mt-6 flex items-center gap-3 text-xs flex-wrap justify-center">
        <a href="/legal/privacy" className="hover:text-white underline underline-offset-2">
          Privacy
        </a>
        <span aria-hidden="true">·</span>
        <a href="/legal/terms" className="hover:text-white underline underline-offset-2">
          Terms
        </a>
        <span aria-hidden="true">·</span>
        <a href="/legal/cookies" className="hover:text-white underline underline-offset-2">
          Cookies
        </a>
        <span aria-hidden="true">·</span>
        <a href="/legal" className="hover:text-white underline underline-offset-2">
          All legal
        </a>
      </div>
    </div>
  );
}

// When Stripe Checkout sends the user back with `?checkout=success`, force-refresh
// the Auth token so the new `stripeRole` custom claim shows up immediately
// (otherwise the user keeps the old plan in their token until ~1h auto-refresh).
// Then strip the query param so a page reload doesn't re-trigger the refresh.
function CheckoutReturnHandler() {
  const { refreshPlan } = usePlan();
  const { firebaseUser } = useAuth();

  useEffect(() => {
    if (!firebaseUser) return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("checkout");
    if (status !== "success") return;

    refreshPlan();
    params.delete("checkout");
    const next = params.toString();
    const url = window.location.pathname + (next ? `?${next}` : "") + window.location.hash;
    window.history.replaceState({}, "", url);
  }, [firebaseUser, refreshPlan]);

  return null;
}

// Used by the retired /profile route to send the user to their own dashboard
// instead of the now-deleted ProfilePage. Runs inside the auth shell where
// profile + plan are guaranteed loaded, so first render produces the final
// target — no loading flash.
function RoleDashboardRedirect() {
  const { profile } = useAuth();
  const { plan } = usePlan();
  const target = profile && isOwnerExperience(profile, plan) ? "/owner" : "/tenant";
  return <Redirect to={target} />;
}

// Marketplace is owner-only — tenants who land on /marketplace via a stale link
// or direct URL get bounced back to their dashboard instead of seeing it.
function OwnerOnlyMarketplace() {
  const { profile } = useAuth();
  const { plan } = usePlan();
  if (profile && !isOwnerExperience(profile, plan)) return <Redirect to="/tenant" />;
  return <MarketplacePage />;
}

function OwnerOnlyMarketplaceDetail() {
  const { profile } = useAuth();
  const { plan } = usePlan();
  if (profile && !isOwnerExperience(profile, plan)) return <Redirect to="/tenant" />;
  return <MarketplaceListingDetailPage />;
}

// Gate for the owner-experience routes (/owner/*, /properties, /tenants,
// /banking, /portfolio-access). A tenant who deep-links into one of these
// would otherwise render owner chrome over data they don't have — so we
// bounce non-owner-experience users to their own dashboard. Uses the SAME
// isOwnerExperience check as the marketplace wrappers. Never redirects across
// subdomains — /tenant is in-app. While profile is still loading we render the
// child (RequireAuth above already guarantees an authed user); once profile
// resolves, a non-owner is redirected.
function RequireOwnerExperience({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const { plan, loading: planLoading } = usePlan();
  // Wait for BOTH profile and the plan claim before deciding. usePlan()
  // defaults plan to "basic" until the stripeRole claim resolves, and a
  // legacy paid owner (no explicit "owner" role, ownerModeEnabled unset)
  // reads as owner-experience ONLY via their plan — so deciding while the
  // claim is still loading would bounce them to /tenant and strand them
  // there. Gating on planLoading mirrors HomeRedirect / PrefetchUserData.
  if (profile && !planLoading && !isOwnerExperience(profile, plan))
    return <Redirect to="/tenant" />;
  return <>{children}</>;
}

// Plan gate for the standalone Ask Olio page (/ask). The AI assistant is an
// owner feature whose availability rides on the ACTIVE PORTFOLIO's plan
// (askOlio.access — granted on advance/pro/business, not basic), mirroring the
// server gate on /api/ask (requireActivePortfolioPlanPrivilege("askOlio.access")).
// Wrapped INSIDE RequireOwnerExperience, so tenants are already bounced to
// /tenant; this only catches an owner whose active plan doesn't include the
// feature and sends them to their dashboard rather than loading a page that
// would 402 on the first send. Gate on planLoading so a legacy paid owner isn't
// bounced before their plan resolves.
function RequireAskOlioPlan({ children }: { children: ReactNode }) {
  const { plan: activePlan, loading: planLoading } = useActivePortfolioPlan();
  const canPlan = useCanOwnerPlan(activePlan);
  if (!planLoading && !canPlan("askOlio.access")) return <Redirect to="/owner" />;
  return <>{children}</>;
}

// AppLayout (sidebar + header + bottom nav) is mounted once around this shell,
// so it stays in place across navigation. Each Route renders only its content.
function AuthenticatedShell() {
  return (
    <AppLayout>
      {/* One-time "tenant or property owner?" prompt for brand-new signups.
        Mounted at the shell so it appears over whatever page the fresh
        account lands on; renders nothing once answered/dismissed. */}
      <RoleSelectionModal />
      {/* Re-consent prompt when the accepted Terms/Privacy version is stale.
        Defers to RoleSelectionModal for brand-new signups (whose consent is
        already current); renders nothing once accepted. */}
      <TermsReconsentModal />
      <Suspense fallback={<PageFallback />}>
        <Switch>
          {/* Owner — every route here is owner-experience only. A tenant who
            deep-links in is redirected to /tenant by RequireOwnerExperience.
            NOTE: /properties/:id is intentionally NOT gated — it serves the
            public, read-only shared-property view to any signed-in viewer who
            follows a shared link (PropertyDetailsPage does its own per-viewer
            access handling), so gating it would break that flow. */}
          <Route path="/owner">
            <RequireOwnerExperience>
              <OwnerDashboard />
            </RequireOwnerExperience>
          </Route>
          <Route path="/owner/activity">
            <RequireOwnerExperience>
              <ActivityPage />
            </RequireOwnerExperience>
          </Route>
          {/* Optional :id so /owner/agreements/:id deep-links into the drawer
            without remounting the list (same component serves both). */}
          <Route path="/owner/agreements/:id?">
            <RequireOwnerExperience>
              <OwnerAgreementsPage />
            </RequireOwnerExperience>
          </Route>
          <Route path="/owner/settings">
            <RequireOwnerExperience>
              <OwnerSettingsPage />
            </RequireOwnerExperience>
          </Route>
          <Route path="/owner/messages">
            <RequireOwnerExperience>
              <MessagesPage />
            </RequireOwnerExperience>
          </Route>
          <Route path="/owner/privacy">
            <RequireOwnerExperience>
              <PrivacyPage />
            </RequireOwnerExperience>
          </Route>
          <Route path="/properties">
            <RequireOwnerExperience>
              <PropertiesPage />
            </RequireOwnerExperience>
          </Route>
          <Route path="/properties/:id">
            <PropertyDetailsPage />
          </Route>
          {/* Optional :id so /tenants/:id deep-links into the details drawer
            without remounting the list (same component serves both). */}
          <Route path="/tenants/:id?">
            <RequireOwnerExperience>
              <TenantsPage />
            </RequireOwnerExperience>
          </Route>
          <Route path="/portfolio-access">
            <RequireOwnerExperience>
              <PortfolioAccessPage />
            </RequireOwnerExperience>
          </Route>
          <Route path="/banking">
            <RequireOwnerExperience>
              <BankingPage />
            </RequireOwnerExperience>
          </Route>

          {/* Tenant */}
          <Route path="/tenant">
            <TenantDashboard />
          </Route>
          <Route path="/tenant/agreements">
            <TenantAgreementsPage />
          </Route>
          <Route path="/tenant/activity">
            <ActivityPage />
          </Route>
          <Route path="/tenant/settings">
            <TenantSettingsPage />
          </Route>
          <Route path="/tenant/messages">
            <MessagesPage />
          </Route>
          <Route path="/tenant/privacy">
            <PrivacyPage />
          </Route>

          {/* Common */}
          <Route path="/network">
            <NetworkPage />
          </Route>
          <Route path="/marketplace">
            <OwnerOnlyMarketplace />
          </Route>
          <Route path="/marketplace/:id">
            <OwnerOnlyMarketplaceDetail />
          </Route>
          <Route path="/expert">
            <ExpertPage />
          </Route>
          {/* Olio Insights — portfolio analytics (occupancy, cash flow, exports). */}
          <Route path="/insights">
            <PortfolioAnalyticsPage />
          </Route>
          <Route path="/payment-channels">
            <PaymentChannelsPage />
          </Route>
          <Route path="/calculator">
            <CalculatorPage />
          </Route>
          <Route path="/ask">
            <RequireOwnerExperience>
              <RequireAskOlioPlan>
                <AskOlioPage />
              </RequireAskOlioPlan>
            </RequireOwnerExperience>
          </Route>
          <Route path="/profile/portfolio-access">
            <PortfolioAccessPage />
          </Route>
          <Route path="/profile/settings">
            <ProfileSettingsPage />
          </Route>
          <Route path="/profile/faq">
            <FAQPage />
          </Route>
          <Route path="/profile/privacy">
            <PrivacyPage />
          </Route>

          {/* Legacy menu pages — retired. Redirect bookmarks/old links to the
            user's dashboard so they don't dead-end on NotFound. /profile is
            role-neutral and picks dashboard by role; /tenant-profile was
            tenant-only, so route there. */}
          <Route path="/profile">
            <RoleDashboardRedirect />
          </Route>
          <Route path="/tenant-profile">
            <Redirect to="/tenant" />
          </Route>
          {/* Analytics was renamed to Olio Insights and moved to /insights. */}
          <Route path="/analytics">
            <Redirect to="/insights" />
          </Route>

          {/* Stubs */}
          <Route path="/invest">
            <OwnerDashboard />
          </Route>
          <Route path="/payments">
            <OwnerDashboard />
          </Route>
          <Route path="/rewards">
            <OwnerDashboard />
          </Route>
          <Route path="/pay-rent">
            <TenantDashboard />
          </Route>
          <Route path="/settings">
            <TenantDashboard />
          </Route>

          <Route>
            <NotFound />
          </Route>
        </Switch>
      </Suspense>
    </AppLayout>
  );
}

// Wraps the entire user app. When config/system.maintenanceMode.enabled is
// true, renders <MaintenanceScreen> for everyone except superadmins. The
// flag updates in realtime via onSnapshot — flipping the toggle in the
// admin app locks (or unlocks) every connected client within ~1s.
//
// The /auth/action path is allowed through so password-reset / email-verify
// callbacks keep working during a lockout. Superadmins bypass entirely so
// they can still log in and turn maintenance back off from here if they
// need to (though the canonical path is the platform subdomain).
function MaintenanceGate({ children }: { children: ReactNode }) {
  const { profile, signOut } = useAuth();
  const { config, loading } = useSystemConfig();
  const path = window.location.pathname;
  if (loading) return <>{children}</>;
  if (!config.maintenanceMode.enabled) return <>{children}</>;
  if (profile?.roles?.includes("superadmin")) return <>{children}</>;
  if (path === "/auth/action") return <>{children}</>;
  return (
    <MaintenanceScreen
      message={config.maintenanceMode.message}
      onSignOut={profile ? () => signOut() : undefined}
    />
  );
}

// Extracts the property id from a /properties/:id path (and nothing else —
// /properties or /properties/:id/anything don't match). Used to give
// logged-out visitors the public property view instead of bouncing them
// to /auth.
function matchPublicPropertyPath(path: string): string | null {
  const m = /^\/properties\/([^/]+)\/?$/.exec(path);
  return m ? decodeURIComponent(m[1]) : null;
}

function Router() {
  const { firebaseUser, loading } = useAuth();
  const [location] = useLocation();

  // Public property links: once auth has resolved and the visitor is signed
  // OUT, /properties/:id renders the standalone read-only, public-safe view.
  // Logged-in users (and the still-loading state) fall through to the Switch
  // below into the authenticated shell — AppLayout stays mounted across
  // navigation. There, PropertyDetailsPage shows the full owner page to the
  // owner/granted readers and falls back to the SAME public view (in-shell)
  // for any other signed-in viewer who followed a shared link.
  if (!loading && !firebaseUser) {
    const publicPropertyId = matchPublicPropertyPath(location);
    if (publicPropertyId) {
      return (
        <Suspense fallback={<RouteFallback />}>
          <PublicPropertyPage id={publicPropertyId} />
        </Suspense>
      );
    }
  }

  return (
    <Suspense fallback={<RouteFallback />}>
      <Switch>
        <Route path="/" component={HomeRedirect} />

        {/* Pre-auth pages — no guard, no shared layout */}
        <Route path="/auth" component={Home} />
        <Route path="/auth/action" component={AuthActionPage} />
        <Route path="/auth/impersonate" component={AuthImpersonatePage} />
        {/* Legacy short paths kept so existing signup checkbox + OAuth screen
          links continue to resolve. */}
        <Route path="/terms">
          <LegalPage docKey="terms" />
        </Route>
        <Route path="/privacy">
          <LegalPage docKey="privacy" />
        </Route>
        {/* Browseable index of every legal document. */}
        <Route path="/legal" component={LegalIndexPage} />
        {/* Dynamic per-doc legal route. The slug must match a ComplianceDocKey
          declared in shared/firestore-schema.ts; unknown slugs render the
          page with empty content (the policy's HTML is the only thing
          missing) but the layout still loads, so we don't hard-404. */}
        <Route path="/legal/:doc">
          {(params) => <LegalPage docKey={(params.doc ?? "terms") as any} />}
        </Route>

        {/* Auth required, no shared layout (onboarding has its own design) */}
        <Route path="/owner-onboarding">
          <RequireAuth>
            <OwnerOnboarding />
          </RequireAuth>
        </Route>

        {/* Everything else: authenticated routes — AppLayout wraps the shell so the sidebar/header survive navigation */}
        <Route>
          <RequireAuth>
            <AuthenticatedShell />
          </RequireAuth>
        </Route>
      </Switch>
    </Suspense>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <PrivilegesProvider>
          <ActivePortfolioProvider>
            <TooltipProvider>
              <ThemeProvider />
              <Toaster />
              <CheckoutReturnHandler />
              <PreloadRoutes />
              <PrefetchUserData />
              <OneSignalBridge />
              <HeartbeatBridge />
              <MaintenanceGate>
                <Router />
              </MaintenanceGate>
            </TooltipProvider>
          </ActivePortfolioProvider>
        </PrivilegesProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
