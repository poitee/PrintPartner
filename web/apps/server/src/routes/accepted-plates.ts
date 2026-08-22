import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppRepository } from "../db/repository.js";
import type { AcceptedPlanBasis } from "../db/accepted-plan-progress.js";
import { AcceptedPlateIntegrityError, MAX_ACCEPTED_PLATE_UM, type AcceptedPlateInput } from "../db/accepted-plates.js";
import { AcceptedPlanOperationalIntegrityError } from "../db/accepted-plan-operational.js";
import { ACCEPTED_PART_MESH_MAX_BYTES } from "../services/accepted-part-media.js";
import {
  acceptedPrinter,
  arrangeAcceptedPlates,
  initializeAcceptedPlates,
  readAcceptedPlateWorkspace,
  type AcceptedPlateWorkspaceDependencies,
  type InitializeAcceptedPlatesResult,
} from "../services/accepted-plate-workspace.js";
import { loadFleet } from "../services/printer-fleet.js";
import { parseRequiredUnitToken, type RequiredUnitToken } from "../services/required-units.js";

type RouteDependencies = Readonly<{
  repo: AppRepository;
  reposDir: string;
}>;

const WORKSPACE_LIMITS = {
  maxArtifactBytes: ACCEPTED_PART_MESH_MAX_BYTES,
  maxTotalSourceBytes: 256 * 1024 * 1024,
  maxObjects: 10_000,
  maxTriangles: 5_000_000,
} as const;

function serviceDependencies(dependencies: RouteDependencies): AcceptedPlateWorkspaceDependencies {
  return {
    repository: dependencies.repo,
    reposDir: dependencies.reposDir,
    limits: WORKSPACE_LIMITS,
    loadPrinters: () => loadFleet(dependencies.repo),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function plateCoordinate(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_ACCEPTED_PLATE_UM
    ? Number(value)
    : null;
}

function profileId(request: FastifyRequest): number | null {
  if (!isRecord(request.params)) return null;
  const value = request.params.id;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return positiveInteger(Number(value));
}

function parseBasis(value: unknown): AcceptedPlanBasis | null {
  if (!isRecord(value)) return null;
  const profileId = positiveInteger(value.profile_id);
  const planVersion = positiveInteger(value.plan_version);
  const revisionId = positiveInteger(value.plan_revision_id);
  const revisionDigest = value.plan_revision_digest;
  const mappingDigest = value.required_unit_mapping_digest;
  if (
    profileId == null ||
    planVersion == null ||
    revisionId == null ||
    typeof revisionDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(revisionDigest) ||
    typeof mappingDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(mappingDigest)
  ) return null;
  return {
    profileId,
    planVersion,
    revisionId,
    revisionDigest,
    requiredUnitMappingDigest: mappingDigest,
  };
}

function parseToken(value: unknown): RequiredUnitToken | null {
  if (typeof value !== "string") return null;
  try {
    return parseRequiredUnitToken(value);
  } catch {
    return null;
  }
}

function parseInitializeRequest(value: unknown): Readonly<{
  expected: AcceptedPlanBasis;
  expectedPlateRevisionId: number | null;
  assignments: readonly Readonly<{ token: RequiredUnitToken; printerId: string | null }>[];
}> | null {
  if (!isRecord(value) || !Array.isArray(value.assignments)) return null;
  const expected = parseBasis(value.expected);
  const expectedPlateRevisionId = value.expected_plate_revision_id === null
    ? null
    : positiveInteger(value.expected_plate_revision_id);
  if (!expected || expectedPlateRevisionId === null && value.expected_plate_revision_id !== null) {
    return null;
  }
  const assignments: Array<{ token: RequiredUnitToken; printerId: string | null }> = [];
  for (const raw of value.assignments) {
    if (!isRecord(raw)) return null;
    const token = parseToken(raw.token);
    const printerId = raw.printer_id === null
      ? null
      : typeof raw.printer_id === "string" && raw.printer_id.trim().length > 0 && raw.printer_id.trim().length <= 200
        ? raw.printer_id.trim()
        : undefined;
    if (!token || printerId === undefined) return null;
    assignments.push({ token, printerId });
  }
  return { expected, expectedPlateRevisionId, assignments };
}

function parseMoveRequest(value: unknown): Readonly<{
  expected: AcceptedPlanBasis;
  expectedPlateRevisionId: number;
  xUm: number;
  yUm: number;
}> | null {
  if (!isRecord(value)) return null;
  const expected = parseBasis(value.expected);
  const expectedPlateRevisionId = positiveInteger(value.expected_plate_revision_id);
  const xUm = plateCoordinate(value.x_um);
  const yUm = plateCoordinate(value.y_um);
  if (!expected || expectedPlateRevisionId == null || xUm == null || yUm == null) return null;
  return { expected, expectedPlateRevisionId, xUm, yUm };
}

function parseRevisionRequest(value: unknown): Readonly<{
  expected: AcceptedPlanBasis;
  expectedPlateRevisionId: number;
}> | null {
  if (!isRecord(value)) return null;
  const expected = parseBasis(value.expected);
  const expectedPlateRevisionId = positiveInteger(value.expected_plate_revision_id);
  return expected && expectedPlateRevisionId != null ? { expected, expectedPlateRevisionId } : null;
}

function parsePinRequest(value: unknown): Readonly<{
  expected: AcceptedPlanBasis;
  expectedPlateRevisionId: number;
  pinned: boolean;
}> | null {
  const revision = parseRevisionRequest(value);
  return revision && isRecord(value) && typeof value.pinned === "boolean"
    ? { ...revision, pinned: value.pinned }
    : null;
}

type TransferRequest = Readonly<{
  expected: AcceptedPlanBasis;
  expectedPlateRevisionId: number;
}> & (
  | Readonly<{ targetPlateId: string }>
  | Readonly<{ targetPrinterId: string }>
);

function parseTransferRequest(value: unknown): TransferRequest | null {
  const revision = parseRevisionRequest(value);
  if (!revision || !isRecord(value)) return null;
  const targetPlateId = typeof value.target_plate_id === "string" ? value.target_plate_id.trim() : null;
  const targetPrinterId = typeof value.target_printer_id === "string" ? value.target_printer_id.trim() : null;
  if ((targetPlateId === null) === (targetPrinterId === null)) return null;
  if (targetPlateId !== null) {
    return /^plate_[0-9a-f]{32}$/.test(targetPlateId) ? { ...revision, targetPlateId } : null;
  }
  return targetPrinterId && targetPrinterId.length <= 200
    ? { ...revision, targetPrinterId }
    : null;
}

function parseArrangeRequest(value: unknown): Readonly<{
  expected: AcceptedPlanBasis;
  expectedPlateRevisionId: number;
  mode: "unplaced" | "all";
}> | null {
  const revision = parseRevisionRequest(value);
  if (!revision || !isRecord(value) || (value.mode !== "unplaced" && value.mode !== "all")) return null;
  return { ...revision, mode: value.mode };
}

function parseRestoreRequest(value: unknown): Readonly<{
  expected: AcceptedPlanBasis;
  expectedPlateRevisionId: number;
  restorePlateRevisionId: number;
}> | null {
  const revision = parseRevisionRequest(value);
  if (!revision || !isRecord(value)) return null;
  const restorePlateRevisionId = positiveInteger(value.restore_plate_revision_id);
  return restorePlateRevisionId == null ? null : { ...revision, restorePlateRevisionId };
}

function fleetPrinterGeometry(
  repo: AppRepository,
  printerId: string,
): Omit<AcceptedPlateInput, "plateId" | "units"> | null {
  const machine = loadFleet(repo).find((candidate) => candidate.id === printerId);
  const printer = machine ? acceptedPrinter(machine) : null;
  return printer ? {
    printerId: printer.id,
    printerName: printer.name,
    printerModel: printer.model,
    bedWidthUm: printer.bed_width_um,
    bedDepthUm: printer.bed_depth_um,
    bedHeightUm: printer.bed_height_um,
    marginUm: printer.margin_um,
  } : null;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
  fields: Record<string, unknown> = {},
) {
  return reply.status(status).send({ detail, code, ...fields });
}

function sendReadFailure(reply: FastifyReply, result: Exclude<ReturnType<typeof readAcceptedPlateWorkspace>, { kind: "workspace" }>) {
  if (result.kind === "profile_not_found") {
    return sendError(reply, 404, "profile_not_found", "Plan not found");
  }
  if (result.kind === "transaction_unavailable") {
    return sendError(reply, 503, "accepted_plate_update_unavailable", "Accepted Plate update is unavailable");
  }
  return sendError(reply, 409, "accepted_state_unavailable", "Accepted Plan state is unavailable");
}

function sendInitializeFailure(reply: FastifyReply, result: Exclude<InitializeAcceptedPlatesResult, { kind: "workspace" }>) {
  switch (result.kind) {
    case "profile_not_found":
      return sendError(reply, 404, "profile_not_found", "Plan not found");
    case "empty_plan":
      return reply.send({ kind: "empty_plan" });
    case "missing_assignment":
    case "duplicate_assignment":
    case "unknown_unit_token":
    case "unassigned_units":
      return sendError(reply, 422, result.kind, "Printer assignments are incomplete", { tokens: result.tokens });
    case "printer_not_found":
      return sendError(reply, 422, "printer_not_found", "Printer was not found", { printer_ids: result.printerIds });
    case "missing_printer_geometry":
      return sendError(reply, 422, "missing_printer_geometry", "Printer build geometry is incomplete", { printer_ids: result.printerIds });
    case "unit_too_large":
      return sendError(reply, 422, "unit_too_large", "Required unit does not fit the selected Printer", { token: result.token, printer_id: result.printerId });
    case "artifact_unavailable":
      return sendError(reply, 409, result.reason, "Accepted artifact is unavailable", { token: result.token });
    case "invalid_stl":
      return sendError(reply, 409, "invalid_stl", "Accepted artifact is not a valid STL", { token: result.token });
    case "degenerate_geometry":
      return sendError(reply, 422, "degenerate_geometry", "Accepted artifact geometry cannot be arranged", { token: result.token });
    case "limit_exceeded":
      return sendError(reply, 413, "limit_exceeded", "Accepted Plate limit exceeded", { limit: result.limit });
    case "stale_accepted_plan":
      return sendError(reply, 409, "accepted_plan_changed", "Accepted Plan changed");
    case "plate_revision_changed":
      return sendError(reply, 409, "plate_revision_changed", "Plate revision changed");
    case "plan_archived":
      return sendError(reply, 409, "plan_archived", "Plan is archived");
    case "accepted_state_unavailable":
      return sendError(reply, 409, "accepted_state_unavailable", "Accepted Plan state is unavailable");
    case "invalid_units":
      return sendError(reply, 422, "invalid_units", "Accepted Plate units are invalid");
    case "invalid_geometry":
      return sendError(reply, 422, result.reason, "Accepted Plate geometry is invalid");
    case "transaction_unavailable":
      return sendError(reply, 503, "accepted_plate_update_unavailable", "Accepted Plate update is unavailable");
  }
}

function sendMoveFailure(reply: FastifyReply, result: Exclude<ReturnType<AppRepository["moveAcceptedPlateUnit"]>, { kind: "moved" | "unchanged" }>) {
  switch (result.kind) {
    case "stale_accepted_plan":
      return sendError(reply, 409, "accepted_plan_changed", "Accepted Plan changed");
    case "plate_revision_changed":
      return sendError(reply, 409, "plate_revision_changed", "Plate revision changed");
    case "plan_archived":
      return sendError(reply, 409, "plan_archived", "Plan is archived");
    case "accepted_state_unavailable":
      return sendError(reply, 409, "accepted_state_unavailable", "Accepted Plan state is unavailable");
    case "unit_not_found":
    case "invalid_units":
      return sendError(reply, 422, result.kind, "Accepted Plate unit is invalid");
    case "invalid_geometry":
      return sendError(reply, 422, result.reason, "Accepted Plate geometry is invalid");
    case "transaction_unavailable":
      return sendError(reply, 503, "accepted_plate_update_unavailable", "Accepted Plate update is unavailable");
  }
}

function sendIntegrityFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof AcceptedPlateIntegrityError || error instanceof AcceptedPlanOperationalIntegrityError) {
    request.log.error({ operation: "accepted_plate", code: error.code }, "Accepted Plate integrity failure");
  } else {
    request.log.error({ operation: "accepted_plate", failure: "unexpected" }, "Accepted Plate request failed");
  }
  return sendError(reply, 500, "internal_error", "Accepted Plate data is inconsistent");
}

export async function registerAcceptedPlateRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): Promise<void> {
  const service = serviceDependencies(dependencies);

  app.get("/plans/:id/plates", async (request, reply) => {
    const id = profileId(request);
    if (id == null) return sendError(reply, 400, "invalid_request", "Request is invalid");
    try {
      const result = readAcceptedPlateWorkspace(service, id);
      return result.kind === "workspace" ? result.workspace : sendReadFailure(reply, result);
    } catch (error) {
      return sendIntegrityFailure(request, reply, error);
    }
  });

  app.post("/plans/:id/plates/initialize", async (request, reply) => {
    const id = profileId(request);
    const body = parseInitializeRequest(request.body);
    if (id == null || !body || body.expected.profileId !== id) {
      return sendError(reply, 400, "invalid_request", "Request is invalid");
    }
    try {
      const result = await initializeAcceptedPlates(service, { profileId: id, ...body });
      return result.kind === "workspace" ? result.workspace : sendInitializeFailure(reply, result);
    } catch (error) {
      return sendIntegrityFailure(request, reply, error);
    }
  });

  app.patch("/plans/:id/plates/:plateId/units/:token", async (request, reply) => {
    const id = profileId(request);
    const params = isRecord(request.params) ? request.params : {};
    const plateId = typeof params.plateId === "string" ? params.plateId.trim() : "";
    const token = parseToken(params.token);
    const body = parseMoveRequest(request.body);
    if (id == null || !plateId || plateId.length > 200 || !token || !body || body.expected.profileId !== id) {
      return sendError(reply, 400, "invalid_request", "Request is invalid");
    }
    try {
      const result = dependencies.repo.moveAcceptedPlateUnit({
        profileId: id,
        expected: body.expected,
        expectedPlateRevisionId: body.expectedPlateRevisionId,
        plateId,
        token,
        xUm: body.xUm,
        yUm: body.yUm,
      });
      if (result.kind === "moved" || result.kind === "unchanged") {
        return {
          plate_revision_id: result.plateRevisionId,
          plate_revision_number: result.plateRevisionNumber,
        };
      }
      return sendMoveFailure(reply, result);
    } catch (error) {
      return sendIntegrityFailure(request, reply, error);
    }
  });

  app.patch("/plans/:id/plates/:plateId/units/:token/pin", async (request, reply) => {
    const id = profileId(request);
    const params = isRecord(request.params) ? request.params : {};
    const plateId = typeof params.plateId === "string" ? params.plateId.trim() : "";
    const token = parseToken(params.token);
    const body = parsePinRequest(request.body);
    if (id == null || !/^plate_[0-9a-f]{32}$/.test(plateId) || !token || !body || body.expected.profileId !== id) {
      return sendError(reply, 400, "invalid_request", "Request is invalid");
    }
    try {
      const result = dependencies.repo.pinAcceptedPlateUnit({
        profileId: id,
        expected: body.expected,
        expectedPlateRevisionId: body.expectedPlateRevisionId,
        plateId,
        token,
        pinned: body.pinned,
      });
      if (result.kind === "moved" || result.kind === "unchanged") {
        return { plate_revision_id: result.plateRevisionId, plate_revision_number: result.plateRevisionNumber };
      }
      return sendMoveFailure(reply, result);
    } catch (error) {
      return sendIntegrityFailure(request, reply, error);
    }
  });

  app.post("/plans/:id/plates/:plateId/units/:token/unplace", async (request, reply) => {
    const id = profileId(request);
    const params = isRecord(request.params) ? request.params : {};
    const plateId = typeof params.plateId === "string" ? params.plateId.trim() : "";
    const token = parseToken(params.token);
    const body = parseRevisionRequest(request.body);
    if (id == null || !/^plate_[0-9a-f]{32}$/.test(plateId) || !token || !body || body.expected.profileId !== id) {
      return sendError(reply, 400, "invalid_request", "Request is invalid");
    }
    try {
      const result = dependencies.repo.unplaceAcceptedPlateUnit({
        profileId: id,
        expected: body.expected,
        expectedPlateRevisionId: body.expectedPlateRevisionId,
        plateId,
        token,
      });
      if (result.kind === "moved" || result.kind === "unchanged") {
        return { plate_revision_id: result.plateRevisionId, plate_revision_number: result.plateRevisionNumber };
      }
      return sendMoveFailure(reply, result);
    } catch (error) {
      return sendIntegrityFailure(request, reply, error);
    }
  });

  app.post("/plans/:id/plates/:plateId/units/:token/transfer", async (request, reply) => {
    const id = profileId(request);
    const params = isRecord(request.params) ? request.params : {};
    const plateId = typeof params.plateId === "string" ? params.plateId.trim() : "";
    const token = parseToken(params.token);
    const body = parseTransferRequest(request.body);
    if (id == null || !/^plate_[0-9a-f]{32}$/.test(plateId) || !token || !body || body.expected.profileId !== id) {
      return sendError(reply, 400, "invalid_request", "Request is invalid");
    }
    const target = "targetPlateId" in body
      ? { targetPlateId: body.targetPlateId }
      : (() => {
          const targetPrinter = fleetPrinterGeometry(dependencies.repo, body.targetPrinterId);
          return targetPrinter ? { targetPrinter } : null;
        })();
    if (!target) return sendError(reply, 422, "printer_not_found", "Printer was not found");
    try {
      const result = dependencies.repo.transferAcceptedPlateUnit({
        profileId: id,
        expected: body.expected,
        expectedPlateRevisionId: body.expectedPlateRevisionId,
        plateId,
        token,
        ...target,
      });
      if (result.kind === "moved" || result.kind === "unchanged") {
        return { plate_revision_id: result.plateRevisionId, plate_revision_number: result.plateRevisionNumber };
      }
      return sendMoveFailure(reply, result);
    } catch (error) {
      return sendIntegrityFailure(request, reply, error);
    }
  });

  app.post("/plans/:id/plates/arrange", async (request, reply) => {
    const id = profileId(request);
    const body = parseArrangeRequest(request.body);
    if (id == null || !body || body.expected.profileId !== id) {
      return sendError(reply, 400, "invalid_request", "Request is invalid");
    }
    try {
      const result = arrangeAcceptedPlates(service, { profileId: id, ...body });
      return result.kind === "workspace" ? result.workspace : sendInitializeFailure(reply, result);
    } catch (error) {
      return sendIntegrityFailure(request, reply, error);
    }
  });

  app.post("/plans/:id/plates/restore", async (request, reply) => {
    const id = profileId(request);
    const body = parseRestoreRequest(request.body);
    if (id == null || !body || body.expected.profileId !== id) {
      return sendError(reply, 400, "invalid_request", "Request is invalid");
    }
    try {
      const result = dependencies.repo.restoreAcceptedPlates({ profileId: id, ...body });
      if (result.kind !== "restored" && result.kind !== "unchanged") {
        return sendMoveFailure(reply, result);
      }
      const workspace = readAcceptedPlateWorkspace(service, id);
      return workspace.kind === "workspace" ? workspace.workspace : sendReadFailure(reply, workspace);
    } catch (error) {
      return sendIntegrityFailure(request, reply, error);
    }
  });
}
