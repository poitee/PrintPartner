/**
 * SINGLE_USER_AUTH=1 must not lock bearer-key MCP clients out of the Streamable
 * HTTP transport: the tenant middleware exempts the exact /api/v1/mcp route so
 * the API-key hook and `assertMcpHttpAllowed` stay the authoritative checks.
 *
 * Every case drives the real Fastify app with a real MCP initialize request —
 * no stubbing of the auth chain. Secrets are generated per run so none live in
 * source.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig, type ServerConfig } from "../config.js";
import { isMcpTransportRequest } from "../lib/mcp-transport-path.js";

/** TEST-NET-3 (RFC 5737) — never loopback, so no loopback shortcut applies. */
const REMOTE_ADDRESS = "203.0.113.10";

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "single-user-auth-test", version: "0.0.1" },
  },
};

function secret(): string {
  return randomBytes(24).toString("hex");
}

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** Self-host app with SINGLE_USER_AUTH=1 bound to a non-loopback host. */
async function buildSingleUserApp(overrides: Partial<ServerConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pp-mcp-single-user-"));
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  const config: ServerConfig = {
    ...loadConfig(),
    dataDir: dir,
    deployMode: "self-host",
    host: "0.0.0.0",
    multiUser: false,
    singleUserAuth: true,
    authRequired: true,
    trustProxy: false,
    basicAuthUser: null,
    basicAuthPass: null,
    integrationApiKey: null,
    sessionSecret: secret(),
    ...overrides,
  };
  const app = await buildApp(config, ports);
  cleanup.push(async () => {
    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, config };
}

function initialize(
  app: Awaited<ReturnType<typeof buildSingleUserApp>>["app"],
  apiKey?: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/mcp",
    remoteAddress: REMOTE_ADDRESS,
    headers: apiKey ? { ...MCP_HEADERS, authorization: `Bearer ${apiKey}` } : MCP_HEADERS,
    payload: INITIALIZE_REQUEST,
  });
}

describe("MCP HTTP auth under SINGLE_USER_AUTH=1", () => {
  it("initializes a session for a valid deployment API key on a non-loopback host", async () => {
    const deploymentKey = secret();
    const { app } = await buildSingleUserApp({ integrationApiKey: deploymentKey });

    const response = await initialize(app, deploymentKey);

    expect(response.statusCode).toBe(200);
    expect(response.headers["mcp-session-id"]).toBeTypeOf("string");
    expect(String(response.headers["mcp-session-id"]).length).toBeGreaterThan(0);
    expect(response.body).toMatch(/tools/i);
  });

  it("accepts a Settings-generated API key in the same auth mode", async () => {
    const { app } = await buildSingleUserApp();

    const registration = await app.inject({
      method: "POST",
      url: "/auth/register",
      remoteAddress: REMOTE_ADDRESS,
      payload: {
        email: "owner@example.com",
        password: secret(),
        display_name: "Owner",
      },
    });
    expect(registration.statusCode).toBe(200);
    const sessionCookie = registration.cookies.find((cookie) => cookie.name === "pp_session");
    expect(sessionCookie?.value).toBeTruthy();

    const created = await app.inject({
      method: "POST",
      url: "/settings/api-keys",
      remoteAddress: REMOTE_ADDRESS,
      cookies: { pp_session: sessionCookie?.value ?? "" },
    });
    expect(created.statusCode).toBe(201);
    const { key } = created.json() as { key: string };

    const response = await initialize(app, key);

    expect(response.statusCode).toBe(200);
    expect(response.headers["mcp-session-id"]).toBeTypeOf("string");
  });

  it("rejects a missing API key when a deployment key is configured", async () => {
    const { app } = await buildSingleUserApp({ integrationApiKey: secret() });

    const response = await initialize(app);

    expect(response.statusCode).toBe(401);
    expect(response.headers["mcp-session-id"]).toBeUndefined();
  });

  it("rejects an invalid API key", async () => {
    const { app } = await buildSingleUserApp({ integrationApiKey: secret() });

    const response = await initialize(app, secret());

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ detail: "Valid API key required" });
  });

  it("fails closed with 503 on a non-loopback host that accepts no key", async () => {
    const { app, config } = await buildSingleUserApp();
    expect(config.integrationApiKey).toBeNull();

    const response = await initialize(app);

    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(response.json())).toMatch(/PRINT_PARTNER_API_KEY/i);
  });

  it("keeps other /api/v1 routes behind the browser session", async () => {
    const deploymentKey = secret();
    const { app } = await buildSingleUserApp({ integrationApiKey: deploymentKey });

    const anonymous = await app.inject({
      method: "GET",
      url: "/api/v1/sources",
      remoteAddress: REMOTE_ADDRESS,
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ detail: "Authentication required" });

    const withApiKey = await app.inject({
      method: "GET",
      url: "/api/v1/sources",
      remoteAddress: REMOTE_ADDRESS,
      headers: { authorization: `Bearer ${deploymentKey}` },
    });
    expect(withApiKey.statusCode).toBe(401);
    expect(withApiKey.json()).toMatchObject({ detail: "Authentication required" });
  });

  it("does not extend the exemption to paths that only look like the MCP route", async () => {
    const deploymentKey = secret();
    const { app } = await buildSingleUserApp({ integrationApiKey: deploymentKey });

    for (const url of ["/api/v1/mcp/other", "/api/v1/mcpx", "/api/v1/mcp/"]) {
      const response = await app.inject({
        method: "POST",
        url,
        remoteAddress: REMOTE_ADDRESS,
        headers: MCP_HEADERS,
        payload: INITIALIZE_REQUEST,
      });
      expect(response.statusCode, url).toBe(401);
      expect(response.json(), url).toMatchObject({ detail: "Authentication required" });
    }
  });
});

describe("isMcpTransportRequest", () => {
  it("matches only the exact transport route and its methods", () => {
    expect(isMcpTransportRequest("POST", "/api/v1/mcp")).toBe(true);
    expect(isMcpTransportRequest("GET", "/api/v1/mcp?x=1")).toBe(true);
    expect(isMcpTransportRequest("delete", "/api/v1/mcp")).toBe(true);

    expect(isMcpTransportRequest("PUT", "/api/v1/mcp")).toBe(false);
    expect(isMcpTransportRequest("POST", "/api/v1/mcp/other")).toBe(false);
    expect(isMcpTransportRequest("POST", "/api/v1/mcp/")).toBe(false);
    expect(isMcpTransportRequest("POST", "/api/v1/mcpx")).toBe(false);
    expect(isMcpTransportRequest("POST", "/api/v2/mcp")).toBe(false);
  });
});
