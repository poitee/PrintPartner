import type {
  AcceptedPlatePlacedUnit,
  AcceptedPlateSetupUnit,
  AcceptedPlateUnplacedUnit,
  AcceptedPlateWorkspace,
  RequiredUnitToken,
} from "@print-partner/contracts";

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
