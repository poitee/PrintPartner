/**
 * Streamable HTTP MCP on the live app process (same tools as stdio).
 * Mounted under /api/v1/mcp.
 *
 * Fail-closed: PRINT_PARTNER_API_KEY is required unless HOST is loopback.
 * Pending proposes are bound to the MCP session (mcp-session-id) — one client
 * cannot list/confirm/dismiss another's.
 * Sessions are bounded (max count + idle/absolute TTL); evict closes transport.
 * New sessions reserve capacity synchronously before async init.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AssistantProposedAction } from "@print-partner/contracts";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ServerConfig } from "../config.js";
import type { AppRepository } from "../db/repository.js";
import type { InProcessJobRunner } from "../routes/jobs.js";
import { sendProblem } from "../lib/api-error.js";
import {
  createProductMcpServer,
  isLoopbackBindHost,
} from "./product-mcp.js";
import { createMcpSessionCapacity } from "./http-session-capacity.js";

type McpHttpDeps = {
  getRepo: () => AppRepository;
  jobs: InProcessJobRunner;
  config: ServerConfig;
  validateApiKey: (rawKey: string) => boolean;
};

type McpSession = {
  transport: StreamableHTTPServerTransport;
  server: Server;
  pending: Map<string, AssistantProposedAction>;
  createdAt: number;
  lastAccessAt: number;
};

/** Max concurrent HTTP MCP sessions per process. */
export const MCP_HTTP_SESSION_MAX = 64;
/** Evict after this much idle time (ms). */
export const MCP_HTTP_SESSION_IDLE_MS = 30 * 60 * 1000;
/** Evict after this absolute age (ms), even if active. */
export const MCP_HTTP_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;

export { createMcpSessionCapacity } from "./http-session-capacity.js";

function extractApiKey(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim() || null;
  }
  const custom = request.headers["x-print-partner-api-key"];
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  return null;
}

/** MCP auth: always require API key when configured; when unset, only loopback binds may expose MCP. */
export function assertMcpHttpAllowed(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
  validateApiKey: (rawKey: string) => boolean,
): boolean {
  const provided = extractApiKey(request);
  if (provided) {
    if (validateApiKey(provided)) return true;
    void sendProblem(reply, 401, "Unauthorized", "Valid API key required");
    return false;
  }

  if (!config.integrationApiKey) {
    if (isLoopbackBindHost(config.host)) return true;
    void sendProblem(
      reply,
      503,
      "Service Unavailable",
      "Configure an API key in Settings or PRINT_PARTNER_API_KEY before exposing /api/v1/mcp on a non-loopback host",
    );
    return false;
  }
  void sendProblem(reply, 401, "Unauthorized", "Valid API key required");
  return false;
}

function closeSession(session: McpSession): void {
  try {
    void session.transport.close();
  } catch {
    /* ignore */
  }
  try {
    void session.server.close();
  } catch {
    /* ignore */
  }
}

/**
 * Drop expired sessions and enforce max count (oldest lastAccess first).
 * Exported for unit tests.
 */
export function pruneMcpSessions(
  sessions: Map<string, McpSession>,
  now = Date.now(),
  opts?: {
    max?: number;
    idleMs?: number;
    absoluteMs?: number;
  },
): number {
  const max = opts?.max ?? MCP_HTTP_SESSION_MAX;
  const idleMs = opts?.idleMs ?? MCP_HTTP_SESSION_IDLE_MS;
  const absoluteMs = opts?.absoluteMs ?? MCP_HTTP_SESSION_ABSOLUTE_MS;
  let evicted = 0;

  for (const [id, session] of sessions) {
    const idle = now - session.lastAccessAt >= idleMs;
    const absolute = now - session.createdAt >= absoluteMs;
    if (idle || absolute) {
      sessions.delete(id);
      closeSession(session);
      evicted += 1;
    }
  }

  if (sessions.size > max) {
    const ranked = [...sessions.entries()].sort(
      (a, b) => a[1].lastAccessAt - b[1].lastAccessAt,
    );
    while (sessions.size > max && ranked.length) {
      const [id, session] = ranked.shift()!;
      if (!sessions.has(id)) continue;
      sessions.delete(id);
      closeSession(session);
      evicted += 1;
    }
  }

  return evicted;
}

export async function registerMcpHttpRoutes(
  app: FastifyInstance,
  deps: McpHttpDeps,
): Promise<void> {
  const planEnv = process.env.PRINT_PARTNER_MCP_PLAN_ID;
  const defaultPlanId =
    planEnv && Number.isFinite(Number(planEnv)) ? Math.trunc(Number(planEnv)) : null;

  /** Per streamable-HTTP session — not process-wide. */
  const sessions = new Map<string, McpSession>();
  const capacity = createMcpSessionCapacity(sessions, MCP_HTTP_SESSION_MAX);

  const touch = (session: McpSession) => {
    session.lastAccessAt = Date.now();
  };

  const mcpAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertMcpHttpAllowed(deps.config, request, reply, deps.validateApiKey)) return reply;
  };

  app.post("/mcp", { preHandler: mcpAuth }, async (request, reply) => {
    pruneMcpSessions(sessions);

    const sessionHeader = request.headers["mcp-session-id"];
    const sessionId =
      typeof sessionHeader === "string" && sessionHeader.trim()
        ? sessionHeader.trim()
        : Array.isArray(sessionHeader) && sessionHeader[0]
          ? String(sessionHeader[0]).trim()
          : "";

    try {
      const existing = sessionId ? sessions.get(sessionId) : undefined;

      if (!existing) {
        if (sessionId || !isInitializeRequest(request.body)) {
          return reply.status(400).send({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: sessionId
                ? "Bad Request: Unknown MCP session"
                : "Bad Request: No valid session ID provided",
            },
            id: null,
          });
        }

        // Reserve BEFORE any await so concurrent inits cannot overshoot max.
        const releaseReservation = capacity.tryReserve();
        if (!releaseReservation) {
          return reply.status(503).send({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "MCP session limit reached; retry later",
            },
            id: null,
          });
        }

        const pending = new Map<string, AssistantProposedAction>();
        const now = Date.now();
        const server = createProductMcpServer({
          getRepo: deps.getRepo,
          jobs: deps.jobs,
          config: deps.config,
          defaultPlanId,
          pending,
          tenantId: request.tenantId,
        });

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            // Register session first, then drop reservation (same occupied count).
            sessions.set(id, {
              transport,
              server,
              pending,
              createdAt: now,
              lastAccessAt: Date.now(),
            });
            releaseReservation();
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            const sess = sessions.get(sid);
            sessions.delete(sid);
            if (sess) {
              try {
                void sess.server.close();
              } catch {
                /* ignore */
              }
            }
          }
          // Init aborted before onsessioninitialized — free the slot.
          releaseReservation();
        };

        try {
          reply.hijack();
          await server.connect(transport);
          await transport.handleRequest(request.raw, reply.raw, request.body);
        } finally {
          // If initialize never registered a session, free the reservation.
          releaseReservation();
        }
        return;
      }

      touch(existing);
      reply.hijack();
      await existing.transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      console.error("[mcp-http]", err);
      if (!reply.raw.headersSent) {
        try {
          reply.raw.writeHead(500, { "Content-Type": "application/json" });
          reply.raw.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            }),
          );
        } catch {
          /* response already committed */
        }
      }
    }
  });

  app.get("/mcp", { preHandler: mcpAuth }, async (request, reply) => {
    pruneMcpSessions(sessions);
    const sessionHeader = request.headers["mcp-session-id"];
    const sessionId =
      typeof sessionHeader === "string" && sessionHeader.trim()
        ? sessionHeader.trim()
        : "";
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      return reply.status(405).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
    }
    touch(session);
    reply.hijack();
    await session.transport.handleRequest(request.raw, reply.raw);
  });

  app.delete("/mcp", { preHandler: mcpAuth }, async (request, reply) => {
    pruneMcpSessions(sessions);
    const sessionHeader = request.headers["mcp-session-id"];
    const sessionId =
      typeof sessionHeader === "string" && sessionHeader.trim()
        ? sessionHeader.trim()
        : "";
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      return reply.status(404).send({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      });
    }
    reply.hijack();
    await session.transport.handleRequest(request.raw, reply.raw);
    sessions.delete(sessionId);
    try {
      void session.server.close();
    } catch {
      /* ignore */
    }
  });
}
