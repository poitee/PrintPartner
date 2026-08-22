import type { FastifyInstance } from "fastify";
import type { IntegrationPort } from "../integrations/store.js";
import { getIntegrationConfig } from "../integrations/store.js";
import type { AppRepository } from "../db/repository.js";
import { sendProblem } from "../lib/api-error.js";
import {
  listSpoolmanFilaments,
  listSpoolmanSpools,
  spoolmanFilamentToCatalogColor,
} from "../integrations/spoolman-client.js";

type RouteDeps = {
  integrations: IntegrationPort;
  repo: AppRepository;
};

function requireSpoolmanIntegration(
  repo: AppRepository,
  integrationId: string,
): { config: Record<string, unknown> } | null {
  const item = getIntegrationConfig(repo, integrationId);
  if (!item) return null;
  if (item.type !== "spoolman") return null;
  return { config: item.config };
}

export async function registerSpoolmanProxyRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get("/integrations/:id/spoolman/filaments", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!deps.integrations.get(id)) {
      return sendProblem(reply, 404, "Not Found", "Integration not found");
    }
    const item = requireSpoolmanIntegration(deps.repo, id);
    if (!item) {
      return sendProblem(reply, 400, "Bad Request", "Integration is not a Spoolman connector");
    }
    try {
      const filaments = await listSpoolmanFilaments(item.config);
      return {
        filaments: filaments.map((f) => spoolmanFilamentToCatalogColor(id, f)),
      };
    } catch (e) {
      return sendProblem(
        reply,
        502,
        "Bad Gateway",
        e instanceof Error ? e.message : String(e),
      );
    }
  });

  app.get("/integrations/:id/spoolman/spools", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!deps.integrations.get(id)) {
      return sendProblem(reply, 404, "Not Found", "Integration not found");
    }
    const item = requireSpoolmanIntegration(deps.repo, id);
    if (!item) {
      return sendProblem(reply, 400, "Bad Request", "Integration is not a Spoolman connector");
    }
    try {
      const spools = await listSpoolmanSpools(item.config);
      return {
        spools: spools.map((s) => ({
          id: s.id,
          filament_id: s.filament_id,
          remaining_weight: s.remaining_weight,
          location: s.location ?? null,
        })),
      };
    } catch (e) {
      return sendProblem(
        reply,
        502,
        "Bad Gateway",
        e instanceof Error ? e.message : String(e),
      );
    }
  });
}
