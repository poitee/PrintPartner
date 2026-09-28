import { useMemo } from "react";
import { partitionPrinterSendFleet } from "../../lib/printerSendModel";
import { useIntegrationsQuery, usePrintersQuery } from "../../queries/printerFleet";

/**
 * How many printers this Build can actually send a sliced file to.
 *
 * Plate assignment needs bed geometry; sending needs a linked printer host.
 * Those are different lists, so the "Send or start" task asks this one rather
 * than counting the Plate printers.
 */
export function useProductionSendFleet(enabled: boolean) {
  const printersQuery = usePrintersQuery(enabled);
  const integrationsQuery = useIntegrationsQuery(enabled);
  const data = useMemo(() => {
    if (!printersQuery.data || !integrationsQuery.data) return undefined;
    const fleet = partitionPrinterSendFleet(printersQuery.data, integrationsQuery.data);
    return {
      sendCount: fleet.sendPrinters.length,
      bambuCount: fleet.bambuPrinters.length,
    };
  }, [printersQuery.data, integrationsQuery.data]);
  return { data };
}
