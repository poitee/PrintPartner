import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  bulkAssignSourceCategory,
  createSource,
  deleteSource,
  fetchSources,
  updateSource,
  type SourceSummary,
} from "../api/engine";
import { queryKeys } from "./keys";

function upsertSources(
  current: SourceSummary[] | undefined,
  updated: readonly SourceSummary[],
): SourceSummary[] {
  const byId = new Map(updated.map((source) => [source.id, source]));
  const next = (current ?? []).map((source) => byId.get(source.id) ?? source);
  const known = new Set(next.map((source) => source.id));
  for (const source of updated) {
    if (!known.has(source.id)) next.push(source);
  }
  return next;
}

function cacheSources(queryClient: QueryClient, updated: readonly SourceSummary[]): void {
  queryClient.setQueryData<SourceSummary[]>(queryKeys.sources, (current) =>
    upsertSources(current, updated),
  );
}

export async function invalidateSourceDependents(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.sources }),
    queryClient.invalidateQueries({ queryKey: queryKeys.profiles }),
    queryClient.invalidateQueries({ queryKey: queryKeys.planReviews }),
  ]);
}

export function useSourcesQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.sources,
    queryFn: fetchSources,
    enabled,
  });
}

export function useCreateSourceMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createSource,
    onSuccess: async (created) => {
      cacheSources(qc, [created]);
      await invalidateSourceDependents(qc);
    },
  });
}

export function useUpdateSourceMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: Parameters<typeof updateSource>[1] }) =>
      updateSource(id, body),
    onSuccess: async (updated) => {
      cacheSources(qc, [updated]);
      await invalidateSourceDependents(qc);
    },
  });
}

export function useDeleteSourceMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteSource(id),
    onSuccess: async (_result, id) => {
      qc.setQueryData<SourceSummary[]>(queryKeys.sources, (current) =>
        (current ?? []).filter((source) => source.id !== id),
      );
      await invalidateSourceDependents(qc);
    },
  });
}

export function useBulkAssignSourceCategoryMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceIds, category }: { sourceIds: number[]; category: string | null }) =>
      bulkAssignSourceCategory(sourceIds, category),
    onSuccess: async (result) => {
      cacheSources(qc, result.updated);
      await invalidateSourceDependents(qc);
    },
  });
}

export function invalidateSources(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: queryKeys.sources });
}

export type { SourceSummary };
