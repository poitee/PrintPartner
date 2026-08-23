import { z } from "zod";

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveMicrometres = positiveSafeInteger.max(1_000_000_000);
const micrometres = nonnegativeSafeInteger.max(1_000_000_000);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const printerId = z.string().trim().min(1).max(200);
const boundedText = z.string().trim().min(1).max(500);
const requiredUnitToken = z.string().regex(/^ppu_[0-9a-f]{32}$/).brand<"RequiredUnitToken">();
const acceptedPlateId = z.string().regex(/^plate_[0-9a-f]{32}$/).brand<"AcceptedPlateId">();
const tenantExportUrl = z.string().regex(/^\/exports\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/);
const relativePath = z.string().min(1).max(1_000).refine((value) => {
  if (value.startsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
});

export type RequiredUnitToken = z.infer<typeof requiredUnitToken>;
export type AcceptedPlateId = z.infer<typeof acceptedPlateId>;

export const acceptedPlanBasisSchema = z.strictObject({
  profile_id: positiveSafeInteger,
  plan_version: positiveSafeInteger,
  plan_revision_id: positiveSafeInteger,
  plan_revision_digest: digest,
  required_unit_mapping_digest: digest,
});

export type AcceptedPlanBasisContract = z.infer<typeof acceptedPlanBasisSchema>;

export function parseAcceptedPlanBasis(value: unknown): AcceptedPlanBasisContract {
  return acceptedPlanBasisSchema.parse(value);
}

const acceptedPlatePrinterSchema = z.strictObject({
  id: printerId,
  name: boundedText,
  model: boundedText,
  bed_width_um: positiveMicrometres,
  bed_depth_um: positiveMicrometres,
  bed_height_um: positiveMicrometres,
  margin_um: micrometres,
}).superRefine((value, context) => {
  if (value.margin_um * 2 >= value.bed_width_um || value.margin_um * 2 >= value.bed_depth_um) {
    context.addIssue({ code: "custom", message: "Printer margin leaves no printable area" });
  }
});

export type AcceptedPlatePrinter = z.infer<typeof acceptedPlatePrinterSchema>;

const acceptedPlatePrinterListSchema = z.array(acceptedPlatePrinterSchema).superRefine((printers, context) => {
  const ids = new Set<string>();
  for (const [index, printer] of printers.entries()) {
    if (ids.has(printer.id)) {
      context.addIssue({ code: "custom", path: [index, "id"], message: "Duplicate Printer ID" });
    }
    ids.add(printer.id);
  }
});

const acceptedPlateSetupUnitSchema = z.strictObject({
  token: requiredUnitToken,
  part_id: positiveSafeInteger.nullable().optional(),
  object_name: z.string().min(1).max(200),
  filename: z.string().min(1).max(1_000),
  relative_path: z.string().max(4_096).default(""),
  source_directory: z.string().max(4_096).default(""),
  source_layer: z.string().max(500),
  role: z.string().max(200),
  filament_color_id: z.string().min(1).max(200).nullable(),
  filament_custom_hex: z.string().trim().max(100).nullable().optional(),
  filament_hex: z.string().trim().max(100).nullable().optional(),
  completed: z.boolean().default(false),
}).superRefine((value, context) => {
  if (!value.object_name.endsWith(`__${value.token}`)) {
    context.addIssue({ code: "custom", path: ["object_name"], message: "Object name does not match its token" });
  }
});

export type AcceptedPlateSetupUnit = z.infer<typeof acceptedPlateSetupUnitSchema>;

const acceptedPlateSetupUnitListSchema = z.array(acceptedPlateSetupUnitSchema).superRefine((units, context) => {
  const tokens = new Set<string>();
  for (const [index, unit] of units.entries()) {
    if (tokens.has(unit.token)) {
      context.addIssue({ code: "custom", path: [index, "token"], message: "Duplicate Required-unit token" });
    }
    tokens.add(unit.token);
  }
});

const acceptedPlatePlacedUnitSchema = acceptedPlateSetupUnitSchema.safeExtend({
  x_um: micrometres,
  y_um: micrometres,
  width_um: positiveMicrometres,
  depth_um: positiveMicrometres,
  height_um: positiveMicrometres,
  placement: z.enum(["auto", "manual"]).default("auto"),
  pinned: z.boolean().default(false),
});

export type AcceptedPlatePlacedUnit = z.infer<typeof acceptedPlatePlacedUnitSchema>;

const acceptedPlateUnplacedUnitSchema = acceptedPlateSetupUnitSchema.safeExtend({
  plate_id: acceptedPlateId,
  printer_id: printerId,
  width_um: positiveMicrometres,
  depth_um: positiveMicrometres,
  height_um: positiveMicrometres,
});

export type AcceptedPlateUnplacedUnit = z.infer<typeof acceptedPlateUnplacedUnitSchema>;

const acceptedPlateViewSchema = z.strictObject({
  plate_id: acceptedPlateId,
  ordinal: positiveSafeInteger,
  printer: acceptedPlatePrinterSchema,
  units: z.array(acceptedPlatePlacedUnitSchema),
}).superRefine((value, context) => {
  const tokens = new Set<string>();
  for (const [index, unit] of value.units.entries()) {
    if (tokens.has(unit.token)) {
      context.addIssue({ code: "custom", path: ["units", index, "token"], message: "Duplicate Required-unit token" });
    }
    tokens.add(unit.token);
    const minimum = value.printer.margin_um;
    const maximumX = value.printer.bed_width_um - value.printer.margin_um;
    const maximumY = value.printer.bed_depth_um - value.printer.margin_um;
    if (
      unit.x_um < minimum ||
      unit.y_um < minimum ||
      unit.x_um + unit.width_um > maximumX ||
      unit.y_um + unit.depth_um > maximumY ||
      unit.height_um > value.printer.bed_height_um
    ) {
      context.addIssue({ code: "custom", path: ["units", index], message: "Unit is outside captured printable bounds" });
    }
  }
});

export type AcceptedPlateView = z.infer<typeof acceptedPlateViewSchema>;

const emptyWorkspaceSchema = z.strictObject({ kind: z.literal("empty_plan") });
const setupWorkspaceSchema = z.strictObject({
  kind: z.literal("setup"),
  basis: acceptedPlanBasisSchema,
  expected_plate_revision_id: positiveSafeInteger.nullable(),
  printers: acceptedPlatePrinterListSchema,
  units: acceptedPlateSetupUnitListSchema,
});
const readyWorkspaceSchema = z.strictObject({
  kind: z.literal("ready"),
  basis: acceptedPlanBasisSchema,
  plate_revision_id: positiveSafeInteger,
  plate_revision_number: positiveSafeInteger,
  arrange_undo_revision_id: positiveSafeInteger.nullable().default(null),
  printers: acceptedPlatePrinterListSchema,
  plates: z.array(acceptedPlateViewSchema).min(1),
  unplaced: z.array(acceptedPlateUnplacedUnitSchema).default([]),
  unassigned: acceptedPlateSetupUnitListSchema.default([]),
}).superRefine((value, context) => {
  const plateIds = new Set<string>();
  const ordinals = new Set<number>();
  const tokens = new Set<string>();
  for (const [plateIndex, plate] of value.plates.entries()) {
    if (plateIds.has(plate.plate_id)) {
      context.addIssue({ code: "custom", path: ["plates", plateIndex, "plate_id"], message: "Duplicate Plate ID" });
    }
    if (ordinals.has(plate.ordinal)) {
      context.addIssue({ code: "custom", path: ["plates", plateIndex, "ordinal"], message: "Duplicate Plate ordinal" });
    }
    plateIds.add(plate.plate_id);
    ordinals.add(plate.ordinal);
    for (const [unitIndex, unit] of plate.units.entries()) {
      if (tokens.has(unit.token)) {
        context.addIssue({ code: "custom", path: ["plates", plateIndex, "units", unitIndex, "token"], message: "Duplicate Required-unit token" });
      }
      tokens.add(unit.token);
    }
  }
  for (let ordinal = 1; ordinal <= value.plates.length; ordinal += 1) {
    if (!ordinals.has(ordinal)) {
      context.addIssue({ code: "custom", path: ["plates"], message: "Plate ordinals must be contiguous" });
      break;
    }
  }
  for (const [index, unit] of value.unplaced.entries()) {
    if (tokens.has(unit.token)) {
      context.addIssue({ code: "custom", path: ["unplaced", index, "token"], message: "Duplicate Required-unit token" });
    }
    tokens.add(unit.token);
    if (!plateIds.has(unit.plate_id)) {
      context.addIssue({ code: "custom", path: ["unplaced", index, "plate_id"], message: "Unplaced unit Plate was not found" });
    }
  }
  for (const [index, unit] of value.unassigned.entries()) {
    if (tokens.has(unit.token)) {
      context.addIssue({
        code: "custom",
        path: ["unassigned", index, "token"],
        message: "Duplicate Required-unit token",
      });
    }
    tokens.add(unit.token);
  }
});

const acceptedPlateWorkspaceSchema = z.discriminatedUnion("kind", [
  emptyWorkspaceSchema,
  setupWorkspaceSchema,
  readyWorkspaceSchema,
]);

export type AcceptedPlateWorkspace = z.infer<typeof acceptedPlateWorkspaceSchema>;

const assignmentSchema = z.strictObject({
  token: requiredUnitToken,
  printer_id: printerId.nullable(),
});

const initializeAcceptedPlatesRequestSchema = z.strictObject({
  expected: acceptedPlanBasisSchema,
  expected_plate_revision_id: positiveSafeInteger.nullable(),
  assignments: z.array(assignmentSchema),
}).superRefine((value, context) => {
  const tokens = new Set<string>();
  for (const [index, assignment] of value.assignments.entries()) {
    if (tokens.has(assignment.token)) {
      context.addIssue({ code: "custom", path: ["assignments", index, "token"], message: "Duplicate assignment token" });
    }
    tokens.add(assignment.token);
  }
});

export type InitializeAcceptedPlatesRequest = z.infer<typeof initializeAcceptedPlatesRequestSchema>;

const moveAcceptedPlateUnitRequestSchema = z.strictObject({
  expected: acceptedPlanBasisSchema,
  expected_plate_revision_id: positiveSafeInteger,
  x_um: micrometres,
  y_um: micrometres,
});

export type MoveAcceptedPlateUnitRequest = z.infer<typeof moveAcceptedPlateUnitRequestSchema>;

const pinAcceptedPlateUnitRequestSchema = z.strictObject({
  expected: acceptedPlanBasisSchema,
  expected_plate_revision_id: positiveSafeInteger,
  pinned: z.boolean(),
});

export type PinAcceptedPlateUnitRequest = z.infer<typeof pinAcceptedPlateUnitRequestSchema>;

const arrangeAcceptedPlatesRequestSchema = z.strictObject({
  expected: acceptedPlanBasisSchema,
  expected_plate_revision_id: positiveSafeInteger,
  mode: z.enum(["unplaced", "all"]),
});

export type ArrangeAcceptedPlatesRequest = z.infer<typeof arrangeAcceptedPlatesRequestSchema>;

const restoreAcceptedPlatesRequestSchema = z.strictObject({
  expected: acceptedPlanBasisSchema,
  expected_plate_revision_id: positiveSafeInteger,
  restore_plate_revision_id: positiveSafeInteger,
});

export type RestoreAcceptedPlatesRequest = z.infer<typeof restoreAcceptedPlatesRequestSchema>;

const unplaceAcceptedPlateUnitRequestSchema = z.strictObject({
  expected: acceptedPlanBasisSchema,
  expected_plate_revision_id: positiveSafeInteger,
});

export type UnplaceAcceptedPlateUnitRequest = z.infer<typeof unplaceAcceptedPlateUnitRequestSchema>;

const transferRequestCommon = {
  expected: acceptedPlanBasisSchema,
  expected_plate_revision_id: positiveSafeInteger,
};

const transferAcceptedPlateUnitRequestSchema = z.union([
  z.strictObject({ ...transferRequestCommon, target_plate_id: acceptedPlateId }),
  z.strictObject({ ...transferRequestCommon, target_printer_id: printerId }),
]);

export type TransferAcceptedPlateUnitRequest = z.infer<typeof transferAcceptedPlateUnitRequestSchema>;

const acceptedPlateMoveReceiptSchema = z.strictObject({
  plate_revision_id: positiveSafeInteger,
  plate_revision_number: positiveSafeInteger,
});

export type AcceptedPlateMoveReceipt = z.infer<typeof acceptedPlateMoveReceiptSchema>;

const startAcceptedPlateExportRequestSchema = z.strictObject({
  profile_id: positiveSafeInteger,
  expected_plate_revision_id: positiveSafeInteger,
});

export type StartAcceptedPlateExportRequest = z.infer<typeof startAcceptedPlateExportRequestSchema>;

const startDirectExportRequestSchema = z.strictObject({
  profile_id: positiveSafeInteger,
  tokens: z.array(requiredUnitToken).min(1),
});

export type StartDirectExportRequest = z.infer<typeof startDirectExportRequestSchema>;

const directExportJobResultSchema = z.strictObject({
  format: z.literal("direct-export-3mf-job-v1"),
  profile_id: positiveSafeInteger,
  basis: acceptedPlanBasisSchema,
  download_url: tenantExportUrl,
  filename: z.string().regex(/^[^/\\]{1,255}$/),
  tokens: z.array(requiredUnitToken).min(1),
}).superRefine((value, context) => {
  if (value.profile_id !== value.basis.profile_id) {
    context.addIssue({
      code: "custom",
      path: ["profile_id"],
      message: "Direct export result basis belongs to another Build",
    });
  }
});

export type DirectExportJobResult = z.infer<typeof directExportJobResultSchema>;

const acceptedPlateExportJobResultSchema = z.strictObject({
  format: z.literal("accepted-plate-export-job-v1"),
  profile_id: positiveSafeInteger,
  basis: acceptedPlanBasisSchema,
  plate_revision_id: positiveSafeInteger,
  plate_revision_number: positiveSafeInteger,
  layout_digest: digest,
  download_url: tenantExportUrl,
  manifest_download_url: tenantExportUrl,
  bundle_download_url: tenantExportUrl,
  plates: z.array(z.strictObject({
    plate_id: acceptedPlateId,
    ordinal: positiveSafeInteger,
    filename: z.string().regex(/^[^/\\]{1,255}$/),
    download_url: tenantExportUrl,
  })).min(1),
}).superRefine((value, context) => {
  if (value.profile_id !== value.basis.profile_id) {
    context.addIssue({ code: "custom", path: ["profile_id"], message: "Export result basis belongs to another Build" });
  }
  const plateIds = new Set<string>();
  const ordinals = new Set<number>();
  for (const [index, plate] of value.plates.entries()) {
    if (plateIds.has(plate.plate_id) || ordinals.has(plate.ordinal)) {
      context.addIssue({ code: "custom", path: ["plates", index], message: "Duplicate exported Plate identity" });
    }
    plateIds.add(plate.plate_id);
    ordinals.add(plate.ordinal);
  }
  for (let ordinal = 1; ordinal <= value.plates.length; ordinal += 1) {
    if (!ordinals.has(ordinal)) {
      context.addIssue({ code: "custom", path: ["plates"], message: "Exported Plate ordinals must be contiguous" });
      break;
    }
  }
});

export type AcceptedPlateExportJobResult = z.infer<typeof acceptedPlateExportJobResultSchema>;

const acceptedPlateSlicerHandoffRequestSchema = startAcceptedPlateExportRequestSchema;
export type AcceptedPlateSlicerHandoffRequest = z.infer<typeof acceptedPlateSlicerHandoffRequestSchema>;

const acceptedPlateSlicerHandoffResultSchema = z.strictObject({
  gui_url: z.url({ protocol: /^https?$/ }),
  plate_revision_id: positiveSafeInteger,
  plate_revision_number: positiveSafeInteger,
  layout_digest: digest,
  inbox_relative_path: relativePath,
  staged: z.array(z.strictObject({
    ordinal: positiveSafeInteger,
    filename: z.string().regex(/^[^/\\]{1,255}$/),
  })).min(1),
  download_url: tenantExportUrl,
  local_app: z.strictObject({
    scheme_attempt: z.null(),
    note: z.string().min(1).max(500),
  }),
});

export type AcceptedPlateSlicerHandoffResult = z.infer<typeof acceptedPlateSlicerHandoffResultSchema>;

const acceptedPlateSlicerExchangeStatusSchema = z.discriminatedUnion("code", [
  z.strictObject({ ready: z.literal(true), code: z.literal("ready") }),
  z.strictObject({ ready: z.literal(false), code: z.literal("not_configured") }),
  z.strictObject({ ready: z.literal(false), code: z.literal("unavailable") }),
]);

export type AcceptedPlateSlicerExchangeStatus = z.infer<typeof acceptedPlateSlicerExchangeStatusSchema>;

const acceptedPlateEndpointErrorCodes = [
  "invalid_request",
  "profile_not_found",
  "slicer_instance_not_found",
  "slicer_instance_disabled",
  "invalid_slicer_gui_url",
  "slicer_exchange_unavailable",
  "plate_revision_changed",
  "unplaced_units",
  "accepted_plan_changed",
  "accepted_state_unavailable",
  "accepted_artifact_unavailable",
  "limit_exceeded",
  "accepted_plate_update_unavailable",
  "output_conflict",
  "internal_error",
  "missing_assignment",
  "duplicate_assignment",
  "unknown_unit_token",
  "unassigned_units",
  "printer_not_found",
  "missing_printer_geometry",
  "unit_too_large",
  "unit_not_found",
  "invalid_stl",
  "degenerate_geometry",
  "plan_archived",
  "invalid_units",
  "outside_build_area",
  "overlapping_units",
  "artifact_geometry_mismatch",
  "legacy",
  "untracked_source",
  "missing",
  "not_file",
  "outside_snapshot",
  "changed",
  "oversized",
] as const;

export type AcceptedPlateEndpointErrorCode = typeof acceptedPlateEndpointErrorCodes[number];

const endpointStatuses: Readonly<Record<AcceptedPlateEndpointErrorCode, readonly number[]>> = {
  invalid_request: [400],
  profile_not_found: [404],
  slicer_instance_not_found: [404],
  slicer_instance_disabled: [400],
  invalid_slicer_gui_url: [400],
  slicer_exchange_unavailable: [400, 503],
  plate_revision_changed: [409],
  unplaced_units: [409],
  accepted_plan_changed: [409],
  accepted_state_unavailable: [409],
  accepted_artifact_unavailable: [409, 422],
  limit_exceeded: [413, 422],
  accepted_plate_update_unavailable: [503],
  output_conflict: [409],
  internal_error: [500],
  missing_assignment: [422],
  duplicate_assignment: [422],
  unknown_unit_token: [422],
  unassigned_units: [422],
  printer_not_found: [422],
  missing_printer_geometry: [422],
  unit_too_large: [422],
  unit_not_found: [422],
  invalid_stl: [409, 422],
  degenerate_geometry: [422],
  plan_archived: [409],
  invalid_units: [422],
  outside_build_area: [422],
  overlapping_units: [422],
  artifact_geometry_mismatch: [422],
  legacy: [409, 422],
  untracked_source: [409, 422],
  missing: [409, 422],
  not_file: [409, 422],
  outside_snapshot: [409, 422],
  changed: [409, 422],
  oversized: [409, 422],
};
export type AcceptedPlateEndpointError = Readonly<{
  code: AcceptedPlateEndpointErrorCode;
  token?: RequiredUnitToken;
  tokens?: readonly RequiredUnitToken[];
  printer_id?: string;
  printer_ids?: readonly string[];
  limit?: "objects" | "source_bytes" | "triangles" | "output_bytes";
}>;

const rawEndpointErrorSchema = z.looseObject({
  code: z.enum(acceptedPlateEndpointErrorCodes),
  token: requiredUnitToken.optional(),
  tokens: z.array(requiredUnitToken).optional(),
  printer_id: printerId.optional(),
  printer_ids: z.array(printerId).optional(),
  limit: z.enum(["objects", "source_bytes", "triangles", "output_bytes"]).optional(),
});

const acceptedPlateExportRecordSchema = z.strictObject({
  job_id: z.string().min(1).max(200),
  kind: z.literal("export-accepted-plate-3mf"),
  status: z.enum(["pending", "running", "done", "error", "cancelled"]),
  message: z.string(),
  progress: z.number().nullable(),
  result: acceptedPlateExportJobResultSchema.nullable(),
  error: z.string().nullable(),
  finished_at: z.iso.datetime().nullable().optional(),
  updated_at: z.iso.datetime().optional(),
}).superRefine((value, context) => {
  if (value.status === "done" && value.result === null) {
    context.addIssue({ code: "custom", path: ["result"], message: "Completed accepted export has no result" });
  }
  if (value.status !== "done" && value.result !== null) {
    context.addIssue({ code: "custom", path: ["result"], message: "Incomplete accepted export has a result" });
  }
});

export type AcceptedPlateExportRecord = z.infer<typeof acceptedPlateExportRecordSchema>;

export function parseAcceptedPlateWorkspace(value: unknown): AcceptedPlateWorkspace {
  return acceptedPlateWorkspaceSchema.parse(value);
}

export function parseRequiredUnitTokenContract(value: unknown): RequiredUnitToken {
  return requiredUnitToken.parse(value);
}

export function parseAcceptedPlateId(value: unknown): AcceptedPlateId {
  return acceptedPlateId.parse(value);
}

export function parseInitializeAcceptedPlatesRequest(value: unknown): InitializeAcceptedPlatesRequest {
  return initializeAcceptedPlatesRequestSchema.parse(value);
}

export function parseMoveAcceptedPlateUnitRequest(value: unknown): MoveAcceptedPlateUnitRequest {
  return moveAcceptedPlateUnitRequestSchema.parse(value);
}

export function parsePinAcceptedPlateUnitRequest(value: unknown): PinAcceptedPlateUnitRequest {
  return pinAcceptedPlateUnitRequestSchema.parse(value);
}

export function parseArrangeAcceptedPlatesRequest(value: unknown): ArrangeAcceptedPlatesRequest {
  return arrangeAcceptedPlatesRequestSchema.parse(value);
}

export function parseRestoreAcceptedPlatesRequest(value: unknown): RestoreAcceptedPlatesRequest {
  return restoreAcceptedPlatesRequestSchema.parse(value);
}

export function parseUnplaceAcceptedPlateUnitRequest(value: unknown): UnplaceAcceptedPlateUnitRequest {
  return unplaceAcceptedPlateUnitRequestSchema.parse(value);
}

export function parseTransferAcceptedPlateUnitRequest(value: unknown): TransferAcceptedPlateUnitRequest {
  return transferAcceptedPlateUnitRequestSchema.parse(value);
}

export function parseAcceptedPlateMoveReceipt(value: unknown): AcceptedPlateMoveReceipt {
  return acceptedPlateMoveReceiptSchema.parse(value);
}

export function parseStartAcceptedPlateExportRequest(value: unknown): StartAcceptedPlateExportRequest {
  return startAcceptedPlateExportRequestSchema.parse(value);
}

export function parseStartDirectExportRequest(value: unknown): StartDirectExportRequest {
  return startDirectExportRequestSchema.parse(value);
}

export function parseDirectExportJobResult(value: unknown): DirectExportJobResult {
  return directExportJobResultSchema.parse(value);
}

export function parseAcceptedPlateExportJobResult(value: unknown): AcceptedPlateExportJobResult {
  return acceptedPlateExportJobResultSchema.parse(value);
}

export function parseAcceptedPlateSlicerHandoffRequest(value: unknown): AcceptedPlateSlicerHandoffRequest {
  return acceptedPlateSlicerHandoffRequestSchema.parse(value);
}

export function parseAcceptedPlateSlicerHandoffResult(value: unknown): AcceptedPlateSlicerHandoffResult {
  return acceptedPlateSlicerHandoffResultSchema.parse(value);
}

export function parseAcceptedPlateSlicerExchangeStatus(value: unknown): AcceptedPlateSlicerExchangeStatus {
  return acceptedPlateSlicerExchangeStatusSchema.parse(value);
}

export function parseAcceptedPlateEndpointError(value: unknown, status: number): AcceptedPlateEndpointError {
  const parsed = rawEndpointErrorSchema.parse(value);
  const code = parsed.code;
  const statuses: readonly number[] = endpointStatuses[code];
  if (!statuses.includes(status)) throw new Error("Accepted Plate error status does not match its code");
  return {
    code,
    ...(parsed.token === undefined ? {} : { token: parsed.token }),
    ...(parsed.tokens === undefined ? {} : { tokens: parsed.tokens }),
    ...(parsed.printer_id === undefined ? {} : { printer_id: parsed.printer_id }),
    ...(parsed.printer_ids === undefined ? {} : { printer_ids: parsed.printer_ids }),
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
  };
}

export function parseAcceptedPlateExportJobList(
  value: unknown,
  profileId: number,
): readonly AcceptedPlateExportRecord[] {
  const id = positiveSafeInteger.parse(profileId);
  const envelope = z.strictObject({ jobs: z.array(z.unknown()) }).parse(value);
  const records: AcceptedPlateExportRecord[] = [];
  for (const job of envelope.jobs) {
    if (typeof job !== "object" || job === null || !("kind" in job)) continue;
    if (job.kind !== "export-accepted-plate-3mf") continue;
    const record = acceptedPlateExportRecordSchema.parse(job);
    if (record.result !== null && record.result.profile_id !== id) {
      throw new Error("Accepted Plate export belongs to another Build");
    }
    records.push(record);
  }
  return records;
}
