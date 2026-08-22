import { z } from "zod";
import { acceptedPlanBasisSchema } from "./accepted-plates.js";

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeVersion = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);

export const planDraftBasisSchema = z.strictObject({
  revision_id: positiveId.nullable(),
  plan_version: nonnegativeVersion,
}).superRefine((value, context) => {
  if (
    (value.revision_id == null && value.plan_version !== 0) ||
    (value.revision_id != null && value.plan_version === 0)
  ) {
    context.addIssue({ code: "custom", message: "Accepted Plan base is inconsistent" });
  }
});

export type PlanDraftBasis = z.infer<typeof planDraftBasisSchema>;

const planDraftIdentitySchema = z.strictObject({
  draft_id: positiveId,
  state: z.enum(["open", "abandoned", "consumed"]),
  lifecycle_version: nonnegativeVersion,
  snapshot_digest: digest,
  base: planDraftBasisSchema,
});

export type PlanDraftIdentity = z.infer<typeof planDraftIdentitySchema>;

const planDraftPartViewSchema = z.strictObject({
  draft_part_id: positiveId,
  base_revision_part_id: positiveId.nullable(),
  part_key: z.string().min(1).max(4_096),
  filename: z.string().min(1).max(1_000),
  relative_path: z.string().min(1).max(4_096),
  source_layer: z.string().max(1_000),
  role: z.string().max(200),
  quantity_inferred: positiveId.max(10_000),
  quantity_override: positiveId.max(10_000).nullable(),
  quantity_effective: positiveId.max(10_000),
  included: z.boolean(),
});

export type PlanDraftPartView = z.infer<typeof planDraftPartViewSchema>;

const acceptedPartReferenceSchema = z.strictObject({
  revision_part_id: positiveId,
  filename: z.string().min(1).max(1_000),
  relative_path: z.string().min(1).max(4_096),
  source_layer: z.string().max(1_000),
});

const planDraftPartChangeSchema = z.strictObject({
  before: acceptedPartReferenceSchema,
  after: planDraftPartViewSchema,
  fields: z.array(z.string().min(1).max(100)),
});

const reconciliationConflictSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ambiguous_exact_match"),
    target_draft_part_id: positiveId,
    candidate_revision_part_ids: z.array(positiveId).min(2),
  }),
  z.strictObject({
    kind: z.enum(["unsafe_predecessor", "predecessor_claimed"]),
    target_draft_part_id: positiveId,
    predecessor_revision_part_id: positiveId,
  }),
]);

const reconciliationViewSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ready"),
    reused_units: nonnegativeVersion,
    new_units: nonnegativeVersion,
    surplus_units: nonnegativeVersion,
  }),
  z.strictObject({
    kind: z.literal("unresolved"),
    conflicts: z.array(reconciliationConflictSchema),
  }),
]);

const planDraftWorkspaceSchema = z.strictObject({
  profile_id: positiveId,
  draft: planDraftIdentitySchema,
  parts: z.array(planDraftPartViewSchema),
  diff: z.strictObject({
    base_is_current: z.boolean(),
    added: z.array(planDraftPartViewSchema),
    removed: z.array(acceptedPartReferenceSchema),
    changed: z.array(planDraftPartChangeSchema),
  }),
  reconciliation: reconciliationViewSchema,
});

export type PlanDraftWorkspace = z.infer<typeof planDraftWorkspaceSchema>;

const uniquePartIds = z.array(positiveId).min(1).superRefine((ids, context) => {
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Plan draft Part targets must be unique" });
  }
});

const planDraftPartDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("set_included"),
    draft_part_ids: uniquePartIds,
    value: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("set_quantity_override"),
    draft_part_ids: uniquePartIds,
    value: positiveId.max(10_000).nullable(),
  }),
]);

export type PlanDraftPartDecisionContract = z.infer<typeof planDraftPartDecisionSchema>;

const requiredUnitDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(["select_exact_predecessor", "accept_prior_completion"]),
    target_draft_part_id: positiveId,
    predecessor_revision_part_id: positiveId,
  }),
  z.strictObject({
    kind: z.literal("replace"),
    target_draft_part_id: positiveId,
  }),
]);

export type RequiredUnitDecisionContract = z.infer<typeof requiredUnitDecisionSchema>;

const batchEditPlanDraftPartsRequestSchema = z.strictObject({
  expected_snapshot_digest: digest,
  decisions: z.array(planDraftPartDecisionSchema).min(1).max(10_000),
}).superRefine((value, context) => {
  const targets = new Set<string>();
  for (const decision of value.decisions) {
    for (const partId of decision.draft_part_ids) {
      const target = `${decision.kind}:${partId}`;
      if (targets.has(target)) {
        context.addIssue({
          code: "custom",
          path: ["decisions"],
          message: "A Plan draft Part field may be edited only once per batch",
        });
        return;
      }
      targets.add(target);
    }
  }
});

const editPlanDraftPartsRequestSchema = z.union([
  z.strictObject({
    expected_snapshot_digest: digest,
    decision: planDraftPartDecisionSchema,
  }),
  batchEditPlanDraftPartsRequestSchema,
]);

export type EditPlanDraftPartsRequest = z.infer<typeof editPlanDraftPartsRequestSchema>;

const reconcilePlanDraftRequestSchema = z.strictObject({
  expected_snapshot_digest: digest,
  decisions: z.array(requiredUnitDecisionSchema).max(10_000),
}).superRefine((value, context) => {
  const targets = new Set<number>();
  for (const decision of value.decisions) {
    if (targets.has(decision.target_draft_part_id)) {
      context.addIssue({
        code: "custom",
        path: ["decisions"],
        message: "A Plan draft Part may be reconciled only once per request",
      });
      return;
    }
    targets.add(decision.target_draft_part_id);
  }
});

export type ReconcilePlanDraftRequest = z.infer<typeof reconcilePlanDraftRequestSchema>;

const applyPlanDraftRequestSchema = z.strictObject({
  expected_snapshot_digest: digest,
  expected_lifecycle_version: nonnegativeVersion,
  expected_base: planDraftBasisSchema,
  /** Remap production links by STL identity. Apply fails if any unit cannot be matched. */
  remap_checkoff_links: z.boolean().optional(),
});

export type ApplyPlanDraftRequest = z.infer<typeof applyPlanDraftRequestSchema>;

const applyPlanDraftReceiptSchema = z.strictObject({
  profile_id: positiveId,
  draft_id: positiveId,
  revision_id: positiveId,
  plan_version: positiveId,
  draft_lifecycle_version: positiveId,
  revision_digest: digest,
  required_unit_mapping_digest: digest,
  applied_at: z.string().min(1).max(100),
});

export type ApplyPlanDraftReceipt = z.infer<typeof applyPlanDraftReceiptSchema>;

const abandonPlanDraftRequestSchema = z.strictObject({
  expected_lifecycle_version: nonnegativeVersion,
});

export type AbandonPlanDraftRequest = z.infer<typeof abandonPlanDraftRequestSchema>;

const rebasePlanDraftRequestSchema = z.strictObject({
  expected_source_lifecycle_version: nonnegativeVersion,
  expected_source_snapshot_digest: digest,
});

export type RebasePlanDraftRequest = z.infer<typeof rebasePlanDraftRequestSchema>;

const acceptedProgressImportRequestSchema = z.strictObject({
  expected: acceptedPlanBasisSchema,
  rows: z.array(z.strictObject({
    part_id: positiveId,
    printed_count: nonnegativeVersion.max(10_000),
  })).min(1).max(10_000),
}).superRefine((value, context) => {
  const partIds = new Set<number>();
  for (const [index, row] of value.rows.entries()) {
    if (partIds.has(row.part_id)) {
      context.addIssue({
        code: "custom",
        path: ["rows", index, "part_id"],
        message: "Accepted Progress import Part targets must be unique",
      });
      return;
    }
    partIds.add(row.part_id);
  }
});

export type AcceptedProgressImportRequest = z.infer<typeof acceptedProgressImportRequestSchema>;

const acceptedProgressImportResponseSchema = z.strictObject({
  updated_parts: nonnegativeVersion.max(10_000),
});

export type AcceptedProgressImportResponse = z.infer<
  typeof acceptedProgressImportResponseSchema
>;

export function isPlanDraftContractError(error: unknown): boolean {
  return error instanceof z.ZodError;
}

export function parsePlanDraftWorkspace(value: unknown): PlanDraftWorkspace {
  return planDraftWorkspaceSchema.parse(value);
}

export function parseEditPlanDraftPartsRequest(value: unknown): EditPlanDraftPartsRequest {
  return editPlanDraftPartsRequestSchema.parse(value);
}

export function parseReconcilePlanDraftRequest(value: unknown): ReconcilePlanDraftRequest {
  return reconcilePlanDraftRequestSchema.parse(value);
}

export function parseApplyPlanDraftRequest(value: unknown): ApplyPlanDraftRequest {
  return applyPlanDraftRequestSchema.parse(value);
}

export function parseApplyPlanDraftReceipt(value: unknown): ApplyPlanDraftReceipt {
  return applyPlanDraftReceiptSchema.parse(value);
}

export function parsePlanDraftIdentity(value: unknown): PlanDraftIdentity {
  return planDraftIdentitySchema.parse(value);
}

export function parseAbandonPlanDraftRequest(value: unknown): AbandonPlanDraftRequest {
  return abandonPlanDraftRequestSchema.parse(value);
}

export function parseRebasePlanDraftRequest(value: unknown): RebasePlanDraftRequest {
  return rebasePlanDraftRequestSchema.parse(value);
}

export function parseAcceptedProgressImportRequest(value: unknown): AcceptedProgressImportRequest {
  return acceptedProgressImportRequestSchema.parse(value);
}

export function parseAcceptedProgressImportResponse(value: unknown): AcceptedProgressImportResponse {
  return acceptedProgressImportResponseSchema.parse(value);
}
