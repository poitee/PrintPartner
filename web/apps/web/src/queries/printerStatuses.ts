import {
  queryOptions,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { PrinterHostStatus } from "@print-partner/contracts";
import { fetchIntegrationStatus } from "../api/endpoints/integrations";
import { usePrinterStatusPollMs } from "../hooks/usePrinterStatusPollMs";

const MAX_OFFLINE_POLL_MS = 60_000;

type PrinterStatusPoll = Readonly<{
  status: PrinterHostStatus;
  offlineStreak: number;
}>;

export function printerStatusKey(
  integrationId: string,
): readonly ["printer-status", string] {
  return ["printer-status", integrationId];
}

/** Consecutive polls that found the host unreachable, reset by any answer. */
export function nextOfflineStreak(previous: number | undefined, status: PrinterHostStatus): number {
  return status.state === "offline" ? (previous ?? 0) + 1 : 0;
}

/** Doubles the poll interval for each consecutive offline poll, up to five minutes. */
export function printerPollDelay(pollMs: number, offlineStreak: number): number {
  if (offlineStreak === 0) return pollMs;
  return Math.max(pollMs, Math.min(pollMs * 2 ** offlineStreak, MAX_OFFLINE_POLL_MS));
}

function offlineStatus(error: unknown): PrinterHostStatus {
  return {
    state: "offline",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function loadPrinterStatus(integrationId: string): Promise<PrinterHostStatus> {
  try {
    return await fetchIntegrationStatus(integrationId);
  } catch (error) {
    return offlineStatus(error);
  }
}

function printerStatusQuery(
  integrationId: string,
  pollMs: number,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: printerStatusKey(integrationId),
    queryFn: async ({ client, queryKey }): Promise<PrinterStatusPoll> => {
      const status = await loadPrinterStatus(integrationId);
      const previous = client.getQueryData<PrinterStatusPoll>(queryKey);
      return { status, offlineStreak: nextOfflineStreak(previous?.offlineStreak, status) };
    },
    enabled,
    staleTime: (query) => printerPollDelay(pollMs, query.state.data?.offlineStreak ?? 0),
    refetchInterval: enabled
      ? (query) => query.state.fetchStatus !== "idle"
        ? false
        : printerPollDelay(pollMs, query.state.data?.offlineStreak ?? 0)
      : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

function uniqueIntegrationIds(integrationIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const rawId of integrationIds) {
    const integrationId = rawId.trim();
    if (!integrationId || seen.has(integrationId)) continue;
    seen.add(integrationId);
    unique.push(integrationId);
  }
  return unique;
}

export function usePrinterStatuses(
  integrationIds: readonly string[],
  enabled = true,
) {
  const pollMs = usePrinterStatusPollMs();
  const queryClient = useQueryClient();
  const ids = useMemo(() => uniqueIntegrationIds(integrationIds), [integrationIds]);
  const statusByIntegration = useQueries({
    queries: ids.map((integrationId) =>
      printerStatusQuery(integrationId, pollMs, enabled),
    ),
    combine: (results) => {
      const statuses: Record<string, PrinterHostStatus> = {};
      if (!enabled) return statuses;
      for (const [index, integrationId] of ids.entries()) {
        const status = results[index]?.data?.status;
        if (status) statuses[integrationId] = status;
      }
      return statuses;
    },
  });

  const refresh = useCallback(
    (integrationId: string) => {
      const normalizedId = integrationId.trim();
      if (!normalizedId) return Promise.resolve<PrinterHostStatus | undefined>(undefined);
      return queryClient.fetchQuery({
        ...printerStatusQuery(normalizedId, pollMs, true),
        staleTime: 0,
      }).then((poll) => poll.status);
    },
    [pollMs, queryClient],
  );

  return { statusByIntegration, refresh };
}
