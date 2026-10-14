import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrinterHostStatus } from "@print-partner/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { loadConfig } from "../config.js";
import { StatusExecution } from "../integrations/status-execution.js";
import { createIntegrationPort, type IntegrationAdapter } from "../integrations/store.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import { registerTenantMiddleware } from "./auth.js";
import { registerIntegrationRoutes } from "./integrations.js";

const invalid = { status: 500, title: "Internal Server Error", detail: "Stored feature toggles are invalid.", code: "FEATURE_TOGGLES_INVALID" };
const missing = { status: 404, title: "Not Found", detail: "Integration not found" };
const operations = ["status", "devices", "test"] as const;
const outputs = { status: { state: "idle", message: "Cached printer ready" }, devices: { devices: [{ id: "printer-1", name: "Workshop printer" }] }, test: { ok: true, message: "Connected to Workshop" } };

describe.each(["bambu", "spoolman"] as const)("%s inspection feature admission", (feature) => {
  const disabled = { status: 403, title: "Forbidden", detail: `Feature ${feature} is disabled.`, code: "FEATURE_DISABLED" };
  let dataDir: string;
  let sqlite: SqliteDatabase;
  let repo: AppRepository;
  let app: FastifyInstance;
  let execution: StatusExecution;
  let integrations: ReturnType<typeof createIntegrationPort>;
  let id: string;
  const cache = new Map<string, PrinterHostStatus>();
  const probe = vi.fn<NonNullable<IntegrationAdapter["getStatus"]>>(async () => {
    const cached = cache.get("printer");
    if (cached) return cached;
    const result: PrinterHostStatus = { state: "idle", message: "Cached printer ready" };
    cache.set("printer", result);
    return result;
  });
  const testConnection = vi.fn(async () => ({ ok: true, message: "Connected to Workshop" }));
  const listDevices = vi.fn(async () => [{ id: "printer-1", name: "Workshop printer" }]);
  beforeEach(async () => {
    vi.stubEnv("PP_DESKTOP_REBUILD", "1");
    vi.stubEnv("DEPLOY_MODE", "self-host");
    cache.clear();
    dataDir = mkdtempSync(join(tmpdir(), `pp-${feature}-features-`));
    sqlite = new SqliteDatabase(dataDir);
    sqlite.connect();
    repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    execution = new StatusExecution();
    integrations = createIntegrationPort({ repo, statusExecution: execution, getAdapter: (type) => ({ type, getStatus: probe, testConnection, listDevices }) });
    id = integrations.create({ type: feature, name: "Workshop", config: { host: "printer", access_code: "secret", url: "http://spoolman.invalid" } }).id;
    app = Fastify();
    app.decorateRequest("tenantId", "default");
    app.addHook("onRequest", (request, _reply, done) => {
      const tenant = request.headers["x-test-tenant"];
      request.tenantId = typeof tenant === "string" ? tenant : "default";
      tenantStorage.run(request.tenantId, done);
    });
    await app.register(async (routes) => registerIntegrationRoutes(routes, { repo, integrations }), { prefix: "/api/v1" });
    await app.ready();
    vi.clearAllMocks();
    vi.spyOn(execution, "probe");
    vi.spyOn(execution, "devices");
    vi.spyOn(execution, "test");
  });
  afterEach(async () => {
    await app.close();
    await execution.stop();
    sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  function inspect(operation: typeof operations[number], integrationId = id, tenant = "default") {
    return app.inject({ method: operation === "test" ? "POST" : "GET", url: `/api/v1/integrations/${integrationId}/${operation}`, headers: { "x-test-tenant": tenant } });
  }
  function noWork() {
    expect(probe).toHaveBeenCalledTimes(0);
    expect(testConnection).toHaveBeenCalledTimes(0);
    expect(listDevices).toHaveBeenCalledTimes(0);
    expect(execution.probe).toHaveBeenCalledTimes(0);
    expect(execution.devices).toHaveBeenCalledTimes(0);
    expect(execution.test).toHaveBeenCalledTimes(0);
    expect(execution.snapshot()).toEqual({ state: "running", tasks: [] });
  }
  async function allowed(operation: typeof operations[number], integrationId = id, tenant = "default") {
    const response = await inspect(operation, integrationId, tenant);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(outputs[operation]);
  }
  for (const operation of operations) {
    it.each([undefined, "{}", JSON.stringify({ [feature]: false })])(`${operation} denies defaults or explicit off %j`, async (value) => {
      if (value !== undefined) repo.setSetting("feature_toggles", value);
      const runtime = vi.spyOn(execution, operation === "status" ? "probe" : operation === "devices" ? "devices" : "test");
      const response = await inspect(operation);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(disabled);
      const absent = await inspect(operation, "missing");
      expect(absent.statusCode).toBe(404);
      expect(absent.json()).toEqual(missing);
      expect(runtime).toHaveBeenCalledTimes(0);
      noWork();
    });
    it.each(["{", "[]", "null", JSON.stringify({ [feature]: "yes" }), JSON.stringify({ [feature]: true, farm: 0 })])(`${operation} rejects invalid snapshot %j`, async (value) => {
      repo.setSetting("feature_toggles", value);
      const response = await inspect(operation);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(invalid);
      const absent = await inspect(operation, "missing");
      expect(absent.statusCode).toBe(404);
      expect(absent.json()).toEqual(missing);
      noWork();
    });
    it(`${operation} opts in then revokes before warm adapter output`, async () => {
      repo.setSetting("feature_toggles", JSON.stringify({ [feature]: true }));
      await allowed(operation);
      expect(probe).toHaveBeenCalledTimes(operation === "status" ? 1 : 0);
      expect(testConnection).toHaveBeenCalledTimes(operation === "test" ? 1 : 0);
      expect(listDevices).toHaveBeenCalledTimes(operation === "devices" ? 1 : 0);
      if (operation === "status") expect(cache.get("printer")).toEqual({ state: "idle", message: "Cached printer ready" });
      vi.clearAllMocks();
      repo.setSetting("feature_toggles", JSON.stringify({ [feature]: false }));
      const runtime = vi.spyOn(execution, operation === "status" ? "probe" : operation === "devices" ? "devices" : "test");
      const denied = await inspect(operation);
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual(disabled);
      expect(runtime).toHaveBeenCalledTimes(0);
      noWork();
      repo.setSetting("feature_toggles", JSON.stringify({ [feature]: true }));
      await allowed(operation);
    });
    it(`${operation} isolates tenant choices, IDs and Plan overrides`, async () => {
      repo.setSetting("feature_toggles:plan:1", JSON.stringify({ [feature]: true }));
      expect((await inspect(operation)).json()).toEqual(disabled);
      repo.setSetting("feature_toggles", JSON.stringify({ [feature]: true }));
      repo.setSetting("feature_toggles:plan:1", JSON.stringify({ [feature]: false }));
      const otherId = tenantStorage.run("other", () => {
        repo.setSetting("feature_toggles", JSON.stringify({ [feature]: false }));
        return integrations.create({ type: feature, name: "Other", config: {} }).id;
      });
      await allowed(operation);
      vi.clearAllMocks();
      expect((await inspect(operation, otherId, "other")).json()).toEqual(disabled);
      for (const [target, tenant] of [[id, "other"], [otherId, "default"], ["missing", "default"]]) {
        const response = await inspect(operation, target, tenant);
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual(missing);
      }
      noWork();
      tenantStorage.run("other", () => repo.setSetting("feature_toggles", JSON.stringify({ [feature]: true })));
      await allowed(operation, otherId, "other");
    });
    it(`${operation} requires its own choice even when the other optional connector is enabled`, async () => {
      repo.setSetting("feature_toggles", JSON.stringify({ [feature === "bambu" ? "spoolman" : "bambu"]: true }));
      const response = await inspect(operation);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(disabled);
      noWork();
    });
    it(`${operation} preserves unrelated inspection with malformed choices`, async () => {
      repo.setSetting("feature_toggles", "invalid JSON");
      const other = integrations.create({ type: "moonraker", name: "Other", config: {} });
      const reads = vi.spyOn(repo, "getSettingSnapshot");
      await allowed(operation, other.id);
      expect(reads).toHaveBeenCalledTimes(0);
    });
  }
  it.each([undefined, "0", "false", "TRUE", "true ", " 1", "yes"])("preserves legacy inspection for flag %j", async (flag) => {
    if (flag === undefined) delete process.env.PP_DESKTOP_REBUILD;
    else vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    repo.setSetting("feature_toggles", "invalid JSON");
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    for (const operation of operations) await allowed(operation);
    expect(reads).toHaveBeenCalledTimes(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(listDevices).toHaveBeenCalledTimes(1);
  });
  it.each(["1", "true"])("requires opt-in for exact flag %j and accepts unknown choices", async (flag) => {
    vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    for (const operation of operations) expect((await inspect(operation)).json()).toEqual(disabled);
    noWork();
    repo.setSetting("feature_toggles", JSON.stringify({ [feature]: true, future: { nested: [null] } }));
    for (const operation of operations) await allowed(operation);
  });
  it("keeps saved metadata and CRUD usable while disabled", async () => {
    repo.setSetting("feature_toggles", "invalid JSON");
    const listed = await app.inject("/api/v1/integrations");
    expect(listed.statusCode).toBe(200);
    expect(listed.json().integrations).toEqual([expect.objectContaining({ id, type: feature, name: "Workshop", config: { host: "printer", access_code: "****", url: "http://spoolman.invalid" }, capabilities: { files: false, cameras: false, status: true } })]);
    const updated = await app.inject({ method: "PATCH", url: `/api/v1/integrations/${id}`, payload: { name: "Renamed" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual(expect.objectContaining({ id, name: "Renamed", config: { host: "printer", access_code: "****", url: "http://spoolman.invalid" } }));
    const created = await app.inject({ method: "POST", url: "/api/v1/integrations", payload: { type: feature, name: "New", config: {} } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual(expect.objectContaining({ type: feature, name: "New", config: {} }));
    expect((await app.inject({ method: "DELETE", url: `/api/v1/integrations/${id}` })).statusCode).toBe(204);
    expect(integrations.list().map((item) => item.name)).toEqual(["New"]);
    noWork();
  });
  it("runs real tenant authentication before admission", async () => {
    const secured = Fastify();
    registerTenantMiddleware(secured, { ...loadConfig(), authRequired: true, multiUser: true }, null);
    await secured.register(async (routes) => registerIntegrationRoutes(routes, { repo, integrations }), { prefix: "/api/v1" });
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    try {
      for (const operation of operations) {
        const response = await secured.inject({ method: operation === "test" ? "POST" : "GET", url: `/api/v1/integrations/${id}/${operation}` });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ detail: "Authentication required" });
      }
      expect(reads).toHaveBeenCalledTimes(0);
      noWork();
    } finally { await secured.close(); }
  });
});
