import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { StatusExecution } from "../integrations/status-execution.js";
import { getIntegrationAdapter } from "../integrations/registry.js";
import { createIntegrationPort } from "../integrations/store.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import { registerSpoolmanProxyRoutes } from "./spoolman-proxy.js";

const disabled = { status: 403, title: "Forbidden", detail: "Feature spoolman is disabled.", code: "FEATURE_DISABLED" };
const invalid = { status: 500, title: "Internal Server Error", detail: "Stored feature toggles are invalid.", code: "FEATURE_TOGGLES_INVALID" };

describe("Spoolman inventory feature admission", () => {
  let dataDir: string;
  let sqlite: SqliteDatabase;
  let repo: AppRepository;
  let app: FastifyInstance;
  let statusExecution: StatusExecution;
  let connectorId: string;
  let integrations: ReturnType<typeof createIntegrationPort>;
  const network = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
    String(url).includes("/filament")
      ? [{ id: 7, name: "Red", vendor: "Workshop", material: "PLA", color_hex: "ff0000" }]
      : [{ id: 11, filament_id: 7, remaining_weight: 480, location: "Shelf" }],
  ), { headers: { "content-type": "application/json" } }));

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-spoolman-features-"));
    vi.stubEnv("PP_DESKTOP_REBUILD", "1");
    vi.stubEnv("DEPLOY_MODE", "self-host");
    vi.stubGlobal("fetch", network);
    network.mockClear();
    sqlite = new SqliteDatabase(dataDir);
    sqlite.connect();
    repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    statusExecution = new StatusExecution();
    integrations = createIntegrationPort({ repo, getAdapter: getIntegrationAdapter, statusExecution });
    connectorId = integrations.create({ type: "spoolman", name: "Workshop",
      config: { base_url: "http://127.0.0.1:7912" } }).id;
    app = Fastify();
    app.decorateRequest("tenantId", "default");
    app.addHook("onRequest", (request, _reply, done) => {
      const tenant = request.headers["x-test-tenant"];
      request.tenantId = typeof tenant === "string" ? tenant : "default";
      tenantStorage.run(request.tenantId, done);
    });
    for (const prefix of ["", "/api/v1"]) {
      await app.register(async (routes) => registerSpoolmanProxyRoutes(routes, { repo, integrations }), { prefix });
    }
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await statusExecution.stop();
    sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  for (const prefix of ["", "/api/v1"]) {
    for (const resource of ["filaments", "spools"]) {
      const path = (id: string) => `${prefix}/integrations/${id}/spoolman/${resource}`;
      it(`${prefix || "root"} ${resource} denies new-user defaults and explicit off before connector lookup or network`, async () => {
        const lookup = vi.spyOn(integrations, "get");
        const reads = vi.spyOn(repo, "getSetting");
        for (const value of [undefined, "{}", '{"spoolman":false}']) {
          if (value !== undefined) repo.setSetting("feature_toggles", value);
          for (const id of [connectorId, "missing"]) {
            const response = await app.inject(path(id));
            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual(disabled);
          }
        }
        expect(lookup).not.toHaveBeenCalled();
        expect(reads).not.toHaveBeenCalled();
        expect(network).not.toHaveBeenCalled();
      });
      it(`${prefix || "root"} ${resource} allows opt-in, then revokes and re-enables on the same server`, async () => {
        repo.setSetting("feature_toggles", '{"spoolman":true}');
        const expected = resource === "spools"
          ? { spools: [{ id: 11, filament_id: 7, remaining_weight: 480, location: "Shelf" }] }
          : { filaments: [{ id: `spoolman:${connectorId}:filament:7`, display_name: "Red",
            product_line: "Workshop PLA", hex: "#ff0000", combo_label: "Workshop PLA · Red", swatch_url: "" }] };
        for (const enabled of [true, false, true]) {
          repo.setSetting("feature_toggles", JSON.stringify({ spoolman: enabled }));
          network.mockClear();
          const response = await app.inject(path(connectorId));
          expect(response.statusCode).toBe(enabled ? 200 : 403);
          expect(response.json()).toEqual(enabled ? expected : disabled);
          expect(network).toHaveBeenCalledTimes(enabled ? 1 : 0);
        }
        expect((await app.inject(path("missing"))).statusCode).toBe(404);
      });
      it.each(["{", "[]", "null", '{"spoolman":"yes"}', '{"spoolman":true,"farm":0}'])(
        `${prefix || "root"} ${resource} fails closed for stored %j`, async (value) => {
          repo.setSetting("feature_toggles", value);
          const lookup = vi.spyOn(integrations, "get");
          const response = await app.inject(path(connectorId));
          expect(response.statusCode).toBe(500);
          expect(response.json()).toEqual(invalid);
          expect(lookup).not.toHaveBeenCalled();
          expect(network).not.toHaveBeenCalled();
        });
    }
  }
  it("uses current tenant choices and ignores Plan overrides for tenant-global inventory", async () => {
    repo.setSetting("feature_toggles:plan:1", '{"spoolman":true}');
    const url = `/api/v1/integrations/${connectorId}/spoolman/spools`;
    expect((await app.inject(url)).json()).toEqual(disabled);
    repo.setSetting("feature_toggles", '{"spoolman":true}');
    repo.setSetting("feature_toggles:plan:1", '{"spoolman":false}');
    tenantStorage.run("other", () => repo.setSetting("feature_toggles", '{"spoolman":false}'));
    expect((await app.inject(url)).statusCode).toBe(200);
    network.mockClear();
    expect((await app.inject({ url, headers: { "x-test-tenant": "other" } })).json()).toEqual(disabled);
    expect(network).not.toHaveBeenCalled();
  });
  it.each([undefined, "0", "false", "TRUE", "true "])("preserves legacy inventory without feature reads for flag %j", async (flag) => {
    if (flag === undefined) delete process.env.PP_DESKTOP_REBUILD;
    else vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    repo.setSetting("feature_toggles", "invalid JSON");
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    for (const resource of ["filaments", "spools"]) {
      expect((await app.inject(`/api/v1/integrations/${connectorId}/spoolman/${resource}`)).statusCode).toBe(200);
    }
    expect(reads).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("accepts exact true and preserves forward-compatible unknown settings", async () => {
    vi.stubEnv("PP_DESKTOP_REBUILD", "true");
    repo.setSetting("feature_toggles", JSON.stringify({ spoolman: true, future: { nested: [null] } }));
    expect((await app.inject(`/api/v1/integrations/${connectorId}/spoolman/spools`)).statusCode).toBe(200);
  });
  for (const prefix of ["", "/api/v1"]) {
    for (const resource of ["filaments", "spools"]) {
      it.each([[false, false], [false, true], [true, false], [true, true]])(
        `${prefix} ${resource} uses the owned Plan override over account %s with Plan %s`,
        async (account, plan) => {
          const profileId = repo.createProfile("Scoped inventory").id;
          repo.setSetting("feature_toggles", JSON.stringify({ spoolman: account }));
          repo.setSetting(`feature_toggles:plan:${profileId}`, JSON.stringify({ spoolman: plan }));
          const response = await app.inject(`${prefix}/integrations/${connectorId}/spoolman/${resource}?profile_id=${profileId}`);
          expect(response.statusCode).toBe(plan ? 200 : 403);
          expect(network).toHaveBeenCalledTimes(plan ? 1 : 0);
        },
      );
      it(`${prefix} ${resource} validates scope before inventory and rejects foreign Plans`, async () => {
        repo.setSetting("feature_toggles", '{"spoolman":true}');
        const foreign = tenantStorage.run("other", () => repo.createProfile("Foreign"));
        for (const profileId of ["", "0", "-1", "1.5", "1e2", "9007199254740992", "1&profile_id=2"]) {
          expect((await app.inject(`${prefix}/integrations/${connectorId}/spoolman/${resource}?profile_id=${profileId}`)).statusCode).toBe(400);
        }
        for (const profileId of [String(foreign.id), "999999"]) {
          expect((await app.inject(`${prefix}/integrations/${connectorId}/spoolman/${resource}?profile_id=${profileId}`)).statusCode).toBe(404);
        }
        const profileId = repo.createProfile("Corrupt Plan").id;
        repo.setSetting(`feature_toggles:plan:${profileId}`, '{"spoolman":"yes"}');
        expect((await app.inject(`${prefix}/integrations/${connectorId}/spoolman/${resource}?profile_id=${profileId}`)).json()).toEqual(invalid);
        expect(network).not.toHaveBeenCalled();
        vi.stubEnv("PP_DESKTOP_REBUILD", "0");
        expect((await app.inject(`${prefix}/integrations/${connectorId}/spoolman/${resource}?profile_id=${profileId}`)).statusCode).toBe(200);
      });
    }
  }

});
