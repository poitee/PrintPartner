import type { PrinterCheckoffLink, PrinterCheckoffUnit } from "@print-partner/contracts";
import {
  groupObjectsByPart,
  matchObjectsToFilenames,
} from "../services/gcode-object-parser.js";
import { acceptedPlanBasis, type AcceptedPlanBasis } from "./accepted-plan-progress.js";
import type {
  AcceptedOperationalPart,
  AcceptedOperationalUnit,
  AcceptedPlanOperationalSnapshot,
} from "./accepted-plan-operational.js";
import type { UnattributedPrint } from "../services/unattributed-print-store.js";

export type AcceptedPrinterObservation = Readonly<{
  objectNames: readonly string[];
  fallbackFilename?: string;
}>;

type AcceptedPrinterMatchedOutcome = Readonly<{
  inputIndex: number;
  rawName: string;
  kind: "required_object_name" | "legacy_filename";
  unit: Readonly<PrinterCheckoffUnit>;
}>;

type AcceptedPrinterUnmatchedOutcome = Readonly<{
  inputIndex: number;
  rawName: string;
  kind:
    | "already_completed"
    | "duplicate_observation"
    | "ambiguous_filename"
    | "unmatched";
}>;

export type AcceptedPrinterNameOutcome =
  | AcceptedPrinterMatchedOutcome
  | AcceptedPrinterUnmatchedOutcome;

export type AcceptedPrinterAttribution = Readonly<{
  expected: AcceptedPlanBasis;
  units: readonly Readonly<PrinterCheckoffUnit>[];
  outcomes: readonly AcceptedPrinterNameOutcome[];
  unmatchedObjectNames: readonly string[];
  fallback: "unused" | "used" | "recognized_observation";
}>;

export type AcceptedPrinterLinkMetadata = Readonly<{
  integrationId: string;
  printerId: string;
  hostName: string;
  filename: string;
  started: boolean;
}>;

export type MaterializeAcceptedPrinterLinkCommand =
  | Readonly<{
      kind: "create";
      profileId: number;
      objectNames: readonly string[];
      fallbackFilename?: string;
      link: AcceptedPrinterLinkMetadata;
    }>
  | Readonly<{
      kind: "repair";
      expectedLink: PrinterCheckoffLink;
    }>
  | Readonly<{
      kind: "claim";
      profileId: number;
      expectedPrint: Readonly<UnattributedPrint>;
    }>;

export type MaterializeAcceptedPrinterLinkResult =
  | Readonly<{
      kind: "created" | "repaired" | "claimed";
      link: PrinterCheckoffLink;
      attribution: AcceptedPrinterAttribution;
    }>
  | Readonly<{
      kind:
        | "already_linked"
        | "link_not_found"
        | "link_changed"
        | "not_repairable"
        | "print_changed"
        | "no_match"
        | "empty"
        | "transaction_unavailable";
    }>
  | Readonly<{
      kind: "accepted_state_unavailable";
      reason: "compatibility_dirty" | "uninitialized";
    }>;

type AcceptedUnitSlot = Readonly<{
  part: AcceptedOperationalPart;
  unit: AcceptedOperationalUnit;
  coordinate: Readonly<PrinterCheckoffUnit>;
}>;

function parsedObjectName(rawName: string): string {
  const grouped = groupObjectsByPart([rawName]);
  return grouped.values().next().value?.objects[0]?.stlBasename ?? rawName;
}

function matchingAcceptedParts(
  rawName: string,
  parts: readonly AcceptedOperationalPart[],
): readonly AcceptedOperationalPart[] {
  const grouped = groupObjectsByPart([rawName]);
  const matched = matchObjectsToFilenames(
    grouped,
    parts.map((part) => part.filename),
  );
  const matchingFilenames = new Set(
    [...matched.values()].flat().map((filename) => filename.toLowerCase()),
  );
  return parts.filter((part) => matchingFilenames.has(part.filename.toLowerCase()));
}

export function resolveAcceptedPrinterAttribution(
  snapshot: AcceptedPlanOperationalSnapshot,
  observation: AcceptedPrinterObservation,
): AcceptedPrinterAttribution {
  const acceptedParts = snapshot.parts.filter(
    (part) => part.included && part.units.some((unit) => unit.required),
  );
  const allRequiredSlots: AcceptedUnitSlot[] = acceptedParts.flatMap((part) =>
    part.units
      .filter((unit) => unit.required)
      .map((unit) => ({
        part,
        unit,
        coordinate: { part_id: part.projectionPartId, unit_index: unit.unitIndex },
      })),
  );
  const availableSlots = allRequiredSlots.filter((slot) => !slot.unit.completed);
  const canonicalSlots = new Map(
    allRequiredSlots.map((slot) => [slot.unit.objectName.toLowerCase(), slot]),
  );
  const usedCoordinates = new Set<string>();
  const outcomesByIndex = new Map<number, AcceptedPrinterNameOutcome>();
  let recognizedCanonical = false;

  const coordinateKey = (coordinate: Readonly<PrinterCheckoffUnit>): string =>
    `${coordinate.part_id}:${coordinate.unit_index}`;

  for (const [inputIndex, rawName] of observation.objectNames.entries()) {
    const canonical = canonicalSlots.get(parsedObjectName(rawName).toLowerCase());
    if (!canonical) continue;
    recognizedCanonical = true;
    if (canonical.unit.completed) {
      outcomesByIndex.set(inputIndex, { inputIndex, rawName, kind: "already_completed" });
      continue;
    }
    const key = coordinateKey(canonical.coordinate);
    if (usedCoordinates.has(key)) {
      outcomesByIndex.set(inputIndex, {
        inputIndex,
        rawName,
        kind: "duplicate_observation",
      });
      continue;
    }
    usedCoordinates.add(key);
    outcomesByIndex.set(inputIndex, {
      inputIndex,
      rawName,
      kind: "required_object_name",
      unit: canonical.coordinate,
    });
  }

  for (const [inputIndex, rawName] of observation.objectNames.entries()) {
    if (outcomesByIndex.has(inputIndex)) continue;
    const parts = matchingAcceptedParts(rawName, acceptedParts);
    if (parts.length > 1) {
      outcomesByIndex.set(inputIndex, { inputIndex, rawName, kind: "ambiguous_filename" });
      continue;
    }
    const part = parts[0];
    const slot = part
      ? availableSlots.find(
          (candidate) =>
            candidate.part.projectionPartId === part.projectionPartId &&
            !usedCoordinates.has(coordinateKey(candidate.coordinate)),
        )
      : undefined;
    if (!slot) {
      outcomesByIndex.set(inputIndex, { inputIndex, rawName, kind: "unmatched" });
      continue;
    }
    usedCoordinates.add(coordinateKey(slot.coordinate));
    outcomesByIndex.set(inputIndex, {
      inputIndex,
      rawName,
      kind: "legacy_filename",
      unit: slot.coordinate,
    });
  }

  const outcomes = observation.objectNames.map((_rawName, inputIndex) => {
    const outcome = outcomesByIndex.get(inputIndex);
    if (!outcome) throw new Error("Printer observation outcome is missing");
    return outcome;
  });
  const units = outcomes.flatMap((outcome) => ("unit" in outcome ? [outcome.unit] : []));
  let fallback: AcceptedPrinterAttribution["fallback"] = recognizedCanonical
    ? "recognized_observation"
    : "unused";
  if (units.length === 0 && !recognizedCanonical && observation.fallbackFilename?.trim()) {
    const parts = matchingAcceptedParts(observation.fallbackFilename, acceptedParts);
    if (parts.length === 1) {
      const fallbackSlot = availableSlots.find(
        (slot) => slot.part.projectionPartId === parts[0]!.projectionPartId,
      );
      if (fallbackSlot) {
        units.push(fallbackSlot.coordinate);
        fallback = "used";
      }
    }
  }

  return {
    expected: acceptedPlanBasis(snapshot),
    units,
    outcomes,
    unmatchedObjectNames: outcomes.flatMap((outcome) =>
      "unit" in outcome ? [] : [outcome.rawName],
    ),
    fallback,
  };
}
