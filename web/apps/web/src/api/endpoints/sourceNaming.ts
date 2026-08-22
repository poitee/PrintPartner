import {
  parseSourceNamingEndpointError,
  parseSourceNamingPutInput,
  parseSourceNamingResponse,
  type SourceNamingEndpointError,
  type SourceNamingPutInput,
  type SourceNamingResponse,
} from "@print-partner/contracts";
import {
  ContractRequestError,
  defineJsonReadEndpoint,
  defineJsonWriteEndpoint,
  encodePositiveInteger,
  requestJsonRead,
  requestJsonWrite,
} from "../contractRequest";

type SourceNamingParams = Readonly<{ sourceId: number }>;

export type SourceNamingSafeError = Readonly<{
  code: SourceNamingEndpointError["code"];
}>;

function parseSafeSourceNamingError(
  value: unknown,
  status: number,
): SourceNamingSafeError {
  const error = parseSourceNamingEndpointError(value, status);
  return { code: error.code };
}

function sourceNamingPath(params: SourceNamingParams): string {
  return `/sources/${encodePositiveInteger(params.sourceId)}/naming`;
}

const getSourceNamingEndpoint = defineJsonReadEndpoint({
  method: "GET",
  route: "/sources/:sourceId/naming",
  path: sourceNamingPath,
  parseSuccess: parseSourceNamingResponse,
  parseFailure: parseSafeSourceNamingError,
});

const putSourceNamingEndpoint = defineJsonWriteEndpoint({
  method: "PUT",
  route: "/sources/:sourceId/naming",
  path: sourceNamingPath,
  encodeBody: parseSourceNamingPutInput,
  parseSuccess: parseSourceNamingResponse,
  parseFailure: parseSafeSourceNamingError,
});

export type SourceNamingSettings = SourceNamingResponse;
export { ContractRequestError as SourceNamingRequestError };

function sourceNamingErrorCode(
  error: unknown,
): SourceNamingSafeError["code"] | undefined {
  if (!(error instanceof ContractRequestError)) return undefined;
  const failure = error.failure;
  if (failure.kind !== "endpoint") return undefined;
  const endpointError = failure.error;
  if (
    typeof endpointError === "object" &&
    endpointError !== null &&
    "code" in endpointError &&
    typeof endpointError.code === "string"
  ) {
    switch (endpointError.code) {
      case "invalid_source_naming":
      case "source_not_found":
      case "source_naming_conflict":
      case "invalid_source_naming_state":
        return endpointError.code;
    }
  }
  return undefined;
}

export function isSourceNamingNotFoundError(error: unknown): boolean {
  return sourceNamingErrorCode(error) === "source_not_found";
}

export function sourceNamingErrorMessage(error: unknown): string {
  const code = sourceNamingErrorCode(error);
  switch (code) {
    case "invalid_source_naming":
      return "Source naming settings are invalid.";
    case "source_not_found":
      return "This Source no longer exists.";
    case "source_naming_conflict":
      return "Source naming changed elsewhere. Reload and try again.";
    case "invalid_source_naming_state":
      return "Stored Source naming settings are invalid.";
  }
  if (error instanceof ContractRequestError) return error.message;
  return "Source naming request failed.";
}

export function fetchSourceNaming(sourceId: number): Promise<SourceNamingResponse> {
  return requestJsonRead(getSourceNamingEndpoint, { sourceId });
}

export function saveSourceNaming(
  sourceId: number,
  input: SourceNamingPutInput,
): Promise<SourceNamingResponse> {
  return requestJsonWrite(putSourceNamingEndpoint, { sourceId }, input);
}
