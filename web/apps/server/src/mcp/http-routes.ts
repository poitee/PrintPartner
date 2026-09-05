/**
 * Streamable HTTP MCP on the live app process (same tools as stdio).
 * Mounted under /api/v1/mcp.
 *
 * Fail-closed: PRINT_PARTNER_API_KEY is required unless HOST is loopback.
 * Pending proposes are bound to the MCP session (mcp-session-id) — one client
 * cannot list/confirm/dismiss another's.
 * Sessions are bounded (max count + idle/absolute TTL); evict closes transport.
 * New sessions reserve capacity synchronously before async init.
 *
 * Session liveness rules (these keep long-lived clients connected):
 * - A request for a session refreshes it BEFORE the prune sweep, so a client
 *   returning from an idle stretch is never evicted by its own request.
 * - A session holding an open standalone SSE stream is never idle-evicted; the
 *   stream is the client, and closing it under them reads as a dropped server.
 * - An unknown/expired session id answers 404, which the MCP spec defines as
 *   "start a new session" — clients re-initialize silently instead of erroring.
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
import { MAX_ASSISTANT_ACTION_BODY_BYTES } from "../services/upload-limits.js";
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
  /** Open standalone SSE streams (GET). Non-zero means a client is attached. */
  openStreams: number;
};

/** Max concurrent HTTP MCP sessions per process. */
export const MCP_HTTP_SESSION_MAX = 64;
/** Evict after this much idle time (ms). Streams held open do not count as idle. */
export const MCP_HTTP_SESSION_IDLE_MS = 30 * 60 * 1000;
/** Evict after this absolute age (ms), even if active. */
export const MCP_HTTP_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
/** Background sweep cadence, so abandoned sessions are reclaimed without traffic. */
export const MCP_HTTP_SWEEP_MS = 60 * 1000;

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

/** Read `mcp-session-id` whether Fastify hands it back as a string or a repeated header. */
export function readMcpSessionId(
  header: string | string[] | undefined,
): string {
  if (typeof header === "string") return header.trim();
  if (Array.isArray(header) && header[0]) return String(header[0]).trim();
  return "";
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

/** An attached SSE stream is a live client, even with no recent request. */
function hasOpenStream(session: McpSession): boolean {
  return (session.openStreams ?? 0) > 0;
}

/**
 * Drop expired sessions and enforce max count.
 * Idle expiry skips sessions holding an open SSE stream; the absolute cap still
 * applies to everything. Over-capacity evicts stream-less sessions first, then
 * oldest lastAccess.
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
    const idle = !hasOpenStream(session) && now - session.lastAccessAt >= idleMs;
    const absolute = now - session.createdAt >= absoluteMs;
    if (idle || absolute) {
      sessions.delete(id);
      closeSession(session);
      evicted += 1;
    }
  }

  if (sessions.size > max) {
    const ranked = [...sessions.entries()].sort((a, b) => {
      const aAttached = hasOpenStream(a[1]) ? 1 : 0;
      const bAttached = hasOpenStream(b[1]) ? 1 : 0;
      if (aAttached !== bAttached) return aAttached - bAttached;
      return a[1].lastAccessAt - b[1].lastAccessAt;
    });
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

/**
 * Refresh the caller's session, then sweep, then hand back whatever survived.
 * Touch-before-prune is what stops a client's own request from evicting the
 * very session it just asked for after an idle stretch.
 * Exported for unit tests.
 */
export function resolveMcpSession(
  sessions: Map<string, McpSession>,
  sessionId: string,
  now = Date.now(),
  opts?: { max?: number; idleMs?: number; absoluteMs?: number },
): McpSession | undefined {
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) existing.lastAccessAt = now;
  pruneMcpSessions(sessions, now, opts);
  return sessionId ? sessions.get(sessionId) : undefined;
}

/** Unknown or expired session id. 404 is the spec's "re-initialize" signal. */
function replyUnknownSession(reply: FastifyReply) {
  return reply.status(404).send({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Session not found" },
    id: null,
  });
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

  const resolveSession = (sessionId: string): McpSession | undefined =>
    resolveMcpSession(sessions, sessionId);

  const sweep = setInterval(() => {
    pruneMcpSessions(sessions);
  }, MCP_HTTP_SWEEP_MS);
  sweep.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(sweep);
    for (const [id, session] of sessions) {
      sessions.delete(id);
      closeSession(session);
    }
  });

  const mcpAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertMcpHttpAllowed(deps.config, request, reply, deps.validateApiKey)) return reply;
  };

  app.post("/mcp", {
    bodyLimit: MAX_ASSISTANT_ACTION_BODY_BYTES,
    preHandler: mcpAuth,
  }, async (request, reply) => {
    const sessionId = readMcpSessionId(request.headers["mcp-session-id"]);

    try {
      const existing = resolveSession(sessionId);

      if (!existing) {
        // Expired/unknown id: 404 tells a spec-compliant client to re-initialize.
        if (sessionId) return replyUnknownSession(reply);
        if (!isInitializeRequest(request.body)) {
          return reply.status(400).send({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: No valid session ID provided",
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
              openStreams: 0,
            });
            releaseReservation();
          },
          onsessionclosed: (id) => {
            const sess = sessions.get(id);
            sessions.delete(id);
            if (sess) {
              try {
                void sess.server.close();
              } catch {
                /* ignore */
              }
            }
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

      reply.hijack();
      await existing.transport.handleRequest(request.raw, reply.raw, request.body);
      touch(existing);
    } catch (err) {
      failHijacked(reply, err);
    }
  });

  app.get("/mcp", { preHandler: mcpAuth }, async (request, reply) => {
    const sessionId = readMcpSessionId(request.headers["mcp-session-id"]);
    const session = resolveSession(sessionId);
    if (!session) return replyUnknownSession(reply);

    // Count the stream while it is attached so the idle sweep leaves it alone.
    session.openStreams = (session.openStreams ?? 0) + 1;
    let released = false;
    const releaseStream = () => {
      if (released) return;
      released = true;
      session.openStreams = Math.max(0, (session.openStreams ?? 1) - 1);
      touch(session);
    };
    reply.raw.on("close", releaseStream);

    try {
      reply.hijack();
      await session.transport.handleRequest(request.raw, reply.raw);
    } catch (err) {
      releaseStream();
      failHijacked(reply, err);
    }
  });

  app.delete("/mcp", { preHandler: mcpAuth }, async (request, reply) => {
    const sessionId = readMcpSessionId(request.headers["mcp-session-id"]);
    const session = resolveSession(sessionId);
    if (!session) return replyUnknownSession(reply);

    try {
      reply.hijack();
      await session.transport.handleRequest(request.raw, reply.raw);
    } catch (err) {
      failHijacked(reply, err);
    } finally {
      sessions.delete(sessionId);
      try {
        void session.server.close();
      } catch {
        /* ignore */
      }
    }
  });
}

/**
 * After reply.hijack() Fastify no longer owns the socket, so an unhandled throw
 * would leave the client waiting forever. Always terminate the raw response.
 */
function failHijacked(reply: FastifyReply, err: unknown): void {
  console.error("[mcp-http]", err);
  try {
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { "Content-Type": "application/json" });
      reply.raw.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
      );
      return;
    }
    reply.raw.end();
  } catch {
    /* response already committed */
  }
}
