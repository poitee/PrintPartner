import {
  queryOptions,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { PrinterHostStatus } from "@print-partner/contracts";
import { fetchIntegrationStatus } from "../api/endpoints/integrations";
import { usePrinterStatusPollMs } from "../hooks/usePrinterStatusPollMs";

export function printerStatusKey(
  integrationId: string,
): readonly ["printer-status", string] {
  return ["printer-status", integrationId];
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
    queryFn: () => loadPrinterStatus(integrationId),
    enabled,
    staleTime: pollMs,
    refetchInterval: enabled
      ? (query) => query.state.fetchStatus !== "idle"
        ? false
        : pollMs
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
        const status = results[index]?.data;
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
      });
    },
    [pollMs, queryClient],
  );

  return { statusByIntegration, refresh };
}
