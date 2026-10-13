import type { FastifyInstance } from "fastify";
import {
  productionSetupCommandSchema,
} from "@print-partner/contracts";
import { recordedPrintsLockProductionMethod } from "@print-partner/domain";
import type { AppRepository } from "../db/repository.js";
import {
  loadProductionSetup,
  ProductionSetupWriteConflictError,
  updateProductionSetup,
} from "../services/production-setup-store.js";
import { loadPrinterCheckoffLinks } from "../services/printer-checkoff-store.js";
import { currentPackageRequiredUnitTokens } from "../services/production-method-lock.js";
import { MAX_BULK_JSON_BODY_BYTES } from "../services/upload-limits.js";

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

  app.patch("/plans/:id/production-setup", { bodyLimit: MAX_BULK_JSON_BODY_BYTES }, async (request, reply) => {
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
    if (parsed.data.kind === "set_route") {
      const current = loadProductionSetup(deps.repo, profileId);
      // An unanswered Build has no method to preserve. The first saved route
      // is allowed; a later change is what the recorded print locks.
      if (current.route != null && parsed.data.route !== current.route) {
        const workspace = deps.repo.readAcceptedPlateWorkspaceInput(profileId);
        if (workspace.kind === "transaction_unavailable" || workspace.kind === "accepted_state_unavailable") {
          return reply.status(503).send({
            detail: "Production method could not be checked against recorded prints",
          });
        }
        const units = workspace.kind === "setup" || workspace.kind === "ready" ? workspace.units : [];
        const locked = recordedPrintsLockProductionMethod({
          profileId,
          packageTokens: currentPackageRequiredUnitTokens(current.selection, units),
          records: loadPrinterCheckoffLinks(deps.repo).map((link) => ({
            profileId: link.profile_id,
            state: link.state,
            objectNames: link.units.map((unit) => unit.object_name),
          })),
        });
        if (locked) {
          return reply.status(409).send({
            detail: "Recorded prints for these Required units keep the Production method",
            code: "production_method_locked",
          });
        }
      }
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
