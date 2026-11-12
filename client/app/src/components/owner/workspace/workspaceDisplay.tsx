// Shared visuals + copy for workspaces (switcher, picker cards, dashboards).
import { Home, SquareDot } from "lucide-react";
import { cn } from "@ui/lib/utils";
import type { WorkspaceType } from "@shared/firestore-schema";
import type { WorkspaceListEntry, WorkspaceRole } from "@shared/workspaces";
import { PALETTE } from "@/components/owner/dashboard/tokens";

// Real estate = green, business = aqua — data colours from the design tokens.
export const WORKSPACE_TONE: Record<WorkspaceType, string> = {
  real_estate: PALETTE.green,
  business: PALETTE.cyan,
};

export function WorkspaceGlyph({
  type,
  size = "md",
  className,
}: {
  type: WorkspaceType;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const Icon = type === "real_estate" ? Home : SquareDot;
  const box =
    size === "sm"
      ? "h-7 w-7 rounded-lg"
      : size === "lg"
        ? "h-12 w-12 rounded-xl"
        : "h-9 w-9 rounded-lg";
  const icon = size === "sm" ? 14 : size === "lg" ? 20 : 16;
  const tone = WORKSPACE_TONE[type];
  return (
    <span
      aria-hidden="true"
      className={cn("flex shrink-0 items-center justify-center", box, className)}
      style={{ backgroundColor: `${tone}1F`, color: tone }}
    >
      <Icon size={icon} strokeWidth={1.9} />
    </span>
  );
}

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  legacy: "Legacy contact",
  legal: "Legal",
  financial: "Financial",
};

export function workspaceRoleLabel(ws: Pick<WorkspaceListEntry, "role" | "permissions">): string {
  if (ws.role === "owner") return ROLE_LABEL.owner;
  const access = ws.permissions.includes("edit") ? "view & edit" : "view only";
  return `${ROLE_LABEL[ws.role]} · ${access}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// One-line description under a workspace name.
export function workspaceSubtitle(ws: WorkspaceListEntry): string {
  if (!ws.isSelf) return `Shared by ${ws.ownerName} · ${workspaceRoleLabel(ws)}`;
  if (ws.type === "business") return "Companies, their accounts, VAT and reports";
  if (!ws.stats) return "Properties, units and tenants";
  return `${plural(ws.stats.properties, "property", "properties")} · ${plural(
    ws.stats.activeTenants,
    "active tenant",
    "active tenants",
  )}`;
}
