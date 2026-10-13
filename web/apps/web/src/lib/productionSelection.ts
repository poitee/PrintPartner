import type {
  AcceptedPlatePlacedUnit,
  AcceptedPlateSetupUnit,
  AcceptedPlateUnplacedUnit,
  AcceptedPlateWorkspace,
  ProductionSelection,
  RequiredUnitToken,
} from "@print-partner/contracts";

const REQUIRED_UNIT_TOKEN = /^ppu_[0-9a-f]{32}$/;

export type ProductionSelectableUnit =
  | AcceptedPlateSetupUnit
  | AcceptedPlatePlacedUnit
  | AcceptedPlateUnplacedUnit;

export function productionSelectableUnits(
  workspace: AcceptedPlateWorkspace,
): ProductionSelectableUnit[] {
  if (workspace.kind === "setup") return [...workspace.units];
  if (workspace.kind === "ready") {
    return [
      ...workspace.plates.flatMap((plate) => plate.units),
      ...workspace.unplaced,
      ...workspace.unassigned,
    ];
  }
  return [];
}

export function productionPlateReadiness(
  workspace: AcceptedPlateWorkspace | undefined,
  selectedTokens: ReadonlySet<string>,
) {
  if (workspace?.kind !== "ready") {
    return { unassigned: 0, unplaced: 0, hasUnselectedPlateUnits: false };
  }
  return {
    unassigned: workspace.unassigned.filter((unit) => selectedTokens.has(unit.token)).length,
    unplaced: workspace.unplaced.filter((unit) => selectedTokens.has(unit.token)).length,
    hasUnselectedPlateUnits: [
      ...workspace.plates.flatMap((plate) => plate.units),
      ...workspace.unplaced,
    ].some((unit) => !selectedTokens.has(unit.token)),
  };
}

export function initialMissingSelection(
  units: readonly ProductionSelectableUnit[],
): Set<RequiredUnitToken> {
  return new Set(
    units.filter((unit) => !unit.completed).map((unit) => unit.token),
  );
}

export function initialProductionSelection(
  units: readonly ProductionSelectableUnit[],
  select: string | null,
): Set<RequiredUnitToken> {
  if (select === "missing") return initialMissingSelection(units);
  return new Set(units.map((unit) => unit.token));
}

export function selectedProductionTokens(
  units: readonly ProductionSelectableUnit[],
  selection: ReadonlySet<RequiredUnitToken>,
): RequiredUnitToken[] {
  return units.filter((unit) => selection.has(unit.token)).map((unit) => unit.token);
}

/**
 * Tokens the server will lock against for the selection it has stored.
 * This follows `currentPackageRequiredUnitTokens` in the production-setup route:
 * a custom selection keeps its saved tokens, and all-incomplete drops finished units.
 */
export function storedPackageTokens(
  selection: ProductionSelection | undefined,
  units: readonly { token: string; completed?: boolean }[],
): string[] {
  if (selection == null || selection.mode === "all_incomplete") {
    return units
      .filter((unit) => unit.completed !== true && REQUIRED_UNIT_TOKEN.test(unit.token))
      .map((unit) => unit.token);
  }
  const available = new Set(units.map((unit) => unit.token));
  return selection.selected_unit_tokens.filter(
    (token) => available.has(token) && REQUIRED_UNIT_TOKEN.test(token),
  );
}

export function samePackageTokens(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  return seen.size === right.length && right.every((token) => seen.has(token));
}

export function toggleProductionUnit(
  selection: ReadonlySet<RequiredUnitToken>,
  token: RequiredUnitToken,
): Set<RequiredUnitToken> {
  const next = new Set(selection);
  if (next.has(token)) next.delete(token);
  else next.add(token);
  return next;
}

export function clearProductionSelectionGroup(
  selection: ReadonlySet<RequiredUnitToken>,
  units: readonly ProductionSelectableUnit[],
  field: "source_layer" | "role",
  value: string,
): Set<RequiredUnitToken> {
  const remove = new Set(
    units.filter((unit) => unit[field] === value).map((unit) => unit.token),
  );
  return new Set([...selection].filter((token) => !remove.has(token)));
}
