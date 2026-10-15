import { useQuery, type QueryClient } from "@tanstack/react-query";
import { fetchFilamentCatalog, fetchSpoolmanSpools } from "../api/endpoints/filaments";
import { queryKeys } from "./keys";

export function useFilamentCatalogQuery(options: {
  profileId?: number | null;
  enabled?: boolean;
} = {}) {
  const { profileId, enabled = true } = options;
  return useQuery({
    queryKey: queryKeys.filamentCatalog(profileId),
    queryFn: () => fetchFilamentCatalog(profileId),
    enabled,
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
  return useQuery({
    queryKey: queryKeys.spoolmanSpools(integrationId ?? "", profileId),
    queryFn: () => fetchSpoolmanSpools(integrationId!, profileId),
    enabled: enabled && Boolean(integrationId),
  });
}
