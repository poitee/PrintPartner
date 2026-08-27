import type { PrinterCheckoffLink } from "@print-partner/contracts";
import type { UnattributedPrint } from "../services/unattributed-print-store.js";
import { normalizePrinterFilename } from "../services/printer-checkoff.js";

const LINKED_CHECKOFF_STATES = new Set<PrinterCheckoffLink["state"]>([
  "watching",
  "awaiting_verify",
  "verified",
]);

export function linkedCheckoffLinks(
  links: readonly PrinterCheckoffLink[],
  integrationId?: string,
): PrinterCheckoffLink[] {
  return links.filter(
    (link) =>
      LINKED_CHECKOFF_STATES.has(link.state) &&
      (!integrationId || link.integration_id === integrationId),
  );
}

export function printMatchesLink(
  print: Pick<UnattributedPrint, "integration_id" | "filename">,
  link: Pick<PrinterCheckoffLink, "integration_id" | "filename">,
): boolean {
  return (
    link.integration_id === print.integration_id &&
    normalizePrinterFilename(link.filename) === normalizePrinterFilename(print.filename)
  );
}

export function filterLinkedUnattributedPrints(
  prints: readonly UnattributedPrint[],
  links: readonly PrinterCheckoffLink[],
  integrationId?: string,
): UnattributedPrint[] {
  const eligibleLinks = linkedCheckoffLinks(links, integrationId);
  return prints.filter((print) => {
    if (integrationId && print.integration_id !== integrationId) return false;
    return !eligibleLinks.some((link) => printMatchesLink(print, link));
  });
}
