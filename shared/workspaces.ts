// Shared workspace contract: API shapes + pure helpers used by the Express
// routes (server/routes/workspaces.ts), the client provider
// (client/app/src/lib/workspaces.tsx) and their tests. No I/O here.

import {
  WORKSPACE_NAME_MAX,
  WORKSPACE_TYPES,
  type AccessContactType,
  type AccessPermission,
  type Plan,
  type User,
  type WorkspaceType,
} from "./firestore-schema";

// "owner" for the workspace's owner; otherwise the access-contact type that
// grants the caller read (and maybe edit) access to the wrapped portfolio.
export type WorkspaceRole = "owner" | AccessContactType;

export interface WorkspaceStats {
  properties: number;
  activeTenants: number;
}

export interface WorkspaceListEntry {
  id: string;
  type: WorkspaceType;
  name: string;
  ownerId: string;
  ownerName: string;
  // real_estate: the wrapped Portfolio doc id (the ?portfolioId= scope key).
  portfolioDocId: string | null;
  role: WorkspaceRole;
  permissions: AccessPermission[];
  isSelf: boolean;
  // null for business workspaces (no business data model yet).
  stats: WorkspaceStats | null;
  createdAt: string;
}

export interface WorkspaceListResponse {
  workspaces: WorkspaceListEntry[];
  // Only echoed back when it still points at a workspace in `workspaces`.
  lastWorkspaceId: string | null;
  // Workspace types the caller may still create (owner-experience users only;
  // max one of each type per owner).
  canCreate: WorkspaceType[];
}

export const WORKSPACE_TYPE_LABEL: Record<WorkspaceType, string> = {
  real_estate: "Real estate portfolio",
  business: "Business",
};

export function realEstateWorkspaceId(portfolioDocId: string): string {
  return `re_${portfolioDocId}`;
}

export function businessWorkspaceId(ownerId: string): string {
  return `biz_${ownerId}`;
}

export function isWorkspaceType(v: unknown): v is WorkspaceType {
  return typeof v === "string" && (WORKSPACE_TYPES as readonly string[]).includes(v);
}

export function defaultWorkspaceName(type: WorkspaceType, firstName?: string | null): string {
  const base = type === "real_estate" ? "Real Estate" : "Businesses";
  const first = firstName?.trim();
  return first ? `${first} ${base}` : base;
}

// Validates an already-sanitized name. Returns an error message or null.
export function validateWorkspaceName(name: string): string | null {
  if (name.length === 0) return "Workspace name is required";
  if (name.length > WORKSPACE_NAME_MAX) {
    return `Workspace name must be ${WORKSPACE_NAME_MAX} characters or fewer`;
  }
  return null;
}

// Mirrors client/app/src/lib/isOwner.ts#isOwnerExperience so the server can
// apply the same "may this account own workspaces?" rule. `resolvePlan` is
// only called on the legacy path (ownerModeEnabled unset, no owner role), so
// the common case costs no Auth lookup.
export async function canOwnWorkspaces(
  profile: Pick<User, "roles" | "ownerModeEnabled"> | undefined,
  resolvePlan: () => Promise<Plan>,
): Promise<boolean> {
  if (!profile) return false;
  if (typeof profile.ownerModeEnabled === "boolean") return profile.ownerModeEnabled;
  if (profile.roles?.includes("owner")) return true;
  return (await resolvePlan()) !== "basic";
}

// Own workspaces first (real estate before business), then granted ones by
// owner name. Stable for equal keys.
export function sortWorkspaces(entries: WorkspaceListEntry[]): WorkspaceListEntry[] {
  const typeRank = (t: WorkspaceType) => (t === "real_estate" ? 0 : 1);
  return [...entries].sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    if (a.type !== b.type) return typeRank(a.type) - typeRank(b.type);
    return a.ownerName.localeCompare(b.ownerName);
  });
}

// Which workspace is active. A business workspace is an explicit choice; a
// real-estate workspace FOLLOWS the active portfolio (activeOwnerId), so a
// portfolio switch anywhere in the app moves the workspace with it. Falls
// back to the preferred one, then the first.
export function resolveActiveWorkspace(
  workspaces: WorkspaceListEntry[],
  preferredId: string | null,
  activeOwnerId: string,
): WorkspaceListEntry | null {
  const preferred = workspaces.find((w) => w.id === preferredId) ?? null;
  if (preferred?.type === "business") return preferred;
  const forActivePortfolio = workspaces.find(
    (w) => w.type === "real_estate" && w.ownerId === activeOwnerId,
  );
  return forActivePortfolio ?? preferred ?? workspaces[0] ?? null;
}
