import { useBambuWorkflowAccess } from "../../hooks/useBambuWorkflowAccess";
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
export function useProductionSendFleet({ profileId, enabled }: { profileId: number | null; enabled: boolean }) {
  const access = useBambuWorkflowAccess({ profileId, engineReady: enabled });
  const printersQuery = usePrintersQuery(enabled);
  const integrationsQuery = useIntegrationsQuery(enabled);
  const data = useMemo(() => {
    if (!printersQuery.data || !integrationsQuery.data) return undefined;
    const fleet = partitionPrinterSendFleet(printersQuery.data, integrationsQuery.data);
    const bambuCount = access.canHandoff ? fleet.bambuPrinters.length : 0;
    return {
      sendCount: fleet.sendPrinters.length + bambuCount,
      bambuCount,
    };
  }, [printersQuery.data, integrationsQuery.data, access.canHandoff]);
  return { data };
}
