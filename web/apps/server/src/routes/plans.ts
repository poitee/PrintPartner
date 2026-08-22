import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  AcceptedProfileProgress,
  AcceptedProfileSummary,
  AppRepository,
} from "../db/repository.js";
import { readAcceptedPlanReview } from "../services/accepted-plan-review.js";
import { loadKitManifest, saveKitManifest } from "../services/kit-manifest-store.js";
import { buildPlanManifestBuilder } from "../services/plan-manifest-builder.js";
import { preloadSpoolmanForColorIds, enrichRoleFilamentRows } from "../services/filament-resolve.js";
import { clearPartThumbnailCacheAtHexes, clearPlanThumbnailCache } from "../services/plan-thumbnails.js";
import { canonicalRoleOrder, loadRoleFilamentDefaults } from "../services/role-filament-store.js";
import { resolvePartFilamentHex } from "../services/filament-catalog.js";
import { resolvePartStl } from "../services/part-paths.js";
import { normalizePartRole } from "../services/role-filament.js";
import { AcceptedPlanOperationalIntegrityError } from "../db/accepted-plan-operational.js";
import { toAcceptedCheckoffView } from "../services/accepted-plan-views.js";
import { acceptedPlanBasis } from "../db/accepted-plan-progress.js";
import {
  filamentAssignmentColumns,
  resolveFilamentAssignment,
  type AssignAcceptedFilamentResult,
  type FilamentAssignment,
} from "../db/accepted-part-filament.js";
import {
  toLegacyProfileSummary,
  toProfileSummary,
  type LegacyProgressFailure,
} from "./plan-summary-presenter.js";

type RouteDeps = { repo: AppRepository; dataDir: string; reposDir: string; thumbsDir: string };
export type PlanSummaryContract = "accepted" | "legacy-v1";

type PlanRouteOptions = { readonly summaryContract?: PlanSummaryContract };

function presentProfile(summary: AcceptedProfileSummary, contract: PlanSummaryContract) {
  if (contract === "accepted") return { kind: "ready" as const, profile: toProfileSummary(summary) };
  return toLegacyProfileSummary(summary);
}

function sendLegacyFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: string,
  failure: LegacyProgressFailure,
  profileId?: number,
) {
  if (failure.kind === "integrity_failure") {
    request.log.error(
      { operation, ...(profileId == null ? {} : { profileId }), code: failure.code },
      "Accepted Plan integrity failure",
    );
    return reply.status(500).send({ detail: "Accepted Plan data is inconsistent" });
  }
  if (failure.kind === "concurrent_update") {
    request.log.warn(
      { operation, ...(profileId == null ? {} : { profileId }), reason: "concurrent_update" },
      "Accepted Plan progress unavailable",
    );
    return reply.status(409).send({ detail: "Accepted Plan changed; reload and retry" });
  }
  request.log.warn(
    { operation, ...(profileId == null ? {} : { profileId }), reason: failure.reason },
    "Accepted Plan progress unavailable",
  );
  return reply.status(409).send({ detail: acceptedStateDetail(failure.reason) });
}

function acceptedStateDetail(reason: "compatibility_dirty" | "uninitialized"): string {
  return reason === "compatibility_dirty"
    ? "Accepted Plan requires compatibility repair"
    : "Accepted Plan operational state is not initialized";
}

function sendAcceptedFilamentFailure(reply: FastifyReply, failure: AssignAcceptedFilamentResult) {
  if (failure.kind === "updated") {
    throw new Error("Accepted filament success cannot be sent as a failure");
  }
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
  return reply.status(404).send({ detail: "Part not found" });
}

function completeRoleAssignment(body: {
  filament_color_id?: string | null;
  filament_custom_hex?: string | null;
  spoolman_spool_id?: string | null;
}): FilamentAssignment {
  return resolveFilamentAssignment(
    { color: { kind: "unset" }, spoolmanSpoolId: null },
    {
      colorId: body.filament_color_id ?? null,
      customHex: body.filament_custom_hex ?? null,
      spoolmanSpoolId: body.spoolman_spool_id ?? null,
    },
  );
}

function archiveAcceptedPlan(
  deps: RouteDeps,
  profile: { readonly id: number; readonly archivedAt: string | null },
) {
  if (profile.archivedAt) {
    return { kind: "already_archived" as const, archivedAt: profile.archivedAt };
  }
  const accepted = deps.repo.readAcceptedPlanOperationalSnapshot(profile.id);
  if (accepted.kind !== "ready") return accepted;
  return deps.repo.archiveAcceptedPlan({ expected: acceptedPlanBasis(accepted.snapshot) });
}

export async function registerPlanRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
  options: PlanRouteOptions = {},
): Promise<void> {
  const contract = options.summaryContract ?? "accepted";

  app.get("/plans", async (request, reply) => {
    try {
      const summaries = deps.repo.listAcceptedProfileSummaries();
      if (contract === "accepted") {
        return { profiles: summaries.map(toProfileSummary) };
      }
      const projected = summaries.map(toLegacyProfileSummary);
      const integrity = projected.find(
        (result) =>
          result.kind === "unavailable" && result.failure.kind === "integrity_failure",
      );
      if (integrity?.kind === "unavailable") {
        return sendLegacyFailure(request, reply, "list_plans", integrity.failure);
      }
      const unavailable = projected.find((result) => result.kind === "unavailable");
      if (unavailable?.kind === "unavailable") {
        request.log.warn(
          { operation: "list_plans", reason: "unavailable" },
          "Accepted Plan progress unavailable",
        );
        return reply.status(409).send({
          detail: "Accepted Plan progress is unavailable for one or more Plans",
        });
      }
      return {
        profiles: projected.map((result) => {
          if (result.kind === "unavailable") {
            throw new Error("Legacy Plan projection changed after preflight");
          }
          return result.profile;
        }),
      };
    } catch {
      request.log.error(
        { failure: "unexpected", operation: "list_plans" },
        "Plan summary collection failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
  });

  app.post("/plans", async (request, reply) => {
    try {
      const body = request.body as { name?: string; base_project_id?: number };
      const created = deps.repo.createProfile(String(body.name ?? ""), body.base_project_id);
      const { layers, ...header } = created;
      const presented = presentProfile({ header, progress: { kind: "empty" } }, contract);
      if (presented.kind !== "ready") {
        throw new Error("Empty Plan cannot fail legacy projection");
      }
      return { ...presented.profile, layers };
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/plans/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    try {
      const read = deps.repo.readAcceptedProfileSummary(id);
      if (read.kind === "missing") {
        return reply.status(404).send({ detail: "Profile not found" });
      }
      const presented = presentProfile(read.summary, contract);
      if (presented.kind === "unavailable") {
        return sendLegacyFailure(request, reply, "get_plan", presented.failure, id);
      }
      return presented.profile;
    } catch {
      request.log.error(
        { failure: "unexpected", operation: "get_plan", profileId: id },
        "Plan summary read failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
  });

  app.delete("/plans/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) {
      return reply.status(404).send({ detail: "Profile not found" });
    }
    deps.repo.deleteProfile(id);
    return reply.status(204).send();
  });

  app.patch("/plans/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body as {
      name?: string;
      special_request?: string | null;
      archived?: boolean;
      touch_last_used?: boolean;
    };
    const archiveAttempted = body.archived === true;
    if (body.archived === false) {
      return reply.status(400).send({
        detail: "Cannot unarchive; duplicate the archived template instead",
      });
    }
    if (archiveAttempted && !deps.repo.canMutateAcceptedPlan()) {
      return reply.status(503).send({ detail: "Accepted Plan update is unavailable" });
    }
    let accepted: AcceptedProfileSummary;
    try {
      const read = deps.repo.readAcceptedProfileSummary(id);
      if (read.kind === "missing") {
        return reply.status(404).send({ detail: "Profile not found" });
      }
      accepted = read.summary;
    } catch {
      request.log.error(
        { failure: "unexpected", operation: "update_plan", profileId: id },
        "Plan summary read failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
    const preflight = presentProfile(accepted, contract);
    if (preflight.kind === "unavailable") {
      return sendLegacyFailure(request, reply, "update_plan", preflight.failure, id);
    }
    try {
      let header =
        typeof body.name === "string"
          ? deps.repo.renameProfile(id, body.name)
          : accepted.header;
      if (body.special_request !== undefined) {
        header = deps.repo.updateProfileSpecialRequest(
          id,
          body.special_request == null ? null : String(body.special_request),
        );
      }
      if (body.archived === true) {
        const archived = archiveAcceptedPlan(deps, {
          id,
          archivedAt: accepted.header.archived_at,
        });
        if (archived.kind === "compatibility_dirty" || archived.kind === "uninitialized") {
          return reply.status(409).send({ detail: acceptedStateDetail(archived.kind) });
        }
        if (archived.kind === "accepted_state_unavailable") {
          return reply.status(409).send({ detail: acceptedStateDetail(archived.reason) });
        }
        if (archived.kind === "stale_accepted_plan") {
          return reply.status(409).send({ detail: "Accepted Plan changed; reload and retry" });
        }
        if (archived.kind === "transaction_unavailable") {
          return reply.status(503).send({ detail: "Accepted Plan update is unavailable" });
        }
        if (archived.kind === "empty" || archived.kind === "remaining") {
          return reply.status(400).send({ detail: "Archive only when print remaining is 0" });
        }
        if (!("archivedAt" in archived)) {
          return reply.status(500).send({ detail: "Internal Server Error" });
        }
        header = { ...header, archived_at: archived.archivedAt };
      }
      if (body.touch_last_used === true) {
        header = deps.repo.touchProfileLastUsed(id);
      }
      const presented = presentProfile(
        { header, progress: accepted.progress },
        contract,
      );
      if (presented.kind === "unavailable") {
        throw new Error("Captured legacy Plan projection changed after write");
      }
      return presented.profile;
    } catch (error) {
      if (error instanceof AcceptedPlanOperationalIntegrityError) {
        request.log.error({ code: error.code, profileId: id }, "Accepted Plan integrity failure");
        return reply.status(500).send({ detail: "Accepted Plan data is inconsistent" });
      }
      if (!archiveAttempted) {
        return reply.status(400).send({ detail: error instanceof Error ? error.message : String(error) });
      }
      request.log.error({ failure: "unexpected", profileId: id }, "Plan update failed");
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
  });

  app.post("/plans/:id/touch", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    let accepted: AcceptedProfileSummary;
    try {
      const read = deps.repo.readAcceptedProfileSummary(id);
      if (read.kind === "missing") {
        return reply.status(404).send({ detail: "Profile not found" });
      }
      accepted = read.summary;
    } catch {
      request.log.error(
        { failure: "unexpected", operation: "touch_plan", profileId: id },
        "Plan summary read failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
    const preflight = presentProfile(accepted, contract);
    if (preflight.kind === "unavailable") {
      return sendLegacyFailure(request, reply, "touch_plan", preflight.failure, id);
    }
    try {
      const header = deps.repo.touchProfileLastUsed(id);
      const presented = presentProfile({ header, progress: accepted.progress }, contract);
      if (presented.kind === "unavailable") {
        throw new Error("Captured legacy Plan projection changed after write");
      }
      return presented.profile;
    } catch {
      request.log.error(
        { failure: "unexpected", operation: "touch_plan", profileId: id },
        "Plan touch failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
  });

  app.post("/plans/:id/archive", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.canMutateAcceptedPlan()) {
      return reply.status(503).send({ detail: "Accepted Plan update is unavailable" });
    }
    let accepted: AcceptedProfileSummary;
    try {
      const read = deps.repo.readAcceptedProfileSummary(id);
      if (read.kind === "missing") {
        return reply.status(404).send({ detail: "Profile not found" });
      }
      accepted = read.summary;
    } catch {
      request.log.error(
        { failure: "unexpected", operation: "archive_plan", profileId: id },
        "Plan summary read failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
    const preflight = presentProfile(accepted, contract);
    if (preflight.kind === "unavailable") {
      return sendLegacyFailure(request, reply, "archive_plan", preflight.failure, id);
    }
    try {
      const archived = archiveAcceptedPlan(deps, {
        id,
        archivedAt: accepted.header.archived_at,
      });
      if (archived.kind === "compatibility_dirty" || archived.kind === "uninitialized") {
        return reply.status(409).send({ detail: acceptedStateDetail(archived.kind) });
      }
      if (archived.kind === "accepted_state_unavailable") {
        return reply.status(409).send({ detail: acceptedStateDetail(archived.reason) });
      }
      if (archived.kind === "stale_accepted_plan") {
        return reply.status(409).send({ detail: "Accepted Plan changed; reload and retry" });
      }
      if (archived.kind === "transaction_unavailable") {
        return reply.status(503).send({ detail: "Accepted Plan update is unavailable" });
      }
      if (archived.kind === "empty" || archived.kind === "remaining") {
        return reply.status(400).send({ detail: "Archive only when print remaining is 0" });
      }
      if (!("archivedAt" in archived)) {
        return reply.status(500).send({ detail: "Internal Server Error" });
      }
      const presented = presentProfile(
        {
          header: { ...accepted.header, archived_at: archived.archivedAt },
          progress: accepted.progress,
        },
        contract,
      );
      if (presented.kind === "unavailable") {
        throw new Error("Captured legacy Plan projection changed after write");
      }
      return presented.profile;
    } catch (error) {
      if (error instanceof AcceptedPlanOperationalIntegrityError) {
        request.log.error({ code: error.code, profileId: id }, "Accepted Plan integrity failure");
        return reply.status(500).send({ detail: "Accepted Plan data is inconsistent" });
      }
      request.log.error({ failure: "unexpected", profileId: id }, "Plan archive failed");
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
  });

  app.post("/plans/:id/duplicate", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body as { name?: string; clear_checkoff?: boolean };
    if (contract === "legacy-v1") {
      return reply.status(409).send({ detail: "Duplicate this Plan through /api/v2" });
    }
    try {
      const duplicate = deps.repo.duplicateProfile(id, String(body.name ?? ""), {
        clearCheckoff: Boolean(body.clear_checkoff),
      });
      const { layers, ...header } = duplicate;
      const progress: AcceptedProfileProgress =
        header.part_count === 0
          ? { kind: "empty" }
          : { kind: "unavailable", reason: "compatibility_dirty" };
      return { ...toProfileSummary({ header, progress }), layers };
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete("/plans/:id/layers/:layerId", async (request, reply) => {
    const profileId = Number((request.params as { id: string }).id);
    const layerId = Number((request.params as { layerId: string }).layerId);
    if (!deps.repo.getOwnedProfileIdentity(profileId)) {
      return reply.status(404).send({ detail: "Profile not found" });
    }
    try {
      deps.repo.removeLayer(layerId);
      return reply.status(204).send();
    } catch (e) {
      return reply.status(404).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.put("/plans/:id/layers/:layerId", async (request, reply) => {
    const profileId = Number((request.params as { id: string }).id);
    const layerId = Number((request.params as { layerId: string }).layerId);
    const body = request.body as { project_id?: number };
    if (!deps.repo.getOwnedProfileIdentity(profileId)) {
      return reply.status(404).send({ detail: "Profile not found" });
    }
    try {
      deps.repo.replaceLayer(layerId, Number(body.project_id));
      return { profile_id: profileId, layers: deps.repo.getProfileLayers(profileId) };
    } catch (e) {
      return reply.status(404).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/plans/:id/layers", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    return { profile_id: id, layers: deps.repo.getProfileLayers(id) };
  });

  app.put("/plans/:id/layers/base", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body as { project_id?: number };
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    try {
      deps.repo.setBaseLayer(id, Number(body.project_id));
      return { profile_id: id, layers: deps.repo.getProfileLayers(id) };
    } catch (e) {
      return reply.status(404).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/plans/:id/layers", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body as { project_id?: number };
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    try {
      deps.repo.addAddonLayer(id, Number(body.project_id));
      return { profile_id: id, layers: deps.repo.getProfileLayers(id) };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      if (detail.includes("already attached")) {
        return reply.status(409).send({ detail });
      }
      if (detail === "Project not found") {
        return reply.status(404).send({ detail });
      }
      return reply.status(400).send({ detail });
    }
  });

  app.get("/plans/:id/parts", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    const query = request.query as { limit?: string; offset?: string };
    const limit = query.limit ? Number(query.limit) : 10000;
    const offset = query.offset ? Number(query.offset) : 0;
    const result = deps.repo.listParts(id, limit, offset);
    return {
      profile_id: id,
      total: result.total,
      offset,
      limit,
      parts: result.parts,
    };
  });

  app.get("/plans/:id/parts-grouped", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    const query = (request.query as { query?: string }).query ?? "";
    return deps.repo.getPartsGrouped(id, query);
  });

  app.get("/plans/:id/review", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const query = request.query as { include_excluded?: string };
    const include_excluded =
      query.include_excluded === "1" ||
      query.include_excluded === "true";
    try {
      const result = await readAcceptedPlanReview({
        repo: deps.repo,
        profileId: id,
        includeExcluded: include_excluded,
        reposDir: deps.reposDir,
        thumbsDir: deps.thumbsDir,
        loadFilamentContext: (colorIds) =>
          preloadSpoolmanForColorIds({ repo: deps.repo, dataDir: deps.dataDir }, colorIds),
      });
      if (result.kind === "not_found") {
        return reply.status(404).send({ detail: "Profile not found" });
      }
      if (result.kind === "accepted_state_unavailable") {
        const detail =
          result.reason === "compatibility_dirty"
            ? "Accepted Plan requires compatibility repair"
            : "Accepted Plan operational state is not initialized";
        return reply.status(409).send({ detail });
      }
      return result.body;
    } catch (error) {
      if (error instanceof AcceptedPlanOperationalIntegrityError) {
        request.log.error({ code: error.code, profileId: id }, "Accepted Plan integrity failure");
        return reply.status(500).send({ detail: "Accepted Plan data is inconsistent" });
      }
      request.log.error(
        { failure: "unexpected", profileId: id },
        "Accepted Plan Review failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
  });

  app.get("/plans/maintenance", async () => ({ plans_with_warnings: [] }));
  app.get("/plans/:id/manifest-summary", async (request) => ({
    profile_id: Number((request.params as { id: string }).id),
    required: { total: 0, included: 0 },
    optional: { total: 0, included: 0 },
    recommended: { total: 0, included: 0 },
    option_groups: [],
  }));
  app.get("/plans/:id/manifest-warnings", async () => ({ warnings: [] }));
  app.get("/plans/:id/role-filaments", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    const roles = deps.repo.getRoleFilaments(id);
    await enrichRoleFilamentRows(roles, { repo: deps.repo, dataDir: deps.dataDir });
    return { roles };
  });

  app.put("/plans/:id/role-filament", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    const body = request.body as {
      role?: string;
      filament_color_id?: string | null;
      filament_custom_hex?: string | null;
      spoolman_spool_id?: string | null;
      refresh_thumbnails?: boolean;
    };
    const role = String(body.role ?? "").trim();
    if (!role) return reply.status(400).send({ detail: "role is required" });
    const snapshot = deps.repo.readAcceptedPlanOperationalSnapshot(id);
    if (snapshot.kind !== "ready") {
      return reply.status(409).send({
        detail:
          snapshot.kind === "empty"
            ? "Accepted Plan changed; reload and retry"
            : acceptedStateDetail(snapshot.kind),
      });
    }
    const normalizedRole = normalizePartRole(role);
    const result = deps.repo.assignAcceptedFilament({
      expected: acceptedPlanBasis(snapshot.snapshot),
      target: { kind: "role", role: normalizedRole },
      assignment: completeRoleAssignment(body),
    });
    if (result.kind !== "updated") return sendAcceptedFilamentFailure(reply, result);
    const refreshThumbnails = body.refresh_thumbnails !== false;
    let thumbnails_cleared = 0;
    if (refreshThumbnails) {
      for (const assigned of result.assigned) {
        const part = deps.repo.getPartRow(assigned.projectionPartId);
        if (!part) continue;
        const stl = resolvePartStl(deps.repo, part);
        if (!stl) continue;
        thumbnails_cleared += clearPartThumbnailCacheAtHexes(
          deps.thumbsDir,
          stl,
          normalizedRole,
          [
            resolvePartFilamentHex(filamentAssignmentColumns(assigned.before)),
            resolvePartFilamentHex(filamentAssignmentColumns(assigned.after)),
          ],
        );
      }
    }
    const roles = deps.repo.getRoleFilaments(id);
    await enrichRoleFilamentRows(roles, { repo: deps.repo, dataDir: deps.dataDir });
    return { updated: result.assigned.length, thumbnails_cleared, roles };
  });

  app.post("/plans/:id/apply-role-colors", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    const body = (request.body ?? {}) as { refresh_thumbnails?: boolean };
    const refreshThumbnails = body.refresh_thumbnails !== false;
    const snapshot = deps.repo.readAcceptedPlanOperationalSnapshot(id);
    if (snapshot.kind !== "ready") {
      return reply.status(409).send({
        detail:
          snapshot.kind === "empty"
            ? "Accepted Plan changed; reload and retry"
            : acceptedStateDetail(snapshot.kind),
      });
    }
    const savedDefaults = loadRoleFilamentDefaults(deps.repo, id);
    const expected = acceptedPlanBasis(snapshot.snapshot);
    let updated = 0;
    for (const role of canonicalRoleOrder()) {
      const saved = savedDefaults[role];
      if (!saved?.filament_color_id && !saved?.filament_custom_hex) continue;
      const result = deps.repo.assignAcceptedFilament({
        expected,
        target: { kind: "role", role },
        assignment: completeRoleAssignment(saved),
      });
      if (result.kind !== "updated") return sendAcceptedFilamentFailure(reply, result);
      updated += result.assigned.length;
    }
    const thumbnails_cleared = refreshThumbnails
      ? clearPlanThumbnailCache(deps.repo, deps.thumbsDir, id)
      : 0;
    const roles = deps.repo.getRoleFilaments(id);
    await enrichRoleFilamentRows(roles, { repo: deps.repo, dataDir: deps.dataDir });
    return { updated, thumbnails_cleared, roles };
  });

  app.get("/plans/:id/checkoff", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    try {
      if (!deps.repo.getOwnedProfileIdentity(id)) {
        return reply.status(404).send({ detail: "Profile not found" });
      }
      const accepted = deps.repo.readAcceptedPlanOperationalSnapshot(id);
      const filamentContext =
        accepted.kind === "ready"
          ? await preloadSpoolmanForColorIds(
              { repo: deps.repo, dataDir: deps.dataDir },
              accepted.snapshot.parts.map((part) => part.filamentColorId),
            )
          : undefined;
      const view = toAcceptedCheckoffView({
        profileId: id,
        accepted,
        filamentContext,
      });
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
          { code: error.code, profileId: id },
          "Accepted Plan integrity failure",
        );
        return reply.status(500).send({ detail: "Accepted Plan data is inconsistent" });
      }
      request.log.error(
        { failure: "unexpected", profileId: id },
        "Accepted Plan read failed",
      );
      return reply.status(500).send({ detail: "Internal Server Error" });
    }
  });

  app.get("/plans/:id/kit-manifest", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    return { profile_id: id, kit: loadKitManifest(deps.repo, id) };
  });

  app.put("/plans/:id/kit-manifest", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    const body = request.body as { kit?: Record<string, unknown> };
    const kit = saveKitManifest(deps.repo, id, (body.kit ?? {}) as Parameters<typeof saveKitManifest>[2]);
    return { profile_id: id, kit };
  });

  app.get("/plans/:id/manifest-v2", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    const raw = deps.repo.getSetting(`manifest_v2_${id}`);
    if (!raw) {
      return {
        profile_id: id,
        version: 2,
        yaml: "format: print-partner-manifest-v2\nversion: 2\n",
        plan: { name: null, base_source_id: null, addon_source_ids: [] },
        sources: [],
        selections: {},
        option_groups: {},
        option_group_count: 0,
        addon_count: 0,
      };
    }
    try {
      return JSON.parse(raw);
    } catch {
      return reply.status(400).send({ detail: "Invalid stored manifest" });
    }
  });

  app.get("/plans/:id/plan-manifest-builder", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    return buildPlanManifestBuilder(deps.repo, id);
  });

  app.get("/plans/:id/decisions", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    return { decisions: deps.repo.listPlanDecisions(id) };
  });

  app.post("/plans/:id/decisions", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    const body = (request.body ?? {}) as {
      kind?: string;
      actor?: string;
      action_type?: string | null;
      params?: Record<string, unknown>;
      label?: string;
      summary?: string;
      rationale?: string | null;
      result?: Record<string, unknown> | null;
    };
    const kind = body.kind ?? "user_note";
    const allowed = new Set(["applied_action", "dismissed_action", "user_note", "choice"]);
    if (!allowed.has(kind)) {
      return reply.status(400).send({ detail: "Invalid kind" });
    }
    try {
      const { appendPlanDecision } = await import("../services/plan-decisions.js");
      const decision = appendPlanDecision(deps.repo, {
        planId: id,
        actor: body.actor === "assistant" ? "assistant" : "user",
        kind: kind as "applied_action" | "dismissed_action" | "user_note" | "choice",
        actionType: body.action_type ?? null,
        params: body.params ?? {},
        label: body.label ?? "",
        summary: body.summary ?? "",
        rationale: body.rationale ?? null,
        result: body.result ?? null,
      });
      return decision;
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/plans/:id/recipe", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const { deriveBuildRecipe } = await import("../services/build-recipe.js");
    const recipe = deriveBuildRecipe(deps.repo, id);
    if (!recipe) return reply.status(404).send({ detail: "Profile not found" });
    return recipe;
  });

  app.get("/plans/:id/snapshots", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    const { listPlanSnapshots } = await import("../services/plan-snapshots.js");
    return { snapshots: listPlanSnapshots(deps.repo, id) };
  });

  app.post("/plans/:id/snapshots", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    const body = (request.body ?? {}) as { name?: string; source?: string };
    const { createPlanSnapshot } = await import("../services/plan-snapshots.js");
    try {
      return createPlanSnapshot(deps.repo, id, {
        name: body.name,
        source:
          body.source === "assistant" || body.source === "pre_apply" ? body.source : "user",
      });
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/plans/:id/snapshots/:sid", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const sid = Number((request.params as { sid: string }).sid);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    const { getPlanSnapshot } = await import("../services/plan-snapshots.js");
    const snap = getPlanSnapshot(deps.repo, sid);
    if (!snap || snap.plan_id !== id) return reply.status(404).send({ detail: "Snapshot not found" });
    return snap;
  });

  app.post("/plans/:id/snapshots/:sid/restore", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const sid = Number((request.params as { sid: string }).sid);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    const { getPlanSnapshot, restorePlanSnapshotPayload } = await import(
      "../services/plan-snapshots.js"
    );
    const snap = getPlanSnapshot(deps.repo, sid);
    if (!snap || snap.plan_id !== id) return reply.status(404).send({ detail: "Snapshot not found" });
    const restored = restorePlanSnapshotPayload(deps.repo, id, snap.payload);
    if (!restored.ok) {
      return reply.status(400).send({ detail: restored.detail, needs_sync: restored.needs_sync });
    }
    try {
      const { appendPlanDecision } = await import("../services/plan-decisions.js");
      appendPlanDecision(deps.repo, {
        planId: id,
        actor: "user",
        kind: "applied_action",
        actionType: "restore_plan_snapshot",
        params: { snapshot_id: sid, name: snap.name },
        label: `Restored snapshot "${snap.name}"`,
        summary: `Restored configuration from snapshot #${sid}`,
        result: { needs_sync: restored.needs_sync },
      });
    } catch {
      /* best-effort */
    }
    return { ok: true, needs_sync: restored.needs_sync, layers: restored.layers, snapshot: snap };
  });

  /** GET /plans/:id/variant-dimensions — read variant_dimensions from the base source manifest. */
  app.get("/plans/:id/variant-dimensions", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) return reply.status(404).send({ detail: "Profile not found" });
    const { getSourceVariantDimensions, getPlanVariantSelection } = await import(
      "../services/variant-dimensions.js"
    );
    const layers = deps.repo.getProfileLayers(id);
    const baseLayer = layers.find((l) => l.layer_type === "base");
    const sourceId = baseLayer?.project_id ?? null;
    const dimensions = sourceId != null ? getSourceVariantDimensions(deps.repo, sourceId) : {};
    const selection = getPlanVariantSelection(deps.repo, id);
    return { profile_id: id, source_id: sourceId, dimensions, selection };
  });

  /** POST /plans/:id/variant-selection — apply variant choice to base source import rules. */
  app.post("/plans/:id/variant-selection", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getOwnedProfileIdentity(id)) {
      return reply.status(404).send({ detail: "Profile not found" });
    }
    const body = (request.body ?? {}) as { selection?: Record<string, string>; source_id?: number };
    const selection = body.selection ?? {};
    const layers = deps.repo.getProfileLayers(id);
    const baseLayer = layers.find((l) => l.layer_type === "base");
    const sourceId = body.source_id ?? baseLayer?.project_id ?? null;
    if (sourceId == null) return reply.status(400).send({ detail: "No base source on plan" });
    try {
      const { applyPlanVariantSelection } = await import("../services/variant-dimensions.js");
      const result = applyPlanVariantSelection(deps.repo, id, selection, sourceId);
      return { profile_id: id, source_id: sourceId, ...result };
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });
}
