/**
 * Direct export writes every selected unit into one unarranged 3MF. "Unarranged"
 * means no Printer allocation, not a heap: parts stacked at a single origin
 * interpenetrate, and a slicer opens that as one tangled mass. Lay the units out
 * the way the Plates step showed them instead - each Plate's layout preserved,
 * Plates set side by side so they cannot collide - and shelf-pack anything that
 * was never placed into a strip after the last Plate.
 */

export const DIRECT_EXPORT_GAP_UM = 10_000;

const DEFAULT_STRIP_WIDTH_UM = 250_000;

export type DirectExportLayoutUnit = Readonly<{
  token: string;
  widthUm: number;
  depthUm: number;
}>;

export type DirectExportPlacement = Readonly<{
  plateOrdinal: number;
  xUm: number;
  yUm: number;
}>;

export type DirectExportPlate = Readonly<{
  ordinal: number;
  bedWidthUm: number;
  bedDepthUm: number;
}>;

export type DirectExportPosition = Readonly<{ xUm: number; yUm: number }>;

function plateOffsetsUm(
  plates: readonly DirectExportPlate[],
  gapUm: number,
): { offsetByOrdinal: Map<number, number>; stripStartUm: number; stripWidthUm: number } {
  const ordered = [...plates].sort((left, right) => left.ordinal - right.ordinal);
  const offsetByOrdinal = new Map<number, number>();
  let cursorUm = 0;
  let widestBedUm = 0;
  for (const plate of ordered) {
    offsetByOrdinal.set(plate.ordinal, cursorUm);
    cursorUm += plate.bedWidthUm + gapUm;
    widestBedUm = Math.max(widestBedUm, plate.bedWidthUm);
  }
  return {
    offsetByOrdinal,
    stripStartUm: cursorUm,
    stripWidthUm: widestBedUm || DEFAULT_STRIP_WIDTH_UM,
  };
}

export function layOutDirectExportUnits(input: Readonly<{
  units: readonly DirectExportLayoutUnit[];
  placements: ReadonlyMap<string, DirectExportPlacement>;
  plates: readonly DirectExportPlate[];
  gapUm?: number;
}>): ReadonlyMap<string, DirectExportPosition> {
  const gapUm = input.gapUm ?? DIRECT_EXPORT_GAP_UM;
  const { offsetByOrdinal, stripStartUm, stripWidthUm } = plateOffsetsUm(input.plates, gapUm);
  const positions = new Map<string, DirectExportPosition>();
  const unplaced: DirectExportLayoutUnit[] = [];

  for (const unit of input.units) {
    const placement = input.placements.get(unit.token);
    const offsetUm = placement ? offsetByOrdinal.get(placement.plateOrdinal) : undefined;
    if (!placement || offsetUm === undefined) {
      unplaced.push(unit);
      continue;
    }
    positions.set(unit.token, { xUm: offsetUm + placement.xUm, yUm: placement.yUm });
  }

  let xUm = stripStartUm;
  let yUm = 0;
  let rowDepthUm = 0;
  for (const unit of unplaced) {
    if (xUm > stripStartUm && xUm + unit.widthUm > stripStartUm + stripWidthUm) {
      xUm = stripStartUm;
      yUm += rowDepthUm + gapUm;
      rowDepthUm = 0;
    }
    positions.set(unit.token, { xUm, yUm });
    xUm += unit.widthUm + gapUm;
    rowDepthUm = Math.max(rowDepthUm, unit.depthUm);
  }
  return positions;
}
