import type { ProductionSetup, ProductionSetupCommand } from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";

export async function fetchProductionSetup(profileId: number): Promise<ProductionSetup> {
  return engineFetch<ProductionSetup>(`/plans/${profileId}/production-setup`);
}

export async function applyProductionSetupCommand(
  profileId: number,
  command: ProductionSetupCommand,
): Promise<ProductionSetup> {
  return engineFetch<ProductionSetup>(`/plans/${profileId}/production-setup`, {
    method: "PATCH",
    body: JSON.stringify(command),
  });
}
