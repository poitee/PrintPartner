import { z } from "zod";
import { acceptedPlanBasisSchema, type ReviewPart } from "@print-partner/contracts";

const positiveInteger = z.number().int().positive();
const nonnegativeInteger = z.number().int().nonnegative();
const nullableString = z.string().nullable();

const reviewPartSchema: z.ZodType<ReviewPart> = z.object({
  id: positiveInteger,
  match_key: z.string(),
  relative_path: z.string(),
  filename: z.string(),
  source_layer: nullableString,
  status: z.string(),
  role: nullableString,
  requirement: nullableString,
  option_group_id: nullableString,
  included: z.boolean(),
  filament_color_id: nullableString,
  filament_custom_hex: nullableString.optional(),
  spoolman_spool_id: nullableString.optional(),
  filament_display: z.string(),
  filament_hex: nullableString.optional(),
  quantity_auto: nonnegativeInteger,
  quantity_override: nonnegativeInteger.nullable(),
  quantity_effective: nonnegativeInteger,
  print_units: z.array(z.boolean()),
  printed_count: nonnegativeInteger,
  assembled_units: z.array(z.boolean()).optional(),
  missing: z.boolean(),
  stl_missing: z.boolean().optional(),
  thumb_empty: z.boolean().optional(),
  spool_summary: z.array(z.object({ remaining_g: z.number(), spool_id: z.number() }).passthrough()).optional(),
  spool_badge: nullableString.optional(),
}).passthrough();

const reviewIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(["blocker", "warning"]),
  link_hint: z.enum(["sources", "build"]).nullable().optional(),
}).passthrough();
const reviewLayerSchema = z.object({
  id: positiveInteger,
  layer_type: z.string(),
  project_id: positiveInteger.nullable(),
  project_name: nullableString,
  local_path: nullableString,
  synced: z.boolean(),
  last_synced_at: nullableString,
}).passthrough();
const reviewTotalsSchema = z.object({
  included_parts: nonnegativeInteger,
  total_print_units: nonnegativeInteger,
  by_role: z.record(z.string(), nonnegativeInteger),
  by_filament: z.record(z.string(), nonnegativeInteger),
}).passthrough();
const reviewPartGroupSchema = z.object({
  folder: z.string(),
  source_layer: nullableString,
  parts: z.array(reviewPartSchema),
}).passthrough();
const planReviewSchema = z.object({
  profile_id: positiveInteger,
  accepted_basis: acceptedPlanBasisSchema.nullable(),
  plan_name: z.string(),
  layers: z.array(reviewLayerSchema),
  totals: reviewTotalsSchema,
  issues: z.array(reviewIssueSchema),
  has_blockers: z.boolean(),
  part_groups: z.array(reviewPartGroupSchema),
}).passthrough();

export type PlanReviewIssue = z.infer<typeof reviewIssueSchema>;
export type PlanReviewPartGroup = z.infer<typeof reviewPartGroupSchema>;
export type PlanReview = z.infer<typeof planReviewSchema>;

export function parsePlanReview(value: unknown, profileId: number): PlanReview {
  const parsed = planReviewSchema.safeParse(value);
  if (!parsed.success || parsed.data.profile_id !== profileId ||
      (parsed.data.accepted_basis !== null && parsed.data.accepted_basis.profile_id !== profileId)) {
    throw new Error("The Build Review response is incomplete or belongs to a different Build");
  }
  return parsed.data;
}
