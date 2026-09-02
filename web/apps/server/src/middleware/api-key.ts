import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ServerConfig } from "../config.js";
import { sendProblem } from "../lib/api-error.js";
import { isMcpTransportRequest } from "../lib/mcp-transport-path.js";
import { isSyntheticAnonymousSession } from "../routes/auth-types.js";

const EXEMPT_PREFIXES = [
  "/api/v1/openapi.json",
  "/api/v1/docs",
  "/api/v2/openapi.json",
  "/openapi.json",
];

function isExempt(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  if (path === "/health" || path === "/api/v1" || path === "/api/v2") return true;
  if (EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
    return true;
  }
  return false;
}

export type ApiKeyValidator = (rawKey: string) => boolean;
export type AdminPreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;

type ExternalAccess = Readonly<{
  apiKeysEnabled: () => boolean;
  mcpEnabled: () => boolean;
}>;

const ALL_EXTERNAL_ACCESS: ExternalAccess = {
  apiKeysEnabled: () => true,
  mcpEnabled: () => true,
};

export function extractApiKey(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim() || null;
  }
  const custom = request.headers["x-print-partner-api-key"];
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  return null;
}

function constantTimeSecretEqual(left: string, right: string): boolean {
  const context = "print-partner:credential-compare:v1";
  const leftDigest = createHmac("sha256", context).update(left).digest();
  const rightDigest = createHmac("sha256", context).update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === "::1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

function hasForwardingHeaders(request: FastifyRequest): boolean {
  return Boolean(
    request.headers.forwarded ||
    request.headers["x-forwarded-for"] ||
    request.headers["x-forwarded-host"] ||
    request.headers["x-forwarded-proto"],
  );
}

function isUnambiguousLoopback(
  request: FastifyRequest,
  config: ServerConfig,
): boolean {
  if (config.trustProxy || config.authRequired || hasForwardingHeaders(request)) {
    return false;
  }
  return isLoopbackAddress(request.socket.remoteAddress);
}

function hasAuthenticatedSession(request: FastifyRequest): boolean {
  const user = request.sessionUser;
  return Boolean(user && !isSyntheticAnonymousSession(user));
}

function isSameOriginBrowserRequest(request: FastifyRequest): boolean {
  if (request.headers["sec-fetch-site"] !== "same-origin") return false;
  const mode = request.headers["sec-fetch-mode"];
  if (mode !== "cors" && mode !== "same-origin") return false;
  if (request.headers["sec-fetch-dest"] !== "empty") return false;

  const referer = request.headers.referer;
  const host = request.headers.host;
  if (typeof referer !== "string" || typeof host !== "string") return false;
  try {
    const origin = new URL(referer);
    return (
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      origin.host.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}

function hasConfiguredBasicAuth(
  request: FastifyRequest,
  config: ServerConfig,
): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Basic ")) return false;

  const configured =
    config.deployMode === "saas"
      ? config.saasBasicAuth
      : config.basicAuthUser && config.basicAuthPass
        ? `${config.basicAuthUser}:${config.basicAuthPass}`
        : null;
  if (!configured) return false;

  const expected = `Basic ${Buffer.from(configured).toString("base64")}`;
  return constantTimeSecretEqual(header, expected);
}

export function registerApiKeyAuth(
  app: FastifyInstance,
  config: ServerConfig,
  validateRepositoryKey: ApiKeyValidator,
  externalAccess: ExternalAccess = ALL_EXTERNAL_ACCESS,
): ApiKeyValidator {
  const validateKey: ApiKeyValidator = (rawKey) => {
    if (!externalAccess.apiKeysEnabled()) return false;
    return (
      (config.integrationApiKey !== null &&
        constantTimeSecretEqual(rawKey, config.integrationApiKey)) ||
      validateRepositoryKey(rawKey)
    );
  };

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (!path.startsWith("/api/v1") && !path.startsWith("/api/v2")) return;
    if (
      isMcpTransportRequest(request.method, path) &&
      !externalAccess.mcpEnabled()
    ) {
      return sendProblem(
        reply,
        403,
        "Forbidden",
        "MCP access is turned off in Settings",
      );
    }
    if (isExempt(path)) return;

    if (!externalAccess.apiKeysEnabled()) {
      if (isUnambiguousLoopback(request, config)) return;
      if (hasAuthenticatedSession(request)) return;
      if (hasConfiguredBasicAuth(request, config)) return;
      if (isSameOriginBrowserRequest(request)) return;
      return sendProblem(
        reply,
        403,
        "Forbidden",
        "External API access is turned off in Settings",
      );
    }

    const provided = extractApiKey(request);
    if (provided) {
      if (validateKey(provided)) return;
      return sendProblem(reply, 401, "Unauthorized", "Valid API key required");
    }
    if (!config.integrationApiKey) return;
    if (isUnambiguousLoopback(request, config)) return;
    if (hasAuthenticatedSession(request)) return;
    if (hasConfiguredBasicAuth(request, config)) return;
    return sendProblem(reply, 401, "Unauthorized", "Valid API key required");
  });

  return validateKey;
}

export function createAdminPreHandler(
  config: ServerConfig,
  validateApiKey: ApiKeyValidator,
): AdminPreHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (isUnambiguousLoopback(request, config)) return;

    const provided = extractApiKey(request);
    if (provided && validateApiKey(provided)) return;
    if (hasConfiguredBasicAuth(request, config)) return;

    const user = request.sessionUser;
    if (user?.is_admin && hasAuthenticatedSession(request)) return;
    if (hasAuthenticatedSession(request)) {
      return sendProblem(reply, 403, "Forbidden", "Administrator access required");
    }
    return sendProblem(reply, 401, "Unauthorized", "Authentication required");
  };
}
