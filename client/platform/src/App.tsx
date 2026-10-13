import { useEffect, Suspense } from "react";
import type { ComponentType } from "react";
import { lazyWithReload } from "@ui/lib/lazyWithReload";
import { Switch, Route, Redirect } from "wouter";
import { Loader2 } from "lucide-react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@ui/lib/queryClient";
import { TooltipProvider } from "@ui/components/ui/tooltip";
import { Toaster } from "@ui/components/ui/toaster";
import { ThemeProvider } from "@ui/components/ThemeProvider";
import { AuthProvider, useAuth } from "@ui/lib/useAuth";
import { ensureOneSignal, loginOneSignal, logoutOneSignal } from "@ui/lib/onesignal";
import { PrivilegesProvider } from "@ui/lib/usePrivileges";
import { RequireAuth } from "@ui/components/RequireAuth";
import { AdminLayout } from "@/components/common/AdminLayout";

// Route components are lazy-loaded so the initial admin bundle stays small —
// the dashboard's leaflet/recharts deps (and every other page) move into their
// own chunks instead of the entry bundle. Suspense renders the fallback while a
// chunk loads. We also collect every loader in `routeLoaders` so we can warm
// them up in the background after mount — first navigation then feels instant.
const routeLoaders: Array<() => Promise<unknown>> = [];
function lazyRoute<T extends ComponentType<any>>(loader: () => Promise<{ default: T }>) {
  routeLoaders.push(loader);
  return lazyWithReload(loader);
}

const Login = lazyRoute(() => import("@/pages/Login"));
const SuperAdminDashboard = lazyRoute(() => import("@/pages/SuperAdminDashboard"));
const AdminEmailMarketingPage = lazyRoute(() => import("@/pages/AdminEmailMarketingPage"));
const AdminNotificationMarketingPage = lazyRoute(
  () => import("@/pages/AdminNotificationMarketingPage"),
);
const AdminUsersPage = lazyRoute(() => import("@/pages/AdminUsersPage"));
const AdminUnitsPage = lazyRoute(() => import("@/pages/AdminUnitsPage"));
const AdminPortfoliosPage = lazyRoute(() => import("@/pages/AdminPortfoliosPage"));
const AdminAgreementsPage = lazyRoute(() => import("@/pages/AdminAgreementsPage"));
const AdminPartnersPage = lazyRoute(() => import("@/pages/AdminPartnersPage"));
const AdminMarketplacePage = lazyRoute(() => import("@/pages/AdminMarketplacePage"));
const AdminInvestmentLeadsPage = lazyRoute(() => import("@/pages/AdminInvestmentLeadsPage"));
const AdminTransactionsPage = lazyRoute(() => import("@/pages/AdminTransactionsPage"));
const AdminActivityLogPage = lazyRoute(() => import("@/pages/AdminActivityLogPage"));
const AdminAuditLogPage = lazyRoute(() => import("@/pages/AdminAuditLogPage"));
const AdminSettingsPage = lazyRoute(() => import("@/pages/AdminSettingsPage"));
const AdminProfilePage = lazyRoute(() => import("@/pages/AdminProfilePage"));
const AdminSocialMediaPage = lazyRoute(() => import("@/pages/AdminSocialMediaPage"));
const AdminSupportPage = lazyRoute(() => import("@/pages/AdminSupportPage"));
const AdminCalculatorPage = lazyRoute(() => import("@/pages/AdminCalculatorPage"));
const NotFound = lazyRoute(() => import("@/pages/NotFound"));

// Warm every route chunk in the background after the app mounts so first-time
// navigation is instant. Runs during browser idle time so it never competes
// with the initial paint.
function PreloadRoutes() {
  useEffect(() => {
    scheduleIdle(() => {
      for (const load of routeLoaders) {
        load().catch(() => {
          // Ignore preload failures — the real navigation will surface any error.
        });
      }
    });
  }, []);
  return null;
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

// Shown during the lazy chunk fetch only (rare — chunks are pre-warmed by
// PreloadRoutes). Mirrors the user app's PageFallback spinner.
function PageFallback() {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
    </div>
  );
}

// Boots the OneSignal Web SDK on platform.oliowallet.com and keeps its
// external_id aligned with the signed-in staff member, so the server can
// address staff pushes (notifyStaff) by uid. Mirrors the user app's bridge; the
// shared lib resolves the staff OneSignal app id by origin (platform.*).
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

const ADMIN_ROLES = ["admin", "superadmin"] as const;

// AdminLayout (sidebar + header + bottom nav) is mounted ONCE here, wrapping the
// admin route switch, so it stays in place across navigation — clicking a
// sidebar link swaps only the routed page content, the shell never re-mounts.
// (Previously every page mounted its own AdminLayout, which re-mounted the whole
// sidebar/header on each navigation and read as a full-page refresh.) Mirrors
// the user app's AuthenticatedShell. The inner Suspense lives inside AdminLayout
// so a lazy chunk fetch shows the spinner in the content area only — the shell
// stays put.
function AdminShell() {
  return (
    <AdminLayout>
      <Suspense fallback={<PageFallback />}>
        <Switch>
          <Route path="/">
            <SuperAdminDashboard />
          </Route>
          <Route path="/admin">
            <SuperAdminDashboard />
          </Route>
          <Route path="/admin/email-marketing">
            <AdminEmailMarketingPage />
          </Route>
          <Route path="/admin/notification-marketing">
            <AdminNotificationMarketingPage />
          </Route>
          <Route path="/admin/users">
            <AdminUsersPage />
          </Route>
          <Route path="/admin/units">
            <AdminUnitsPage />
          </Route>
          <Route path="/admin/portfolios">
            <AdminPortfoliosPage />
          </Route>
          <Route path="/admin/agreements">
            <AdminAgreementsPage />
          </Route>
          <Route path="/admin/partners">
            <AdminPartnersPage />
          </Route>
          <Route path="/admin/marketplace">
            <AdminMarketplacePage />
          </Route>
          <Route path="/admin/investment-leads">
            <AdminInvestmentLeadsPage />
          </Route>
          <Route path="/admin/transactions">
            <AdminTransactionsPage />
          </Route>
          <Route path="/admin/activity-log">
            <AdminActivityLogPage />
          </Route>
          <Route path="/admin/audit-log">
            <AdminAuditLogPage />
          </Route>
          <Route path="/admin/settings">
            <AdminSettingsPage />
          </Route>
          <Route path="/admin/profile">
            <AdminProfilePage />
          </Route>
          <Route path="/admin/social-media">
            <AdminSocialMediaPage />
          </Route>
          <Route path="/admin/support">
            <AdminSupportPage />
          </Route>
          <Route path="/admin/compliance">
            <Redirect to="/admin/settings?tab=Compliance" />
          </Route>
          <Route path="/admin/portfolio-roles">
            <Redirect to="/admin/settings?tab=Portfolio Roles" />
          </Route>
          <Route path="/admin/platform-roles">
            <Redirect to="/admin/settings?tab=Platform Roles" />
          </Route>
          <Route path="/admin/owner-plans">
            <Redirect to="/admin/settings?tab=Owner Plans" />
          </Route>
          <Route path="/admin/calculator">
            <AdminCalculatorPage />
          </Route>

          <Route>
            <NotFound />
          </Route>
        </Switch>
      </Suspense>
    </AdminLayout>
  );
}

function Router() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Switch>
        {/* Login owns its own design — no admin chrome. */}
        <Route path="/login" component={Login} />

        {/* Everything else is staff-only and shares the AdminLayout shell. One
            RequireAuth gate wraps the whole shell (was one per route). */}
        <Route>
          <RequireAuth roles={[...ADMIN_ROLES]} fallback="/login">
            <AdminShell />
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
          <TooltipProvider>
            <ThemeProvider />
            <Toaster />
            <OneSignalBridge />
            <PreloadRoutes />
            <Router />
          </TooltipProvider>
        </PrivilegesProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
