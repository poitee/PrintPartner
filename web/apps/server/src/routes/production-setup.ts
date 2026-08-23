import type { FastifyInstance } from "fastify";
import {
  defaultProductionSetup,
  productionSetupInputSchema,
  productionSetupSchema,
  type ProductionSetup,
} from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";

type RouteDeps = { repo: AppRepository };

function settingKey(profileId: number): string {
  return `production_setup:${profileId}`;
}

function parseProfileId(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function loadSetup(repo: AppRepository, profileId: number): ProductionSetup {
  const raw = repo.getSetting(settingKey(profileId));
  if (!raw) return defaultProductionSetup(profileId);
  try {
    const parsed = productionSetupSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.profile_id === profileId
      ? parsed.data
      : defaultProductionSetup(profileId);
  } catch {
    return defaultProductionSetup(profileId);
  }
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
    return loadSetup(deps.repo, profileId);
  });

  app.put("/plans/:id/production-setup", async (request, reply) => {
    const profileId = parseProfileId((request.params as { id: string }).id);
    if (!profileId) return reply.status(400).send({ detail: "invalid Build id" });
    if (!deps.repo.getProfileHeader(profileId)) {
      return reply.status(404).send({ detail: "Build not found" });
    }
    const parsed = productionSetupInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        detail: "Invalid production setup",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }
    const setup: ProductionSetup = {
      format: "production-setup-v1",
      profile_id: profileId,
      ...parsed.data,
      updated_at: new Date().toISOString(),
    };
    deps.repo.setSetting(settingKey(profileId), JSON.stringify(setup));
    return setup;
  });
}
