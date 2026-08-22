import type { FastifyInstance } from "fastify";
import type { IntegrationType } from "@print-partner/contracts";
import type { IntegrationPort } from "../integrations/store.js";
import type { AppRepository } from "../db/repository.js";
import { sendProblem } from "../lib/api-error.js";
import { getIntegrationAdapter } from "../integrations/registry.js";
import { registerSpoolmanProxyRoutes } from "./spoolman-proxy.js";
import { clearFleetIntegrationBinds } from "../services/printer-fleet.js";

type RouteDeps = { integrations: IntegrationPort; repo: AppRepository };

const VALID_TYPES = new Set<IntegrationType>([
  "moonraker",
  "prusalink",
  "bambu",
  "spoolman",
  "slicer_folder",
  "slicer_sidecar",
  "ai_assistant",
  "home_assistant",
]);

export async function registerIntegrationRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get("/integrations", async () => ({
    integrations: deps.integrations.list(),
  }));

  app.post("/integrations", async (request, reply) => {
    const body = request.body as {
      type?: string;
      name?: string;
      config?: Record<string, unknown>;
    };
    const type = body.type as IntegrationType | undefined;
    if (!type || !VALID_TYPES.has(type)) {
      return sendProblem(reply, 400, "Bad Request", "Invalid integration type");
    }
    if (!getIntegrationAdapter(type)) {
      return sendProblem(reply, 400, "Bad Request", "Unsupported integration type");
    }
    const name = String(body.name ?? "").trim();
    if (!name) return sendProblem(reply, 400, "Bad Request", "name is required");
    const item = deps.integrations.create({
      type,
      name,
      config: body.config ?? {},
    });
    return reply.status(201).send(item);
  });

  app.patch("/integrations/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as { name?: string; config?: Record<string, unknown> };
    const updated = deps.integrations.update(id, body);
    if (!updated) return sendProblem(reply, 404, "Not Found", "Integration not found");
    return updated;
  });

  app.delete("/integrations/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!deps.integrations.delete(id)) {
      return sendProblem(reply, 404, "Not Found", "Integration not found");
    }
    clearFleetIntegrationBinds(deps.repo, id);
    return reply.status(204).send();
  });

  app.post(
    "/integrations/:id/test",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const result = await deps.integrations.test(id);
      if (result.message === "Integration not found") {
        return sendProblem(reply, 404, "Not Found", result.message);
      }
      return result;
    },
  );

  app.get("/integrations/:id/devices", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!deps.integrations.get(id)) {
      return sendProblem(reply, 404, "Not Found", "Integration not found");
    }
    const devices = await deps.integrations.listDevices(id);
    return { devices };
  });

  app.get(
    "/integrations/:id/status",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          keyGenerator: (request) => {
            const id = (request.params as { id?: string }).id ?? "";
            return `${request.ip}:${id}`;
          },
        },
      },
    },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      if (!deps.integrations.get(id)) {
        return sendProblem(reply, 404, "Not Found", "Integration not found");
      }
      return deps.integrations.getStatus(id);
    },
  );

  await registerSpoolmanProxyRoutes(app, deps);
}
