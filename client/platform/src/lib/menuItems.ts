// Sidebar / nav menu config for the admin platform. NOT mock data — this is
// real, hand-curated configuration for what each role sees in the UI.

import {
  Home,
  Building,
  FileText,
  History,
  BarChart3,
  Calculator,
  Handshake,
  MessageCircle,
  Settings,
  LayoutDashboard,
  Users as UsersIcon,
  Building as BuildingIcon,
  Receipt,
  SendHorizontal,
  BellRing,
  Share2,
  Store,
  Briefcase,
  UserPlus,
  ShieldCheck,
} from "lucide-react";
import type { PlatformPrivilegeKey } from "@shared/firestore-schema";

// Each admin nav item carries the privilege required to see it. The sidebar
// filters by `canPlatform()` at render time, so flipping the matrix in
// /admin/settings hides/shows menu items in realtime. Items with no
// `privilege` are visible to anyone with admin/superadmin role (e.g.
// Dashboard and Settings — admins should always be able to reach Settings).
export type PlatformMenuItem = {
  icon: typeof LayoutDashboard;
  label: string;
  path: string;
  privilege?: PlatformPrivilegeKey;
};

export const menuItems = [
  { icon: Home, label: "Home", path: "/owner" },
  { icon: Building, label: "Properties", path: "/properties" },
  { icon: FileText, label: "Agreements", path: "/owner/agreements" },
  { icon: History, label: "Activity", path: "/owner/activity" },
  { icon: BarChart3, label: "Olio Insights", path: "/insights" },
  { icon: Calculator, label: "Smart Calculator", path: "/calculator" },
  { icon: Handshake, label: "Network", path: "/network" },
  { icon: MessageCircle, label: "Ask Olio", path: "/ask-olio" },
  { icon: Settings, label: "Settings", path: "/owner/settings" },
];

export const tenantMenuItems = [
  { icon: Home, label: "Home", path: "/tenant" },
  { icon: FileText, label: "Agreements", path: "/tenant/agreements" },
  { icon: History, label: "Activity", path: "/tenant/activity" },
  { icon: Settings, label: "Settings", path: "/tenant/settings" },
];

export const adminMenuItems: PlatformMenuItem[] = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/admin" },
  { icon: UsersIcon, label: "Users", path: "/admin/users", privilege: "users.viewAll" },
  { icon: BuildingIcon, label: "Units", path: "/admin/units", privilege: "properties.viewAll" },
  {
    icon: Briefcase,
    label: "Portfolios",
    path: "/admin/portfolios",
    privilege: "properties.viewAll",
  },
  { icon: FileText, label: "Agreements", path: "/admin/agreements", privilege: "legal.viewAll" },
  { icon: Handshake, label: "Partners", path: "/admin/partners", privilege: "comm.partners" },
  { icon: Store, label: "Marketplace", path: "/admin/marketplace", privilege: "comm.partners" },
  {
    icon: UserPlus,
    label: "Marketplace Leads",
    path: "/admin/investment-leads",
    // Lead data + the lead-notification bell are gated on comm.activityLog (the
    // server gate for lead PII), so the nav entry must match — otherwise a
    // comm.partners-only role sees the page but only empty 403 responses.
    privilege: "comm.activityLog",
  },
  {
    icon: Receipt,
    label: "Transaction History",
    path: "/admin/transactions",
    privilege: "finance.viewAll",
  },
  {
    icon: History,
    label: "Activity Log",
    path: "/admin/activity-log",
    privilege: "comm.activityLog",
  },
  { icon: ShieldCheck, label: "Audit Log", path: "/admin/audit-log", privilege: "users.viewAll" },
  {
    icon: SendHorizontal,
    label: "Email Marketing",
    path: "/admin/email-marketing",
    privilege: "comm.email",
  },
  {
    icon: BellRing,
    label: "Notification Marketing",
    path: "/admin/notification-marketing",
    privilege: "comm.email",
  },
  { icon: Share2, label: "Social Media", path: "/admin/social-media", privilege: "comm.email" },
  { icon: Settings, label: "Settings", path: "/admin/settings" },
];
