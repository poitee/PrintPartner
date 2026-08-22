import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  archiveProfile,
  createProfile,
  deleteProfile,
  duplicateProfile,
  fetchProfiles,
  touchProfileLastUsed,
  updateProfile,
  type ProfileSummary,
} from "../api/engine";
import { queryKeys } from "./keys";

function asSummary(
  row: ProfileSummary & { layers?: unknown },
): ProfileSummary {
  const { layers: _layers, ...summary } = row;
  return summary;
}

function upsertProfile(
  list: ProfileSummary[] | undefined,
  row: ProfileSummary,
): ProfileSummary[] {
  const prev = list ?? [];
  if (prev.some((p) => p.id === row.id)) {
    return prev.map((p) => (p.id === row.id ? row : p));
  }
  return [row, ...prev];
}

export function useProfilesQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.profiles,
    queryFn: fetchProfiles,
    enabled,
  });
}

export function useCreateProfileMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createProfile(name),
    onSuccess: async (created) => {
      qc.setQueryData<ProfileSummary[]>(queryKeys.profiles, (prev) =>
        upsertProfile(prev, asSummary(created)),
      );
      await qc.invalidateQueries({ queryKey: queryKeys.profiles });
    },
  });
}

export function useUpdateProfileMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      name,
      special_request,
    }: {
      id: number;
      name?: string;
      special_request?: string | null;
    }) => updateProfile(id, { name, special_request }),
    onSuccess: async (updated) => {
      qc.setQueryData<ProfileSummary[]>(queryKeys.profiles, (prev) =>
        upsertProfile(prev, updated),
      );
      await qc.invalidateQueries({ queryKey: queryKeys.profiles });
    },
  });
}

export function useArchiveProfileMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => archiveProfile(id),
    onSuccess: async (updated) => {
      qc.setQueryData<ProfileSummary[]>(queryKeys.profiles, (prev) =>
        upsertProfile(prev, updated),
      );
      await qc.invalidateQueries({ queryKey: queryKeys.profiles });
    },
  });
}

export function useTouchProfileLastUsedMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => touchProfileLastUsed(id),
    onSuccess: (updated) => {
      // Merge only last_used_at so a delayed touch cannot clobber archived_at.
      qc.setQueryData<ProfileSummary[]>(queryKeys.profiles, (prev) =>
        (prev ?? []).map((p) =>
          p.id === updated.id ? { ...p, last_used_at: updated.last_used_at } : p,
        ),
      );
    },
  });
}

export function useDeleteProfileMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteProfile(id),
    onSuccess: async (_void, id) => {
      qc.setQueryData<ProfileSummary[]>(queryKeys.profiles, (prev) =>
        (prev ?? []).filter((p) => p.id !== id),
      );
      await qc.invalidateQueries({ queryKey: queryKeys.profiles });
    },
  });
}

export function useDuplicateProfileMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      name,
      clearCheckoff,
    }: {
      id: number;
      name: string;
      clearCheckoff?: boolean;
    }) => duplicateProfile(id, name, { clearCheckoff }),
    onSuccess: async (copy) => {
      qc.setQueryData<ProfileSummary[]>(queryKeys.profiles, (prev) =>
        upsertProfile(prev, asSummary(copy)),
      );
      await qc.invalidateQueries({ queryKey: queryKeys.profiles });
    },
  });
}

export function invalidateProfiles(qc: ReturnType<typeof useQueryClient>) {
  return qc.invalidateQueries({ queryKey: queryKeys.profiles });
}

export type { ProfileSummary };
