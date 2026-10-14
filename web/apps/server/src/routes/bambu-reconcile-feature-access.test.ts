import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { StatusExecution } from "../integrations/status-execution.js";
import { createIntegrationPort, type IntegrationAdapter } from "../integrations/store.js";
import * as registry from "../integrations/registry.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import { loadConfig } from "../config.js";
import { registerTenantMiddleware } from "./auth.js";
import { registerPrinterCheckoffRoutes } from "./printer-checkoff.js";
import { loadPrinterCheckoffLinks } from "../services/printer-checkoff-store.js";
import * as checkoff from "../services/printer-checkoff.js";
import { listUnattributedPrints } from "../services/unattributed-print-store.js";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";

const disabled = { status: 403, title: "Forbidden", detail: "Feature bambu is disabled.", code: "FEATURE_DISABLED" };
const invalid = { status: 500, title: "Internal Server Error", detail: "Stored feature toggles are invalid.", code: "FEATURE_TOGGLES_INVALID" };
const idle = { state: "idle", message: "Ready" };
const output = { status: idle, updates: [], created_links: [], applied: [], unattributed: [] };
const urls = ["/printer-checkoff/reconcile", "/api/v1/printer-checkoff/reconcile"];

describe("Bambu checkoff reconcile feature admission", () => {
  let root: string;
  let sqlite: SqliteDatabase;
  let repo: AppRepository;
  let app: FastifyInstance;
  let execution: StatusExecution;
  let integrations: ReturnType<typeof createIntegrationPort>;
  let id: string;
  const probe = vi.fn<NonNullable<IntegrationAdapter["getStatus"]>>(async () => ({ state: "idle", message: "Ready" }));
  const objects = vi.fn(async () => []);

  beforeEach(async () => {
    probe.mockReset();
    probe.mockResolvedValue({ state: "idle", message: "Ready" });
    vi.stubEnv("PP_DESKTOP_REBUILD", "1");
    vi.stubEnv("DEPLOY_MODE", "self-host");
    root = mkdtempSync(join(tmpdir(), "pp-bambu-reconcile-"));
    sqlite = new SqliteDatabase(root);
    sqlite.connect();
    repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    execution = new StatusExecution();
    const adapter = (type: string): IntegrationAdapter | undefined => {
      if (type !== "bambu" && type !== "moonraker" && type !== "prusalink") return undefined;
      return { type, getStatus: probe, getObjectList: objects, testConnection: async () => ({ ok: true }) };
    };
    vi.spyOn(registry, "getIntegrationAdapter").mockImplementation(adapter);
    integrations = createIntegrationPort({ repo, statusExecution: execution, getAdapter: adapter });
    id = integrations.create({ type: "bambu", name: "Workshop", config: { host: "printer" } }).id;
    app = Fastify();
    app.decorateRequest("tenantId", "default");
    app.addHook("onRequest", (request, _reply, done) => {
      const tenant = request.headers["x-test-tenant"];
      request.tenantId = typeof tenant === "string" ? tenant : "default";
      tenantStorage.run(request.tenantId, done);
    });
    await registerPrinterCheckoffRoutes(app, { repo, integrations });
    await app.register(async (routes) => registerPrinterCheckoffRoutes(routes, { repo, integrations }), { prefix: "/api/v1" });
    await app.ready();
    vi.clearAllMocks();
    vi.spyOn(checkoff, "observePrinterCheckoffFileDrift");
    vi.spyOn(checkoff, "reconcilePrinterCheckoff");
  });
  afterEach(async () => {
    await app.close();
    await execution.stop();
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  function reconcile(url = urls[0], integrationId = id, tenant = "default") {
    return app.inject({ method: "POST", url, payload: { integration_id: integrationId }, headers: { "x-test-tenant": tenant } });
  }
  function noWork(storage = repo) {
    expect(probe).not.toHaveBeenCalled();
    expect(objects).not.toHaveBeenCalled();
    expect(checkoff.observePrinterCheckoffFileDrift).not.toHaveBeenCalled();
    expect(checkoff.reconcilePrinterCheckoff).not.toHaveBeenCalled();
    expect(execution.snapshot()).toEqual({ state: "running", tasks: [] });
    expect(loadPrinterCheckoffLinks(storage)).toEqual([]);
    expect(listUnattributedPrints(storage)).toEqual([]);
  }
  for (const url of urls) {
    it.each([undefined, "{}", '{"bambu":false}', '{"farm":true,"spoolman":true}'])(`${url} denies defaults or explicit off %j`, async (stored) => {
      if (stored !== undefined) repo.setSetting("feature_toggles", stored);
      probe.mockResolvedValueOnce({ state: "complete", filename: "finished.gcode" });
      const writes = vi.spyOn(repo, "setSetting");
      const response = await reconcile(url);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(disabled);
      expect(writes).not.toHaveBeenCalled();
      noWork();
    });
    it.each(["", "{", "[]", "null", '{"bambu":null}', '{"bambu":"true"}', '{"bambu":true,"orders":0}'])(`${url} fails closed on corrupt choices %j`, async (stored) => {
      repo.setSetting("feature_toggles", stored);
      const response = await reconcile(url);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(invalid);
      noWork();
    });
    it(`${url} reads current opt-in after live revoke and re-enable`, async () => {
      for (const enabled of [true, false, true]) {
        repo.setSetting("feature_toggles", JSON.stringify({ bambu: enabled, future: { option: 1 } }));
        vi.clearAllMocks();
        const response = await reconcile(url);
        expect(response.statusCode).toBe(enabled ? 200 : 403);
        expect(response.json()).toEqual(enabled ? output : disabled);
        expect(probe).toHaveBeenCalledTimes(enabled ? 1 : 0);
        if (!enabled) noWork();
      }
    });
    it(`${url} preserves input and missing connector errors`, async () => {
      expect((await reconcile(url, "")).statusCode).toBe(400);
      const response = await reconcile(url, "missing");
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ status: 404, title: "Not Found", detail: "Integration not found" });
      noWork();
    });
  }
  it("isolates tenant choices and ignores Plan overrides for connector-wide polling", async () => {
    const plan = repo.createProfile("Bambu checkoff");
    repo.setSetting(`feature_toggles:plan:${plan.id}`, '{"bambu":true}');
    expect((await reconcile()).json()).toEqual(disabled);
    repo.setSetting("feature_toggles", '{"bambu":true}');
    repo.setSetting(`feature_toggles:plan:${plan.id}`, '{"bambu":false}');
    const otherId = tenantStorage.run("other", () => {
      repo.setSetting("feature_toggles", '{"bambu":false}');
      return integrations.create({ type: "bambu", name: "Other", config: {} }).id;
    });
    expect((await reconcile()).json()).toEqual(output);
    vi.clearAllMocks();
    expect((await reconcile(urls[0], otherId, "other")).json()).toEqual(disabled);
    expect((await reconcile(urls[0], id, "other")).statusCode).toBe(404);
    noWork();
    expect((await reconcile()).json()).toEqual(output);
  });
  it.each(["moonraker", "prusalink"] as const)("preserves %s reconciliation without optional feature reads", async (type) => {
    repo.setSetting("feature_toggles", "broken");
    const other = integrations.create({ type, name: "Other host", config: {} });
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    expect((await reconcile(urls[0], other.id)).json()).toEqual(output);
    expect(reads).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "", "0", "false", "TRUE", "true ", "yes", "2"])("preserves legacy behavior without feature reads for flag %j", async (flag) => {
    if (flag === undefined) delete process.env.PP_DESKTOP_REBUILD;
    else vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    repo.setSetting("feature_toggles", "broken");
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    expect((await reconcile()).json()).toEqual(output);
    expect(reads).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it("runs authentication before connector and feature reads", async () => {
    const secured = Fastify();
    registerTenantMiddleware(secured, { ...loadConfig(), authRequired: true, multiUser: true }, null);
    await registerPrinterCheckoffRoutes(secured, { repo, integrations });
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    const connector = vi.spyOn(integrations, "get");
    try {
      const response = await secured.inject({ method: "POST", url: urls[0], payload: { integration_id: id } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ detail: "Authentication required" });
      expect(reads).not.toHaveBeenCalled();
      expect(connector).not.toHaveBeenCalled();
      noWork();
    } finally { await secured.close(); }
  });
  it.each(["1", "true"])("guards production aliases with optional authentication and flag %j", async (flag) => {
    vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    const dataDir = join(root, "production");
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const production = await buildApp({ ...loadConfig(), dataDir, authRequired: false }, ports);
    const connector = createIntegrationPort({ repo: ports.repository, statusExecution: execution, getAdapter: registry.getIntegrationAdapter }).create({ type: "bambu", name: "Production", config: {} });
    vi.clearAllMocks();
    try {
      for (const url of urls) {
        const request = () => production.inject({ method: "POST", url, payload: { integration_id: connector.id } });
        ports.repository.setSetting("feature_toggles", '{"bambu":false}');
        const denied = await request();
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toEqual(disabled);
        noWork(ports.repository);
        ports.repository.setSetting("feature_toggles", '{"bambu":true}');
        const admitted = await request();
        expect(admitted.statusCode).toBe(200);
        expect(admitted.json()).toEqual(output);
        vi.clearAllMocks();
        ports.repository.setSetting("feature_toggles", "broken");
        const corrupt = await request();
        expect(corrupt.statusCode).toBe(500);
        expect(corrupt.json()).toEqual(invalid);
        noWork(ports.repository);
      }
    } finally {
      await production.close();
      await ports.db.close();
    }
  });
});
