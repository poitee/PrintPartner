import { useQuery, type QueryClient } from "@tanstack/react-query";
import { fetchFilamentCatalog, fetchSpoolmanSpools } from "../api/endpoints/filaments";
import { useSpoolmanWorkflowAccess } from "../hooks/useSpoolmanWorkflowAccess";
import { queryKeys } from "./keys";

export function useFilamentCatalogQuery(options: {
  profileId?: number | null;
  enabled?: boolean;
} = {}) {
  const { profileId, enabled = true } = options;
  const access = useSpoolmanWorkflowAccess(profileId);
  return useQuery({
    queryKey: queryKeys.filamentCatalog(profileId, access.queryAllowed),
    staleTime: 0,
    queryFn: () => fetchFilamentCatalog(profileId),
    enabled,
    placeholderData: (previous, query) => query?.queryKey[1] === profileId ? previous : undefined,
    select: (catalog) => access.allowed ? catalog : { ...catalog, spoolman_colors: [], spoolman_status: "disabled" as const },
  });
}

export function invalidateFilamentCatalog(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.filamentCatalogs });
}

export function useSpoolmanSpoolsQuery(
  integrationId: string | null,
  options: {
    profileId?: number | null;
    enabled?: boolean;
  } = {},
) {
  const { profileId, enabled = true } = options;
  const access = useSpoolmanWorkflowAccess(profileId);
  return useQuery({
    queryKey: queryKeys.spoolmanSpools(integrationId ?? "", profileId, access.queryAllowed),
    staleTime: 0,
    queryFn: () => fetchSpoolmanSpools(integrationId!, profileId),
    enabled: enabled && Boolean(integrationId) && access.queryAllowed,
    select: (spools) => access.allowed ? spools : [],
  });
}
