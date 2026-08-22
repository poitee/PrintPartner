/**
 * HTTP MCP smoke: fail-closed auth, session init, env restore.
 * Session map bounds: idle/absolute expiry + max count (close on evict).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, createPorts } from "../app.js";
import { loadConfig } from "../config.js";
import { isLoopbackBindHost } from "./product-mcp.js";
import { pruneMcpSessions } from "./http-routes.js";

describe("HTTP MCP /api/v1/mcp", () => {
  let dataDir: string;
  let prevKey: string | undefined;
  let prevDataDir: string | undefined;
  let prevDeployMode: string | undefined;
  let prevHost: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-mcp-http-"));
    prevKey = process.env.PRINT_PARTNER_API_KEY;
    prevDataDir = process.env.PRINT_PARTNER_DATA_DIR;
    prevDeployMode = process.env.DEPLOY_MODE;
    prevHost = process.env.HOST;
    process.env.PRINT_PARTNER_API_KEY = "test-mcp-key";
    process.env.PRINT_PARTNER_DATA_DIR = dataDir;
    process.env.DEPLOY_MODE = "self-host";
    process.env.HOST = "127.0.0.1";
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.PRINT_PARTNER_API_KEY;
    else process.env.PRINT_PARTNER_API_KEY = prevKey;
    if (prevDataDir === undefined) delete process.env.PRINT_PARTNER_DATA_DIR;
    else process.env.PRINT_PARTNER_DATA_DIR = prevDataDir;
    if (prevDeployMode === undefined) delete process.env.DEPLOY_MODE;
    else process.env.DEPLOY_MODE = prevDeployMode;
    if (prevHost === undefined) delete process.env.HOST;
    else process.env.HOST = prevHost;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("requires API key and answers initialize with tools list capability", async () => {
    const config = loadConfig();
    const ports = createPorts(config);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/mcp",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.1" },
        },
      },
    });
    expect(denied.statusCode).toBe(401);

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-mcp-key",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.1" },
        },
      },
    });
    expect(ok.statusCode).toBe(200);
    const text = ok.body;
    expect(text).toMatch(/print-partner-assistant|tools/i);
    const sessionId = ok.headers["mcp-session-id"];
    expect(typeof sessionId === "string" && sessionId.length > 0).toBe(true);

    await app.close();
    await ports.db.close();
  });

  it("fails closed without API key when HOST is not loopback", async () => {
    delete process.env.PRINT_PARTNER_API_KEY;
    process.env.HOST = "0.0.0.0";
    const config = loadConfig();
    expect(config.integrationApiKey).toBeNull();
    expect(isLoopbackBindHost(config.host)).toBe(false);

    const ports = createPorts(config);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mcp",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.1" },
        },
      },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.json())).toMatch(/PRINT_PARTNER_API_KEY/i);

    await app.close();
    await ports.db.close();
  });

  it("accepts a settings-created API key with timing-safe shared validation", async () => {
    delete process.env.PRINT_PARTNER_API_KEY;
    process.env.HOST = "0.0.0.0";
    const config = loadConfig();
    const ports = createPorts(config);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    const created = await app.inject({
      method: "POST",
      url: "/settings/api-keys",
      remoteAddress: "127.0.0.1",
    });
    expect(created.statusCode).toBe(201);
    const { key } = created.json() as { key: string };

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/mcp",
      remoteAddress: "203.0.113.10",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${key}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.1" },
        },
      },
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["mcp-session-id"]).toBeTypeOf("string");
    await app.close();
    await ports.db.close();
  });
});

describe("pruneMcpSessions", () => {
  function mkSession(id: string, createdAt: number, lastAccessAt: number) {
    const transportClose = vi.fn();
    const serverClose = vi.fn();
    return {
      id,
      session: {
        transport: { close: transportClose },
        server: { close: serverClose },
        pending: new Map(),
        createdAt,
        lastAccessAt,
      },
      transportClose,
      serverClose,
    };
  }

  it("evicts idle and absolute-expired sessions and closes transport", () => {
    const now = 1_000_000;
    const idle = mkSession("idle", now - 100, now - 500);
    const absolute = mkSession("abs", now - 10_000, now - 1);
    const live = mkSession("live", now - 100, now - 1);
    const sessions = new Map<string, (typeof idle)["session"]>([
      ["idle", idle.session],
      ["abs", absolute.session],
      ["live", live.session],
    ]);

    const evicted = pruneMcpSessions(sessions as never, now, {
      max: 64,
      idleMs: 200,
      absoluteMs: 5_000,
    });
    expect(evicted).toBe(2);
    expect(sessions.has("live")).toBe(true);
    expect(sessions.has("idle")).toBe(false);
    expect(sessions.has("abs")).toBe(false);
    expect(idle.transportClose).toHaveBeenCalled();
    expect(absolute.transportClose).toHaveBeenCalled();
    expect(live.transportClose).not.toHaveBeenCalled();
  });

  it("enforces max count by evicting oldest lastAccess first", () => {
    const now = 1_000_000;
    const a = mkSession("a", now, now - 30);
    const b = mkSession("b", now, now - 20);
    const c = mkSession("c", now, now - 10);
    const sessions = new Map<string, (typeof a)["session"]>([
      ["a", a.session],
      ["b", b.session],
      ["c", c.session],
    ]);

    const evicted = pruneMcpSessions(sessions as never, now, {
      max: 2,
      idleMs: 60_000,
      absoluteMs: 60_000,
    });
    expect(evicted).toBe(1);
    expect([...sessions.keys()].sort()).toEqual(["b", "c"]);
    expect(a.transportClose).toHaveBeenCalled();
    expect(b.transportClose).not.toHaveBeenCalled();
  });
});

