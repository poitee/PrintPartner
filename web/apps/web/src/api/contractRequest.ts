const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
const API_PREFIX = (import.meta.env.VITE_API_PREFIX ?? "").replace(/\/$/, "");

export type EngineMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type RequestContext = Readonly<{
  method: EngineMethod;
  route: string;
}>;

type ResponseContext = RequestContext &
  Readonly<{
    status: number;
    requestId?: string;
    correlationId?: string;
  }>;

export type ContractRequestFailure<EndpointError> =
  | ({ readonly kind: "invalid_request" } & RequestContext)
  | ({ readonly kind: "transport" } & RequestContext)
  | ({ readonly kind: "unauthorized"; readonly status: 401 } & ResponseContext)
  | ({ readonly kind: "endpoint"; readonly error: EndpointError } & ResponseContext)
  | ({ readonly kind: "malformed_success" } & ResponseContext)
  | ({ readonly kind: "malformed_error" } & ResponseContext);

function messageForFailure<EndpointError>(
  failure: ContractRequestFailure<EndpointError>,
): string {
  switch (failure.kind) {
    case "invalid_request":
      return "Request input is invalid";
    case "transport":
      return "Request could not reach Print Partner";
    case "unauthorized":
      return "Request is unauthorized";
    case "endpoint":
      return `Request failed (${failure.status})`;
    case "malformed_success":
      return "Print Partner returned an invalid response";
    case "malformed_error":
      return `Print Partner returned an invalid error (${failure.status})`;
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

export class ContractRequestError<EndpointError = unknown> extends Error {
  constructor(readonly failure: ContractRequestFailure<EndpointError>) {
    super(messageForFailure(failure));
    this.name = "ContractRequestError";
  }
}

type EndpointBase<Params, Success, EndpointError> = Readonly<{
  route: string;
  path: (params: Params) => string;
  parseSuccess: (value: unknown, status: number) => Success;
  parseFailure: (value: unknown, status: number) => EndpointError;
}>;

type ResponseEndpoint<Success, EndpointError> = Readonly<{
  method: EngineMethod;
  route: string;
  parseSuccess: (value: unknown, status: number) => Success;
  parseFailure: (value: unknown, status: number) => EndpointError;
}>;

export type JsonReadEndpoint<Params, Success, EndpointError> = EndpointBase<
  Params,
  Success,
  EndpointError
> &
  Readonly<{
    method: "GET" | "DELETE";
  }>;

export type JsonWriteEndpoint<Params, Input, Success, EndpointError> = EndpointBase<
  Params,
  Success,
  EndpointError
> &
  Readonly<{
    method: "POST" | "PUT" | "PATCH";
    encodeBody: (input: Input) => unknown;
  }>;

function assertSafeRouteTemplate(route: string): void {
  if (
    !route.startsWith("/") ||
    route.startsWith("//") ||
    route.includes("://") ||
    route.includes("?") ||
    route.includes("#")
  ) {
    throw new Error("Route template must be an absolute path without a query or fragment");
  }
}

export function defineJsonReadEndpoint<Params, Success, EndpointError>(
  endpoint: JsonReadEndpoint<Params, Success, EndpointError>,
): JsonReadEndpoint<Params, Success, EndpointError> {
  assertSafeRouteTemplate(endpoint.route);
  return endpoint;
}

export function defineJsonWriteEndpoint<Params, Input, Success, EndpointError>(
  endpoint: JsonWriteEndpoint<Params, Input, Success, EndpointError>,
): JsonWriteEndpoint<Params, Input, Success, EndpointError> {
  assertSafeRouteTemplate(endpoint.route);
  return endpoint;
}

export function encodePositiveInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Expected a positive integer");
  }
  return String(value);
}

export function resolveEngineUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const withPrefix = API_PREFIX ? `${API_PREFIX}${normalized}` : normalized;
  if (API_BASE) return `${API_BASE}${withPrefix}`;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}${withPrefix}`;
  }
  return withPrefix;
}

export function getEngineBaseUrl(): string {
  return API_BASE;
}

let unauthorizedHandler: (() => void) | null = null;

export function setEngineUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function notifyEngineUnauthorized(): void {
  unauthorizedHandler?.();
}

function notifyEngineUnauthorizedSafely(): void {
  try {
    notifyEngineUnauthorized();
  } catch {
    return;
  }
}

function safeTraceId(value: string | null): string | undefined {
  if (value === null || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) return undefined;
  return value;
}

function responseContext(
  request: RequestContext,
  response: Response,
): ResponseContext {
  const requestId = safeTraceId(response.headers.get("x-request-id"));
  const correlationId = safeTraceId(response.headers.get("x-correlation-id"));
  return {
    ...request,
    status: response.status,
    ...(requestId === undefined ? {} : { requestId }),
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new Error("Expected JSON");
  }
  const value: unknown = await response.json();
  return value;
}

async function performJsonRequest<Success, EndpointError>(
  endpoint: ResponseEndpoint<Success, EndpointError>,
  path: string,
  body: string | undefined,
): Promise<Success> {
  const request = { method: endpoint.method, route: endpoint.route };
  let response: Response;
  try {
    response = await fetch(resolveEngineUrl(path), {
      method: endpoint.method,
      credentials: "include",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body,
          }),
    });
  } catch {
    throw new ContractRequestError({ kind: "transport", ...request });
  }

  const context = responseContext(request, response);
  if (response.status === 401) {
    notifyEngineUnauthorizedSafely();
    throw new ContractRequestError({ kind: "unauthorized", ...context, status: 401 });
  }

  let payload: unknown;
  try {
    payload = await readJson(response);
  } catch {
    throw new ContractRequestError({
      kind: response.ok ? "malformed_success" : "malformed_error",
      ...context,
    });
  }

  if (response.ok) {
    try {
      return endpoint.parseSuccess(payload, response.status);
    } catch {
      throw new ContractRequestError({ kind: "malformed_success", ...context });
    }
  }

  let error: EndpointError;
  try {
    error = endpoint.parseFailure(payload, response.status);
  } catch {
    throw new ContractRequestError({ kind: "malformed_error", ...context });
  }
  throw new ContractRequestError({ kind: "endpoint", ...context, error });
}

function requestPath<Params, Success, EndpointError>(
  endpoint: EndpointBase<Params, Success, EndpointError> & { readonly method: EngineMethod },
  params: Params,
): string {
  const request = { method: endpoint.method, route: endpoint.route };
  try {
    const path = endpoint.path(params);
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
      throw new Error("Invalid path");
    }
    return path;
  } catch {
    throw new ContractRequestError({ kind: "invalid_request", ...request });
  }
}

export async function requestJsonRead<Params, Success, EndpointError>(
  endpoint: JsonReadEndpoint<Params, Success, EndpointError>,
  params: Params,
): Promise<Success> {
  const path = requestPath(endpoint, params);
  return performJsonRequest(endpoint, path, undefined);
}

export async function requestJsonWrite<Params, Input, Success, EndpointError>(
  endpoint: JsonWriteEndpoint<Params, Input, Success, EndpointError>,
  params: Params,
  input: Input,
): Promise<Success> {
  const request = { method: endpoint.method, route: endpoint.route };
  const path = requestPath(endpoint, params);
  let body: string | undefined;
  try {
    body = JSON.stringify(endpoint.encodeBody(input));
    if (body === undefined) throw new Error("Invalid body");
  } catch {
    throw new ContractRequestError({ kind: "invalid_request", ...request });
  }
  return performJsonRequest(endpoint, path, body);
}
