import type { AcceptedPlateWorkspace, RequiredUnitToken } from "@print-partner/contracts";

export function directExportTokensFromWorkspace(
  workspace: AcceptedPlateWorkspace | undefined,
): RequiredUnitToken[] {
  if (workspace?.kind === "setup") {
    return workspace.units.map((unit) => unit.token);
  }
  if (workspace?.kind === "ready") {
    return workspace.plates.flatMap((plate) => plate.units.map((unit) => unit.token));
  }
  return [];
}
