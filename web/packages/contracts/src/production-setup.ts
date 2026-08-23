import { z } from "zod";

export const productionGroupingFieldSchema = z.enum([
  "material",
  "color",
  "source_directory",
  "source_layer",
  "role",
  "part",
]);
const productionMatchFieldSchema = z.enum([
  "color",
  "source_directory",
  "source_layer",
  "role",
  "part",
]);

const ruleBaseSchema = z.object({
  id: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
});

export const productionGroupingRuleSchema = z.discriminatedUnion("kind", [
  ruleBaseSchema.extend({
    kind: z.literal("separate_by"),
    field: productionGroupingFieldSchema,
  }),
  ruleBaseSchema.extend({
    kind: z.literal("keep_together"),
    field: productionGroupingFieldSchema,
    value: z.string().trim().min(1).max(500),
  }),
  ruleBaseSchema.extend({
    kind: z.literal("assign_to_printer"),
    field: productionGroupingFieldSchema,
    value: z.string().trim().min(1).max(500),
    printer_id: z.string().trim().min(1).max(200),
  }),
  ruleBaseSchema.extend({
    kind: z.literal("set_material"),
    field: productionMatchFieldSchema,
    value: z.string().trim().min(1).max(500),
    material_type: z.string().trim().min(1).max(100),
  }),
]);

export const productionSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all_incomplete") }),
  z.object({
    mode: z.literal("custom"),
    selected_unit_tokens: z.array(z.string().trim().min(1).max(500)).max(20_000),
  }),
]);

export const productionPrinterAssignmentSchema = z.object({
  token: z.string().trim().min(1).max(500),
  printer_id: z.string().trim().min(1).max(200),
});

export const productionSetupInputSchema = z.object({
  preferred_slicer_instance_id: z.string().trim().min(1).max(200).nullable(),
  selection: productionSelectionSchema,
  printer_assignments: z.array(productionPrinterAssignmentSchema).max(20_000).default([]),
  rules: z.array(productionGroupingRuleSchema).max(200),
});

export const productionSetupSchema = productionSetupInputSchema.extend({
  format: z.literal("production-setup-v1"),
  profile_id: z.number().int().positive(),
  updated_at: z.string().datetime().nullable(),
});

export type ProductionGroupingField = z.infer<typeof productionGroupingFieldSchema>;
export type ProductionGroupingRule = z.infer<typeof productionGroupingRuleSchema>;
export type ProductionSelection = z.infer<typeof productionSelectionSchema>;
export type ProductionPrinterAssignment = z.infer<typeof productionPrinterAssignmentSchema>;
export type ProductionSetupInput = z.infer<typeof productionSetupInputSchema>;
export type ProductionSetup = z.infer<typeof productionSetupSchema>;

export function defaultProductionSetup(profileId: number): ProductionSetup {
  return {
    format: "production-setup-v1",
    profile_id: profileId,
    preferred_slicer_instance_id: null,
    selection: { mode: "all_incomplete" },
    printer_assignments: [],
    rules: [],
    updated_at: null,
  };
}
