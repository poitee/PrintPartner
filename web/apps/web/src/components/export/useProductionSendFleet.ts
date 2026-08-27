import { useQuery } from "@tanstack/react-query";
import { fetchIntegrations } from "../../api/endpoints/integrations";
import { fetchPrinters } from "../../api/endpoints/printers";
import { partitionPrinterSendFleet } from "../../lib/printerSendModel";

/**
 * How many printers this Build can actually send a sliced file to.
 *
 * Plate assignment needs bed geometry; sending needs a linked printer host.
 * Those are different lists, so the "Send or start" task asks this one rather
 * than counting the Plate printers.
 */
export const productionSendFleetKey = ["production-send-fleet"] as const;

export function useProductionSendFleet(enabled: boolean) {
  return useQuery({
    queryKey: productionSendFleetKey,
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const [printers, integrations] = await Promise.all([
        fetchPrinters(),
        fetchIntegrations(),
      ]);
      const fleet = partitionPrinterSendFleet(printers, integrations);
      return {
        sendCount: fleet.sendPrinters.length,
        bambuCount: fleet.bambuPrinters.length,
      };
    },
  });
}
