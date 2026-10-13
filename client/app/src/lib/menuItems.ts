// Sidebar / nav menu config for the user app (owner + tenant). NOT mock data —
// this is real, hand-curated configuration for what each role sees in the UI.
//
// Owner menu — Settings lives under the avatar dropdown in the top-right
// (DesktopHeader), not in the sidebar, because it covers user-level prefs.
// Portfolio Access sits here instead since it's portfolio-scoped, not user-
// scoped (legacy / legal / financial contacts attached to this portfolio).

import {
  Home,
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
} from "lucide-react";

export const menuItems = [
  { icon: Home, label: "Home", path: "/owner" },
  { icon: Building, label: "Properties", path: "/properties" },
  { icon: Store, label: "Marketplace", path: "/marketplace" },
  { icon: FileText, label: "Agreements", path: "/owner/agreements" },
  { icon: MessageSquare, label: "Messages", path: "/owner/messages" },
  { icon: History, label: "Activity", path: "/owner/activity" },
  { icon: BarChart3, label: "Olio Insights", path: "/insights" },
  { icon: Calculator, label: "Smart Calculator", path: "/calculator" },
  { icon: Handshake, label: "Network", path: "/network" },
  { icon: KeyRound, label: "Portfolio Access", path: "/portfolio-access" },
  { icon: Landmark, label: "Banking", path: "/banking" },
  { icon: MessageCircle, label: "Ask Olio", path: "/ask-olio" },
];

export const tenantMenuItems = [
  { icon: Home, label: "Home", path: "/tenant" },
  { icon: FileText, label: "Agreements", path: "/tenant/agreements" },
  { icon: MessageSquare, label: "Messages", path: "/tenant/messages" },
  { icon: History, label: "Activity", path: "/tenant/activity" },
  { icon: MessageCircle, label: "Ask Olio", path: "/ask-olio" },
];

// Admin menu retained here so DesktopSidebar can render it when the app
// is mounted under an admin context. The user app currently has no /admin
// routes — this list is for parity and is unreachable today.
export const adminMenuItems: typeof menuItems = [];
