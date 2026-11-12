// Workspace service — the only writer of COL.workspaces.
//
// A real-estate workspace wraps the owner's existing Portfolio doc (see the
// `Workspace` comment in shared/firestore-schema.ts): portfolio data, scoping
// (ownerScope) and grants (portfolioAccessContacts) are untouched, so every
// existing owner keeps working — their workspace is created lazily on first
// list. Business workspaces carry no data yet.
//
// Access for non-owners is derived live from ACTIVE PortfolioAccessContacts on
// the wrapped portfolio, so a revoked grant drops the workspace immediately.

import { db } from "../firebase";
import { ensurePortfolio, getPortfolio } from "./portfolioBanking";
import {
  COL,
  type AccessPermission,
  type PortfolioAccessContact,
  type Property,
  type Tenant,
  type User,
  type Workspace,
  type WorkspaceType,
} from "../../shared/firestore-schema";
import {
  businessWorkspaceId,
  defaultWorkspaceName,
  realEstateWorkspaceId,
  sortWorkspaces,
  type WorkspaceListEntry,
  type WorkspaceListResponse,
  type WorkspaceRole,
  type WorkspaceStats,
} from "../../shared/workspaces";

const OWNER_PERMISSIONS: AccessPermission[] = ["view", "edit"];

function workspaceRef(id: string) {
  return db().collection(COL.workspaces).doc(id);
}

// Firestore ALREADY_EXISTS (gRPC code 6) as surfaced by the Admin SDK.
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}

// Atomic get-or-create on a deterministic id: concurrent callers race on
// `create()`, the loser reads the winner's doc. Never overwrites.
async function createIfAbsent(ws: Workspace): Promise<{ workspace: Workspace; created: boolean }> {
  const ref = workspaceRef(ws.id);
  try {
    await ref.create(ws);
    return { workspace: ws, created: true };
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    const snap = await ref.get();
    return { workspace: snap.data() as Workspace, created: false };
  }
}

function displayName(user: Pick<User, "firstName" | "lastName" | "email"> | undefined): string {
  if (!user) return "";
  return `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || (user.email ?? "");
}

// Get-or-create the real-estate workspace wrapping `portfolioDocId`.
async function ensureRealEstateWorkspaceFor(
  ownerId: string,
  portfolioDocId: string,
  ownerFirstName: string | undefined,
): Promise<Workspace> {
  const id = realEstateWorkspaceId(portfolioDocId);
  const snap = await workspaceRef(id).get();
  if (snap.exists) return snap.data() as Workspace;
  const { workspace } = await createIfAbsent({
    id,
    type: "real_estate",
    name: defaultWorkspaceName("real_estate", ownerFirstName),
    ownerId,
    portfolioId: portfolioDocId,
    memberIds: [ownerId],
    createdAt: new Date().toISOString(),
  });
  return workspace;
}

export async function ensureOwnRealEstateWorkspace(
  ownerId: string,
  profile: User | undefined,
): Promise<Workspace> {
  const portfolio = await ensurePortfolio(ownerId);
  return ensureRealEstateWorkspaceFor(ownerId, portfolio.id, profile?.firstName);
}

// Active grants held by `uid`, each resolved to the granted portfolio doc id
// (stamped on the grant, or looked up by owner for unstamped legacy rows).
async function activeGrants(
  uid: string,
): Promise<{ grant: PortfolioAccessContact; portfolioDocId: string }[]> {
  const snap = await db()
    .collection(COL.portfolioAccessContacts)
    .where("contactUserId", "==", uid)
    .get();
  const grants = snap.docs
    .map((d) => d.data() as PortfolioAccessContact)
    .filter((g) => g.status === "active");
  const resolved = await Promise.all(
    grants.map(async (g) => ({
      grant: g,
      portfolioDocId: g.portfolioId ?? (await getPortfolio(g.ownerId))?.id ?? null,
    })),
  );
  return resolved.filter(
    (r): r is { grant: PortfolioAccessContact; portfolioDocId: string } => !!r.portfolioDocId,
  );
}

// Counts that mirror what the owner UI shows: soft-deactivated properties are
// hidden there, and only `active` tenancies generate rent. `select()` keeps the
// reads to one small field per doc.
async function loadStats(portfolioDocId: string): Promise<WorkspaceStats> {
  const [props, tenants] = await Promise.all([
    db()
      .collection(COL.properties)
      .where("portfolioId", "==", portfolioDocId)
      .select("status")
      .get(),
    db().collection(COL.tenants).where("portfolioId", "==", portfolioDocId).select("status").get(),
  ]);
  return {
    properties: props.docs.filter(
      (d) => (d.data() as Pick<Property, "status">).status !== "inactive",
    ).length,
    activeTenants: tenants.docs.filter(
      (d) => (d.data() as Pick<Tenant, "status">).status === "active",
    ).length,
  };
}

async function toEntry(
  ws: Workspace,
  viewerUid: string,
  role: WorkspaceRole,
  permissions: AccessPermission[],
  ownerName: string,
): Promise<WorkspaceListEntry> {
  return {
    id: ws.id,
    type: ws.type,
    name: ws.name,
    ownerId: ws.ownerId,
    ownerName,
    portfolioDocId: ws.portfolioId ?? null,
    role,
    permissions,
    isSelf: ws.ownerId === viewerUid,
    stats: ws.type === "real_estate" && ws.portfolioId ? await loadStats(ws.portfolioId) : null,
    createdAt: ws.createdAt,
  };
}

export async function listWorkspaces(
  uid: string,
  profile: User | undefined,
  isOwner: boolean,
): Promise<WorkspaceListResponse> {
  const ownSnap = await db().collection(COL.workspaces).where("ownerId", "==", uid).get();
  const own = ownSnap.docs.map((d) => d.data() as Workspace);

  // Backward compatibility: every existing owner gets a real-estate workspace
  // around the portfolio they already have, on first list.
  if (isOwner && !own.some((w) => w.type === "real_estate")) {
    own.push(await ensureOwnRealEstateWorkspace(uid, profile));
  }

  const selfName = displayName(profile);
  const entries: WorkspaceListEntry[] = await Promise.all(
    own.map((ws) => toEntry(ws, uid, "owner", OWNER_PERMISSIONS, selfName)),
  );

  // Real-estate workspaces shared with the caller through portfolio access.
  const grants = (await activeGrants(uid)).filter((g) => g.grant.ownerId !== uid);
  const ownerIds = Array.from(new Set(grants.map((g) => g.grant.ownerId)));
  const ownerSnaps = await Promise.all(
    ownerIds.map((id) => db().collection(COL.users).doc(id).get()),
  );
  const owners = new Map<string, User>();
  ownerSnaps.forEach((s) => s.exists && owners.set(s.id, s.data() as User));

  const seen = new Set(entries.map((e) => e.id));
  for (const { grant, portfolioDocId } of grants) {
    const owner = owners.get(grant.ownerId);
    const ws = await ensureRealEstateWorkspaceFor(grant.ownerId, portfolioDocId, owner?.firstName);
    if (seen.has(ws.id)) continue;
    seen.add(ws.id);
    entries.push(
      await toEntry(ws, uid, grant.type, grant.permissions, displayName(owner) || grant.ownerId),
    );
  }

  const workspaces = sortWorkspaces(entries);
  const ownedTypes = new Set(own.map((w) => w.type));
  const canCreate: WorkspaceType[] = isOwner
    ? (["real_estate", "business"] as WorkspaceType[]).filter((t) => !ownedTypes.has(t))
    : [];
  const last = profile?.lastWorkspaceId;
  return {
    workspaces,
    lastWorkspaceId: last && workspaces.some((w) => w.id === last) ? last : null,
    canCreate,
  };
}

export type WorkspaceAccess =
  | { ok: true; workspace: Workspace; role: WorkspaceRole; permissions: AccessPermission[] }
  | { ok: false; status: 403 | 404; error: string };

// Membership check for a single workspace. Owners always pass; for a
// real-estate workspace, an ACTIVE grant on the wrapped portfolio passes.
// Unknown ids and non-members both get 404 so ids can't be probed.
export async function resolveWorkspaceAccess(
  uid: string,
  workspaceId: string,
): Promise<WorkspaceAccess> {
  const notFound = { ok: false, status: 404, error: "Workspace not found" } as const;
  const snap = await workspaceRef(workspaceId).get();
  if (!snap.exists) return notFound;
  const ws = snap.data() as Workspace;
  if (ws.ownerId === uid) {
    return { ok: true, workspace: ws, role: "owner", permissions: OWNER_PERMISSIONS };
  }
  if (ws.type !== "real_estate" || !ws.portfolioId) return notFound;
  const grant = (await activeGrants(uid)).find((g) => g.portfolioDocId === ws.portfolioId);
  if (!grant) return notFound;
  return { ok: true, workspace: ws, role: grant.grant.type, permissions: grant.grant.permissions };
}

export type CreateWorkspaceResult =
  { ok: true; entry: WorkspaceListEntry } | { ok: false; status: 409; error: string };

export async function createWorkspace(
  uid: string,
  profile: User | undefined,
  type: WorkspaceType,
  name: string,
): Promise<CreateWorkspaceResult> {
  const now = new Date().toISOString();
  let candidate: Workspace;
  if (type === "real_estate") {
    const portfolio = await ensurePortfolio(uid);
    candidate = {
      id: realEstateWorkspaceId(portfolio.id),
      type,
      name,
      ownerId: uid,
      portfolioId: portfolio.id,
      memberIds: [uid],
      createdAt: now,
    };
  } else {
    candidate = {
      id: businessWorkspaceId(uid),
      type,
      name,
      ownerId: uid,
      memberIds: [uid],
      createdAt: now,
    };
  }
  const { workspace, created } = await createIfAbsent(candidate);
  if (!created) {
    return {
      ok: false,
      status: 409,
      error:
        type === "real_estate"
          ? "You already have a real estate workspace"
          : "You already have a business workspace",
    };
  }
  return {
    ok: true,
    entry: await toEntry(workspace, uid, "owner", OWNER_PERMISSIONS, displayName(profile)),
  };
}

export async function recordWorkspaceOpened(uid: string, workspaceId: string): Promise<void> {
  await db().collection(COL.users).doc(uid).set({ lastWorkspaceId: workspaceId }, { merge: true });
}
