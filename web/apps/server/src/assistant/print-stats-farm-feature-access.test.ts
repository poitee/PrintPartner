import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { StatusExecution } from "../integrations/status-execution.js";
import { createProductMcpServer } from "../mcp/product-mcp.js";
import { InProcessJobRunner } from "../services/job-runner.js";
import { invokeAssistantTool } from "./tools.js";

const disabled = { error: "Feature farm is disabled.", code: "FEATURE_DISABLED" };
const invalid = { error: "Stored feature toggles are invalid.", code: "FEATURE_TOGGLES_INVALID" };
const emptyStats = expect.objectContaining({
  plates_sent: 0,
  plates_completed: 0,
  plates_failed: 0,
});

function toolData(result: Awaited<ReturnType<Client["callTool"]>>) {
  if (!Array.isArray(result.content)) throw new Error("Missing content");
  const text = result.content[0];
  if (!text || text.type !== "text" || typeof text.text !== "string")
    throw new Error("Missing text");
  return JSON.parse(text.text);
}

describe("get_print_stats farm feature admission", () => {
  let root: string;
  let database: SqliteDatabase;
  let repo: AppRepository;
  let jobs: InProcessJobRunner;
  let execution: StatusExecution;
  let clients: Client[];

  beforeEach(() => {
    vi.stubEnv("PP_DESKTOP_REBUILD", "1");
    vi.stubEnv("HOST", "127.0.0.1");
    root = mkdtempSync(join(tmpdir(), "pp-print-stats-farm-"));
    vi.stubEnv("PRINT_PARTNER_DATA_DIR", root);
    database = new SqliteDatabase(root);
    database.connect();
    repo = new AppRepository(getDb(database), undefined, database.reposDir);
    jobs = new InProcessJobRunner({
      getRepo: () => repo,
      reposDir: database.reposDir,
      exportsDir: join(root, "exports"),
      dataDir: root,
    });
    execution = new StatusExecution();
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) await client.close();
    await execution.stop();
    database.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function mcp() {
    const server = createProductMcpServer({
      getRepo: () => repo,
      jobs,
      statusExecution: execution,
      config: loadConfig(),
      pending: new Map(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "print-stats-farm-test", version: "1" });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  async function assistant() {
    return JSON.parse((await invokeAssistantTool("get_print_stats", {}, { repo })).content);
  }

  it.each([undefined, "{}", '{"farm":false}'])(
    "assistant and MCP deny missing/false farm for %j without reading print jobs",
    async (stored) => {
      if (stored !== undefined) repo.setSetting("feature_toggles", stored);
      const jobsSpy = vi.spyOn(repo, "recentPrintJobs");
      const client = await mcp();
      expect((await client.listTools()).tools.some((tool) => tool.name === "get_print_stats")).toBe(
        false,
      );
      const call = await client.callTool({ name: "get_print_stats", arguments: {} });
      expect(call.isError).toBe(true);
      expect(toolData(call)).toEqual(disabled);
      expect(await assistant()).toEqual(disabled);
      expect(jobsSpy).toHaveBeenCalledTimes(0);
    },
  );

  it("allows farm true on assistant and MCP, and lists the tool", async () => {
    repo.setSetting("feature_toggles", '{"farm":true}');
    const client = await mcp();
    expect((await client.listTools()).tools.some((tool) => tool.name === "get_print_stats")).toBe(
      true,
    );
    expect(toolData(await client.callTool({ name: "get_print_stats", arguments: {} }))).toEqual(
      emptyStats,
    );
    expect(await assistant()).toEqual(emptyStats);
  });

  it.each(["{", "[]", "null", "", '{"farm":"yes"}'])(
    "fails closed on corrupt toggles %j and hides the tool",
    async (value) => {
      repo.setSetting("feature_toggles", value);
      const jobsSpy = vi.spyOn(repo, "recentPrintJobs");
      const client = await mcp();
      expect((await client.listTools()).tools.some((tool) => tool.name === "get_print_stats")).toBe(
        false,
      );
      const call = await client.callTool({ name: "get_print_stats", arguments: {} });
      expect(call.isError).toBe(true);
      expect(toolData(call)).toEqual(invalid);
      expect(await assistant()).toEqual(invalid);
      expect(jobsSpy).toHaveBeenCalledTimes(0);
    },
  );

  it.each([undefined, "0", "false", "TRUE", "yes", ""])(
    "flag %j keeps legacy stats without feature reads",
    async (flag) => {
      if (flag === undefined) delete process.env.PP_DESKTOP_REBUILD;
      else vi.stubEnv("PP_DESKTOP_REBUILD", flag);
      repo.setSetting("feature_toggles", "broken");
      const snapshots = vi.spyOn(repo, "getSettingSnapshot");
      expect(await assistant()).toEqual(emptyStats);
      expect(snapshots).toHaveBeenCalledTimes(0);
    },
  );

  it("open MCP session hides and denies on revoke, then restores on re-enable", async () => {
    repo.setSetting("feature_toggles", '{"farm":true}');
    const client = await mcp();
    expect((await client.listTools()).tools.some((tool) => tool.name === "get_print_stats")).toBe(
      true,
    );
    expect(toolData(await client.callTool({ name: "get_print_stats", arguments: {} }))).toEqual(
      emptyStats,
    );

    repo.setSetting("feature_toggles", '{"farm":false}');
    const jobsSpy = vi.spyOn(repo, "recentPrintJobs");
    expect((await client.listTools()).tools.some((tool) => tool.name === "get_print_stats")).toBe(
      false,
    );
    const denied = await client.callTool({ name: "get_print_stats", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(toolData(denied)).toEqual(disabled);
    expect(await assistant()).toEqual(disabled);
    expect(jobsSpy).toHaveBeenCalledTimes(0);

    repo.setSetting("feature_toggles", '{"farm":true}');
    expect((await client.listTools()).tools.some((tool) => tool.name === "get_print_stats")).toBe(
      true,
    );
    expect(toolData(await client.callTool({ name: "get_print_stats", arguments: {} }))).toEqual(
      emptyStats,
    );
  });
});
