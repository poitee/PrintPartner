import type { IntegrationConfig, IntegrationTestResult } from "@print-partner/contracts";
import type { IntegrationAdapter } from "../store.js";
import {
  listSpoolmanFilaments,
  listSpoolmanSpools,
  testSpoolmanConnection,
} from "../spoolman-client.js";

export const spoolmanAdapter: IntegrationAdapter = {
  type: "spoolman",

  async testConnection(config: IntegrationConfig): Promise<IntegrationTestResult> {
    return testSpoolmanConnection(config);
  },

  async listDevices(config: IntegrationConfig) {
    try {
      const filaments = await listSpoolmanFilaments(config);
      const spools = await listSpoolmanSpools(config);
      return [
        {
          id: "spoolman",
          name: `Spoolman (${filaments.length} filaments, ${spools.length} spools)`,
          type: "spoolman",
        },
      ];
    } catch {
      return [];
    }
  },
};
