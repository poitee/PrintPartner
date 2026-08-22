import { useQuery, type QueryClient } from "@tanstack/react-query";
import { fetchRoleFilaments, type RoleFilamentRow } from "../api/engine";
import { queryKeys } from "./keys";

export function useRoleFilamentsQuery(profileId: number | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.roleFilaments(profileId ?? 0),
    queryFn: () => fetchRoleFilaments(profileId!),
    enabled: enabled && profileId != null && profileId > 0,
  });
}

export function invalidateRoleFilaments(queryClient: QueryClient, profileId: number) {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.roleFilaments(profileId),
  });
}

export function publishRoleFilaments(
  queryClient: QueryClient,
  profileId: number,
  rows: RoleFilamentRow[],
) {
  queryClient.setQueryData(queryKeys.roleFilaments(profileId), rows);
}
