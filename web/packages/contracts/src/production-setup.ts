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

/**
 * How one Production work package turns Required units into physical results.
 *
 * The routes are not variations on one sequence. They differ in what they
 * produce, whether a printer is involved at all, and whether the work happens
 * inside PrintPartner or is being recorded after the fact.
 *
 * - `plates`:   prepare Plates for linked printers, export, slice, send.
 * - `stl`:      hand over the unit files. No Plates, no printers.
 * - `external`: the print already exists somewhere. Record it against
 *               Required units so Checkoff can verify it.
 *
 * Null means the operator has not chosen yet. There is deliberately no
 * default: pre-selecting a route would answer a question the operator has
 * not read.
 */
export const productionRouteSchema = z.enum(["plates", "stl", "external"]);

export type ProductionRoute = z.infer<typeof productionRouteSchema>;

export const productionSetupInputSchema = z.object({
  preferred_slicer_instance_id: z.string().trim().min(1).max(200).nullable(),
  selection: productionSelectionSchema,
  printer_assignments: z.array(productionPrinterAssignmentSchema).max(20_000).default([]),
  /** Null until the operator answers the route question. */
  route: productionRouteSchema.nullable().default(null),
  rules: z.array(productionGroupingRuleSchema).max(200),
});

export const productionSetupCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set_preferred_slicer_instance"),
    preferred_slicer_instance_id: productionSetupInputSchema.shape.preferred_slicer_instance_id,
  }).strict(),
  z.object({
    kind: z.literal("set_selection"),
    selection: productionSelectionSchema,
  }).strict(),
  z.object({
    kind: z.literal("replace_printer_assignments"),
    printer_assignments: z.array(productionPrinterAssignmentSchema).max(20_000),
  }).strict(),
  z.object({
    kind: z.literal("set_route"),
    route: productionRouteSchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal("replace_rules"),
    rules: z.array(productionGroupingRuleSchema).max(200),
  }).strict(),
]);

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
export type ProductionSetupCommand = z.infer<typeof productionSetupCommandSchema>;
export type ProductionSetup = z.infer<typeof productionSetupSchema>;

export function defaultProductionSetup(profileId: number): ProductionSetup {
  return {
    format: "production-setup-v1",
    profile_id: profileId,
    preferred_slicer_instance_id: null,
    selection: { mode: "all_incomplete" },
    printer_assignments: [],
    route: null,
    rules: [],
    updated_at: null,
  };
}
