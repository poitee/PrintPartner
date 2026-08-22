import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  isPlanDraftContractError,
  parseAbandonPlanDraftRequest,
  parseAcceptedProgressImportRequest,
  parseApplyPlanDraftRequest,
  parseEditPlanDraftPartsRequest,
  parseReconcilePlanDraftRequest,
  parseRebasePlanDraftRequest,
} from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import {
  PlanDraftWorkspaceService,
  type ApplyDraftWorkspaceResult,
  type PlanDraftWorkspaceResult,
} from "../services/plan-draft-workspace.js";

type RouteDeps = { readonly repo: AppRepository };

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
  const service = new PlanDraftWorkspaceService(deps.repo);

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
    const body = request.body as { apply_manifest?: unknown } | null;
    if (profileId == null || key == null || body?.apply_manifest !== true) {
      return invalidRequest(reply);
    }
    try {
      return sendWorkspaceResult(reply, service.recompute({
        profileId,
        actorId: actorId(request),
        idempotencyKey: key,
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
      const result = service.apply({
        profileId,
        draftId,
        actorId: actorId(request),
        idempotencyKey: key,
        request: parsed,
      });
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
