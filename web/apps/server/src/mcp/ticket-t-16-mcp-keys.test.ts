/**
 * T-16 (GRE-348): HTTP MCP needs a valid API key for every trust class.
 *
 * - desktop: the Node child behind the Rust gateway binds 127.0.0.1 and sees
 *   loopback peers. The Rust gateway also refuses /api/v1/mcp (runtime_m0).
 * - loopback: a local process on a loopback bind.
 * - LAN: a private-network peer on a 0.0.0.0 bind.
 *
 * No case may reach the MCP transport without a key, including the old
 * loopback-bind exemption that let keyless clients in when no deployment key
 * was set.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createPorts } from "../app.js";
import { loadConfig } from "../config.js";

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ticket-t-16", version: "0.0.1" },
  },
};

const TRUST_CLASSES = [
  { name: "desktop", host: "127.0.0.1", peer: "127.0.0.1" },
  { name: "loopback", host: "127.0.0.1", peer: "::1" },
  { name: "LAN", host: "0.0.0.0", peer: "192.168.1.20" },
] as const;

const ENV_KEYS = ["PRINT_PARTNER_API_KEY", "PRINT_PARTNER_DATA_DIR", "DEPLOY_MODE", "HOST"] as const;

describe("ticket_t_16 MCP key enforcement", () => {
  let dataDir: string;
  const saved = new Map<string, string | undefined>();
  const cleanup: Array<() => Promise<void>> = [];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-mcp-t16-"));
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    process.env.PRINT_PARTNER_DATA_DIR = dataDir;
    process.env.DEPLOY_MODE = "self-host";
  });

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function start(host: string, deploymentKey: string | null) {
    process.env.HOST = host;
    if (deploymentKey) process.env.PRINT_PARTNER_API_KEY = deploymentKey;
    else delete process.env.PRINT_PARTNER_API_KEY;
    const config = loadConfig();
    const ports = createPorts(config);
    await ports.db.connect();
    const app = await buildApp(config, ports);
    cleanup.push(async () => {
      await app.close();
      await ports.db.close();
    });
    return app;
  }

  type App = Awaited<ReturnType<typeof start>>;

  function initialize(app: App, peer: string, key?: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/mcp",
      remoteAddress: peer,
      headers: key ? { ...MCP_HEADERS, authorization: `Bearer ${key}` } : MCP_HEADERS,
      payload: INITIALIZE,
    });
  }

  async function createSettingsKey(app: App) {
    const created = await app.inject({
      method: "POST",
      url: "/settings/api-keys",
      remoteAddress: "127.0.0.1",
    });
    expect(created.statusCode).toBe(201);
    return created.json() as { id: string; key: string };
  }

  for (const trust of TRUST_CLASSES) {
    describe(`${trust.name} peer`, () => {
      it("refuses a missing key when no deployment key is set", async () => {
        const app = await start(trust.host, null);
        await createSettingsKey(app);

        const response = await initialize(app, trust.peer);

        expect(response.statusCode).toBe(503);
        expect(response.body).not.toContain("protocolVersion");
        expect(response.headers["mcp-session-id"]).toBeUndefined();
      });

      it("refuses missing and invalid keys when a deployment key is set", async () => {
        const app = await start(trust.host, "t16-deployment-key");

        const missing = await initialize(app, trust.peer);
        expect(missing.statusCode).toBe(401);
        expect(missing.json()).toMatchObject({ detail: "Valid API key required" });

        for (const bad of ["t16-wrong-key", "ppk_0000000000000000000000000000000000000000"]) {
          const invalid = await initialize(app, trust.peer, bad);
          expect(invalid.statusCode).toBe(401);
          expect(invalid.body).not.toContain("protocolVersion");
        }
      });

      it("accepts a valid ppk_ Settings key and refuses it after revocation", async () => {
        const app = await start(trust.host, null);
        const { id, key } = await createSettingsKey(app);
        expect(key).toMatch(/^ppk_/);

        const accepted = await initialize(app, trust.peer, key);
        expect(accepted.statusCode).toBe(200);
        expect(accepted.headers["mcp-session-id"]).toBeTypeOf("string");

        const revoked = await app.inject({
          method: "DELETE",
          url: `/settings/api-keys/${id}`,
          remoteAddress: "127.0.0.1",
        });
        expect(revoked.statusCode).toBe(200);

        const refused = await initialize(app, trust.peer, key);
        expect(refused.statusCode).toBe(401);
        expect(refused.headers["mcp-session-id"]).toBeUndefined();
      });

      it("accepts the deployment key", async () => {
        const app = await start(trust.host, "t16-deployment-key");

        const accepted = await initialize(app, trust.peer, "t16-deployment-key");

        expect(accepted.statusCode).toBe(200);
        expect(accepted.headers["mcp-session-id"]).toBeTypeOf("string");
      });
    });
  }
});
