import type { FastifyInstance } from "fastify";
import type { AppRepository } from "../db/repository.js";
import type { IntegrationPort } from "../integrations/store.js";
import { getIntegrationConfig } from "../integrations/store.js";
import { sendProblem } from "../lib/api-error.js";
import { parseCheckoffUnits } from "../services/printer-checkoff.js";
import { loadFleet } from "../services/printer-fleet.js";
import {
  cancelPrinterSendQueueItem,
  enqueuePrinterSend,
  getPrinterSendQueueItem,
  listActivePrinterSendQueue,
  loadPrinterSendQueue,
} from "../services/printer-send-queue-store.js";
import {
  dispatchPrinterSendQueueItem,
  drainPrinterSendQueue,
} from "../services/printer-send-queue.js";
import { computePrinterQueueSuggestions } from "../services/printer-queue-suggestions.js";
import { parsePrinterUploadMultipart } from "../services/printer-upload-multipart.js";
import { cleanupPrinterUploadArtifactDir } from "../services/printer-upload-job.js";
import type { InProcessJobRunner } from "./jobs.js";

type RouteDeps = {
  repo: AppRepository;
  integrations: IntegrationPort;
  jobs: InProcessJobRunner;
};

export async function registerPrinterSendQueueRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  const makeStartJob = (tenantId: string) => async (payload: {
    printer_id: string;
    artifact_path: string;
    filename: string;
    start: boolean;
    host_name?: string;
    profile_id?: number;
    checkoff_units?: ReturnType<typeof parseCheckoffUnits>;
  }) =>
    deps.jobs.start(
      "printer-upload",
      {
        ...payload,
        upload_job_id: undefined,
      },
      tenantId,
    );

  const getStatus = (integrationId: string) => deps.integrations.getStatus(integrationId);

  app.get("/printer-send-queue", async (request) => {
    const query = request.query as { active?: string };
    if (query.active === "1" || query.active === "true") {
      return { items: listActivePrinterSendQueue(deps.repo) };
    }
    return { items: loadPrinterSendQueue(deps.repo) };
  });

  /**
   * Smart queue routing suggestions.
   * Caller passes idle integration ids (from their live status poll) and
   * receives a suggestion per idle printer that has matching queued items.
   *
   * Query params:
   *   idle_integration_ids  comma-separated integration ids currently idle/complete
   */
  app.get(
    "/printer-send-queue/suggestions",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const query = request.query as { idle_integration_ids?: string };
      const rawIds = (query.idle_integration_ids ?? "").trim();
      const idleIds = new Set(
        rawIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const fleet = loadFleet(deps.repo);
      const queued = listActivePrinterSendQueue(deps.repo).filter(
        (i) => i.state === "queued",
      );
      const suggestions = computePrinterQueueSuggestions(
        deps.repo,
        fleet,
        idleIds,
        queued,
      );
      return { suggestions };
    },
  );

  app.post(
    "/printer-send-queue",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      let artifactPath: string | null = null;

      try {
        const parsed = await parsePrinterUploadMultipart(request, {
          exportsDir: deps.jobs.getExportsDir(request.tenantId),
          allowQueueFields: true,
        });
        if (!parsed.ok) {
          return sendProblem(
            reply,
            parsed.error.status,
            parsed.error.title,
            parsed.error.detail,
          );
        }

        const {
          printer_id: printerId,
          start,
          filename: baseName,
          artifact_path,
          profile_id: profileId,
          checkoff_units_raw: checkoffUnitsRaw,
          wait_for_idle: waitForIdle = true,
          match = "pinned",
        } = parsed.value;
        artifactPath = artifact_path;

        const checkoff_units = parseCheckoffUnits(checkoffUnitsRaw);
        if (profileId == null) {
          return sendProblem(
            reply,
            400,
            "Bad Request",
            "Pick a plan to bind this send (profile_id required)",
          );
        }
        if (!deps.repo.getOwnedProfileIdentity(profileId)) {
          return sendProblem(reply, 404, "Not Found", "Profile not found");
        }

        const machine = loadFleet(deps.repo).find((m) => m.id === printerId);
        if (!machine) {
          return sendProblem(reply, 404, "Not Found", "Fleet printer not found");
        }
        const integrationId = machine.integration_id?.trim();
        if (!integrationId) {
          return sendProblem(
            reply,
            400,
            "Bad Request",
            "Printer is not linked to a host. Link a Moonraker or PrusaLink host in Settings.",
          );
        }
        const integration = getIntegrationConfig(deps.repo, integrationId);
        if (!integration) {
          return sendProblem(reply, 400, "Bad Request", "Linked printer host was not found");
        }
        if (integration.type !== "moonraker" && integration.type !== "prusalink") {
          return sendProblem(
            reply,
            400,
            "Bad Request",
            `Queue is not supported for ${integration.type}`,
          );
        }

        const item = enqueuePrinterSend(deps.repo, {
          filename: baseName,
          artifact_path: artifactPath,
          printer_id: printerId,
          start,
          wait_for_idle: waitForIdle,
          match,
          profile_id: profileId,
          checkoff_units,
          host_name: integration.name,
        });
        if (!item) {
          return sendProblem(reply, 400, "Bad Request", "Could not enqueue item");
        }
        artifactPath = null;
        return { item };
      } finally {
        if (artifactPath) {
          cleanupPrinterUploadArtifactDir(artifactPath);
        }
      }
    },
  );

  app.post(
    "/printer-send-queue/:id/dispatch",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const id = String((request.params as { id: string }).id ?? "").trim();
      const body = (request.body ?? {}) as { force?: boolean };
      if (!id) return sendProblem(reply, 400, "Bad Request", "id is required");
      const result = await dispatchPrinterSendQueueItem(
        deps.repo,
        deps.jobs.getExportsDir(request.tenantId),
        id,
        {
          startJob: makeStartJob(request.tenantId ?? "default"),
          getStatus,
          force: Boolean(body.force),
        },
      );
      if ("error" in result) {
        return sendProblem(
          reply,
          result.status,
          result.status === 404
            ? "Not Found"
            : result.status === 409
              ? "Conflict"
              : result.status >= 500
                ? "Internal Server Error"
                : "Bad Request",
          result.error,
        );
      }
      return result;
    },
  );

  app.post(
    "/printer-send-queue/drain",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as { printer_id?: unknown };
      const rawPrinterId = body.printer_id;
      if (
        rawPrinterId !== undefined &&
        (typeof rawPrinterId !== "string" || !rawPrinterId.trim())
      ) {
        return sendProblem(
          reply,
          400,
          "Bad Request",
          "printer_id must be a non-empty string",
        );
      }
      const printerId =
        typeof rawPrinterId === "string" ? rawPrinterId.trim() : undefined;
      const results = await drainPrinterSendQueue(
        deps.repo,
        deps.jobs.getExportsDir(request.tenantId),
        {
          startJob: makeStartJob(request.tenantId ?? "default"),
          getStatus,
        },
        { printerId },
      );
      return { results };
    },
  );

  app.delete("/printer-send-queue/:id", async (request, reply) => {
    const id = String((request.params as { id: string }).id ?? "").trim();
    if (!id) return sendProblem(reply, 400, "Bad Request", "id is required");
    const existing = getPrinterSendQueueItem(deps.repo, id);
    if (!existing) {
      return sendProblem(reply, 404, "Not Found", "Queue item not found");
    }
    const item = cancelPrinterSendQueueItem(deps.repo, id);
    if (!item) {
      return sendProblem(reply, 409, "Conflict", "Item not cancellable");
    }
    return { item };
  });
}
