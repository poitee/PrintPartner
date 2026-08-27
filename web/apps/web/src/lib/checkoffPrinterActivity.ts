import type { UnattributedPrint } from "@print-partner/contracts";
import type { PrinterCheckoffLink } from "../api/endpoints/checkoff";
import type { ReviewPart } from "../api/endpoints/planManifests";

export type SuggestedPrinterClaim = {
  hostName: string;
  printId: string;
  filename: string;
  stlBasename: string;
};

export type CheckoffPrinterActivityParts = {
  printingPartIds: Map<number, string>;
  awaitingPartIds: Map<number, string>;
  suggestedPartIds: Map<number, SuggestedPrinterClaim>;
};

export function buildCheckoffPrinterActivityParts(input: {
  watchingLinks: PrinterCheckoffLink[];
  awaitingLinks: PrinterCheckoffLink[];
  unattributedPrints: UnattributedPrint[];
  includedParts: ReviewPart[];
}): CheckoffPrinterActivityParts {
  const printingPartIds = new Map<number, string>();
  for (const link of input.watchingLinks) {
    if (link.state !== "watching") continue;
    for (const unit of link.units ?? []) {
      if (!printingPartIds.has(unit.part_id)) {
        printingPartIds.set(unit.part_id, link.host_name);
      }
    }
  }

  const awaitingPartIds = new Map<number, string>();
  for (const link of input.awaitingLinks) {
    if (link.state !== "awaiting_verify") continue;
    for (const unit of link.units ?? []) {
      if (!awaitingPartIds.has(unit.part_id)) {
        awaitingPartIds.set(unit.part_id, link.host_name);
      }
    }
  }

  const partsByFilename = new Map<string, ReviewPart>();
  for (const part of input.includedParts) {
    partsByFilename.set(part.filename, part);
  }

  const suggestedPartIds = new Map<number, SuggestedPrinterClaim>();
  for (const print of input.unattributedPrints) {
    for (const candidate of print.candidates ?? []) {
      for (const matchingFilename of candidate.matching_filenames ?? []) {
        const part = partsByFilename.get(matchingFilename);
        if (!part || suggestedPartIds.has(part.id)) continue;
        suggestedPartIds.set(part.id, {
          hostName: print.host_name,
          printId: print.id,
          filename: print.filename,
          stlBasename: candidate.stl_basename,
        });
      }
    }
  }

  return { printingPartIds, awaitingPartIds, suggestedPartIds };
}
