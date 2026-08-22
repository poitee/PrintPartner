import type { FastifyInstance } from "fastify";
import { existsSync, accessSync, constants } from "node:fs";
import type {
  AcceptedPlateEndpointErrorCode,
  AcceptedPlateSlicerHandoffResult,
} from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import type { ServerConfig } from "../config.js";
import { validateSlicerGuiUrl } from "../services/slicer-instances.js";
import { exportDownloadKey, tenantExportDirectory } from "../lib/secure-path.js";
import {
  ACCEPTED_PLATE_EXPORT_LIMITS,
  materializeAcceptedPlateExport,
  stageAcceptedPlateExport,
  type MaterializeAcceptedPlateExportResult,
} from "../services/accepted-plate-export-delivery.js";

type RouteDeps = {
  repo: AppRepository;
  config: ServerConfig;
  exportsDir: string;
  dataDir: string;
  reposDir: string;
};

function positiveSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function acceptedHandoffFailure(
  result: Exclude<MaterializeAcceptedPlateExportResult, { readonly kind: "materialized" }>,
): Readonly<{ status: number; code: AcceptedPlateEndpointErrorCode; detail: string }> {
  switch (result.kind) {
    case "plate_revision_changed":
      return { status: 409, code: "plate_revision_changed", detail: "Plate layout changed. Refresh and try again." };
    case "unplaced_units":
      return { status: 409, code: "unplaced_units", detail: "Arrange every Required unit on a Plate before opening the slicer." };
    case "output_conflict":
      return { status: 409, code: "output_conflict", detail: "The stored export for this Plate revision failed integrity verification." };
    case "transaction_unavailable":
      return { status: 503, code: "accepted_plate_update_unavailable", detail: "Accepted Plate export is temporarily unavailable." };
    case "artifact_unavailable":
    case "invalid_stl":
    case "artifact_geometry_mismatch":
      return { status: 422, code: "accepted_artifact_unavailable", detail: "A verified accepted artifact is unavailable." };
    case "limit_exceeded":
      return { status: 422, code: "limit_exceeded", detail: "Accepted Plate export exceeds the configured limit." };
    case "profile_not_found":
      return { status: 404, code: "profile_not_found", detail: "Profile not found." };
    case "empty_plan":
    case "plates_not_published":
    case "stale_accepted_plan":
      return { status: 409, code: "accepted_plan_changed", detail: "Accepted Plan state is unavailable. Refresh the Plan." };
    case "accepted_state_unavailable":
      return { status: 409, code: "accepted_state_unavailable", detail: "Accepted Plan state is unavailable. Refresh the Plan." };
  }
}

type ExchangeState =
  | { readonly code: "ready" }
  | { readonly code: "not_configured" }
  | { readonly code: "unavailable" };

function exchangeState(exchangeDir: string): ExchangeState {
  if (!exchangeDir.trim()) {
    return { code: "not_configured" };
  }
  try {
    if (!existsSync(exchangeDir)) {
      return { code: "unavailable" };
    }
    accessSync(exchangeDir, constants.W_OK);
  } catch {
    return { code: "unavailable" };
  }
  return { code: "ready" };
}

export async function registerSlicerHandoffRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.post("/slicer-instances/:id/open-accepted-plates", async (request, reply) => {
    if (!isRecord(request.body)) {
      return reply.status(400).send({ detail: "profile_id and expected_plate_revision_id are required", code: "invalid_request" });
    }
    const profileId = positiveSafeInteger(request.body.profile_id);
    const expectedPlateRevisionId = positiveSafeInteger(request.body.expected_plate_revision_id);
    if (profileId == null || expectedPlateRevisionId == null) {
      return reply.status(400).send({ detail: "profile_id and expected_plate_revision_id must be positive integers", code: "invalid_request" });
    }
    if (!deps.repo.getOwnedProfileIdentity(profileId)) {
      return reply.status(404).send({ detail: "Profile not found", code: "profile_not_found" });
    }
    if (!isRecord(request.params) || typeof request.params.id !== "string") {
      return reply.status(400).send({ detail: "Slicer instance id is invalid", code: "invalid_request" });
    }
    const id = request.params.id;
    const instance = deps.repo.getSlicerInstance(id);
    if (!instance) return reply.status(404).send({ detail: "Slicer instance not found", code: "slicer_instance_not_found" });
    if (!instance.enabled) return reply.status(400).send({ detail: "Slicer instance is disabled", code: "slicer_instance_disabled" });
    const guiErr = validateSlicerGuiUrl(instance.guiUrl);
    if (guiErr || !instance.guiUrl.trim()) {
      return reply.status(400).send({ detail: "Instance needs a valid http(s) gui_url", code: "invalid_slicer_gui_url" });
    }
    const exchange = exchangeState(deps.config.exchangeDir);
    if (exchange.code !== "ready") {
      request.log.warn({ operation: "accepted_plate_slicer_handoff", code: exchange.code }, "Slicer exchange unavailable");
      return reply.status(400).send({
        detail: "Slicer exchange is unavailable. Use Download 3MF instead.",
        code: "slicer_exchange_unavailable",
      });
    }

    try {
      const materialized = await materializeAcceptedPlateExport({
        repository: deps.repo,
        reposDir: deps.reposDir,
        tenantExportsDir: tenantExportDirectory(deps.exportsDir, request.tenantId),
        limits: ACCEPTED_PLATE_EXPORT_LIMITS,
      }, { profileId, expectedPlateRevisionId });
      if (materialized.kind !== "materialized") {
        const failure = acceptedHandoffFailure(materialized);
        return reply.status(failure.status).send({ detail: failure.detail, code: failure.code });
      }
      const staged = await stageAcceptedPlateExport({
        materialized,
        exchangeRoot: deps.config.exchangeDir,
        instanceId: instance.id,
      });
      if (staged.kind === "output_conflict") {
        return reply.status(409).send({
          detail: "The slicer inbox for this Plate revision failed integrity verification.",
          code: "output_conflict",
        });
      }
      const primary = materialized.plates.length === 1
        ? materialized.plates[0]
        : materialized.bundle;
      if (!primary) {
        return reply.status(500).send({ detail: "Accepted Plate handoff failed.", code: "internal_error" });
      }
      const downloadKey = exportDownloadKey(
        deps.dataDir,
        request.tenantId,
        primary.absolutePath,
      );
      if (!downloadKey) {
        return reply.status(500).send({ detail: "Accepted Plate handoff failed.", code: "internal_error" });
      }
      const result: AcceptedPlateSlicerHandoffResult = {
        gui_url: instance.guiUrl.trim(),
        plate_revision_id: materialized.plateRevisionId,
        plate_revision_number: materialized.plateRevisionNumber,
        layout_digest: materialized.layoutDigest,
        inbox_relative_path: staged.inboxRelativePath,
        staged: [...staged.staged],
        download_url: `/exports/${downloadKey}`,
        local_app: {
          scheme_attempt: null,
          note: "Open the revision directory from the configured slicer exchange mount.",
        },
      };
      return result;
    } catch {
      request.log.error(
        {
          operation: "accepted_plate_slicer_handoff",
          failure: "unexpected",
          profileId,
          expectedPlateRevisionId,
          slicerInstanceId: id,
        },
        "Accepted Plate slicer handoff failed unexpectedly",
      );
      return reply.status(500).send({ detail: "Accepted Plate handoff failed.", code: "internal_error" });
    }
  });

  app.get("/slicer-handoff/exchange-status", async (request) => {
    const exchange = exchangeState(deps.config.exchangeDir);
    if (exchange.code !== "ready") {
      request.log.warn({ operation: "slicer_exchange_status", code: exchange.code }, "Slicer exchange unavailable");
    }
    return exchange.code === "ready"
      ? { ready: true, code: exchange.code }
      : { ready: false, code: exchange.code };
  });
}
