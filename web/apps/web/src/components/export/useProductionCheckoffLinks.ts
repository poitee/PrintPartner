import { useQuery } from "@tanstack/react-query";
import {
  fetchPrinterCheckoffLinks,
  type PrinterCheckoffLink,
  type PrinterCheckoffLinkState,
} from "../../api/endpoints/checkoff";

/**
 * Printer checkoff links are the durable record of a work package that already
 * left for a printer: which file was sent, to which host, and what happened.
 * Production reads them so a package stays visible after the send, instead of
 * disappearing until someone opens Checkoff.
 */
const TRACKED_STATES: readonly PrinterCheckoffLinkState[] = [
  "watching",
  "awaiting_verify",
  "host_failed",
  "verified",
  "applied",
];

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
      const responses = await Promise.all(
        TRACKED_STATES.map((state) =>
          fetchPrinterCheckoffLinks({ state, profile_id: profileId! }),
        ),
      );
      const byId = new Map<string, PrinterCheckoffLink>();
      for (const response of responses) {
        for (const link of response.links ?? []) byId.set(link.id, link);
      }
      return [...byId.values()];
    },
  });
}
