// Sidebar / nav menu config for the user app (owner + tenant). NOT mock data —
// this is real, hand-curated configuration for what each role sees in the UI.
//
// Owner menu — Settings lives under the avatar dropdown in the top-right
// (DesktopHeader), not in the sidebar, because it covers user-level prefs.
// Portfolio Access sits here instead since it's portfolio-scoped, not user-
// scoped (legacy / legal / financial contacts attached to this portfolio).

import {
  Home,
  Briefcase,
  Building,
  Store,
  FileText,
  History,
  BarChart3,
  Calculator,
  Handshake,
  KeyRound,
  Landmark,
  MessageCircle,
  MessageSquare,
  Network,
  Users,
  ArrowLeftRight,
  CreditCard,
  Repeat,
  Settings,
  Wrench,
} from "lucide-react";

// Real-estate workspace sidebar, grouped into "Workspace" and "Manage"
// sections to match the design.
export const menuItems: {
  icon: typeof Home;
  label: string;
  path: string;
  section?: string;
}[] = [
  { icon: Home, label: "Dashboard", path: "/owner", section: "Workspace" },
  { icon: Building, label: "Portfolio", path: "/portfolios", section: "Workspace" },
  { icon: Network, label: "Structure", path: "/structure", section: "Workspace" },
  { icon: Users, label: "Tenants & leases", path: "/owner/tenants_leases", section: "Workspace" },
  { icon: ArrowLeftRight, label: "Transactions", path: "/owner/transaction", section: "Workspace" },
  { icon: Landmark, label: "Banking", path: "/banking", section: "Workspace" },
  { icon: CreditCard, label: "Cards", path: "/owner/cards", section: "Workspace" },
  { icon: Repeat, label: "Transfers", path: "/owner/transfers", section: "Workspace" },
  { icon: BarChart3, label: "Reports", path: "/insights", section: "Manage" },
  { icon: Wrench, label: "Tools", path: "/calculator", section: "Manage" },
  { icon: KeyRound, label: "Users & access", path: "/portfolio-access", section: "Manage" },
  { icon: Settings, label: "Settings", path: "/owner/settings", section: "Manage" },
];

// Sidebar items shown while a BUSINESS workspace is active. Business
// workspaces have no property/portfolio data yet, so portfolio-only sections
// (portfolios, agreements, activity, insights, access, banking, marketplace)
// are hidden there; general tools stay.
export const BUSINESS_WORKSPACE_PATHS: string[] = [
  "/owner",
  "/business",
  "/owner/transaction",
  "/banking",
  "/owner/cards",
  "/owner/transfers",
  "/insights",
  "/calculator",
  "/portfolio-access",
  "/owner/settings",
];

// Sidebar items that exist ONLY in a business workspace (inserted after Dashboard).
export const businessOnlyMenuItems = [
  { icon: Briefcase, label: "Portfolio", path: "/business", section: "Workspace" },
];

export const tenantMenuItems = [
  { icon: Home, label: "Home", path: "/tenant" },
  { icon: FileText, label: "Agreements", path: "/tenant/agreements" },
  { icon: MessageSquare, label: "Messages", path: "/tenant/messages" },
  { icon: History, label: "Activity", path: "/tenant/activity" },
  { icon: MessageCircle, label: "Ask Nuleeo", path: "/ask-olio" },
];

// Admin menu retained here so DesktopSidebar can render it when the app
// is mounted under an admin context. The user app currently has no /admin
// routes — this list is for parity and is unreachable today.
export const adminMenuItems: typeof menuItems = [];
