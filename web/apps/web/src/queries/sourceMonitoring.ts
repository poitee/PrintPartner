import { useQuery } from "@tanstack/react-query";
import { fetchSources } from "../api/endpoints/sources";
import { fetchSourceActivity } from "../api/endpoints/sourceContent";
import { queryKeys } from "./keys";

const SOURCE_NOTICE_POLL_MS = 60_000;

export function useSourceMonitoringQueries(enabled = true) {
  const sources = useQuery({
    queryKey: queryKeys.sources,
    queryFn: fetchSources,
    enabled,
    refetchInterval: SOURCE_NOTICE_POLL_MS,
    refetchIntervalInBackground: false,
  });
  const activity = useSourceActivityQuery(enabled);
  return { sources, activity };
}

export function useSourceActivityQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.sourceActivity,
    queryFn: () => fetchSourceActivity(20),
    enabled,
    refetchInterval: SOURCE_NOTICE_POLL_MS,
    refetchIntervalInBackground: false,
  });
}
