import type { ProductionSelection } from "@print-partner/contracts";

const REQUIRED_UNIT_TOKEN = /^ppu_[0-9a-f]{32}$/;

/** Tokens the next package will make, using the same selection rules as Production. */
export function currentPackageRequiredUnitTokens(
  selection: ProductionSelection,
  units: readonly { token: string; completed?: boolean }[],
): string[] {
  if (selection.mode === "custom") {
    const available = new Set(units.map((unit) => unit.token));
    return selection.selected_unit_tokens.filter(
      (token) => available.has(token) && REQUIRED_UNIT_TOKEN.test(token),
    );
  }
  return units
    .filter((unit) => unit.completed !== true && REQUIRED_UNIT_TOKEN.test(unit.token))
    .map((unit) => unit.token);
}
