import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useAuth } from "@ui/lib/useAuth";
import { apiRequest } from "@ui/lib/queryClient";
import type { Entity } from "@shared/firestore-schema";
import type {
  BusinessDraft,
  BusinessPortfolioResponse,
  BusinessWizardData,
  OwnershipFilter,
  PortfolioView,
  WizardStep,
} from "@shared/businesses";
import type { BusinessDetailResponse, ShareholderRowInput } from "@shared/shareholdings";

// Businesses are Entities (entityType COMPANY), so every key lives under
// /api/entities and one prefix invalidation refreshes all entity views.
const isEntityKey = (key: readonly unknown[]) =>
  typeof key[0] === "string" && key[0].startsWith("/api/entities");

export function useBusinessPortfolio(params: {
  q: string;
  ownership: OwnershipFilter;
  view: PortfolioView;
}) {
  const { firebaseUser } = useAuth();
  const qs = new URLSearchParams();
  if (params.q.trim()) qs.set("q", params.q.trim());
  if (params.ownership !== "all") qs.set("ownership", params.ownership);
  if (params.view !== "active") qs.set("view", params.view);
  const url = `/api/entities/portfolio${qs.size ? `?${qs}` : ""}`;
  return useQuery<BusinessPortfolioResponse>({
    queryKey: [url],
    enabled: !!firebaseUser,
    placeholderData: keepPreviousData,
  });
}

export function useBusiness(id: string | undefined) {
  const { firebaseUser } = useAuth();
  return useQuery<Entity>({
    queryKey: [`/api/entities/${encodeURIComponent(id ?? "")}`],
    enabled: !!firebaseUser && !!id,
  });
}

// ── Business Detail ─────────────────────────────────────────────────────
const detailKey = (id: string) => `/api/entities/${encodeURIComponent(id)}/detail`;

export function useBusinessDetail(id: string | undefined) {
  const { firebaseUser } = useAuth();
  return useQuery<BusinessDetailResponse>({
    queryKey: [detailKey(id ?? "")],
    enabled: !!firebaseUser && !!id,
    retry: (n, err) => !String(err?.message).startsWith("404") && n < 2,
  });
}

function useEntityMutation<TBody, TRes>(id: string, run: (body: TBody) => Promise<TRes>) {
  const qc = useQueryClient();
  return useMutation<TRes, Error, TBody>({
    mutationFn: run,
    onSuccess: (res) => {
      if (res && typeof res === "object" && "business" in res) qc.setQueryData([detailKey(id)], res);
      qc.invalidateQueries({ predicate: (q) => isEntityKey(q.queryKey) && q.queryKey[0] !== BUSINESS_DRAFT_KEY });
    },
  });
}

export function useUpdateBusiness(id: string) {
  return useEntityMutation<BusinessWizardData, Entity>(id, async (body) =>
    (await apiRequest("PATCH", `/api/entities/${encodeURIComponent(id)}`, body)).json(),
  );
}

export function useArchiveBusiness(id: string) {
  return useEntityMutation<{ archive: boolean }, Entity>(id, async ({ archive }) =>
    (await apiRequest("POST", `/api/entities/${encodeURIComponent(id)}/${archive ? "archive" : "unarchive"}`)).json(),
  );
}

export function useSaveShareholders(id: string) {
  return useEntityMutation<{ shareholders: ShareholderRowInput[]; complete: boolean }, BusinessDetailResponse>(
    id,
    async (body) => (await apiRequest("PUT", `/api/entities/${encodeURIComponent(id)}/shareholders`, body)).json(),
  );
}

export const BUSINESS_DRAFT_KEY = "/api/entities/draft";

export function useBusinessDraft() {
  const { firebaseUser } = useAuth();
  return useQuery<{ draft: BusinessDraft | null }>({
    queryKey: [BUSINESS_DRAFT_KEY],
    enabled: !!firebaseUser,
    // The wizard owns the draft once loaded; don't refetch underneath it.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useSaveBusinessDraft() {
  const qc = useQueryClient();
  return useMutation<{ draft: BusinessDraft }, Error, { step: WizardStep; data: BusinessWizardData }>({
    mutationFn: async (body) => (await apiRequest("PUT", BUSINESS_DRAFT_KEY, body)).json(),
    onSuccess: (res) => qc.setQueryData([BUSINESS_DRAFT_KEY], res),
  });
}

export function useDiscardBusinessDraft() {
  const qc = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: async () => {
      await apiRequest("DELETE", BUSINESS_DRAFT_KEY);
    },
    onSuccess: () => qc.setQueryData([BUSINESS_DRAFT_KEY], { draft: null }),
  });
}

export function useCreateBusiness() {
  const qc = useQueryClient();
  return useMutation<Entity, Error, { submissionId: string; data: BusinessWizardData }>({
    mutationFn: async (body) => (await apiRequest("POST", "/api/entities/business", body)).json(),
    onSuccess: () => {
      qc.setQueryData([BUSINESS_DRAFT_KEY], { draft: null });
      qc.invalidateQueries({ predicate: (q) => isEntityKey(q.queryKey) && q.queryKey[0] !== BUSINESS_DRAFT_KEY });
    },
  });
}
