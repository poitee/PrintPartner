import type { FastifyInstance } from "fastify";
import {
  productionSetupCommandSchema,
} from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import {
  loadProductionSetup,
  ProductionSetupWriteConflictError,
  updateProductionSetup,
} from "../services/production-setup-store.js";

type RouteDeps = { repo: AppRepository };

function parseProfileId(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export async function registerProductionSetupRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get("/plans/:id/production-setup", async (request, reply) => {
    const profileId = parseProfileId((request.params as { id: string }).id);
    if (!profileId) return reply.status(400).send({ detail: "invalid Build id" });
    if (!deps.repo.getProfileHeader(profileId)) {
      return reply.status(404).send({ detail: "Build not found" });
    }
    return loadProductionSetup(deps.repo, profileId);
  });

  app.patch("/plans/:id/production-setup", async (request, reply) => {
    const profileId = parseProfileId((request.params as { id: string }).id);
    if (!profileId) return reply.status(400).send({ detail: "invalid Build id" });
    if (!deps.repo.getProfileHeader(profileId)) {
      return reply.status(404).send({ detail: "Build not found" });
    }
    const parsed = productionSetupCommandSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        detail: "Invalid production setup",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }
    try {
      return updateProductionSetup(deps.repo, {
        profileId,
        command: parsed.data,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof ProductionSetupWriteConflictError) {
        return reply.status(409).send({ detail: error.message });
      }
      throw error;
    }
  });
}
