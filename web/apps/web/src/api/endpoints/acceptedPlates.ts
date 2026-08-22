import {
  parseAcceptedPlateEndpointError,
  parseAcceptedPlateExportJobList,
  parseAcceptedPlateMoveReceipt,
  parseAcceptedPlateSlicerHandoffRequest,
  parseAcceptedPlateSlicerHandoffResult,
  parseAcceptedPlateSlicerExchangeStatus,
  parseAcceptedPlateWorkspace,
  parseArrangeAcceptedPlatesRequest,
  parseInitializeAcceptedPlatesRequest,
  parseMoveAcceptedPlateUnitRequest,
  parsePinAcceptedPlateUnitRequest,
  parseRestoreAcceptedPlatesRequest,
  parseStartAcceptedPlateExportRequest,
  parseStartDirectExportRequest,
  parseTransferAcceptedPlateUnitRequest,
  parseUnplaceAcceptedPlateUnitRequest,
  type AcceptedPlateEndpointError,
  type AcceptedPlateExportRecord,
  type AcceptedPlateMoveReceipt,
  type AcceptedPlateSlicerHandoffRequest,
  type AcceptedPlateSlicerHandoffResult,
  type AcceptedPlateSlicerExchangeStatus,
  type AcceptedPlateWorkspace,
  type ArrangeAcceptedPlatesRequest,
  type InitializeAcceptedPlatesRequest,
  type MoveAcceptedPlateUnitRequest,
  type PinAcceptedPlateUnitRequest,
  type RestoreAcceptedPlatesRequest,
  type StartAcceptedPlateExportRequest,
  type StartDirectExportRequest,
  type TransferAcceptedPlateUnitRequest,
  type UnplaceAcceptedPlateUnitRequest,
} from "@print-partner/contracts";
import {
  ContractRequestError,
  defineJsonReadEndpoint,
  defineJsonWriteEndpoint,
  encodePositiveInteger,
  requestJsonRead,
  requestJsonWrite,
} from "../contractRequest";

type ProfileParams = Readonly<{ profileId: number }>;
type UnitParams = ProfileParams & Readonly<{ plateId: string; token: string }>;
type HandoffParams = Readonly<{ instanceId: string }>;

function parseSafeError(value: unknown, status: number): AcceptedPlateEndpointError {
  return parseAcceptedPlateEndpointError(value, status);
}

function encodePlateId(value: string): string {
  if (!/^plate_[0-9a-f]{32}$/.test(value)) throw new Error("Invalid Plate ID");
  return encodeURIComponent(value);
}

function encodeToken(value: string): string {
  if (!/^ppu_[0-9a-f]{32}$/.test(value)) throw new Error("Invalid Required-unit token");
  return encodeURIComponent(value);
}

function parseJobStart(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("job_id" in value) ||
    typeof value.job_id !== "string" ||
    value.job_id.length === 0 ||
    value.job_id.length > 200
  ) throw new Error("Invalid job start response");
  return value.job_id;
}

const workspaceEndpoint = defineJsonReadEndpoint({
  method: "GET",
  route: "/plans/:profileId/plates",
  path: ({ profileId }: ProfileParams) => `/plans/${encodePositiveInteger(profileId)}/plates`,
  parseSuccess: parseAcceptedPlateWorkspace,
  parseFailure: parseSafeError,
});

const initializeEndpoint = defineJsonWriteEndpoint({
  method: "POST",
  route: "/plans/:profileId/plates/initialize",
  path: ({ profileId }: ProfileParams) => `/plans/${encodePositiveInteger(profileId)}/plates/initialize`,
  encodeBody: parseInitializeAcceptedPlatesRequest,
  parseSuccess: parseAcceptedPlateWorkspace,
  parseFailure: parseSafeError,
});

const moveEndpoint = defineJsonWriteEndpoint({
  method: "PATCH",
  route: "/plans/:profileId/plates/:plateId/units/:token",
  path: ({ profileId, plateId, token }: UnitParams) =>
    `/plans/${encodePositiveInteger(profileId)}/plates/${encodePlateId(plateId)}/units/${encodeToken(token)}`,
  encodeBody: parseMoveAcceptedPlateUnitRequest,
  parseSuccess: parseAcceptedPlateMoveReceipt,
  parseFailure: parseSafeError,
});

const pinEndpoint = defineJsonWriteEndpoint({
  method: "PATCH",
  route: "/plans/:profileId/plates/:plateId/units/:token/pin",
  path: ({ profileId, plateId, token }: UnitParams) =>
    `/plans/${encodePositiveInteger(profileId)}/plates/${encodePlateId(plateId)}/units/${encodeToken(token)}/pin`,
  encodeBody: parsePinAcceptedPlateUnitRequest,
  parseSuccess: parseAcceptedPlateMoveReceipt,
  parseFailure: parseSafeError,
});

const unplaceEndpoint = defineJsonWriteEndpoint({
  method: "POST",
  route: "/plans/:profileId/plates/:plateId/units/:token/unplace",
  path: ({ profileId, plateId, token }: UnitParams) =>
    `/plans/${encodePositiveInteger(profileId)}/plates/${encodePlateId(plateId)}/units/${encodeToken(token)}/unplace`,
  encodeBody: parseUnplaceAcceptedPlateUnitRequest,
  parseSuccess: parseAcceptedPlateMoveReceipt,
  parseFailure: parseSafeError,
});

const transferEndpoint = defineJsonWriteEndpoint({
  method: "POST",
  route: "/plans/:profileId/plates/:plateId/units/:token/transfer",
  path: ({ profileId, plateId, token }: UnitParams) =>
    `/plans/${encodePositiveInteger(profileId)}/plates/${encodePlateId(plateId)}/units/${encodeToken(token)}/transfer`,
  encodeBody: parseTransferAcceptedPlateUnitRequest,
  parseSuccess: parseAcceptedPlateMoveReceipt,
  parseFailure: parseSafeError,
});

const arrangeEndpoint = defineJsonWriteEndpoint({
  method: "POST",
  route: "/plans/:profileId/plates/arrange",
  path: ({ profileId }: ProfileParams) => `/plans/${encodePositiveInteger(profileId)}/plates/arrange`,
  encodeBody: parseArrangeAcceptedPlatesRequest,
  parseSuccess: parseAcceptedPlateWorkspace,
  parseFailure: parseSafeError,
});

const restoreEndpoint = defineJsonWriteEndpoint({
  method: "POST",
  route: "/plans/:profileId/plates/restore",
  path: ({ profileId }: ProfileParams) => `/plans/${encodePositiveInteger(profileId)}/plates/restore`,
  encodeBody: parseRestoreAcceptedPlatesRequest,
  parseSuccess: parseAcceptedPlateWorkspace,
  parseFailure: parseSafeError,
});

const startExportEndpoint = defineJsonWriteEndpoint({
  method: "POST",
  route: "/jobs/export-accepted-plate-3mf",
  path: () => "/jobs/export-accepted-plate-3mf",
  encodeBody: parseStartAcceptedPlateExportRequest,
  parseSuccess: parseJobStart,
  parseFailure: parseSafeError,
});

const startDirectExportEndpoint = defineJsonWriteEndpoint({
  method: "POST",
  route: "/jobs/export-direct-3mf",
  path: () => "/jobs/export-direct-3mf",
  encodeBody: parseStartDirectExportRequest,
  parseSuccess: parseJobStart,
  parseFailure: parseSafeError,
});

function recentJobsEndpoint(profileId: number) {
  return defineJsonReadEndpoint({
    method: "GET",
    route: "/api/v1/jobs",
    path: () => `/api/v1/jobs?profile_id=${encodePositiveInteger(profileId)}`,
    parseSuccess: (value: unknown) => parseAcceptedPlateExportJobList(value, profileId),
    parseFailure: parseSafeError,
  });
}

const handoffEndpoint = defineJsonWriteEndpoint({
  method: "POST",
  route: "/slicer-instances/:instanceId/open-accepted-plates",
  path: ({ instanceId }: HandoffParams) => {
    const id = instanceId.trim();
    if (id.length === 0 || id.length > 200) throw new Error("Invalid slicer instance ID");
    return `/slicer-instances/${encodeURIComponent(id)}/open-accepted-plates`;
  },
  encodeBody: parseAcceptedPlateSlicerHandoffRequest,
  parseSuccess: parseAcceptedPlateSlicerHandoffResult,
  parseFailure: parseSafeError,
});

const slicerExchangeStatusEndpoint = defineJsonReadEndpoint({
  method: "GET",
  route: "/slicer-handoff/exchange-status",
  path: () => "/slicer-handoff/exchange-status",
  parseSuccess: parseAcceptedPlateSlicerExchangeStatus,
  parseFailure: parseSafeError,
});

export { ContractRequestError as AcceptedPlateRequestError };

export function acceptedPlateErrorCode(error: unknown): AcceptedPlateEndpointError["code"] | undefined {
  if (!(error instanceof ContractRequestError) || error.failure.kind !== "endpoint") return undefined;
  try {
    return parseAcceptedPlateEndpointError(error.failure.error, error.failure.status).code;
  } catch {
    return undefined;
  }
}

export function isAcceptedPlateStaleError(error: unknown): boolean {
  const code = acceptedPlateErrorCode(error);
  return code === "plate_revision_changed" || code === "accepted_plan_changed" || code === "accepted_state_unavailable";
}

export function fetchAcceptedPlateWorkspace(profileId: number): Promise<AcceptedPlateWorkspace> {
  return requestJsonRead(workspaceEndpoint, { profileId });
}

export function initializeAcceptedPlates(
  profileId: number,
  input: InitializeAcceptedPlatesRequest,
): Promise<AcceptedPlateWorkspace> {
  return requestJsonWrite(initializeEndpoint, { profileId }, input);
}

export function moveAcceptedPlateUnit(
  profileId: number,
  plateId: string,
  token: string,
  input: MoveAcceptedPlateUnitRequest,
): Promise<AcceptedPlateMoveReceipt> {
  return requestJsonWrite(moveEndpoint, { profileId, plateId, token }, input);
}

export function pinAcceptedPlateUnit(
  profileId: number,
  plateId: string,
  token: string,
  input: PinAcceptedPlateUnitRequest,
): Promise<AcceptedPlateMoveReceipt> {
  return requestJsonWrite(pinEndpoint, { profileId, plateId, token }, input);
}

export function unplaceAcceptedPlateUnit(
  profileId: number,
  plateId: string,
  token: string,
  input: UnplaceAcceptedPlateUnitRequest,
): Promise<AcceptedPlateMoveReceipt> {
  return requestJsonWrite(unplaceEndpoint, { profileId, plateId, token }, input);
}

export function transferAcceptedPlateUnit(
  profileId: number,
  plateId: string,
  token: string,
  input: TransferAcceptedPlateUnitRequest,
): Promise<AcceptedPlateMoveReceipt> {
  return requestJsonWrite(transferEndpoint, { profileId, plateId, token }, input);
}

export function arrangeAcceptedPlates(
  profileId: number,
  input: ArrangeAcceptedPlatesRequest,
): Promise<AcceptedPlateWorkspace> {
  return requestJsonWrite(arrangeEndpoint, { profileId }, input);
}

export function restoreAcceptedPlates(
  profileId: number,
  input: RestoreAcceptedPlatesRequest,
): Promise<AcceptedPlateWorkspace> {
  return requestJsonWrite(restoreEndpoint, { profileId }, input);
}

export function startAcceptedPlateExport(input: StartAcceptedPlateExportRequest): Promise<string> {
  return requestJsonWrite(startExportEndpoint, {}, input);
}

export function startDirectExport(input: StartDirectExportRequest): Promise<string> {
  return requestJsonWrite(startDirectExportEndpoint, {}, input);
}

export function fetchAcceptedPlateExportJobs(profileId: number): Promise<readonly AcceptedPlateExportRecord[]> {
  return requestJsonRead(recentJobsEndpoint(profileId), {});
}

export function openAcceptedPlatesInSlicer(
  instanceId: string,
  input: AcceptedPlateSlicerHandoffRequest,
): Promise<AcceptedPlateSlicerHandoffResult> {
  return requestJsonWrite(handoffEndpoint, { instanceId }, input);
}

export function fetchAcceptedPlateSlicerExchangeStatus(): Promise<AcceptedPlateSlicerExchangeStatus> {
  return requestJsonRead(slicerExchangeStatusEndpoint, {});
}
