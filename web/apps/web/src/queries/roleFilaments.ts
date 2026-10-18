import { useQuery, type QueryClient } from "@tanstack/react-query";
import { fetchRoleFilaments, type RoleFilamentRow } from "../api/endpoints/filaments";
import { useSpoolmanWorkflowAccess } from "../hooks/useSpoolmanWorkflowAccess";
import { hasSpoolmanAssignment } from "../lib/spoolmanIds";
import { queryKeys } from "./keys";

export function useRoleFilamentsQuery(profileId: number | null, enabled = true) {
  const access = useSpoolmanWorkflowAccess(profileId);
  return useQuery({
    queryKey: queryKeys.roleFilaments(profileId ?? 0, access.queryAllowed),
    ...(access.gated ? { staleTime: 0 } : {}),
    queryFn: () => fetchRoleFilaments(profileId!),
    enabled: enabled && profileId != null && profileId > 0,
    placeholderData: (previous, query) => query?.queryKey[1] === profileId ? previous : undefined,
    select: (rows) => access.allowed ? rows : rows.map((row) => hasSpoolmanAssignment(row)
      ? { ...row, filament_display: row.filament_color_id ?? "", filament_hex: row.filament_custom_hex ?? null } : row),
  });
}

export function invalidateRoleFilaments(queryClient: QueryClient, profileId: number) {
  return queryClient.invalidateQueries({
    queryKey: ["roleFilaments", profileId],
  });
}

export function publishRoleFilaments(
  queryClient: QueryClient,
  profileId: number,
  rows: RoleFilamentRow[],
) {
  queryClient.setQueryData(queryKeys.roleFilaments(profileId), rows);
  queryClient.setQueriesData({ queryKey: ["roleFilaments", profileId] }, rows);
}
