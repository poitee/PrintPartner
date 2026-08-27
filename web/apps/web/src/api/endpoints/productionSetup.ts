import type { ProductionSetup, ProductionSetupInput } from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";

/** Row shape from GET /profile-library — mirrors AppRepository.ProfileLibraryRow on the server. */
export type ProfileLibraryRow = {
  id: number;
  kind: "printer" | "process" | "filament";
  name: string;
  slicerFormat: string | null;
  materialType: string | null;
  resolvedFlatConfig: string | null;
  sourcePath: string | null;
  syncedFromSlicerVersion: string | null;
  lastSyncedAt: string | null;
  importedAt: string;
};

export async function fetchProductionSetup(profileId: number): Promise<ProductionSetup> {
  return engineFetch<ProductionSetup>(`/plans/${profileId}/production-setup`);
}

export async function saveProductionSetup(
  profileId: number,
  setup: ProductionSetupInput,
): Promise<ProductionSetup> {
  return engineFetch<ProductionSetup>(`/plans/${profileId}/production-setup`, {
    method: "PUT",
    body: JSON.stringify(setup),
  });
}

export async function fetchProfileLibrary(): Promise<ProfileLibraryRow[]> {
  const body = await engineFetch<{ profiles: ProfileLibraryRow[] }>("/profile-library");
  return body.profiles;
}
