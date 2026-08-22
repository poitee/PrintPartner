import type { IntegrationConfig, IntegrationTestResult } from "@print-partner/contracts";
import type { IntegrationAdapter } from "../store.js";

export const slicerFolderAdapter: IntegrationAdapter = {
  type: "slicer_folder",

  async testConnection(_config: IntegrationConfig): Promise<IntegrationTestResult> {
    return { ok: false, message: "Slicer folder watch integration not implemented yet" };
  },
};
