import { useQuery, type QueryClient } from "@tanstack/react-query";
import { fetchIntegrations } from "../api/endpoints/integrations";
import { fetchPrinters } from "../api/endpoints/printers";
import { queryKeys } from "./keys";

export function usePrintersQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.printers,
    queryFn: fetchPrinters,
    enabled,
  });
}

export function useIntegrationsQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.integrations,
    queryFn: fetchIntegrations,
    enabled,
  });
}

export function invalidateIntegrations(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.integrations });
}

export function invalidatePrinterFleet(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.printers }),
    invalidateIntegrations(queryClient),
  ]);
}
