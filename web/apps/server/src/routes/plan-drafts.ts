import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  isPlanDraftContractError,
  parseAbandonPlanDraftRequest,
  parseAcceptedProgressImportRequest,
  parseApplyPlanDraftRequest,
  parseEditPlanDraftPartsRequest,
  parseReconcilePlanDraftRequest,
  parseRebasePlanDraftRequest,
  parseSavePlanChoicesRequest,
} from "@print-partner/contracts";
import type { AcceptedPlanBase, AppRepository } from "../db/repository.js";
import { projectCapturedPlanReview } from "../services/accepted-plan-review.js";
import { preloadSpoolmanForColorIds } from "../services/filament-resolve.js";
import { toProfileSummary } from "./plan-summary-presenter.js";
import {
  PlanDraftWorkspaceService,
  type ApplyDraftWorkspaceResult,
  type PlanDraftWorkspaceResult,
} from "../services/plan-draft-workspace.js";

type RouteDeps = { readonly repo: AppRepository; readonly reposDir: string; readonly thumbsDir: string; readonly dataDir: string };

function positiveId(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function actorId(request: FastifyRequest): string {
  return request.sessionUser?.user_id ?? `tenant:${request.tenantId ?? "default"}`;
}

function idempotencyKey(request: FastifyRequest): string | null {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 160 ? trimmed : null;
}

function sendWorkspaceResult(reply: FastifyReply, result: PlanDraftWorkspaceResult) {
  if (result.kind === "ready") return reply.send(result.workspace);
  return sendFailure(reply, result);
}

function sendFailure(
  reply: FastifyReply,
  result: Exclude<PlanDraftWorkspaceResult | ApplyDraftWorkspaceResult, { kind: "ready" | "applied" }>,
) {
  switch (result.kind) {
    case "profile_not_found":
      return reply.status(404).send({ detail: "Plan not found", code: result.kind });
    case "draft_not_found":
      return reply.status(404).send({ detail: "Plan draft not found", code: result.kind });
    case "transaction_unavailable":
      return reply.status(503).send({ detail: "Plan draft update is unavailable", code: result.kind });
    case "reconciliation_required":
      return reply.status(422).send({ code: result.kind, reason: result.reason });
    case "production_active":
      return reply.status(423).send({
        code: result.kind,
        checkoff_link_count: result.checkoff_link_count,
        send_queue_item_count: result.send_queue_item_count,
      });
    case "checkoff_remap_unsafe":
      return reply.status(422).send({
        code: result.kind,
        unmappable: result.unmappable,
      });
    case "domain_error":
      return reply.status(422).send({ code: result.code });
    case "merge_conflicts":
      return reply.status(422).send({ code: result.kind, conflicts: result.conflicts });
    case "accepted_baseline_required":
    case "base_changed":
    case "inputs_changed":
    case "draft_changed":
    case "idempotency_conflict":
    case "not_open":
    case "base_unchanged":
      return reply.status(409).send({
        code: result.kind,
        ...("workspace" in result && result.workspace ? { workspace: result.workspace } : {}),
      });
  }
}

function invalidRequest(reply: FastifyReply) {
  return reply.status(400).send({ detail: "Request is invalid", code: "invalid_request" });
}

export async function registerPlanDraftRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  const service = new PlanDraftWorkspaceService(deps.repo, (timing) => {
    app.log.info(timing, "Plan phase timing");
  });

  app.post("/plans/:id/save", async (request, reply) => {
    const profileId = positiveId((request.params as { id: string }).id);
    const key = idempotencyKey(request);
    if (profileId == null || key == null) return invalidRequest(reply);
    try {
      const parsed = parseSavePlanChoicesRequest(request.body);
      const expectedBase: AcceptedPlanBase = parsed.expected_base.revision_id == null
        ? { kind: "empty", planVersion: 0 }
        : { kind: "revision", revisionId: parsed.expected_base.revision_id, planVersion: parsed.expected_base.plan_version };
      const started = performance.now();
      const result = deps.repo.savePlanChoices({
        profileId, actorId: actorId(request), idempotencyKey: key, expectedBase,
        expectedDraft: parsed.expected_draft == null ? null : {
          id: parsed.expected_draft.draft_id,
          lifecycleVersion: parsed.expected_draft.lifecycle_version,
          snapshotDigest: parsed.expected_draft.snapshot_digest,
        },
        remapCheckoffLinks: parsed.remap_checkoff_links,
        changes: parsed.decisions.map(({ target, ...decision }) => ({ ...decision,
          target: { partKey: target.part_key, relativePath: target.relative_path, sourceLayer: target.source_layer },
        })),
      });
      if (result.kind !== "saved") {
        if (result.kind === "transaction_unavailable") return sendFailure(reply, result);
        const open = result.kind === "draft_changed" ? service.list(profileId)?.filter((draft) => draft.state === "open").at(-1) : null;
        const changed = open ? service.read(profileId, open.draft_id) : null;
        const status = result.kind === "not_found" ? 404
          : result.kind === "production_active" ? 423
          : ["base_changed", "draft_changed", "inputs_changed", "idempotency_conflict", "not_open", "accepted_baseline_required"].includes(result.kind) ? 409 : 422;
        return reply.status(status).send({ code: result.kind,
          detail: "Plan choices could not be saved. Your pending choices have been kept.",
          ...(changed?.kind === "ready" ? { workspace: changed.workspace } : {}),
          ...(result.kind === "production_active" ? { checkoff_link_count: result.checkoffLinkCount, send_queue_item_count: result.sendQueueItemCount } : {}),
          ...(result.kind === "checkoff_remap_unsafe" ? { unmappable: result.unmappable } : {}),
        });
      }
      const committed = performance.now();
      const captured = deps.repo.transaction(() => ({
        accepted: deps.repo.readAcceptedPlanOperationalSnapshot(profileId),
        summary: deps.repo.readAcceptedProfileSummary(profileId),
      }));
      if (captured.accepted.kind !== "ready" || captured.summary.kind !== "found" ||
        captured.accepted.snapshot.planVersion < result.receipt.planVersion) {
        throw new Error("Saved Plan snapshot is unavailable");
      }
      const snapshotMs = performance.now() - committed;
      const review = await projectCapturedPlanReview({
        snapshot: captured.accepted.snapshot, includeExcluded: true,
        reposDir: deps.reposDir, thumbsDir: deps.thumbsDir,
        loadFilamentContext: (colorIds) => preloadSpoolmanForColorIds({ repo: deps.repo, dataDir: deps.dataDir }, colorIds),
        reportTiming: (timing) => request.log.info({ ...timing, profileId,
          commandMs: committed - started, snapshotMs, totalMs: performance.now() - started,
        }, "Plan save timing"),
      });
      const receipt = result.receipt;
      return {
        receipt: { profile_id: receipt.profileId, draft_id: receipt.draftId,
          revision_id: receipt.revisionId, plan_version: receipt.planVersion,
          draft_lifecycle_version: receipt.draftLifecycleVersion,
          revision_digest: receipt.revisionDigest,
          required_unit_mapping_digest: receipt.requiredUnitMappingDigest, applied_at: receipt.appliedAt },
        review, profile: toProfileSummary(captured.summary.summary), closed_draft_ids: result.closedDraftIds,
      };
    } catch (error) {
      if (isPlanDraftContractError(error)) return invalidRequest(reply);
      request.log.error({ failure: "unexpected", profileId }, "Plan choices save failed");
      return reply.status(500).send({ detail: "Plan save could not be confirmed. Retry with your retained choices.", code: "internal_error" });
    }
  });

  app.get("/plans/:id/drafts", async (request, reply) => {
    const profileId = positiveId((request.params as { id: string }).id);
    if (profileId == null) return invalidRequest(reply);
    try {
      const drafts = service.list(profileId);
      if (!drafts) return sendFailure(reply, { kind: "profile_not_found" });
      return { profile_id: profileId, drafts };
    } catch {
      request.log.error({ failure: "unexpected", profileId }, "Plan draft list failed");
      return reply.status(500).send({ detail: "Plan draft data is inconsistent", code: "internal_error" });
    }
  });

  app.get("/plans/:id/drafts/:draftId", async (request, reply) => {
    const params = request.params as { id: string; draftId: string };
    const profileId = positiveId(params.id);
    const draftId = positiveId(params.draftId);
    if (profileId == null || draftId == null) return invalidRequest(reply);
    try {
      return sendWorkspaceResult(reply, service.read(profileId, draftId));
    } catch {
      request.log.error({ failure: "integrity", profileId, draftId }, "Plan draft read failed");
      return reply.status(500).send({ detail: "Plan draft data is inconsistent", code: "internal_error" });
    }
  });

  app.post("/plans/:id/drafts/recompute", async (request, reply) => {
    const profileId = positiveId((request.params as { id: string }).id);
    const key = idempotencyKey(request);
    const body = request.body;
    if (profileId == null || key == null || body === null || typeof body !== "object" ||
      !("apply_manifest" in body) || typeof body.apply_manifest !== "boolean") {
      return invalidRequest(reply);
    }
    try {
      return sendWorkspaceResult(reply, service.recompute({
        profileId,
        actorId: actorId(request),
        idempotencyKey: key,
        applyManifest: body.apply_manifest,
      }));
    } catch {
      request.log.error({ failure: "unexpected", profileId }, "Plan draft recompute failed");
      return reply.status(500).send({ detail: "Plan draft update failed", code: "internal_error" });
    }
  });

  app.patch("/plans/:id/drafts/:draftId/parts", async (request, reply) => {
    const params = request.params as { id: string; draftId: string };
    const profileId = positiveId(params.id);
    const draftId = positiveId(params.draftId);
    if (profileId == null || draftId == null) return invalidRequest(reply);
    try {
      const parsed = parseEditPlanDraftPartsRequest(request.body);
      return sendWorkspaceResult(reply, service.editParts({
        profileId,
        draftId,
        actorId: actorId(request),
        request: parsed,
      }));
    } catch (error) {
      if (isPlanDraftContractError(error)) return invalidRequest(reply);
      request.log.error({ failure: "unexpected", profileId, draftId }, "Plan draft edit failed");
      return reply.status(500).send({ detail: "Plan draft update failed", code: "internal_error" });
    }
  });

  app.put("/plans/:id/drafts/:draftId/reconciliation", async (request, reply) => {
    const params = request.params as { id: string; draftId: string };
    const profileId = positiveId(params.id);
    const draftId = positiveId(params.draftId);
    const key = idempotencyKey(request);
    if (profileId == null || draftId == null || key == null) return invalidRequest(reply);
    try {
      const parsed = parseReconcilePlanDraftRequest(request.body);
      return sendWorkspaceResult(reply, service.reconcile({
        profileId,
        draftId,
        actorId: actorId(request),
        idempotencyKey: key,
        request: parsed,
      }));
    } catch (error) {
      if (isPlanDraftContractError(error)) return invalidRequest(reply);
      request.log.error({ failure: "unexpected", profileId, draftId }, "Plan draft reconciliation failed");
      return reply.status(500).send({ detail: "Plan draft update failed", code: "internal_error" });
    }
  });

  app.post("/plans/:id/drafts/:draftId/apply", async (request, reply) => {
    const params = request.params as { id: string; draftId: string };
    const profileId = positiveId(params.id);
    const draftId = positiveId(params.draftId);
    const key = idempotencyKey(request);
    if (profileId == null || draftId == null || key == null) return invalidRequest(reply);
    try {
      const parsed = parseApplyPlanDraftRequest(request.body);
      if (!deps.repo.canMutateAcceptedPlan()) {
        return sendFailure(reply, { kind: "transaction_unavailable" });
      }
      // MCP Preparation data is advisory. PlanDraftWorkspaceService remains the
      // publication authority and atomically enforces snapshot, lifecycle,
      // accepted-base, required-unit reconciliation, and active-work safety.
      let result = service.apply({
        profileId,
        draftId,
        actorId: actorId(request),
        idempotencyKey: key,
        request: parsed,
      });
      if (result.kind === "reconciliation_required") {
        const prepared = service.prepareForApply({
          profileId,
          draftId,
          actorId: actorId(request),
          expected: {
            snapshotDigest: parsed.expected_snapshot_digest,
            lifecycleVersion: parsed.expected_lifecycle_version,
            base: parsed.expected_base,
          },
        });
        if (prepared.kind !== "ready") return sendFailure(reply, prepared);
        result = service.apply({
          profileId,
          draftId,
          actorId: actorId(request),
          idempotencyKey: key,
          request: {
            ...parsed,
            expected_snapshot_digest: prepared.workspace.draft.snapshot_digest,
            expected_lifecycle_version: prepared.workspace.draft.lifecycle_version,
            expected_base: prepared.workspace.draft.base,
          },
        });
      }
      if (result.kind !== "applied") return sendFailure(reply, result);
      return {
        profile_id: result.receipt.profileId,
        draft_id: result.receipt.draftId,
        revision_id: result.receipt.revisionId,
        plan_version: result.receipt.planVersion,
        draft_lifecycle_version: result.receipt.draftLifecycleVersion,
        revision_digest: result.receipt.revisionDigest,
        required_unit_mapping_digest: result.receipt.requiredUnitMappingDigest,
        applied_at: result.receipt.appliedAt,
      };
    } catch (error) {
      if (isPlanDraftContractError(error)) return invalidRequest(reply);
      request.log.error({ failure: "unexpected", profileId, draftId }, "Plan draft Apply failed");
      return reply.status(500).send({ detail: "Plan draft update failed", code: "internal_error" });
    }
  });

  app.post("/plans/:id/drafts/:draftId/abandon", async (request, reply) => {
    const params = request.params as { id: string; draftId: string };
    const profileId = positiveId(params.id);
    const draftId = positiveId(params.draftId);
    if (profileId == null || draftId == null) return invalidRequest(reply);
    try {
      const parsed = parseAbandonPlanDraftRequest(request.body);
      const result = service.abandon({ profileId, draftId, request: parsed });
      if (result.kind === "ready") return result.draft;
      return sendFailure(reply, result);
    } catch (error) {
      if (isPlanDraftContractError(error)) return invalidRequest(reply);
      request.log.error({ failure: "unexpected", profileId, draftId }, "Plan draft abandon failed");
      return reply.status(500).send({ detail: "Plan draft update failed", code: "internal_error" });
    }
  });

  app.post("/plans/:id/drafts/:draftId/rebase", async (request, reply) => {
    const params = request.params as { id: string; draftId: string };
    const profileId = positiveId(params.id);
    const draftId = positiveId(params.draftId);
    const key = idempotencyKey(request);
    if (profileId == null || draftId == null || key == null) return invalidRequest(reply);
    try {
      const parsed = parseRebasePlanDraftRequest(request.body);
      return sendWorkspaceResult(reply, service.rebase({
        profileId,
        draftId,
        actorId: actorId(request),
        idempotencyKey: key,
        request: parsed,
      }));
    } catch (error) {
      if (isPlanDraftContractError(error)) return invalidRequest(reply);
      request.log.error({ failure: "unexpected", profileId, draftId }, "Plan draft rebase failed");
      return reply.status(500).send({ detail: "Plan draft update failed", code: "internal_error" });
    }
  });

  app.post("/plans/:id/progress/import", async (request, reply) => {
    const profileId = positiveId((request.params as { id: string }).id);
    if (profileId == null) return invalidRequest(reply);
    try {
      const parsed = parseAcceptedProgressImportRequest(request.body);
      if (parsed.expected.profile_id !== profileId) {
        return reply.status(404).send({ detail: "Plan or Part not found", code: "progress_target_not_found" });
      }
      const result = deps.repo.setAcceptedPrintedCounts({
        expected: {
          profileId: parsed.expected.profile_id,
          planVersion: parsed.expected.plan_version,
          revisionId: parsed.expected.plan_revision_id,
          revisionDigest: parsed.expected.plan_revision_digest,
          requiredUnitMappingDigest: parsed.expected.required_unit_mapping_digest,
        },
        rows: parsed.rows.map((row) => ({
          partId: row.part_id,
          printedCount: row.printed_count,
        })),
      });
      switch (result.kind) {
        case "updated":
          return { updated_parts: result.updatedParts };
        case "part_not_found":
        case "unit_not_found":
          return reply.status(404).send({ detail: "Plan or Part not found", code: "progress_target_not_found" });
        case "invalid_rows":
          return reply.status(422).send({ detail: "Printed counts are invalid", code: result.kind });
        case "stale_accepted_plan":
          return reply.status(409).send({ detail: "Accepted Plan changed; reload and retry", code: result.kind });
        case "accepted_state_unavailable":
          return reply.status(409).send({ detail: "Accepted Plan state is unavailable", code: result.kind });
        case "plan_archived":
          return reply.status(409).send({ detail: "Archived Plan Progress cannot be changed", code: result.kind });
        case "transaction_unavailable":
          return reply.status(503).send({ detail: "Plan draft update is unavailable", code: result.kind });
      }
    } catch (error) {
      if (isPlanDraftContractError(error)) return invalidRequest(reply);
      request.log.error({ failure: "unexpected", profileId }, "Accepted Progress import failed");
      return reply.status(500).send({ detail: "Accepted Progress import failed", code: "internal_error" });
    }
  });
}
