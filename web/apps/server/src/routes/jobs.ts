import type { FastifyInstance } from "fastify";
import {
  filenameGroupingSchema,
  filenameExportSchema,
  miloFilenameGrouping,
  parseStartDirectExportRequest,
  type StartAcceptedPlateExportRequest,
  type StartDirectExportRequest,
} from "@print-partner/contracts";
import { parseStlPackUnitTokens } from "../services/export-stl-pack.js";
import { parseCheckoffUnits, parseUnlabeledNames } from "../services/printer-checkoff.js";
import { sendProblem } from "../lib/api-error.js";
import { hostedPlanningPolicy } from "../lib/hosted-planning.js";
import { sendIfTenantDiskQuotaExceeded } from "../lib/tenant-disk-quota.js";
import { getIntegrationAdapter } from "../integrations/registry.js";
import { getIntegrationConfig } from "../integrations/store.js";
import { loadFleet } from "../services/printer-fleet.js";
import { parsePrinterUploadMultipart } from "../services/printer-upload-multipart.js";
import { cleanupPrinterUploadArtifactDir } from "../services/printer-upload-job.js";
import { ACCEPTED_PLATE_EXPORT_LIMITS } from "../services/accepted-plate-export-delivery.js";
import { captureAcceptedOperationalExport } from "../services/accepted-operational-export.js";
import { DIRECT_EXPORT_3MF_LIMITS } from "../services/accepted-direct-export-3mf.js";
import type { InProcessJobRunner } from "../services/job-runner.js";
import { isRecord, positiveSafeInteger } from "./job-route-inputs.js";

export async function registerJobRoutes(
  app: FastifyInstance,
  jobs: InProcessJobRunner,
  config?: { deployMode?: string },
): Promise<void> {
  const limited = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
  const hostedQuotaBytes = hostedPlanningPolicy(
    config?.deployMode === "saas" ? "saas" : "self-host",
  ).tenantDiskQuotaBytes;

  async function refuseIfHostedQuotaExceeded(
    reply: import("fastify").FastifyReply,
    tenantId: string,
    additionalBytes = 0,
  ): Promise<boolean> {
    if (hostedQuotaBytes == null) return false;
    return sendIfTenantDiskQuotaExceeded(reply, {
      dataDir: jobs.getDataDir(),
      reposDir: jobs.getReposDir(),
      tenantId,
      sourceIds: jobs.getRepo().listSources().map((source) => source.id),
      additionalBytes,
      quotaBytes: hostedQuotaBytes,
    });
  }

  app.post("/jobs/sync", limited, async (request, reply) => {
    if (await refuseIfHostedQuotaExceeded(reply, request.tenantId)) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const job_id = await jobs.start("sync", body, request.tenantId);
    return { job_id };
  });

  app.post("/jobs/import-scan", async (request, reply) => {
    if (await refuseIfHostedQuotaExceeded(reply, request.tenantId)) return;
    const body = request.body as { project_id?: number };
    const job_id = await jobs.start("import-scan", { project_id: body.project_id }, request.tenantId);
    return { job_id };
  });

  app.post("/jobs/check-source-updates", async (request) => {
    const job_id = await jobs.start("check-source-updates", {}, request.tenantId);
    return { job_id };
  });

  app.post("/jobs/extract-source-docs", async (request, reply) => {
    if (await refuseIfHostedQuotaExceeded(reply, request.tenantId)) return;
    const body = request.body as { project_id?: number };
    const job_id = await jobs.start(
      "extract-source-docs",
      { project_id: body.project_id },
      request.tenantId,
    );
    return { job_id };
  });

  app.get<{ Params: { profileId: string } }>("/plans/:profileId/filename-grouping", async (request, reply) => {
    const profileId = Number(request.params.profileId);
    const repo = jobs.getRepo();
    if (!repo.getOwnedProfileIdentity(profileId)) return sendProblem(reply, 404, "Not Found", "Build not found");
    const stored = repo.getSetting(`filename_grouping:${profileId}`);
    const definition = stored ? filenameGroupingSchema.parse(JSON.parse(stored)) : miloFilenameGrouping;
    const capture = captureAcceptedOperationalExport({ repository: repo, profileId });
    const parts = capture.kind === "ready" ? capture.export.parts.filter((part) => part.included).map((part) => ({
      relativePath: part.relativePath, sourceLayer: part.sourceLayer, role: part.role,
      units: part.units.map((unit) => ({ token: unit.token, completed: unit.completed })),
    })) : [];
    return { definition, parts };
  });

  app.put<{ Params: { profileId: string } }>("/plans/:profileId/filename-grouping", async (request, reply) => {
    const profileId = Number(request.params.profileId);
    const repo = jobs.getRepo();
    if (!repo.getOwnedProfileIdentity(profileId)) return sendProblem(reply, 404, "Not Found", "Build not found");
    const parsed = filenameGroupingSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, 400, "Bad Request", parsed.error.message);
    repo.setSetting(`filename_grouping:${profileId}`, JSON.stringify(parsed.data));
    return { definition: parsed.data };
  });

  app.post("/jobs/export-stl-pack", limited, async (request, reply) => {
    const body = request.body as {
      profile_id?: number;
      missing_only?: boolean;
      group_by?: string;
      unit_tokens?: unknown;
      filename_grouping?: unknown;
    };
    if (!body.profile_id || !jobs.getRepo().getOwnedProfileIdentity(body.profile_id)) {
      return sendProblem(reply, 404, "Not Found", "Profile not found");
    }
    const unitTokens = parseStlPackUnitTokens(body.unit_tokens);
    const grouping = filenameExportSchema.optional().safeParse(body.filename_grouping);
    if (!grouping.success) return sendProblem(reply, 400, "Bad Request", grouping.error.message);
    if (unitTokens === "invalid") {
      return sendProblem(
        reply,
        400,
        "Bad Request",
        "unit_tokens must be a list of Required-unit tokens",
      );
    }
    if (await refuseIfHostedQuotaExceeded(reply, request.tenantId)) return;
    const job_id = await jobs.start(
      "export-stl-pack",
      {
        profile_id: body.profile_id,
        missing_only: body.missing_only ?? false,
        group_by: body.group_by === "color" ? "color" : "color_dir",
        ...(grouping.data ? { filename_grouping: grouping.data } : {}),
        ...(unitTokens.length > 0 ? { unit_tokens: [...unitTokens] } : {}),
      },
      request.tenantId,
    );
    return { job_id };
  });

  app.post("/jobs/export-checklist-html", async (request, reply) => {
    const body = request.body as { profile_id?: number };
    if (!body.profile_id || !jobs.getRepo().getOwnedProfileIdentity(body.profile_id)) {
      return sendProblem(reply, 404, "Not Found", "Profile not found");
    }
    if (await refuseIfHostedQuotaExceeded(reply, request.tenantId)) return;
    const job_id = await jobs.start(
      "export-checklist-html",
      { profile_id: body.profile_id },
      request.tenantId,
    );
    return { job_id };
  });

  app.post("/jobs/export-kit-bundle", limited, async (request, reply) => {
    const body = request.body as { profile_id?: number; include_print_progress?: boolean };
    if (!body.profile_id || !jobs.getRepo().getOwnedProfileIdentity(body.profile_id)) {
      return sendProblem(reply, 404, "Not Found", "Profile not found");
    }
    if (await refuseIfHostedQuotaExceeded(reply, request.tenantId)) return;
    const job_id = await jobs.start(
      "export-kit-bundle",
      {
        profile_id: body.profile_id,
        include_print_progress: body.include_print_progress ?? false,
      },
      request.tenantId,
    );
    return { job_id };
  });

  app.post("/jobs/export-accepted-plate-3mf", limited, async (request, reply) => {
    if (!isRecord(request.body)) {
      return reply.status(400).send({
        detail: "profile_id and expected_plate_revision_id are required",
        code: "invalid_request",
      });
    }
    const profileId = positiveSafeInteger(request.body.profile_id);
    const expectedPlateRevisionId = positiveSafeInteger(request.body.expected_plate_revision_id);
    if (profileId == null || expectedPlateRevisionId == null) {
      return reply.status(400).send({
        detail: "profile_id and expected_plate_revision_id must be positive integers",
        code: "invalid_request",
      });
    }
    if (!jobs.getRepo().getOwnedProfileIdentity(profileId)) {
      return reply.status(404).send({ detail: "Profile not found", code: "profile_not_found" });
    }
    if (
      await refuseIfHostedQuotaExceeded(
        reply,
        request.tenantId,
        ACCEPTED_PLATE_EXPORT_LIMITS.maxOutputBytes,
      )
    ) {
      return;
    }
    const payload: StartAcceptedPlateExportRequest = {
      profile_id: profileId,
      expected_plate_revision_id: expectedPlateRevisionId,
    };
    const job_id = await jobs.start("export-accepted-plate-3mf", payload, request.tenantId);
    return { job_id };
  });

  app.post("/jobs/export-direct-3mf", limited, async (request, reply) => {
    let payload: StartDirectExportRequest;
    try {
      payload = parseStartDirectExportRequest(request.body);
    } catch {
      return reply.status(400).send({
        detail: "profile_id and tokens are required",
        code: "invalid_request",
      });
    }
    if (!jobs.getRepo().getOwnedProfileIdentity(payload.profile_id)) {
      return reply.status(404).send({ detail: "Profile not found", code: "profile_not_found" });
    }
    if (
      await refuseIfHostedQuotaExceeded(
        reply,
        request.tenantId,
        DIRECT_EXPORT_3MF_LIMITS.maxOutputBytes,
      )
    ) {
      return;
    }
    const job_id = await jobs.start("export-direct-3mf", payload, request.tenantId);
    return { job_id };
  });

  app.post(
    "/jobs/printer-upload",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      let artifactPath: string | null = null;

      try {
        const parsed = await parsePrinterUploadMultipart(request, {
          exportsDir: jobs.getExportsDir(request.tenantId),
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
          unlabeled_names_raw: unlabeledNamesRaw,
        } = parsed.value;
        artifactPath = artifact_path;

        const checkoff_units = parseCheckoffUnits(checkoffUnitsRaw);
        const unlabeledParsed = parseUnlabeledNames(unlabeledNamesRaw);
        const unlabeled_names = unlabeledParsed.length ? unlabeledParsed : undefined;
        if (profileId == null) {
          return sendProblem(
            reply,
            400,
            "Bad Request",
            "Pick a plan to bind this send (profile_id required)",
          );
        }
        if (!jobs.getRepo().getOwnedProfileIdentity(profileId)) {
          return sendProblem(reply, 404, "Not Found", "Profile not found");
        }

        const repo = jobs.getRepo();
        const machine = loadFleet(repo).find((m) => m.id === printerId);
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
        const integration = getIntegrationConfig(repo, integrationId);
        if (!integration) {
          return sendProblem(reply, 400, "Bad Request", "Linked printer host was not found");
        }
        if (integration.type !== "moonraker" && integration.type !== "prusalink") {
          return sendProblem(
            reply,
            400,
            "Bad Request",
            `Upload is not supported for ${integration.type}`,
          );
        }

        if (start) {
          const adapter = getIntegrationAdapter(integration.type);
          let hostState: string = "unknown";
          try {
            const status = adapter?.getStatus
              ? await adapter.getStatus(integration.config)
              : { state: "unknown" as const };
            hostState = status.state;
          } catch {
            hostState = "offline";
          }
          if (hostState !== "idle" && hostState !== "complete") {
            return sendProblem(
              reply,
              409,
              "Conflict",
              `Printer is ${hostState} — wait for Idle or queue for idle`,
            );
          }
        }

        const job_id = await jobs.start(
          "printer-upload",
          {
            printer_id: printerId,
            artifact_path: artifactPath,
            filename: baseName,
            start,
            host_name: integration.name,
            profile_id: profileId,
            checkoff_units,
            unlabeled_names,
          },
          request.tenantId,
        );
        artifactPath = null;
        return { job_id };
      } finally {
        if (artifactPath) {
          cleanupPrinterUploadArtifactDir(artifactPath);
        }
      }
    },
  );

  app.get("/jobs/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const snap = await jobs.get(id, request.tenantId);
    if (!snap) return reply.status(404).send({ detail: "Job not found" });
    return snap;
  });
}

export function registerJobWebSocket(
  app: FastifyInstance,
  jobs: InProcessJobRunner,
): void {
  app.get("/ws/jobs/:jobId", { websocket: true }, (socket, request) => {
    const jobId = (request.params as { jobId: string }).jobId;
    void jobs.get(jobId, request.tenantId).then((snap) => {
      if (!snap) {
        socket.close(1008, "Job not found");
        return;
      }
      socket.send(JSON.stringify(snap));
      if (snap.status === "done" || snap.status === "error" || snap.status === "cancelled") {
        socket.close();
        return;
      }
      const unsub = jobs.subscribe(jobId, request.tenantId, (event) => {
        socket.send(JSON.stringify(event));
        if (event.status === "done" || event.status === "error" || event.status === "cancelled") {
          socket.close();
        }
      });
      socket.on("close", () => unsub?.());
    });
  });
}
