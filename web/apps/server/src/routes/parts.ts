import { basename } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppRepository } from "../db/repository.js";
import type {
  AcceptedOperationalPart,
  AcceptedPlanOperationalSnapshot,
} from "../db/accepted-plan-operational.js";
import { PLACEHOLDER_PNG } from "../lib/thumbnails.js";
import { AcceptedPlanOperationalIntegrityError } from "../db/accepted-plan-operational.js";
import { toAcceptedPartAssembledView } from "../services/accepted-plan-views.js";
import { openVerifiedAcceptedArtifact } from "../services/accepted-artifacts.js";
import {
  readAcceptedMediaPng,
  removeAcceptedMediaPng,
  writeAcceptedMediaPng,
} from "../lib/accepted-media-cache.js";
import {
  MAX_THUMBNAIL_UPLOAD_BYTES,
  THUMBNAIL_UPLOAD_TOO_LARGE_DETAIL,
} from "../services/upload-limits.js";
import {
  acceptedPartMediaIdentity,
} from "../services/accepted-part-media.js";
import { acceptedPlanBasis, type AcceptedProgressFailure } from "../db/accepted-plan-progress.js";
import {
  liveAssignmentFrom,
  resolveFilamentAssignment,
} from "../db/accepted-part-filament.js";
import { getColorById, resolvePartFilamentHex } from "../services/filament-catalog.js";
import { THUMBNAIL_RENDERER_VERSION, type PartRow } from "@print-partner/contracts";
import { parseRequiredUnitToken } from "../services/required-units.js";
import { acceptedStateDetail } from "./accepted-state-detail.js";
import { sendAcceptedFilamentFailure } from "./accepted-filament-failure.js";

type RouteDeps = {
  repo: AppRepository;
  reposDir: string;
  thumbsDir: string;
};

type AcceptedPartRequest =
  | {
      readonly kind: "ready";
      readonly profileId: number;
      readonly part: AcceptedOperationalPart;
      readonly snapshot: AcceptedPlanOperationalSnapshot;
    }
  | { readonly kind: "part_not_found" }
  | {
      readonly kind: "accepted_state_unavailable";
      readonly reason: "compatibility_dirty" | "uninitialized";
    };

function readAcceptedPartRequest(deps: RouteDeps, partId: number): AcceptedPartRequest {
  const projection = deps.repo.getPartRow(partId);
  if (!projection) return { kind: "part_not_found" };
  const accepted = deps.repo.readAcceptedPlanOperationalSnapshot(projection.profileId);
  if (accepted.kind === "empty") return { kind: "part_not_found" };
  if (accepted.kind !== "ready") {
    return { kind: "accepted_state_unavailable", reason: accepted.kind };
  }
  const part = accepted.snapshot.parts.find((candidate) => candidate.projectionPartId === partId);
  return part
    ? { kind: "ready", profileId: projection.profileId, part, snapshot: accepted.snapshot }
    : { kind: "part_not_found" };
}

function toPartRow(part: AcceptedOperationalPart): PartRow {
  const color = part.filamentColorId ? getColorById(part.filamentColorId) : null;
  return {
    id: part.projectionPartId,
    match_key: part.partKey,
    relative_path: part.relativePath,
    filename: part.filename,
    source_layer: part.sourceLayer,
    status: part.status,
    role: part.effectiveRole,
    requirement: part.requirement,
    option_group_id: part.optionGroupId,
    included: part.included,
    filament_color_id: part.filamentColorId,
    filament_custom_hex: part.filamentCustomHex,
    spoolman_spool_id: part.spoolmanSpoolId,
    filament_display: color?.combo_label ?? "",
    filament_hex: resolvePartFilamentHex(part),
    quantity_auto: part.quantityInferred,
    quantity_override: part.quantityOverride,
    quantity_effective: part.quantityEffective,
  };
}

function sendAcceptedProgressFailure(reply: FastifyReply, failure: AcceptedProgressFailure) {
  if (failure.kind === "accepted_state_unavailable") {
    return reply.status(409).send({ detail: acceptedStateDetail(failure.reason) });
  }
  if (failure.kind === "stale_accepted_plan") {
    return reply.status(409).send({ detail: "Accepted Plan changed; reload and retry" });
  }
  if (failure.kind === "transaction_unavailable") {
    return reply.status(503).send({ detail: "Accepted Plan update is unavailable" });
  }
  if (failure.kind === "plan_archived") {
    return reply.status(409).send({ detail: "Archived Plan Progress cannot be changed" });
  }
  return reply.status(404).send({ detail: "Part unit not found" });
}

function matchesStrongEtagList(value: string | string[] | undefined, etag: string): boolean {
  if (typeof value !== "string") return false;
  return value.split(",").some((candidate) => candidate.trim() === etag);
}

async function sendPartImage(
  deps: RouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  preview: boolean,
) {
  const id = Number((request.params as { id: string }).id);
  let profileId: number | null = null;
  try {
    const accepted = readAcceptedPartRequest(deps, id);
    if (accepted.kind === "part_not_found") {
      return reply.status(404).send({ detail: "Part not found" });
    }
    if (accepted.kind === "accepted_state_unavailable") {
      return reply.status(409).send({ detail: acceptedStateDetail(accepted.reason) });
    }
    profileId = accepted.profileId;
    const part = accepted.part;
    if (part.artifact.kind === "unavailable") {
      return reply.status(409).send({ detail: "Accepted Part media is unavailable" });
    }
    const verified = openVerifiedAcceptedArtifact({
      reposDir: deps.reposDir,
      artifact: part.artifact,
    });
    if (verified.kind !== "verified") {
      if (verified.kind === "unavailable") {
        return reply.status(409).send({ detail: "Accepted Part media is unavailable" });
      }
      return reply.status(409).send({ detail: "Accepted Part artifact is unavailable" });
    }
    verified.lease.close();
    const { hex, basis } = acceptedPartMediaIdentity(
      part,
      preview ? "preview" : "thumbnail",
    );
    const cached = readAcceptedMediaPng({ thumbsDir: deps.thumbsDir, basis });
    if (!cached) {
      reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "no-store")
        .header("X-Thumbnail-Placeholder", "1");
      if (hex) reply.header("X-Accepted-Render-Hex", hex);
      return reply.send(PLACEHOLDER_PNG);
    }
    const etag = `"${basis}"`;
    if (matchesStrongEtagList(request.headers["if-none-match"], etag)) {
      reply.status(304).header("Cache-Control", "private, no-cache").header("ETag", etag);
      if (hex) reply.header("X-Accepted-Render-Hex", hex);
      return reply.send();
    }
    reply
      .header("Content-Type", "image/png")
      .header("Cache-Control", "private, no-cache")
      .header("ETag", etag);
    if (hex) reply.header("X-Accepted-Render-Hex", hex);
    return reply.send(cached);
  } catch (error) {
    if (error instanceof AcceptedPlanOperationalIntegrityError) {
      request.log.error(
        { code: error.code, profileId, partId: id },
        "Accepted Plan integrity failure",
      );
      return reply.status(500).send({ detail: "Accepted Plan data is inconsistent" });
    }
    request.log.error(
      { failure: "unexpected", profileId, partId: id },
      "Accepted Part media failed",
    );
    return reply.status(500).send({ detail: "Internal Server Error" });
  }
}

export async function registerPartRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.patch("/parts/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.status(400).send({ detail: "No fields to update" });
    }
    const fields = body as Record<string, unknown>;
    const keys = Object.keys(fields);
    if (
      keys.length === 0 ||
      keys.some((key) => key !== "filament_color_id" && key !== "spoolman_spool_id") ||
      (fields.filament_color_id !== undefined &&
        fields.filament_color_id !== null &&
        typeof fields.filament_color_id !== "string") ||
      (fields.spoolman_spool_id !== undefined &&
        fields.spoolman_spool_id !== null &&
        typeof fields.spoolman_spool_id !== "string")
    ) {
      return reply.status(400).send({ detail: "Only filament and spool assignment may be updated" });
    }
    if (!deps.repo.canMutateAcceptedPlan()) {
      return reply.status(503).send({ detail: "Accepted Plan update is unavailable" });
    }
    let profileId: number | null = null;
    try {
      const accepted = readAcceptedPartRequest(deps, id);
      if (accepted.kind === "part_not_found") {
        return reply.status(404).send({ detail: "Part not found" });
      }
      if (accepted.kind === "accepted_state_unavailable") {
        return reply.status(409).send({ detail: acceptedStateDetail(accepted.reason) });
      }
      profileId = accepted.profileId;
      const result = deps.repo.assignAcceptedFilament({
        expected: acceptedPlanBasis(accepted.snapshot),
        target: { kind: "part", projectionPartId: id },
        assignment: resolveFilamentAssignment(liveAssignmentFrom(accepted.part), {
          ...(fields.filament_color_id !== undefined
            ? { colorId: fields.filament_color_id as string | null }
            : {}),
          ...(fields.spoolman_spool_id !== undefined
            ? { spoolmanSpoolId: fields.spoolman_spool_id as string | null }
            : {}),
        }),
      });
      if (result.kind !== "updated") return sendAcceptedFilamentFailure(reply, result);
      if (!result.part) return reply.status(404).send({ detail: "Part not found" });
      return toPartRow(result.part);
    } catch (error) {
      if (error instanceof AcceptedPlanOperationalIntegrityError) {
        request.log.error(
          { code: error.code, profileId, partId: id },
          "Accepted Plan integrity failure",
        );
        return reply.status(500).send({ detail: "Accepted Plan data is inconsistent" });
      }
      request.log.error(
        { failure: "unexpected", profileId, partId: id },
        "Accepted Plan filament update failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
  });

  app.patch("/parts/:id/progress", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body as { unit_index?: number; completed?: boolean };
    if (body.unit_index == null || body.completed == null) {
      return reply.status(400).send({ detail: "unit_index and completed required" });
    }
    if (
      typeof body.completed !== "boolean" ||
      !Number.isInteger(body.unit_index) ||
      body.unit_index < 0
    ) {
      return reply.status(400).send({
        detail: "unit_index must be a non-negative integer and completed a boolean",
      });
    }
    if (!deps.repo.canMutateAcceptedPlan()) {
      return reply.status(503).send({ detail: "Accepted Plan update is unavailable" });
    }
    let profileId: number | null = null;
    try {
      const accepted = readAcceptedPartRequest(deps, id);
      if (accepted.kind === "part_not_found") {
        return reply.status(404).send({ detail: "Part not found" });
      }
      if (accepted.kind === "accepted_state_unavailable") {
        return reply.status(409).send({ detail: acceptedStateDetail(accepted.reason) });
      }
      profileId = accepted.profileId;
      const unit = accepted.part.units[body.unit_index];
      if (!unit) return reply.status(400).send({ detail: "unit_index out of range" });
      const result = deps.repo.setAcceptedUnitCompletion({
        expected: acceptedPlanBasis(accepted.snapshot),
        token: parseRequiredUnitToken(unit.token),
        completed: body.completed,
      });
      return result.kind === "updated"
        ? result.body
        : sendAcceptedProgressFailure(reply, result);
    } catch (error) {
      if (error instanceof AcceptedPlanOperationalIntegrityError) {
        request.log.error(
          { code: error.code, profileId, partId: id },
          "Accepted Plan integrity failure",
        );
        return reply.status(500).send({ detail: "Accepted Plan data is inconsistent" });
      }
      request.log.error(
        { failure: "unexpected", profileId, partId: id },
        "Accepted Plan Progress update failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
  });

  app.get("/parts/:id/assembled", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    let profileId: number | null = null;
    try {
      const part = deps.repo.getPartRow(id);
      if (!part) return reply.status(404).send({ detail: "Part not found" });
      profileId = part.profileId;
      const accepted = deps.repo.readAcceptedPlanOperationalSnapshot(profileId);
      const view = toAcceptedPartAssembledView({ partId: id, accepted });
      if (view.kind === "part_not_found") {
        return reply.status(404).send({ detail: "Part not found" });
      }
      if (view.kind === "accepted_state_unavailable") {
        const detail =
          view.reason === "compatibility_dirty"
            ? "Accepted Plan requires compatibility repair"
            : "Accepted Plan operational state is not initialized";
        return reply.status(409).send({ detail });
      }
      return view.body;
    } catch (error) {
      if (error instanceof AcceptedPlanOperationalIntegrityError) {
        request.log.error(
          { code: error.code, profileId, partId: id },
          "Accepted Plan integrity failure",
        );
        return reply.status(500).send({ detail: "Accepted Plan data is inconsistent" });
      }
      request.log.error(
        { failure: "unexpected", profileId, partId: id },
        "Accepted Plan read failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
  });

  app.patch("/parts/:id/assembled", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body as { unit_index?: number; assembled?: boolean };
    if (body.unit_index == null || body.assembled == null) {
      return reply.status(400).send({ detail: "unit_index and assembled required" });
    }
    if (
      typeof body.assembled !== "boolean" ||
      !Number.isInteger(body.unit_index) ||
      body.unit_index < 0
    ) {
      return reply.status(400).send({
        detail: "unit_index must be a non-negative integer and assembled a boolean",
      });
    }
    if (!deps.repo.canMutateAcceptedPlan()) {
      return reply.status(503).send({ detail: "Accepted Plan update is unavailable" });
    }
    let profileId: number | null = null;
    try {
      const accepted = readAcceptedPartRequest(deps, id);
      if (accepted.kind === "part_not_found") {
        return reply.status(404).send({ detail: "Part not found" });
      }
      if (accepted.kind === "accepted_state_unavailable") {
        return reply.status(409).send({ detail: acceptedStateDetail(accepted.reason) });
      }
      profileId = accepted.profileId;
      const unit = accepted.part.units[body.unit_index];
      if (!unit) return reply.status(400).send({ detail: "unit_index out of range" });
      const result = deps.repo.setAcceptedUnitAssembly({
        expected: acceptedPlanBasis(accepted.snapshot),
        token: parseRequiredUnitToken(unit.token),
        assembled: body.assembled,
      });
      return result.kind === "updated"
        ? result.body
        : sendAcceptedProgressFailure(reply, result);
    } catch (error) {
      if (error instanceof AcceptedPlanOperationalIntegrityError) {
        request.log.error(
          { code: error.code, profileId, partId: id },
          "Accepted Plan integrity failure",
        );
        return reply.status(500).send({ detail: "Accepted Plan data is inconsistent" });
      }
      request.log.error(
        { failure: "unexpected", profileId, partId: id },
        "Accepted Plan assembly update failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
  });

  app.get("/parts/:id/mesh", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    let profileId: number | null = null;
    try {
      const accepted = readAcceptedPartRequest(deps, id);
      if (accepted.kind === "part_not_found") {
        return reply.status(404).send({ detail: "Part not found" });
      }
      if (accepted.kind === "accepted_state_unavailable") {
        return reply.status(409).send({ detail: acceptedStateDetail(accepted.reason) });
      }
      const part = accepted.part;
      profileId = accepted.profileId;
      if (part.artifact.kind === "unavailable") {
        return reply.status(409).send({ detail: "Accepted Part media is unavailable" });
      }
      const { hex, basis } = acceptedPartMediaIdentity(part, "mesh");
      const opened = openVerifiedAcceptedArtifact({
        reposDir: deps.reposDir,
        artifact: part.artifact,
      });
      if (opened.kind !== "verified") {
        if (opened.kind === "unavailable") {
          return reply.status(409).send({ detail: "Accepted Part media is unavailable" });
        }
        return reply.status(409).send({ detail: "Accepted Part artifact is unavailable" });
      }
      const etag = `"${basis}"`;
      if (matchesStrongEtagList(request.headers["if-none-match"], etag)) {
        opened.lease.close();
        reply.status(304).header("Cache-Control", "private, no-cache").header("ETag", etag);
        if (hex) reply.header("X-Accepted-Render-Hex", hex);
        return reply.send();
      }
      const stream = opened.lease.createReadStream();
      const closeLease = () => opened.lease.close();
      stream.once("end", closeLease);
      stream.once("error", closeLease);
      stream.once("close", closeLease);
      const filename = basename(part.filename).replace(/["\r\n]/g, "_");
      reply
        .header("Content-Type", "model/stl")
        .header("Content-Disposition", `inline; filename="${filename}"`)
        .header("Content-Length", opened.lease.size)
        .header("Cache-Control", "private, no-cache")
        .header("ETag", etag);
      if (hex) reply.header("X-Accepted-Render-Hex", hex);
      return reply.send(stream);
    } catch (error) {
      if (error instanceof AcceptedPlanOperationalIntegrityError) {
        request.log.error(
          { code: error.code, profileId, partId: id },
          "Accepted Plan integrity failure",
        );
        return reply.status(500).send({ detail: "Accepted Plan data is inconsistent" });
      }
      request.log.error(
        { failure: "unexpected", profileId, partId: id },
        "Accepted Part media failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
  });

  app.get("/parts/:id/thumbnail", async (request, reply) => sendPartImage(deps, request, reply, false));
  app.get("/parts/:id/preview", async (request, reply) => sendPartImage(deps, request, reply, true));

  app.post("/plans/:id/regenerate-thumbnails", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    try {
      if (!deps.repo.getOwnedProfileIdentity(id)) {
        return reply.status(404).send({ detail: "Profile not found" });
      }
      const accepted = deps.repo.readAcceptedPlanOperationalSnapshot(id);
      if (accepted.kind === "empty") return { cleared: 0 };
      if (accepted.kind !== "ready") {
        return reply.status(409).send({ detail: acceptedStateDetail(accepted.kind) });
      }
      let cleared = 0;
      for (const part of accepted.snapshot.parts) {
        if (part.artifact.kind !== "tracked") continue;
        for (const variant of ["thumbnail", "preview"] as const) {
          const { basis } = acceptedPartMediaIdentity(part, variant);
          if (removeAcceptedMediaPng({ thumbsDir: deps.thumbsDir, basis })) cleared += 1;
        }
      }
      return { cleared };
    } catch (error) {
      if (error instanceof AcceptedPlanOperationalIntegrityError) {
        request.log.error({ code: error.code, profileId: id }, "Accepted Plan integrity failure");
        return reply.status(500).send({ detail: "Accepted Plan data is inconsistent" });
      }
      request.log.error(
        { failure: "unexpected", profileId: id },
        "Accepted thumbnail regeneration failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
  });

  app.post("/parts/:id/thumbnail", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    let profileId: number | null = null;
    try {
      const projection = deps.repo.getPartRow(id);
      if (!projection) {
        return reply.status(404).send({ detail: "Part not found" });
      }
      profileId = projection.profileId;
      const ifMatch = request.headers["if-match"];
      if (typeof ifMatch !== "string" || !/^"[0-9a-f]{64}"$/.test(ifMatch)) {
        return reply.status(400).send({ detail: "Strong If-Match header required" });
      }
      const file = await request.file({
        throwFileSizeLimit: false,
        limits: {
          fileSize: MAX_THUMBNAIL_UPLOAD_BYTES,
          files: 1,
          fields: 0,
          parts: 1,
        },
      });
      if (!file) return reply.status(400).send({ detail: "PNG file required" });
      const buf = await file.toBuffer();
      if (file.file.truncated) {
        return reply.status(413).send({
          detail: THUMBNAIL_UPLOAD_TOO_LARGE_DETAIL,
        });
      }

      const accepted = deps.repo.readAcceptedPlanOperationalSnapshot(profileId);
      if (accepted.kind === "empty") {
        return reply.status(404).send({ detail: "Part not found" });
      }
      if (accepted.kind !== "ready") {
        return reply.status(409).send({ detail: acceptedStateDetail(accepted.kind) });
      }
      const part = accepted.snapshot.parts.find(
        (candidate) => candidate.projectionPartId === id,
      );
      if (!part) {
        return reply.status(409).send({ detail: "Accepted Part media basis is stale" });
      }
      if (part.artifact.kind === "unavailable") {
        return reply.status(409).send({ detail: "Accepted Part media is unavailable" });
      }
      const { basis: meshBasis } = acceptedPartMediaIdentity(part, "mesh");
      if (ifMatch !== `"${meshBasis}"`) {
        return reply.status(409).send({ detail: "Accepted Part media basis is stale" });
      }
      const verified = openVerifiedAcceptedArtifact({
        reposDir: deps.reposDir,
        artifact: part.artifact,
      });
      if (verified.kind !== "verified") {
        return reply.status(409).send({ detail: "Accepted Part artifact is unavailable" });
      }
      verified.lease.close();
      if (request.headers["x-thumbnail-renderer-version"] !== THUMBNAIL_RENDERER_VERSION) {
        return reply.status(409).send({
          detail: "Thumbnail renderer is out of date; refresh the app and retry",
        });
      }
      const { basis: thumbnailBasis } = acceptedPartMediaIdentity(part, "thumbnail");
      try {
        writeAcceptedMediaPng({ thumbsDir: deps.thumbsDir, basis: thumbnailBasis, png: buf });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("Invalid accepted media PNG")) {
          return reply.status(400).send({ detail: "Expected PNG image" });
        }
        throw error;
      }
      return { saved: true, digest: thumbnailBasis };
    } catch (error) {
      if (error instanceof AcceptedPlanOperationalIntegrityError) {
        request.log.error(
          { code: error.code, profileId, partId: id },
          "Accepted Plan integrity failure",
        );
        return reply.status(500).send({ detail: "Accepted Plan data is inconsistent" });
      }
      request.log.error(
        { failure: "unexpected", profileId, partId: id },
        "Accepted Part media failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
  });
}
