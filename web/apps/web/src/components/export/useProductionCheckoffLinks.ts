import { useQuery } from "@tanstack/react-query";
import {
  fetchPrinterCheckoffLinks,
  type PrinterCheckoffLink,
} from "../../api/endpoints/checkoff";

/**
 * Printer checkoff links are the durable record of a work package that already
 * left for a printer: which file was sent, to which host, and what happened.
 * Production reads them so a package stays visible after the send, instead of
 * disappearing until someone opens Checkoff.
 */
export const productionCheckoffLinksKey = (profileId: number | null) =>
  ["production-checkoff-links", profileId] as const;

export function useProductionCheckoffLinks(profileId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: productionCheckoffLinksKey(profileId),
    enabled: enabled && profileId != null,
    // A print finishes while the page is open, so poll gently rather than
    // leaving the operator with a stale "Printing" line.
    refetchInterval: 15_000,
    queryFn: async (): Promise<PrinterCheckoffLink[]> => {
      if (profileId == null) return [];
      const response = await fetchPrinterCheckoffLinks({ profile_id: profileId });
      return response.links.filter((link) => link.state !== "dismissed");
    },
  });
}
