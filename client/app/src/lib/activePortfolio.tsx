import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "@ui/lib/useAuth";
import { BillingScopeProvider } from "@ui/lib/billingScope";
import { useAccessiblePortfolios, type AccessiblePortfolio } from "@/lib/ownerQueries";

// Which portfolio the owner-side UI should render. `null` = self (the signed-in
// user's own portfolio) and is the default. A non-null value is the ownerId of
// another portfolio that has granted the current user access (legacy / legal /
// financial contact). Persisted in localStorage so a refresh keeps the choice.
//
// On mount we re-validate the persisted ownerId against the live accessible-
// portfolios query — if the grant has been revoked, we silently fall back to
// self instead of leaving the user staring at a 403.

const STORAGE_KEY = "olio_active_portfolio_owner_id";

interface ActivePortfolioContextValue {
  activeOwnerId: string;
  // The STABLE Portfolio doc id for the active selection, derived from the
  // accessible-portfolios list. Null while that query is loading (or before
  // the self entry resolves) — callers fall back to the legacy ?ownerId=
  // path until it's known. Selection persistence stays ownerId-keyed.
  activePortfolioDocId: string | null;
  isSelf: boolean;
  activePortfolio: AccessiblePortfolio | null;
  permissions: ("view" | "edit")[];
  canEdit: boolean;
  setActiveOwnerId: (ownerId: string | null) => void;
  // True when we don't yet know whether the persisted ownerId is valid (the
  // accessible-portfolios query hasn't resolved). Pages can use this to delay
  // mutations that would target the wrong portfolio mid-resolution.
  loading: boolean;
}

const ActivePortfolioContext = createContext<ActivePortfolioContextValue>({
  activeOwnerId: "",
  activePortfolioDocId: null,
  isSelf: true,
  activePortfolio: null,
  permissions: ["view", "edit"],
  canEdit: true,
  setActiveOwnerId: () => {},
  loading: false,
});

function readPersisted(): string | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function writePersisted(v: string | null): void {
  try {
    if (v === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, v);
  } catch {
    // Storage may be disabled (Safari private mode); fall back to in-memory only.
  }
}

export function ActivePortfolioProvider({ children }: { children: ReactNode }) {
  const { firebaseUser } = useAuth();
  const portfoliosQuery = useAccessiblePortfolios();
  const portfolios = portfoliosQuery.data ?? [];

  // Persisted choice — initialize once, then keep it in state.
  const [persisted, setPersisted] = useState<string | null>(() => readPersisted());

  // If the persisted ownerId no longer appears in the accessible list (grant
  // revoked, signed in as a different user, etc.), drop it.
  useEffect(() => {
    if (!persisted) return;
    if (!portfoliosQuery.isSuccess) return;
    const stillThere = portfolios.some((p) => p.ownerId === persisted);
    if (!stillThere) {
      setPersisted(null);
      writePersisted(null);
    }
  }, [persisted, portfolios, portfoliosQuery.isSuccess]);

  const selfOwnerId = firebaseUser?.uid ?? "";
  const effectiveOwnerId = persisted ?? selfOwnerId;
  const activePortfolio = portfolios.find((p) => p.ownerId === effectiveOwnerId) ?? null;
  // Stable Portfolio doc id for the active selection. Null until the
  // accessible list resolves (or when the server hasn't backfilled one yet) —
  // consumers then keep using the legacy ?ownerId= scope param.
  const activePortfolioDocId = activePortfolio?.portfolioDocId ?? null;
  const isSelf = !persisted || persisted === selfOwnerId;
  const permissions = activePortfolio?.permissions ?? (isSelf ? ["view", "edit"] : ["view"]);
  const canEdit = isSelf || permissions.includes("edit");

  const value = useMemo<ActivePortfolioContextValue>(
    () => ({
      activeOwnerId: effectiveOwnerId,
      activePortfolioDocId,
      isSelf,
      activePortfolio,
      permissions,
      canEdit,
      setActiveOwnerId: (id: string | null) => {
        const next = !id || id === selfOwnerId ? null : id;
        setPersisted(next);
        writePersisted(next);
      },
      loading: portfoliosQuery.isLoading,
    }),
    [
      effectiveOwnerId,
      activePortfolioDocId,
      isSelf,
      activePortfolio,
      permissions,
      canEdit,
      selfOwnerId,
      portfoliosQuery.isLoading,
    ],
  );

  return (
    <ActivePortfolioContext.Provider value={value}>
      <BillingScopeProvider
        canManageBilling={isSelf}
        ownerName={isSelf ? null : (activePortfolio?.ownerName ?? null)}
      >
        {children}
      </BillingScopeProvider>
    </ActivePortfolioContext.Provider>
  );
}

export function useActivePortfolio(): ActivePortfolioContextValue {
  return useContext(ActivePortfolioContext);
}

// Convenience helper for hooks that need to inject the active-portfolio scope
// param into an owner API URL. Returns the URL unchanged when viewing self
// (prefetch warm-keys depend on the bare URL — do not change), otherwise
// appends `?portfolioId=<stable portfolio doc id>` when known (preferred),
// falling back to the legacy `?ownerId=<uid>` while the doc id is still
// resolving (or for rows the server hasn't backfilled). The legacy param keeps
// working server-side throughout Phase 2.
export function withOwnerScope(
  url: string,
  ownerId: string,
  isSelf: boolean,
  portfolioDocId?: string | null,
): string {
  if (isSelf || !ownerId) return url;
  const sep = url.includes("?") ? "&" : "?";
  if (portfolioDocId) {
    return `${url}${sep}portfolioId=${encodeURIComponent(portfolioDocId)}`;
  }
  return `${url}${sep}ownerId=${encodeURIComponent(ownerId)}`;
}
