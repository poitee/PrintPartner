import { useQuery } from "@tanstack/react-query";
import { ensureEngineRunning, fetchHealth, type HealthResponse } from "../api/engine";
import { queryKeys } from "./keys";

const HEALTH_POLL_MS = 8000;

async function loadHealth(): Promise<HealthResponse> {
  await ensureEngineRunning();
  return fetchHealth();
}

export function useHealthQuery() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: loadHealth,
    // Pause polling while the tab is hidden — no need to ping every 8s
    // when the user isn't looking at the page. Resumes instantly on focus.
    refetchInterval: (query) => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return false;
      }
      return query.state.error ? HEALTH_POLL_MS * 2 : HEALTH_POLL_MS;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 2,
  });
}

export type { HealthResponse };
