import { useQuery, type QueryClient } from "@tanstack/react-query";
import { fetchFilamentCatalog, fetchSpoolmanSpools } from "../api/endpoints/filaments";
import { queryKeys } from "./keys";

export function useFilamentCatalogQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.filamentCatalog,
    queryFn: fetchFilamentCatalog,
    enabled,
  });
}

export function invalidateFilamentCatalog(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.filamentCatalog });
}

export function useSpoolmanSpoolsQuery(integrationId: string | null) {
  return useQuery({
    queryKey: queryKeys.spoolmanSpools(integrationId ?? ""),
    queryFn: () => fetchSpoolmanSpools(integrationId!),
    enabled: Boolean(integrationId),
  });
}
