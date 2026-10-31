import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAssistantTool } from "../assistant/tools.js";
import { loadConfig } from "../config.js";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { StatusExecution } from "../integrations/status-execution.js";
import { createIntegrationPort } from "../integrations/store.js";
import { getIntegrationAdapter } from "../integrations/registry.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import { createProductMcpServer } from "../mcp/product-mcp.js";
import { registerMcpHttpRoutes } from "../mcp/http-routes.js";
import { registerPrinterSendQueueRoutes } from "../routes/printer-send-queue.js";
import { InProcessJobRunner } from "../services/job-runner.js";
import { saveFleet } from "../services/printer-fleet.js";

const disabled = { error: "Feature farm is disabled.", code: "FEATURE_DISABLED" };
const invalid = { error: "Stored feature toggles are invalid.", code: "FEATURE_TOGGLES_INVALID" };
function toolData(result: Awaited<ReturnType<Client["callTool"]>>) {
  if (!Array.isArray(result.content)) throw new Error("Missing content");
  const text = result.content[0];
  if (!text || text.type !== "text" || typeof text.text !== "string")
    throw new Error("Missing text");
  return JSON.parse(text.text);
}

describe("tenant-global farm access through live handlers", () => {
  let dataDir: string;
  let sqlite: SqliteDatabase;
  let repo: AppRepository;
  let app: FastifyInstance;
  let jobs: InProcessJobRunner;
  let clients: Client[];
  let statusExecution: StatusExecution;
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-farm-access-"));
    vi.stubEnv("PRINT_PARTNER_DATA_DIR", dataDir);
    vi.stubEnv("HOST", "127.0.0.1");
    vi.stubEnv("DEPLOY_MODE", "self-host");
    vi.stubEnv("PRINT_PARTNER_API_KEY", "farm-test-key");
    vi.stubEnv("PP_DESKTOP_REBUILD", "1");
    statusExecution = new StatusExecution();
    sqlite = new SqliteDatabase(dataDir);
    sqlite.connect();
    repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    saveFleet(repo, []);
    jobs = new InProcessJobRunner({
      getRepo: () => repo,
      reposDir: sqlite.reposDir,
      exportsDir: join(dataDir, "exports"),
      dataDir,
    });
    const integrations = createIntegrationPort({
      repo,
      getAdapter: getIntegrationAdapter,
      statusExecution,
    });
    app = Fastify();
    app.decorateRequest("tenantId", "default");
    app.addHook("onRequest", (request, _reply, done) => {
      const tenant = request.headers["x-test-tenant"];
      request.tenantId = typeof tenant === "string" ? tenant : "default";
      tenantStorage.run(request.tenantId, done);
    });
    const deps = { repo, integrations, jobs };
    await app.register(async (routes) => registerPrinterSendQueueRoutes(routes, deps));
    await app.register(async (routes) => registerPrinterSendQueueRoutes(routes, deps), {
      prefix: "/api/v1",
    });
    await app.register(
      async (routes) =>
        registerMcpHttpRoutes(routes, {
          getRepo: () => repo,
          jobs,
          statusExecution,
          config: loadConfig(),
          validateApiKey: (key) => key === "farm-test-key",
        }),
      { prefix: "/api/v1" },
    );
    clients = [];
    await app.ready();
  });
  afterEach(async () => {
    for (const client of clients) await client.close();
    await app.close();
    await statusExecution.stop();
    sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  async function mcp(getRepo = () => repo) {
    const server = createProductMcpServer({
      getRepo,
      jobs,
      statusExecution,
      config: loadConfig(),
      pending: new Map(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "farm-test", version: "1" });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }
  it("MCP tools/list includes farm with an unset rebuild flag without acquiring the repository", async () => {
    delete process.env.PP_DESKTOP_REBUILD;
    const client = await mcp(() => {
      throw new Error("tools/list must not read the repository");
    });
    expect((await client.listTools()).tools.some((tool) => tool.name === "get_farm_status")).toBe(
      true,
    );
  });
  for (const prefix of ["", "/api/v1"]) {
    it(`${prefix || "root"} suggestions deny missing and false farm, allow true, and leave the single-printer queue available`, async () => {
      for (const value of [undefined, '{"farm":false}', '{"farm":true}']) {
        if (value !== undefined) repo.setSetting("feature_toggles", value);
        const response = await app.inject(`${prefix}/printer-send-queue/suggestions`);
        expect(response.statusCode).toBe(value === '{"farm":true}' ? 200 : 403);
        expect(response.json()).toEqual(
          value === '{"farm":true}'
            ? { suggestions: [] }
            : {
                status: 403,
                title: "Forbidden",
                detail: disabled.error,
                code: disabled.code,
              },
        );
        const queue = await app.inject(`${prefix}/printer-send-queue`);
        expect(queue.statusCode).toBe(200);
        expect(queue.json()).toEqual({ items: [] });
      }
    });
  }
  it.each(["1", "true", "TRUE", "True", " true", "true ", "0", "false", ""])(
    "runtime spelling %j gates only exact 1 and true",
    async (flag) => {
      vi.stubEnv("PP_DESKTOP_REBUILD", flag);
      repo.setSetting("feature_toggles", "invalid JSON");
      const reads = vi.spyOn(repo, "getSettingSnapshot");
      const gated = flag === "1" || flag === "true";
      expect((await app.inject("/printer-send-queue/suggestions")).statusCode).toBe(
        gated ? 500 : 200,
      );
      const client = await mcp();
      expect((await client.listTools()).tools.some((tool) => tool.name === "get_farm_status")).toBe(
        !gated,
      );
      expect(toolData(await client.callTool({ name: "get_farm_status" }))).toEqual(
        gated ? invalid : expect.objectContaining({ printer_count: 0 }),
      );
      expect(reads.mock.calls.length).toBe(gated ? 3 : 0);
    },
  );
  it("an unset rebuild flag preserves farm behavior without reading feature storage", async () => {
    delete process.env.PP_DESKTOP_REBUILD;
    repo.setSetting("feature_toggles", "");
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    expect((await app.inject("/api/v1/printer-send-queue/suggestions")).json()).toEqual({
      suggestions: [],
    });
    expect(
      JSON.parse((await invokeAssistantTool("get_farm_status", {}, { repo })).content),
    ).toMatchObject({ printer_count: 0 });
    expect(reads.mock.calls).toEqual([]);
  });
  it.each([
    "{",
    "[]",
    "null",
    "",
    '"text"',
    '{"farm":"yes"}',
    '{"farm":true,"orders":0}',
    '{"farm":true,"bambu":null}',
    '{"farm":true,"spoolman":[]}',
  ])("stored %j fails closed in HTTP, MCP, and assistant with settings-invalid", async (value) => {
    repo.setSetting("feature_toggles", value);
    for (const prefix of ["", "/api/v1"]) {
      const response = await app.inject(`${prefix}/printer-send-queue/suggestions`);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        status: 500,
        title: "Internal Server Error",
        detail: invalid.error,
        code: invalid.code,
      });
    }
    const client = await mcp();
    expect((await client.listTools()).tools.some((tool) => tool.name === "get_farm_status")).toBe(
      false,
    );
    const call = await client.callTool({ name: "get_farm_status" });
    expect(call.isError).toBe(true);
    expect(toolData(call)).toEqual(invalid);
    expect(
      JSON.parse((await invokeAssistantTool("get_farm_status", {}, { repo })).content),
    ).toEqual(invalid);
  });
  it("known optional booleans and arbitrary unknown values allow farm, while an empty object defaults to disabled", async () => {
    repo.setSetting(
      "feature_toggles",
      JSON.stringify({
        farm: true,
        orders: false,
        bambu: true,
        spoolman: false,
        unknown: { any: [null, "value"] },
      }),
    );
    expect((await app.inject("/printer-send-queue/suggestions")).json()).toEqual({
      suggestions: [],
    });
    repo.setSetting("feature_toggles", "{}");
    expect((await app.inject("/printer-send-queue/suggestions")).statusCode).toBe(403);
  });
  it("tenant settings stay isolated and Plan rows never enable or disable tenant-global farm", async () => {
    repo.setSetting("feature_toggles:plan:1", '{"farm":true}');
    expect((await app.inject("/printer-send-queue/suggestions")).statusCode).toBe(403);
    repo.setSetting("feature_toggles", '{"farm":true}');
    repo.setSetting("feature_toggles:plan:1", '{"farm":false}');
    tenantStorage.run("other", () => repo.setSetting("feature_toggles", '{"farm":false}'));
    for (const prefix of ["", "/api/v1"]) {
      expect((await app.inject(`${prefix}/printer-send-queue/suggestions`)).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            url: `${prefix}/printer-send-queue/suggestions`,
            headers: { "x-test-tenant": "other" },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      JSON.parse(
        (
          await tenantStorage.run("other", () =>
            invokeAssistantTool("get_farm_status", {}, { repo }),
          )
        ).content,
      ),
    ).toEqual(disabled);
    expect(
      JSON.parse((await invokeAssistantTool("get_farm_status", {}, { repo })).content),
    ).toMatchObject({ printer_count: 0 });
  });
  it("an open MCP session re-reads enable, disable, hidden list, cached call, and re-enable without farm effects on denial", async () => {
    repo.setSetting("feature_toggles", '{"farm":true}');
    const client = await mcp();
    expect((await client.listTools()).tools.some((tool) => tool.name === "get_farm_status")).toBe(
      true,
    );
    expect(toolData(await client.callTool({ name: "get_farm_status" }))).toMatchObject({
      printer_count: 0,
    });
    repo.setSetting("feature_toggles", '{"farm":false}');
    const reads = vi.spyOn(repo, "getSetting");
    const network = vi.fn(() => {
      throw new Error("Farm denial reached network");
    });
    vi.stubGlobal("fetch", network);
    const list = await client.listTools();
    expect(list.tools.some((tool) => tool.name === "get_farm_status")).toBe(false);
    expect(list.tools.some((tool) => tool.name === "get_print_stats")).toBe(false);
    const call = await client.callTool({ name: "get_farm_status" });
    expect(call.isError).toBe(true);
    expect(toolData(call)).toEqual(disabled);
    expect(
      JSON.parse((await invokeAssistantTool("get_farm_status", {}, { repo })).content),
    ).toEqual(disabled);
    expect(reads.mock.calls).toEqual([]);
    expect(network.mock.calls).toEqual([]);
    expect(toolData(await client.callTool({ name: "list_pending_actions" }))).toEqual({
      actions: [],
    });
    const stats = await client.callTool({ name: "get_print_stats" });
    expect(stats.isError).toBe(true);
    expect(toolData(stats)).toEqual(disabled);
    expect(
      JSON.parse((await invokeAssistantTool("get_print_stats", {}, { repo })).content),
    ).toEqual(disabled);
    const unknown = await client.callTool({ name: "missing_tool" });
    expect(unknown.isError).toBe(true);
    expect(toolData(unknown)).toEqual({ error: "Unknown tool: missing_tool" });
    repo.setSetting("feature_toggles", '{"farm":true}');
    expect((await client.listTools()).tools.some((tool) => tool.name === "get_farm_status")).toBe(
      true,
    );
    expect((await client.listTools()).tools.some((tool) => tool.name === "get_print_stats")).toBe(
      true,
    );
    expect(toolData(await client.callTool({ name: "get_farm_status" }))).toMatchObject({
      printer_count: 0,
    });
    expect(toolData(await client.callTool({ name: "get_print_stats" }))).toMatchObject({
      plates_sent: 0,
    });
    expect(
      JSON.parse((await invokeAssistantTool("get_farm_status", {}, { repo })).content),
    ).toMatchObject({ printer_count: 0 });
  });
  it("denied assistant calls skip fleet, host and Spoolman reads that enabled calls perform", async () => {
    const integrations = createIntegrationPort({
      repo,
      getAdapter: getIntegrationAdapter,
      statusExecution,
    });
    const spoolman = integrations.create({
      type: "spoolman",
      name: "Workshop",
      config: { base_url: "http://127.0.0.1:7912" },
    });
    saveFleet(repo, [
      {
        id: "printer",
        name: "Printer",
        model: "Printer",
        bed_width_mm: 250,
        bed_depth_mm: 250,
        bed_height_mm: 250,
        margin_mm: 4,
        max_filament_slots: 1,
        integration_id: "host",
        loaded_filaments: [
          { slot: 1, filament_color_id: `spoolman:${spoolman.id}:filament:7`, label: "PLA" },
        ],
      },
    ]);
    const host = vi.spyOn(integrations, "getStatus").mockResolvedValue({ state: "idle" });
    const network = vi.fn(
      async () =>
        new Response(JSON.stringify([{ id: 11, filament_id: 7, remaining_weight: 480 }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", network);
    const reads = vi.spyOn(repo, "getSetting");
    for (const value of ['{"farm":false}', '{"farm":"invalid"}']) {
      repo.setSetting("feature_toggles", value);
      const result = await invokeAssistantTool("get_farm_status", {}, { repo, integrations });
      expect(JSON.parse(result.content)).toEqual(value === '{"farm":false}' ? disabled : invalid);
      expect(reads.mock.calls).toEqual([]);
      expect(host.mock.calls).toEqual([]);
      expect(network.mock.calls).toEqual([]);
      expect((await app.inject("/printer-send-queue/suggestions")).statusCode).toBe(
        value === '{"farm":false}' ? 403 : 500,
      );
      expect(reads.mock.calls).toEqual(value === '{"farm":false}' ? [["printer.send_queue"]] : []);
      reads.mockClear();
    }
    repo.setSetting("feature_toggles", '{"farm":true}');
    const deniedInventory = JSON.parse(
      (await invokeAssistantTool("get_farm_status", {}, { repo, integrations })).content,
    );
    expect(deniedInventory.printers).toEqual([
      expect.objectContaining({ id: "printer", state: "idle", filament_remaining_g: null }),
    ]);
    expect(network).not.toHaveBeenCalled();
    host.mockClear();
    repo.setSetting("feature_toggles", '{"farm":true,"spoolman":true}');
    const result = JSON.parse(
      (await invokeAssistantTool("get_farm_status", {}, { repo, integrations })).content,
    );
    expect(result.printers).toEqual([
      expect.objectContaining({ id: "printer", state: "idle", filament_remaining_g: 480 }),
    ]);
    expect(host.mock.calls).toEqual([["host"]]);
    expect(network.mock.calls.length).toBe(1);
    expect(reads.mock.calls.some(([key]) => key === "printer.fleet")).toBe(true);
  });
  it("HTTP MCP uses the current request tenant in an existing session and re-reads toggles", async () => {
    repo.setSetting("feature_toggles", '{"farm":true}');
    tenantStorage.run("other", () => repo.setSetting("feature_toggles", '{"farm":false}'));
    const headers = {
      authorization: "Bearer farm-test-key",
      accept: "application/json, text/event-stream",
    };
    const initialized = await app.inject({
      method: "POST",
      url: "/api/v1/mcp",
      headers,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "farm-http", version: "1" },
        },
      },
    });
    expect(initialized.statusCode).toBe(200);
    const session = initialized.headers["mcp-session-id"];
    if (typeof session !== "string") throw new Error("No MCP session id");
    let id = 1;
    async function rpc(method: string, tenant = "default", params = {}) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/mcp",
        headers: { ...headers, "mcp-session-id": session, "x-test-tenant": tenant },
        payload: { jsonrpc: "2.0", id: ++id, method, params },
      });
      expect(response.statusCode).toBe(200);
      const data = response.body.split("\n").find((line) => line.startsWith("data: "));
      if (!data) throw new Error(`No SSE data in ${response.body}`);
      return JSON.parse(data.slice(6)).result;
    }
    expect(
      (await rpc("tools/list")).tools.some(
        (tool: { name: string }) => tool.name === "get_farm_status",
      ),
    ).toBe(true);
    expect(
      (await rpc("tools/list", "other")).tools.some(
        (tool: { name: string }) => tool.name === "get_farm_status",
      ),
    ).toBe(false);
    const denied = await rpc("tools/call", "other", { name: "get_farm_status" });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0].text)).toEqual(disabled);
    repo.setSetting("feature_toggles", '{"farm":false}');
    expect(
      (await rpc("tools/list")).tools.some(
        (tool: { name: string }) => tool.name === "get_farm_status",
      ),
    ).toBe(false);
    repo.setSetting("feature_toggles", '{"farm":true}');
    expect(
      JSON.parse((await rpc("tools/call", "default", { name: "get_farm_status" })).content[0].text),
    ).toMatchObject({ printer_count: 0 });
  });
});
