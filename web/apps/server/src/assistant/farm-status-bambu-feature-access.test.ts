import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PrinterHostStatus } from "@print-partner/contracts";
import type { PrinterMachine } from "@print-partner/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { StatusExecution } from "../integrations/status-execution.js";
import { createIntegrationPort, type IntegrationAdapter, type IntegrationPort } from "../integrations/store.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import { createProductMcpServer } from "../mcp/product-mcp.js";
import { InProcessJobRunner } from "../services/job-runner.js";
import { saveFleet } from "../services/printer-fleet.js";
import { invokeAssistantTool } from "./tools.js";

const telemetry: PrinterHostStatus = {
  state: "paused", filename: "private-bambu-job.gcode", progress: 37, eta_seconds: 123,
  message: "Filament runout private telemetry", nozzle_temperature_c: 215,
};
const savedBambu: PrinterMachine = {
  id: "bambu", name: "Saved Bambu", model: "Moonraker-looking model", integration_id: "moonraker-looking-id",
  bed_width_mm: 250, bed_depth_mm: 250, bed_height_mm: 250, margin_mm: 4, max_filament_slots: 1,
  loaded_filaments: [{ slot: 1, filament_color_id: "catalog:saved-pla", label: "Saved PLA" }],
};
const savedMoonraker: PrinterMachine = {
  ...savedBambu, id: "moonraker", name: "Saved Moonraker", model: "Bambu-looking model", integration_id: "bambu-looking-id",
};
const deniedPrinter = {
  id: "bambu", name: "Saved Bambu", state: "unknown", active_job: null, progress: null,
  eta_seconds: null, message: "Feature bambu is disabled.", integration_id: "moonraker-looking-id",
  idle_since: null,
  filament_slots: [{ slot: 1, label: "Saved PLA", filament_color_id: "catalog:saved-pla",
    remaining_g: null, spool_ids: [], empty: false, low: false }],
  filament_remaining_g: null, needs_filament_swap: false, filament_swap_reason: null,
};
const livePrinter = {
  ...deniedPrinter, state: "paused", active_job: "private-bambu-job.gcode", progress: 37,
  eta_seconds: 123, message: "Filament runout private telemetry", needs_filament_swap: true,
  filament_swap_reason: "printer reports filament runout: Filament runout private telemetry",
};
const deniedFarm = { printer_count: 1, printers: [deniedPrinter], idle: 0, printing: 0,
  offline: 1, needs_filament_swap: [] };
const liveFarm = { printer_count: 1, printers: [livePrinter], idle: 0, printing: 1, offline: 0,
  needs_filament_swap: [{ id: "bambu", name: "Saved Bambu", reason: livePrinter.filament_swap_reason }] };
const invalid = { error: "Stored feature toggles are invalid.", code: "FEATURE_TOGGLES_INVALID" };

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred not initialized"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("farm status Bambu feature admission", () => {
  let root: string;
  let database: SqliteDatabase;
  let repo: AppRepository;
  let execution: StatusExecution;
  let integrations: IntegrationPort;
  let jobs: InProcessJobRunner;
  let clients: Client[];
  const bambu = vi.fn<NonNullable<IntegrationAdapter["getStatus"]>>(async () => telemetry);
  const moonraker = vi.fn<NonNullable<IntegrationAdapter["getStatus"]>>(async () => ({ state: "idle" }));

  function seedFleet(mixed = false) {
    repo.setSetting("integrations", JSON.stringify([
      { id: "moonraker-looking-id", type: "bambu", name: "Synthetic Bambu", config: {} },
      { id: "bambu-looking-id", type: "moonraker", name: "Synthetic Moonraker", config: {} },
    ]));
    saveFleet(repo, mixed ? [savedBambu, savedMoonraker] : [savedBambu]);
  }

  beforeEach(() => {
    vi.stubEnv("PP_DESKTOP_REBUILD", "1");
    vi.stubEnv("HOST", "127.0.0.1");
    root = mkdtempSync(join(tmpdir(), "pp-farm-bambu-"));
    vi.stubEnv("PRINT_PARTNER_DATA_DIR", root);
    database = new SqliteDatabase(root);
    database.connect();
    repo = new AppRepository(getDb(database), undefined, database.reposDir);
    execution = new StatusExecution();
    bambu.mockReset().mockResolvedValue(telemetry);
    moonraker.mockReset().mockResolvedValue({ state: "idle" });
    integrations = createIntegrationPort({ repo, statusExecution: execution,
      getAdapter: (type) => ({ type, getStatus: type === "bambu" ? bambu : moonraker,
        testConnection: async () => ({ ok: true }) }) });
    jobs = new InProcessJobRunner({ getRepo: () => repo, reposDir: database.reposDir,
      exportsDir: join(root, "exports"), dataDir: root });
    clients = [];
    seedFleet();
  });

  afterEach(async () => {
    for (const client of clients) await client.close();
    await execution.stop();
    database.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function mcp(defaultPlanId?: number) {
    const server = createProductMcpServer({ getRepo: () => repo, jobs, statusExecution: execution,
      integrations, config: loadConfig(), pending: new Map(), defaultPlanId });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bambu-feature-test", version: "1" });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  async function call(client?: Client, planId?: number) {
    if (!client) return (await invokeAssistantTool("get_farm_status", { plan_id: planId },
      { repo, integrations, activePlanId: planId })).content;
    const result = await client.callTool({ name: "get_farm_status", arguments: { plan_id: planId } });
    if (!Array.isArray(result.content)) throw new Error("Missing MCP content");
    const text = result.content[0];
    if (!text || text.type !== "text" || typeof text.text !== "string") throw new Error("Missing MCP text");
    return text.text;
  }

  for (const surface of ["assistant", "MCP"]) {
    it.each([undefined, "{}", '{"farm":false,"bambu":true}'])(
      `${surface} preserves the outer farm guard for %j`, async (value) => {
        if (value !== undefined) repo.setSetting("feature_toggles", value);
        const client = surface === "MCP" ? await mcp() : undefined;
        const reads = vi.spyOn(repo, "getSetting");
        expect(JSON.parse(await call(client))).toEqual({ error: "Feature farm is disabled.", code: "FEATURE_DISABLED" });
        expect(reads.mock.calls.filter(([key]) => key === "integrations")).toEqual([]);
        expect(bambu).toHaveBeenCalledTimes(0);
        expect(execution.snapshot()).toEqual({ state: "running", tasks: [] });
      });

    it.each(['{"farm":true}', '{"farm":true,"bambu":false}'])(
      `${surface} denies missing and false Bambu for %j without probing`, async (value) => {
        repo.setSetting("feature_toggles", value);
        const client = surface === "MCP" ? await mcp() : undefined;
        const status = vi.spyOn(integrations, "getStatus");
        expect(JSON.parse(await call(client))).toEqual(deniedFarm);
        expect(status).toHaveBeenCalledTimes(0);
        expect(bambu).toHaveBeenCalledTimes(0);
        expect(execution.snapshot()).toEqual({ state: "running", tasks: [] });
        expect(JSON.parse(repo.getSetting("printer.fleet") ?? "null")).toEqual([savedBambu]);
      });
  }

  it.each(["1", "true"])("supports live enable, revoke and re-enable in one MCP session with flag %j", async (flag) => {
    vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    const client = await mcp();
    for (const enabled of [true, false, true]) {
      repo.setSetting("feature_toggles", JSON.stringify({ farm: true, bambu: enabled, future: { nested: [null] } }));
      bambu.mockClear();
      expect((await client.listTools()).tools.some((tool) => tool.name === "get_farm_status")).toBe(true);
      expect(JSON.parse(await call(client))).toEqual(enabled ? liveFarm : deniedFarm);
      expect(JSON.parse(await call())).toEqual(enabled ? liveFarm : deniedFarm);
      expect(bambu).toHaveBeenCalledTimes(enabled ? 2 : 0);
    }
  });

  it.each([undefined, "0", "false", "TRUE", "True", " true", "true ", "yes", "2", ""])(
    "preserves the exact legacy response without feature reads or port.get for flag %j", async (flag) => {
      if (flag === undefined) delete process.env.PP_DESKTOP_REBUILD;
      else vi.stubEnv("PP_DESKTOP_REBUILD", flag);
      repo.setSetting("feature_toggles", "broken");
      const snapshots = vi.spyOn(repo, "getSettingSnapshot");
      const reads = vi.spyOn(repo, "getSetting");
      const get = vi.spyOn(integrations, "get").mockImplementation(() => { throw new Error("Legacy port has no get"); });
      expect(await call()).toBe(JSON.stringify(liveFarm));
      expect(snapshots).toHaveBeenCalledTimes(0);
      expect(reads.mock.calls.filter(([key]) => key === "integrations")).toEqual([["integrations"]]);
      expect(get).toHaveBeenCalledTimes(0);
      expect(bambu).toHaveBeenCalledTimes(1);
    });

  it("uses canonical connector types and keeps Moonraker usable in a mixed fleet", async () => {
    seedFleet(true);
    repo.setSetting("feature_toggles", '{"farm":true,"bambu":false}');
    const client = await mcp();
    const expected = { printer_count: 2, printers: [deniedPrinter, { ...deniedPrinter,
      id: "moonraker", name: "Saved Moonraker", state: "idle", message: null, integration_id: "bambu-looking-id" }],
    idle: 1, printing: 0, offline: 1, needs_filament_swap: [] };
    expect(JSON.parse(await call())).toEqual(expected);
    expect(JSON.parse(await call(client))).toEqual(expected);
    expect(bambu).toHaveBeenCalledTimes(0);
    expect(moonraker).toHaveBeenCalledTimes(2);
  });

  it.each(['{"farm":true,"bambu":false}', '{"farm":true,"bambu":true}'])(
    "skips corrupt integration elements instead of failing the farm call for %j", async (value) => {
      seedFleet(true);
      const stored = JSON.parse(repo.getSetting("integrations") ?? "[]") as unknown[];
      repo.setSetting("integrations", JSON.stringify([null, 7, "x", [], { type: "bambu" }, ...stored]));
      repo.setSetting("feature_toggles", value);
      const enabled = value.includes('"bambu":true');
      const moonrakerPrinter = { ...deniedPrinter, id: "moonraker", name: "Saved Moonraker", state: "idle",
        message: null, integration_id: "bambu-looking-id" };
      const client = await mcp();
      const expected = enabled
        ? { printer_count: 2, printers: [livePrinter, moonrakerPrinter], idle: 1, printing: 1, offline: 0,
          needs_filament_swap: liveFarm.needs_filament_swap }
        : { printer_count: 2, printers: [deniedPrinter, moonrakerPrinter], idle: 1, printing: 0, offline: 1,
          needs_filament_swap: [] };
      expect(JSON.parse(await call())).toEqual(expected);
      expect(JSON.parse(await call(client))).toEqual(expected);
      expect(bambu).toHaveBeenCalledTimes(enabled ? 2 : 0);
    });

  it("fails closed when the printer's own integration element is corrupt", async () => {
    repo.setSetting("integrations", JSON.stringify([null, { type: "bambu", config: {} }]));
    repo.setSetting("feature_toggles", '{"farm":true,"bambu":true}');
    expect(JSON.parse(await call())).toEqual({ ...deniedFarm,
      printers: [{ ...deniedPrinter, state: "offline", message: "Integration not found" }] });
    expect(bambu).toHaveBeenCalledTimes(0);
    expect(moonraker).toHaveBeenCalledTimes(0);
  });

  it("isolates tenant connector settings and ignores Plan overrides in direct and MCP calls", async () => {
    repo.setSetting("feature_toggles", '{"farm":true,"bambu":false}');
    repo.setSetting("feature_toggles:plan:42", '{"bambu":true}');
    tenantStorage.run("other", () => {
      seedFleet();
      repo.setSetting("feature_toggles", '{"farm":true,"bambu":true}');
      repo.setSetting("feature_toggles:plan:42", '{"bambu":false}');
    });
    const client = await mcp(42);
    const otherClient = await tenantStorage.run("other", () => mcp(42));
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    for (const target of [undefined, client]) expect(JSON.parse(await call(target, 42))).toEqual(deniedFarm);
    for (const target of [undefined, otherClient]) {
      expect(JSON.parse(await tenantStorage.run("other", () => call(target, 42)))).toEqual(liveFarm);
    }
    expect(JSON.parse(await call(client, 42))).toEqual(deniedFarm);
    expect(reads.mock.calls.some(([key]) => key.startsWith("feature_toggles:plan:"))).toBe(false);
    expect(bambu).toHaveBeenCalledTimes(2);
  });

  it.each(["", "{", "[]", "null", '{"farm":true,"bambu":null}', '{"farm":true,"bambu":"true"}',
    '{"farm":true,"bambu":0}'])("fails closed on corrupt settings %j", async (value) => {
    repo.setSetting("feature_toggles", value);
    const client = await mcp();
    expect((await client.listTools()).tools.some((tool) => tool.name === "get_farm_status")).toBe(false);
    expect(JSON.parse(await call())).toEqual(invalid);
    expect(JSON.parse(await call(client))).toEqual(invalid);
    expect(bambu).toHaveBeenCalledTimes(0);
  });

  it("ignores corrupt Plan overrides when Bambu is globally enabled", async () => {
    repo.setSetting("feature_toggles", '{"farm":true,"bambu":true}');
    repo.setSetting("feature_toggles:plan:42", "broken");
    const client = await mcp(42);
    expect(JSON.parse(await call(undefined, 42))).toEqual(liveFarm);
    expect(JSON.parse(await call(client, 42))).toEqual(liveFarm);
    expect(bambu).toHaveBeenCalledTimes(2);
  });

  it.each(["assistant", "MCP"])("%s discards Bambu telemetry revoked while its probe is pending", async (surface) => {
    repo.setSetting("feature_toggles", '{"farm":true,"bambu":true}');
    const entered = deferred<void>();
    const pending = deferred<PrinterHostStatus>();
    bambu.mockImplementation(async () => { entered.resolve(); return pending.promise; });
    const client = surface === "MCP" ? await mcp() : undefined;
    const response = call(client);
    await entered.promise;
    repo.setSetting("feature_toggles", '{"farm":true,"bambu":false}');
    pending.resolve(telemetry);
    expect(JSON.parse(await response)).toEqual(deniedFarm);
    expect(bambu).toHaveBeenCalledTimes(1);
  });

  it.each(["assistant", "MCP"])("%s rechecks an already completed Bambu probe after a slower sibling", async (surface) => {
    seedFleet(true);
    repo.setSetting("feature_toggles", '{"farm":true,"bambu":true}');
    const entered = deferred<void>();
    const pending = deferred<PrinterHostStatus>();
    moonraker.mockImplementation(async () => { entered.resolve(); return pending.promise; });
    const client = surface === "MCP" ? await mcp() : undefined;
    const response = call(client);
    await entered.promise;
    await vi.waitFor(() => expect(execution.snapshot().tasks.map((task) => task.provider)).toEqual(["moonraker"]));
    repo.setSetting("feature_toggles", '{"farm":true,"bambu":false}');
    pending.resolve({ state: "idle" });
    expect(JSON.parse(await response)).toEqual({ printer_count: 2, printers: [deniedPrinter,
      { ...deniedPrinter, id: "moonraker", name: "Saved Moonraker", state: "idle", message: null,
        integration_id: "bambu-looking-id" }], idle: 1, printing: 0, offline: 1, needs_filament_swap: [] });
  });

  it("fails closed if settings become corrupt during an active probe", async () => {
    repo.setSetting("feature_toggles", '{"farm":true,"bambu":true}');
    const entered = deferred<void>();
    const pending = deferred<PrinterHostStatus>();
    bambu.mockImplementation(async () => { entered.resolve(); return pending.promise; });
    const response = call();
    await entered.promise;
    repo.setSetting("feature_toggles", '{"farm":true,"bambu":[]}');
    pending.resolve(telemetry);
    expect(JSON.parse(await response)).toEqual({ ...deniedFarm,
      printers: [{ ...deniedPrinter, message: "Stored feature toggles are invalid." }] });
  });
});
