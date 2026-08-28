import type {
  PrinterCheckoffLink,
  PrinterCheckoffUnit,
  PrinterFileDriftReason,
  PrinterFileIdentity,
  PrintFileClassification,
} from "@print-partner/contracts";
import {
  interpretSlicedObjectName,
  matchSlicedObjectName,
} from "@print-partner/domain";
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
  remotePath?: string;
  /** Provider identity of remotePath, including a SHA-256 of the bytes read. */
  remoteIdentity?: PrinterFileIdentity;
  /** What the bytes classified as. Never an operator's claim about them. */
  classification?: PrintFileClassification;
  started: boolean;
}>;

/**
 * The Required-unit coordinate the browser round-trips, `${part_id}:${unit_index}`.
 * The operator confirms a mapping in these terms, so a stale or invented token
 * is refused instead of quietly re-derived from filename similarity.
 */
export function parsePrinterCheckoffUnitToken(raw: string): PrinterCheckoffUnit | null {
  const [partIdText, unitIndexText, ...rest] = raw.trim().split(":");
  if (rest.length > 0 || !partIdText || unitIndexText === undefined) return null;
  const partId = Number(partIdText);
  const unitIndex = Number(unitIndexText);
  if (!Number.isInteger(partId) || partId <= 0) return null;
  if (!Number.isInteger(unitIndex) || unitIndex < 0) return null;
  return { part_id: partId, unit_index: unitIndex };
}

/**
 * Why a linked provider file no longer matches the identity recorded for it, or
 * null when it still does. Only fields present on both sides are compared, so
 * a provider that never reported a modification time cannot manufacture drift.
 */
export function detectPrinterFileDrift(input: {
  readonly recorded: PrinterFileIdentity | undefined;
  readonly observed: PrinterFileIdentity | null;
}): PrinterFileDriftReason | null {
  if (input.observed === null) return "missing";
  const { recorded, observed } = input;
  if (!recorded) return null;
  // Strongest evidence first: a content hash settles it, a provider revision is
  // the provider's own answer, and size beats a coarse modification time.
  if (recorded.sha256 && observed.sha256 && recorded.sha256 !== observed.sha256) return "content";
  if (
    recorded.provider_revision &&
    observed.provider_revision &&
    recorded.provider_revision !== observed.provider_revision
  ) {
    return "revision";
  }
  if (
    recorded.size_bytes !== undefined &&
    observed.size_bytes !== undefined &&
    recorded.size_bytes !== observed.size_bytes
  ) {
    return "size";
  }
  if (
    recorded.modified_at &&
    observed.modified_at &&
    recorded.modified_at !== observed.modified_at
  ) {
    return "modified";
  }
  return null;
}

export type ConfirmedPrinterUnitsResult =
  | Readonly<{ kind: "confirmed"; units: readonly Readonly<PrinterCheckoffUnit>[] }>
  | Readonly<{
      kind: "rejected";
      reason: "unknown_unit" | "already_completed" | "duplicate_unit";
      token: string;
    }>;

/**
 * Check an operator-confirmed mapping against the Accepted Plan.
 *
 * The operator picks the units; this only proves each pick is a Required unit
 * of this Build that is still incomplete, and stamps its object name so the
 * link reads the same as an object-name match would.
 */
export function confirmAcceptedPrinterUnits(input: {
  readonly snapshot: AcceptedPlanOperationalSnapshot;
  readonly confirmed: readonly Readonly<PrinterCheckoffUnit>[];
}): ConfirmedPrinterUnitsResult {
  const slots = new Map<string, AcceptedOperationalUnit>();
  for (const part of input.snapshot.parts) {
    if (!part.included) continue;
    for (const unit of part.units) {
      if (!unit.required) continue;
      slots.set(`${part.projectionPartId}:${unit.unitIndex}`, unit);
    }
  }
  const units: PrinterCheckoffUnit[] = [];
  const taken = new Set<string>();
  for (const coordinate of input.confirmed) {
    const token = `${coordinate.part_id}:${coordinate.unit_index}`;
    const slot = slots.get(token);
    if (!slot) return { kind: "rejected", reason: "unknown_unit", token };
    if (slot.completed) return { kind: "rejected", reason: "already_completed", token };
    if (taken.has(token)) return { kind: "rejected", reason: "duplicate_unit", token };
    taken.add(token);
    units.push({
      part_id: coordinate.part_id,
      unit_index: coordinate.unit_index,
      ...(slot.objectName ? { object_name: slot.objectName } : {}),
    });
  }
  return { kind: "confirmed", units };
}

export type MaterializeAcceptedPrinterLinkCommand =
  | Readonly<{
      kind: "create";
      profileId: number;
      /**
       * The Accepted Plan revision the operator's browser was looking at. A
       * mismatch means the Plan moved on, so the assignment is refused rather
       * than attached to a superseded revision.
       */
      expectedPlanRevisionId: number;
      objectNames: readonly string[];
      /**
       * Required units the operator confirmed. Filename similarity may suggest
       * a mapping but never creates one, so there is no filename fallback here.
       */
      confirmedUnits: readonly Readonly<PrinterCheckoffUnit>[];
      link: AcceptedPrinterLinkMetadata;
    }>
  | Readonly<{
      /**
       * The host reported it is already printing this file. There is no
       * operator in the loop, so this recovery path may still fall back to
       * filename similarity, exactly as the unattributed-print claim does.
       */
      kind: "observe";
      profileId: number;
      objectNames: readonly string[];
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
      objectNames?: readonly string[];
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
        | "stale_plan_revision"
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
  return interpretSlicedObjectName(rawName).unwrappedName.replace(/_stl$/i, ".stl");
}

function matchingAcceptedParts(
  rawName: string,
  parts: readonly AcceptedOperationalPart[],
): readonly AcceptedOperationalPart[] {
  const paths = parts.map((part) => part.relativePath || part.filename);
  const matched = matchSlicedObjectName(rawName, paths);
  if (matched.kind === "unmatched") return [];
  const matchingPaths = new Set(
    (matched.kind === "matched" ? [matched.filename] : matched.filenames).map((path) =>
      path.toLowerCase(),
    ),
  );
  return parts.filter((part) =>
    matchingPaths.has((part.relativePath || part.filename).toLowerCase()),
  );
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
