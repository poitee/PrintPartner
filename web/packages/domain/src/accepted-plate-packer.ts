export type AcceptedPlatePrinterGeometry = Readonly<{
  bedWidthUm: number;
  bedDepthUm: number;
  bedHeightUm: number;
  marginUm: number;
}>;

export type AcceptedPackingUnit = Readonly<{
  token: string;
  widthUm: number;
  depthUm: number;
  heightUm: number;
}>;

export type AcceptedPackedUnit = AcceptedPackingUnit & Readonly<{
  xUm: number;
  yUm: number;
}>;

export type AcceptedPlateFootprint = Readonly<{
  xUm: number;
  yUm: number;
  widthUm: number;
  depthUm: number;
}>;

export type AcceptedPlacedPackingUnit = AcceptedPackedUnit & Readonly<{
  placement: "auto" | "manual" | "unplaced";
  pinned: boolean;
}>;

export type PackAcceptedUnitsResult =
  | {
      readonly kind: "packed";
      readonly plates: readonly Readonly<{ units: readonly AcceptedPackedUnit[] }>[];
    }
  | { readonly kind: "unit_too_large"; readonly token: string };

function compareUnits(left: AcceptedPackingUnit, right: AcceptedPackingUnit): number {
  const longest = Math.max(right.widthUm, right.depthUm) - Math.max(left.widthUm, left.depthUm);
  if (longest !== 0) return longest;
  const leftArea = BigInt(left.widthUm) * BigInt(left.depthUm);
  const rightArea = BigInt(right.widthUm) * BigInt(right.depthUm);
  if (rightArea !== leftArea) return rightArea > leftArea ? 1 : -1;
  return left.token < right.token ? -1 : left.token > right.token ? 1 : 0;
}

function printableBounds(printer: AcceptedPlatePrinterGeometry): Readonly<{
  min: number;
  maxX: number;
  maxY: number;
  usableWidth: number;
  usableDepth: number;
}> {
  return {
    min: printer.marginUm,
    maxX: printer.bedWidthUm - printer.marginUm,
    maxY: printer.bedDepthUm - printer.marginUm,
    usableWidth: printer.bedWidthUm - 2 * printer.marginUm,
    usableDepth: printer.bedDepthUm - 2 * printer.marginUm,
  };
}

function unitFitsPrinter(
  printer: AcceptedPlatePrinterGeometry,
  unit: AcceptedPackingUnit,
): boolean {
  const bounds = printableBounds(printer);
  return (
    unit.widthUm <= bounds.usableWidth &&
    unit.depthUm <= bounds.usableDepth &&
    unit.heightUm <= printer.bedHeightUm
  );
}

export function acceptedPlateUnitsViolateClearance(
  left: AcceptedPlateFootprint,
  right: AcceptedPlateFootprint,
  clearanceUm: number,
): boolean {
  return (
    left.xUm < right.xUm + right.widthUm + clearanceUm &&
    right.xUm < left.xUm + left.widthUm + clearanceUm &&
    left.yUm < right.yUm + right.depthUm + clearanceUm &&
    right.yUm < left.yUm + left.depthUm + clearanceUm
  );
}

function inBounds(
  printer: AcceptedPlatePrinterGeometry,
  unit: AcceptedPackedUnit,
): boolean {
  const bounds = printableBounds(printer);
  return (
    unit.xUm >= bounds.min &&
    unit.yUm >= bounds.min &&
    unit.xUm + unit.widthUm <= bounds.maxX &&
    unit.yUm + unit.depthUm <= bounds.maxY &&
    unit.heightUm <= printer.bedHeightUm
  );
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function findSlot(
  printer: AcceptedPlatePrinterGeometry,
  occupied: readonly AcceptedPackedUnit[],
  unit: AcceptedPackingUnit,
): Readonly<{ xUm: number; yUm: number }> | null {
  const bounds = printableBounds(printer);
  const xs = uniqueSorted([
    bounds.min,
    ...occupied.flatMap((item) => [item.xUm, item.xUm + item.widthUm + printer.marginUm]),
  ]).filter((xUm) => xUm + unit.widthUm <= bounds.maxX);
  const ys = uniqueSorted([
    bounds.min,
    ...occupied.flatMap((item) => [item.yUm, item.yUm + item.depthUm + printer.marginUm]),
  ]).filter((yUm) => yUm + unit.depthUm <= bounds.maxY);

  for (const yUm of ys) {
    for (const xUm of xs) {
      const candidate: AcceptedPackedUnit = { ...unit, xUm, yUm };
      if (!inBounds(printer, candidate)) continue;
      if (occupied.some((item) => acceptedPlateUnitsViolateClearance(item, candidate, printer.marginUm))) continue;
      return { xUm, yUm };
    }
  }
  return null;
}

export function packAcceptedUnits(input: Readonly<{
  printer: AcceptedPlatePrinterGeometry;
  units: readonly AcceptedPackingUnit[];
}>): PackAcceptedUnitsResult {
  const { printer } = input;
  const units = [...input.units].sort(compareUnits);

  for (const unit of units) {
    if (!unitFitsPrinter(printer, unit)) {
      return { kind: "unit_too_large", token: unit.token };
    }
  }

  const plates: Array<{ units: AcceptedPackedUnit[] }> = [];
  let current: AcceptedPackedUnit[] = [];
  let xUm = printer.marginUm;
  let yUm = printer.marginUm;
  let rowDepthUm = 0;

  const flush = () => {
    if (current.length === 0) return;
    plates.push({ units: current });
    current = [];
    xUm = printer.marginUm;
    yUm = printer.marginUm;
    rowDepthUm = 0;
  };

  for (const unit of units) {
    if (xUm > printer.marginUm && xUm + unit.widthUm > printer.bedWidthUm - printer.marginUm) {
      xUm = printer.marginUm;
      yUm += rowDepthUm + printer.marginUm;
      rowDepthUm = 0;
    }
    if (yUm + unit.depthUm > printer.bedDepthUm - printer.marginUm) flush();
    current.push({
      token: unit.token,
      widthUm: unit.widthUm,
      depthUm: unit.depthUm,
      heightUm: unit.heightUm,
      xUm,
      yUm,
    });
    xUm += unit.widthUm + printer.marginUm;
    rowDepthUm = Math.max(rowDepthUm, unit.depthUm);
  }
  flush();
  return { kind: "packed", plates };
}

export function packAcceptedUnitsAround(input: Readonly<{
  printer: AcceptedPlatePrinterGeometry;
  occupied: readonly AcceptedPackedUnit[];
  units: readonly AcceptedPackingUnit[];
}>): PackAcceptedUnitsResult {
  const occupiedTokens = new Set(input.occupied.map((unit) => unit.token));
  const moving = input.units
    .filter((unit) => !occupiedTokens.has(unit.token))
    .slice()
    .sort(compareUnits);
  for (const unit of [...input.occupied, ...moving]) {
    if (!unitFitsPrinter(input.printer, unit)) {
      return { kind: "unit_too_large", token: unit.token };
    }
  }
  if (input.occupied.length === 0) {
    return packAcceptedUnits({ printer: input.printer, units: moving });
  }

  const firstPlate: AcceptedPackedUnit[] = input.occupied.map((unit) => ({ ...unit }));
  const leftover: AcceptedPackingUnit[] = [];
  for (const unit of moving) {
    const slot = findSlot(input.printer, firstPlate, unit);
    if (slot == null) {
      leftover.push(unit);
    } else {
      firstPlate.push({ ...unit, ...slot });
    }
  }
  const extra = leftover.length === 0
    ? { kind: "packed" as const, plates: [] }
    : packAcceptedUnits({ printer: input.printer, units: leftover });
  if (extra.kind !== "packed") return extra;
  return { kind: "packed", plates: [{ units: firstPlate }, ...extra.plates] };
}

export function arrangeAcceptedUnits(input: Readonly<{
  mode: "unplaced" | "all";
  printer: AcceptedPlatePrinterGeometry;
  units: readonly AcceptedPlacedPackingUnit[];
}>): PackAcceptedUnitsResult {
  if (input.mode === "all") {
    return packAcceptedUnits({ printer: input.printer, units: input.units });
  }
  const occupied = input.units.filter((unit) => unit.placement === "manual" || unit.pinned);
  const moving = input.units.filter((unit) => unit.placement !== "manual" && !unit.pinned);
  return packAcceptedUnitsAround({ printer: input.printer, occupied, units: moving });
}
