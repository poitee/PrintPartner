import { createHash } from "node:crypto";
import {
  acceptedPlateUnitsViolateClearance,
  MAX_ACCEPTED_PLATES,
} from "@print-partner/domain";
import { parseRequiredUnitToken } from "../services/required-units.js";
import type { AcceptedPlateInput, AcceptedPlateUnitInput } from "./accepted-plates.js";

export const MAX_ACCEPTED_PLATE_UM = 2_147_483_647;
export const ACCEPTED_PLATE_LAYOUT_FORMAT = 2;
export const LEGACY_ACCEPTED_PLATE_LAYOUT_FORMAT = 1;

export type AcceptedPlateLayoutFailure =
  | { readonly kind: "stale_accepted_plan" }
  | {
      readonly kind: "accepted_state_unavailable";
      readonly reason: "compatibility_dirty" | "uninitialized";
    }
  | { readonly kind: "plan_archived" }
  | { readonly kind: "invalid_units" }
  | { readonly kind: "invalid_geometry"; readonly reason: "outside_build_area" | "overlapping_units" };

export type ValidatedPlate = AcceptedPlateInput & Readonly<{ ordinal: number }>;

export function unitPlacement(unit: AcceptedPlateUnitInput): "auto" | "manual" | "unplaced" {
  return unit.placement === "manual" || unit.placement === "unplaced" ? unit.placement : "auto";
}

export function unitPinned(unit: AcceptedPlateUnitInput): boolean {
  return unit.pinned === true;
}

export function unitDimensionsFitPrintableArea(
  plate: AcceptedPlateInput,
  unit: AcceptedPlateUnitInput,
): boolean {
  return (
    unit.widthUm <= plate.bedWidthUm - 2 * plate.marginUm &&
    unit.depthUm <= plate.bedDepthUm - 2 * plate.marginUm &&
    unit.heightUm <= plate.bedHeightUm
  );
}

export function storedInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_ACCEPTED_PLATE_UM;
}

export function normalizedText(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 200 ? normalized : null;
}

export function validatePlates(
  plates: readonly AcceptedPlateInput[],
  expectedTokens: ReadonlySet<string>,
  requireEveryExpectedToken = true,
  spacing: "clearance" | "overlap_only" = "clearance",
): { readonly kind: "ready"; readonly plates: readonly ValidatedPlate[] } | AcceptedPlateLayoutFailure {
  if (
    plates.length === 0 ||
    plates.length > MAX_ACCEPTED_PLATES ||
    expectedTokens.size === 0
  ) {
    return { kind: "invalid_units" };
  }
  const seenPlates = new Set<string>();
  const seenTokens = new Set<string>();
  const normalized: ValidatedPlate[] = [];
  for (const [index, plate] of plates.entries()) {
    const plateId = normalizedText(plate.plateId);
    const printerId = normalizedText(plate.printerId);
    const printerName = normalizedText(plate.printerName);
    const printerModel = normalizedText(plate.printerModel);
    if (!plateId || !printerId || !printerName || !printerModel || seenPlates.has(plateId)) {
      return { kind: "invalid_units" };
    }
    seenPlates.add(plateId);
    if (
      !storedInteger(plate.bedWidthUm) ||
      plate.bedWidthUm <= 0 ||
      !storedInteger(plate.bedDepthUm) ||
      plate.bedDepthUm <= 0 ||
      !storedInteger(plate.bedHeightUm) ||
      plate.bedHeightUm <= 0 ||
      !storedInteger(plate.marginUm) ||
      plate.marginUm < 0 ||
      plate.marginUm > Math.floor(plate.bedWidthUm / 2) ||
      plate.marginUm > Math.floor(plate.bedDepthUm / 2)
    ) {
      return { kind: "invalid_geometry", reason: "outside_build_area" };
    }
    const units: AcceptedPlateUnitInput[] = [];
    for (const unit of plate.units) {
      try {
        parseRequiredUnitToken(unit.token);
      } catch {
        return { kind: "invalid_units" };
      }
      if (!expectedTokens.has(unit.token) || seenTokens.has(unit.token)) {
        return { kind: "invalid_units" };
      }
      seenTokens.add(unit.token);
      const placement = unitPlacement(unit);
      if (
        !storedInteger(unit.xUm) ||
        !storedInteger(unit.yUm) ||
        !storedInteger(unit.widthUm) ||
        !storedInteger(unit.depthUm) ||
        !storedInteger(unit.heightUm) ||
        unit.widthUm <= 0 ||
        unit.depthUm <= 0 ||
        unit.heightUm <= 0 ||
        (placement !== "unplaced" &&
          (unit.xUm < plate.marginUm ||
            unit.yUm < plate.marginUm ||
            unit.xUm > plate.bedWidthUm - plate.marginUm ||
            unit.widthUm > plate.bedWidthUm - plate.marginUm - unit.xUm ||
            unit.yUm > plate.bedDepthUm - plate.marginUm ||
            unit.depthUm > plate.bedDepthUm - plate.marginUm - unit.yUm ||
            unit.heightUm > plate.bedHeightUm))
      ) {
        return { kind: "invalid_geometry", reason: "outside_build_area" };
      }
      units.push({ ...unit, placement, pinned: placement === "unplaced" ? false : unitPinned(unit) });
    }
    const onBed = units.filter((unit) => unitPlacement(unit) !== "unplaced");
    for (let leftIndex = 0; leftIndex < onBed.length; leftIndex += 1) {
      const left = onBed[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < onBed.length; rightIndex += 1) {
        const right = onBed[rightIndex]!;
        const clearanceUm = spacing === "clearance" ? plate.marginUm : 0;
        if (acceptedPlateUnitsViolateClearance(left, right, clearanceUm)) {
          return { kind: "invalid_geometry", reason: "overlapping_units" };
        }
      }
    }
    normalized.push({
      ...plate,
      plateId,
      printerId,
      printerName,
      printerModel,
      ordinal: index + 1,
      units,
    });
  }
  if (seenTokens.size === 0) return { kind: "invalid_units" };
  if (requireEveryExpectedToken && seenTokens.size !== expectedTokens.size) {
    return { kind: "invalid_units" };
  }
  return { kind: "ready", plates: normalized };
}

export function layoutDigest(
  plates: readonly ValidatedPlate[],
  format = ACCEPTED_PLATE_LAYOUT_FORMAT,
): string {
  const canonical = {
    format,
    plates: plates.map((plate) => ({
      ordinal: plate.ordinal,
      plateId: plate.plateId,
      printerId: plate.printerId,
      printerName: plate.printerName,
      printerModel: plate.printerModel,
      bedWidthUm: plate.bedWidthUm,
      bedDepthUm: plate.bedDepthUm,
      bedHeightUm: plate.bedHeightUm,
      marginUm: plate.marginUm,
      units: [...plate.units]
        .sort((left, right) => left.token.localeCompare(right.token))
        .map((unit) => ({
          token: unit.token,
          xUm: unit.xUm,
          yUm: unit.yUm,
          widthUm: unit.widthUm,
          depthUm: unit.depthUm,
          heightUm: unit.heightUm,
          ...(format >= 2 ? { placement: unitPlacement(unit), pinned: unitPinned(unit) } : {}),
        })),
    })),
  };

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
