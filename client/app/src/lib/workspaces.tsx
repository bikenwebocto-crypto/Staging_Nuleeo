import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@ui/lib/useAuth";
import { apiRequest } from "@ui/lib/queryClient";
import type { WorkspaceType } from "@shared/firestore-schema";
import {
  resolveActiveWorkspace,
  type WorkspaceListEntry,
  type WorkspaceListResponse,
} from "@shared/workspaces";
import { useActivePortfolio } from "@/lib/activePortfolio";

// Active workspace for the owner experience.
//
// A REAL-ESTATE workspace wraps a portfolio, so it does not keep a separate
// data scope: it follows ActivePortfolioProvider's active owner (the single
// source of truth every owner query already reads). Selecting a real-estate
// workspace therefore just switches the active portfolio, and switching the
// portfolio anywhere else (e.g. the dashboard owner filter) moves the
// workspace with it. A BUSINESS workspace is an explicit selection.
//
// The selection is remembered per browser (localStorage, a convenience) and
// per account (POST /api/workspaces/:id/open → User.lastWorkspaceId), so a new
// device restores the last workspace too.

export const WORKSPACES_QUERY_KEY = "/api/workspaces";
const STORAGE_KEY = "nuleeo_active_workspace_id";

function readPersisted(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function writePersisted(v: string | null): void {
  try {
    if (v) localStorage.setItem(STORAGE_KEY, v);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage disabled (private mode) — in-memory selection still works.
  }
}

interface WorkspaceContextValue {
  workspaces: WorkspaceListEntry[];
  activeWorkspace: WorkspaceListEntry | null;
  lastWorkspaceId: string | null;
  canCreate: WorkspaceType[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  selectWorkspace: (workspace: WorkspaceListEntry) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspaces: [],
  activeWorkspace: null,
  lastWorkspaceId: null,
  canCreate: [],
  isLoading: false,
  isError: false,
  refetch: () => {},
  selectWorkspace: () => {},
});

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { firebaseUser } = useAuth();
  const query = useQuery<WorkspaceListResponse>({
    queryKey: [WORKSPACES_QUERY_KEY],
    enabled: !!firebaseUser,
  });
  const { activeOwnerId, setActiveOwnerId } = useActivePortfolio();
  const [selectedId, setSelectedId] = useState<string | null>(() => readPersisted());

  const workspaces = useMemo(() => query.data?.workspaces ?? [], [query.data]);
  const lastWorkspaceId = query.data?.lastWorkspaceId ?? null;
  const preferredId = selectedId ?? lastWorkspaceId;

  // Drop a remembered selection that no longer exists (revoked grant,
  // different account on this browser).
  useEffect(() => {
    if (!query.isSuccess || !selectedId) return;
    if (!workspaces.some((w) => w.id === selectedId)) {
      setSelectedId(null);
      writePersisted(null);
    }
  }, [query.isSuccess, selectedId, workspaces]);

  // One-time hydration: if the remembered workspace is a real-estate one for
  // a different portfolio than the active one (e.g. restored from the server
  // on a new device), align the active portfolio to it. After this, the
  // active portfolio drives real-estate selection.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !query.isSuccess) return;
    hydrated.current = true;
    const preferred = workspaces.find((w) => w.id === preferredId);
    if (preferred?.type === "real_estate" && preferred.ownerId !== activeOwnerId) {
      setActiveOwnerId(preferred.isSelf ? null : preferred.ownerId);
    }
  }, [query.isSuccess, workspaces, preferredId, activeOwnerId, setActiveOwnerId]);

  const activeWorkspace = useMemo(
    () => resolveActiveWorkspace(workspaces, preferredId, activeOwnerId),
    [workspaces, preferredId, activeOwnerId],
  );

  const selectWorkspace = useCallback(
    (workspace: WorkspaceListEntry) => {
      setSelectedId(workspace.id);
      writePersisted(workspace.id);
      // Business workspaces have no portfolio; fall back to the user's own so
      // no cross-portfolio banner lingers.
      setActiveOwnerId(
        workspace.type === "real_estate" && !workspace.isSelf ? workspace.ownerId : null,
      );
      // Best-effort: remembering the choice server-side must never block or
      // fail the switch itself.
      apiRequest("POST", `/api/workspaces/${encodeURIComponent(workspace.id)}/open`).catch(
        () => {},
      );
    },
    [setActiveOwnerId],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspaces,
      activeWorkspace,
      lastWorkspaceId,
      canCreate: query.data?.canCreate ?? [],
      isLoading: query.isLoading,
      isError: query.isError,
      refetch: () => void query.refetch(),
      selectWorkspace,
    }),
    [workspaces, activeWorkspace, lastWorkspaceId, query, selectWorkspace],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  return useContext(WorkspaceContext);
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation<WorkspaceListEntry, Error, { type: WorkspaceType; name: string }>({
    mutationFn: async (body) => {
      const res = await apiRequest("POST", WORKSPACES_QUERY_KEY, body);
      return (await res.json()) as WorkspaceListEntry;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [WORKSPACES_QUERY_KEY] });
    },
  });
}
