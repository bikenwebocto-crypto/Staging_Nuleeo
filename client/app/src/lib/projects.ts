import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@shared/firestore-schema";
import { useAuth } from "@ui/lib/useAuth";
import { apiRequest } from "@ui/lib/queryClient";

export const PROJECTS_QUERY_KEY = "/api/projects";
export const OWNER_PROPERTIES_QUERY_KEY = "/api/owner/properties";

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function useProjects(enabled = true) {
  const { firebaseUser } = useAuth();
  return useQuery<{ projects: Project[] }>({
    queryKey: [PROJECTS_QUERY_KEY],
    enabled: enabled && !!firebaseUser,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) =>
      json<Project>(await apiRequest("POST", PROJECTS_QUERY_KEY, { name })),
    onSuccess: () => qc.invalidateQueries({ queryKey: [PROJECTS_QUERY_KEY] }),
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) =>
      json<Project>(await apiRequest("PATCH", `${PROJECTS_QUERY_KEY}/${id}`, { name })),
    onSuccess: () => qc.invalidateQueries({ queryKey: [PROJECTS_QUERY_KEY] }),
  });
}

export interface DeleteProjectResult {
  deleted: boolean;
  unassigned: number;
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      json<DeleteProjectResult>(await apiRequest("DELETE", `${PROJECTS_QUERY_KEY}/${id}`)),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: [PROJECTS_QUERY_KEY] }),
        qc.invalidateQueries({ queryKey: [OWNER_PROPERTIES_QUERY_KEY] }),
      ]);
    },
  });
}

export function useAssignPropertyProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      propertyId,
      projectId,
    }: {
      propertyId: string;
      projectId: string | null;
    }) => apiRequest("PATCH", `/api/properties/${propertyId}`, { projectId }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: [OWNER_PROPERTIES_QUERY_KEY] }),
        qc.invalidateQueries({ queryKey: [PROJECTS_QUERY_KEY] }),
      ]);
    },
  });
}
