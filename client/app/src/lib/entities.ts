import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@ui/lib/useAuth";
import { apiRequest } from "@ui/lib/queryClient";
import type { Entity } from "@shared/firestore-schema";
import type { EntityInput, EntityListResponse } from "@shared/entities";

// The signed-in owner's entities (companies + personal holding). Owner-scoped,
// so the same list serves the Real Estate and the Business workspace.
export const ENTITIES_QUERY_KEY = "/api/entities";

export function useEntities() {
  const { firebaseUser } = useAuth();
  return useQuery<EntityListResponse>({
    queryKey: [ENTITIES_QUERY_KEY],
    enabled: !!firebaseUser,
  });
}

export function useCreateEntity() {
  const qc = useQueryClient();
  return useMutation<Entity, Error, Partial<EntityInput> & Pick<EntityInput, "entityType">>({
    mutationFn: async (body) => {
      const res = await apiRequest("POST", ENTITIES_QUERY_KEY, body);
      return (await res.json()) as Entity;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [ENTITIES_QUERY_KEY] });
    },
  });
}
