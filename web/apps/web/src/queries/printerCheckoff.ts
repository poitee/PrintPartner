import { useQuery, type QueryClient } from "@tanstack/react-query";
import { fetchPrinterCheckoffLinks, fetchUnattributedPrints } from "../api/endpoints/checkoff";
import { queryKeys } from "./keys";

export function usePrinterCheckoffLinksQuery(enabled: boolean, pollMs?: number) {
  return useQuery({
    queryKey: queryKeys.printerCheckoffLinks,
    queryFn: () => fetchPrinterCheckoffLinks(),
    enabled,
    ...(pollMs == null
      ? {}
      : { staleTime: pollMs, refetchInterval: pollMs, refetchIntervalInBackground: false }),
    retry: false,
  });
}

export function useUnattributedPrintsQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.unattributedPrints,
    queryFn: fetchUnattributedPrints,
    enabled,
    retry: false,
  });
}

export function invalidatePrinterFarm(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.printerCheckoffLinks }),
    queryClient.invalidateQueries({ queryKey: queryKeys.unattributedPrints }),
  ]);
}
