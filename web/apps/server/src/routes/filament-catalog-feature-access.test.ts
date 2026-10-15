import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { getIntegrationAdapter } from "../integrations/registry.js";
import { StatusExecution } from "../integrations/status-execution.js";
import * as integrationStore from "../integrations/store.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import { addCustomFilament } from "../services/custom-filaments.js";
import { loadFilamentCatalog } from "../services/filament-catalog.js";
import { registerStubRoutes } from "./settings.js";

const disabled = {
  spoolman_colors: [],
  spoolman_status: "disabled",
  spoolman_error: "Feature spoolman is disabled.",
};
const invalid = {
  status: 500,
  title: "Internal Server Error",
  detail: "Stored feature toggles are invalid.",
  code: "FEATURE_TOGGLES_INVALID",
};

describe("filament catalog feature admission", () => {
  let dataDir: string;
  let sqlite: SqliteDatabase;
  let repo: AppRepository;
  let app: FastifyInstance;
  let statusExecution: StatusExecution;
  let integrations: ReturnType<typeof integrationStore.createIntegrationPort>;
  let connectorId: string;
  let customId: string;
  const network = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify([
    { id: 7, name: "Red", vendor: { name: "Workshop" }, material: "PLA", color_hex: "ff0000" },
    { id: 8, name: null, vendor: null, material: null, color_hex: null },
  ]), { headers: { "content-type": "application/json" } }));

  function expectedColors(id: string) {
    return [
      { id: `spoolman:${id}:filament:7`, display_name: "Red", product_line: "Workshop PLA",
        hex: "#ff0000", combo_label: "Workshop PLA · Red", swatch_url: "" },
      { id: `spoolman:${id}:filament:8`, display_name: "Filament 8", product_line: "Spoolman",
        hex: "#888888", combo_label: "Filament 8", swatch_url: "" },
    ];
  }

  function expectBaseAndCustom(response: ReturnType<typeof loadFilamentCatalog>) {
    expect(response).toMatchObject({
      source: "west3d_shopify",
      status: "ok",
      custom_colors: [{ id: customId, display_name: "Saved blue", product_line: "Workshop",
        hex: "#123abc", combo_label: "Saved blue", swatch_url: "" }],
    });
    expect(response.colors).toHaveLength(252);
    expect(response.colors[0]).toEqual({
      id: "abs-matte::black-pantone-7c",
      display_name: "Black (Pantone 7C)",
      product_line: "ABS Matte",
      hex: "#c0afa1",
      combo_label: "ABS Matte · Black (Pantone 7C)",
      swatch_url: "https://cdn.shopify.com/s/files/1/0596/0692/5480/files/ambrosia-abs-matte-filament-of-the-gods-1kg-bambu-ams-friendly-cardboard-spools-premium-3d-printing-filament-west3d-3d-printing-supplies-ambrosia-filament-8590986.png?v=1755306659",
    });
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-catalog-features-"));
    vi.stubEnv("PP_DESKTOP_REBUILD", "1");
    vi.stubEnv("DEPLOY_MODE", "self-host");
    vi.stubGlobal("fetch", network);
    network.mockClear();
    sqlite = new SqliteDatabase(dataDir);
    sqlite.connect();
    repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    statusExecution = new StatusExecution();
    integrations = integrationStore.createIntegrationPort({ repo, getAdapter: getIntegrationAdapter, statusExecution });
    connectorId = integrations.create({ type: "spoolman", name: "Workshop",
      config: { base_url: "http://127.0.0.1:7912" } }).id;
    repo.setSetting("default_spoolman_integration_id", connectorId);
    customId = addCustomFilament(dataDir, {
      display_name: "Saved blue", hex: "123abc", product_line: "Workshop",
    }).id;
    app = Fastify();
    app.decorateRequest("tenantId", "default");
    app.addHook("onRequest", (request, _reply, done) => {
      const tenant = request.headers["x-test-tenant"];
      request.tenantId = typeof tenant === "string" ? tenant : "default";
      tenantStorage.run(request.tenantId, done);
    });
    for (const prefix of ["", "/api/v1"]) {
      await app.register(async (routes) => registerStubRoutes(routes, { repo, dataDir }), { prefix });
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
    const url = `${prefix}/filaments/catalog`;

    it.each([undefined, "{}", '{"spoolman":false}'])(
      `${prefix || "root"} preserves base, custom and default for disabled choices %j without connector lookup`, async (value) => {
        if (value !== undefined) repo.setSetting("feature_toggles", value);
        const lookup = vi.spyOn(integrationStore, "getIntegrationConfig");
        const cachedBefore = structuredClone(loadFilamentCatalog());
        for (const query of ["", `?spoolman_integration_id=${connectorId}`, "?spoolman_integration_id=missing"]) {
          const response = await app.inject(`${url}${query}`);
          expect(response.statusCode).toBe(200);
          const body = response.json<ReturnType<typeof loadFilamentCatalog>>();
          expectBaseAndCustom(body);
          expect(body).toMatchObject({ ...disabled, default_spoolman_integration_id: connectorId });
          expect(body.colors).toEqual(cachedBefore.colors);
        }
        expect(lookup.mock.calls).toEqual([]);
        expect(network.mock.calls).toEqual([]);
        expect(loadFilamentCatalog()).toEqual(cachedBefore);
        expect(repo.getSettingSnapshot("feature_toggles")).toEqual(value === undefined
          ? { kind: "missing" } : { kind: "stored", value });
      });

    it(`${prefix || "root"} returns disabled admission even without a saved default`, async () => {
      repo.setSetting("default_spoolman_integration_id", "");
      const lookup = vi.spyOn(integrationStore, "getIntegrationConfig");
      const response = await app.inject(url);
      expect(response.statusCode).toBe(200);
      expectBaseAndCustom(response.json());
      expect(response.json()).toMatchObject({ ...disabled, default_spoolman_integration_id: null });
      expect(lookup.mock.calls).toEqual([]);
      expect(network.mock.calls).toEqual([]);
    });

    it.each(["{", "[]", "null", '{"spoolman":"yes"}', '{"spoolman":null}',
      '{"spoolman":true,"farm":0}', '{"spoolman":false,"orders":"yes"}', '{"bambu":[]}'])(
      `${prefix || "root"} rejects stored %j before metadata or connector reads without repair`, async (value) => {
        repo.setSetting("feature_toggles", value);
        const lookup = vi.spyOn(integrationStore, "getIntegrationConfig");
        const reads = vi.spyOn(repo, "getSetting");
        const writes = vi.spyOn(repo, "setSetting");
        for (const query of ["", `?spoolman_integration_id=${connectorId}`, "?spoolman_integration_id=missing"]) {
          const response = await app.inject(`${url}${query}`);
          expect(response.statusCode).toBe(500);
          expect(response.json()).toEqual(invalid);
        }
        expect(lookup.mock.calls).toEqual([]);
        expect(reads.mock.calls).toEqual([]);
        expect(writes.mock.calls).toEqual([]);
        expect(network.mock.calls).toEqual([]);
        expect(repo.getSettingSnapshot("feature_toggles")).toEqual({ kind: "stored", value });
      });

    it(`${prefix || "root"} admits, revokes and re-admits on the same server without mutating the base`, async () => {
      const cachedBefore = structuredClone(loadFilamentCatalog());
      const lookup = vi.spyOn(integrationStore, "getIntegrationConfig");
      for (const enabled of [true, false, true]) {
        repo.setSetting("feature_toggles", JSON.stringify({ spoolman: enabled }));
        lookup.mockClear();
        network.mockClear();
        const response = await app.inject(url);
        expect(response.statusCode).toBe(200);
        expectBaseAndCustom(response.json());
        expect(response.json()).toMatchObject(enabled
          ? { spoolman_colors: expectedColors(connectorId), spoolman_status: "ok",
            default_spoolman_integration_id: connectorId }
          : { ...disabled, default_spoolman_integration_id: connectorId });
        expect(network).toHaveBeenCalledTimes(enabled ? 1 : 0);
        expect(lookup).toHaveBeenCalledTimes(enabled ? 1 : 0);
        expect(loadFilamentCatalog()).toEqual(cachedBefore);
      }
    });

    it(`${prefix || "root"} honors query precedence and trimming while preserving the saved default`, async () => {
      repo.setSetting("feature_toggles", '{"spoolman":true}');
      const selected = integrations.create({ type: "spoolman", name: "Selected",
        config: { base_url: "http://127.0.0.1:7913" } }).id;
      for (const query of [`?spoolman_integration_id=%20${selected}%20`, "?spoolman_integration_id=%20%20"]) {
        network.mockClear();
        const response = await app.inject(`${url}${query}`);
        expect(response.statusCode).toBe(200);
        expectBaseAndCustom(response.json());
        const isSelected = query.includes(selected);
        expect(response.json()).toMatchObject({ spoolman_colors: expectedColors(isSelected ? selected : connectorId),
          spoolman_status: "ok", default_spoolman_integration_id: connectorId });
        expect(response.json()).not.toHaveProperty("spoolman_error");
        expect(String(network.mock.calls[0]?.[0])).toBe(
          `http://127.0.0.1:${isSelected ? 7913 : 7912}/api/v1/filament`);
        expect(network).toHaveBeenCalledTimes(1);
      }
    });

    it(`${prefix || "root"} preserves allowed missing, wrong-type, disabled and absent connector responses`, async () => {
      repo.setSetting("feature_toggles", '{"spoolman":true}');
      const wrong = integrations.create({ type: "moonraker", name: "Printer", config: {} }).id;
      const off = integrations.create({ type: "spoolman", name: "Disabled", config: { enabled: false } }).id;
      for (const selection of [
        { id: "missing", status: "not_found", error: "Spoolman integration not found" },
        { id: wrong, status: "error", error: "Selected integration is not a Spoolman connector" },
        { id: off, status: "disabled", error: "Spoolman integration is disabled in Settings" },
      ]) {
        const response = await app.inject(`${url}?spoolman_integration_id=${selection.id}`);
        expect(response.statusCode).toBe(200);
        expectBaseAndCustom(response.json());
        expect(response.json()).toMatchObject({ spoolman_colors: [], spoolman_status: selection.status,
          spoolman_error: selection.error, default_spoolman_integration_id: connectorId });
      }
      repo.setSetting("default_spoolman_integration_id", "");
      const response = await app.inject(url);
      expect(response.statusCode).toBe(200);
      expectBaseAndCustom(response.json());
      expect(response.json()).toMatchObject({ spoolman_colors: [], default_spoolman_integration_id: null });
      expect(response.json()).not.toHaveProperty("spoolman_status");
      expect(response.json()).not.toHaveProperty("spoolman_error");
      expect(network.mock.calls).toEqual([]);
    });

    it(`${prefix || "root"} preserves allowed empty and upstream error fragments`, async () => {
      repo.setSetting("feature_toggles", '{"spoolman":true}');
      network.mockResolvedValueOnce(new Response("[]"));
      const empty = await app.inject(url);
      expect(empty.statusCode).toBe(200);
      expectBaseAndCustom(empty.json());
      expect(empty.json()).toMatchObject({ spoolman_colors: [], spoolman_status: "empty",
        spoolman_error: "Spoolman returned no filament types — add filaments in Spoolman (spools alone are not listed here)" });
      network.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
      const error = await app.inject(url);
      expect(error.statusCode).toBe(200);
      expectBaseAndCustom(error.json());
      expect(error.json()).toMatchObject({ spoolman_colors: [], spoolman_status: "error",
        spoolman_error: "Spoolman filaments request failed: HTTP 503" });
      expect(network).toHaveBeenCalledTimes(2);
    });
  }

  it("isolates tenant choices and saved defaults and ignores Plan overrides", async () => {
    const plan = repo.createProfile("Catalog plan").id;
    repo.setSetting(`feature_toggles:plan:${plan}`, '{"spoolman":true}');
    const url = `/api/v1/filaments/catalog?plan_id=${plan}`;
    const denied = await app.inject(url);
    expect(denied.statusCode).toBe(200);
    expectBaseAndCustom(denied.json());
    expect(denied.json()).toMatchObject({ ...disabled, default_spoolman_integration_id: connectorId });
    expect(network.mock.calls).toEqual([]);
    repo.setSetting("feature_toggles", '{"spoolman":true}');
    repo.setSetting(`feature_toggles:plan:${plan}`, '{"spoolman":false}');
    tenantStorage.run("other", () => {
      repo.setSetting("feature_toggles", '{"spoolman":false}');
      repo.setSetting("default_spoolman_integration_id", "other-default");
    });
    const allowed = await app.inject(url);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ spoolman_colors: expectedColors(connectorId), spoolman_status: "ok" });
    expect(network).toHaveBeenCalledTimes(1);
    network.mockClear();
    const lookup = vi.spyOn(integrationStore, "getIntegrationConfig");
    const other = await app.inject({ url, headers: { "x-test-tenant": "other" } });
    expect(other.statusCode).toBe(200);
    expectBaseAndCustom(other.json());
    expect(other.json()).toMatchObject({ ...disabled, default_spoolman_integration_id: "other-default" });
    expect(lookup.mock.calls).toEqual([]);
    expect(network.mock.calls).toEqual([]);
  });

  it.each([undefined, "0", "false", "TRUE", "true "])(
    "preserves legacy enrichment without feature snapshot reads for flag %j", async (flag) => {
      if (flag === undefined) delete process.env.PP_DESKTOP_REBUILD;
      else vi.stubEnv("PP_DESKTOP_REBUILD", flag);
      repo.setSetting("feature_toggles", "invalid JSON");
      const reads = vi.spyOn(repo, "getSettingSnapshot");
      for (const prefix of ["", "/api/v1"]) {
        const response = await app.inject(`${prefix}/filaments/catalog`);
        expect(response.statusCode).toBe(200);
        expectBaseAndCustom(response.json());
        expect(response.json()).toMatchObject({ spoolman_colors: expectedColors(connectorId), spoolman_status: "ok" });
      }
      expect(reads.mock.calls).toEqual([]);
      expect(network).toHaveBeenCalledTimes(2);
    });

  it("applies exact true admission and permits unknown settings", async () => {
    vi.stubEnv("PP_DESKTOP_REBUILD", "true");
    for (const prefix of ["", "/api/v1"]) {
      repo.setSetting("feature_toggles", '{"spoolman":false}');
      const response = await app.inject(`${prefix}/filaments/catalog`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject(disabled);
    }
    expect(network.mock.calls).toEqual([]);
    repo.setSetting("feature_toggles", '{"spoolman":true,"future":{"nested":[null,1]}}');
    const response = await app.inject("/api/v1/filaments/catalog");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ spoolman_colors: expectedColors(connectorId), spoolman_status: "ok" });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("inherits real buildApp authentication and admission on both aliases", async () => {
    const { buildApp } = await import("../app.js");
    const { createSelfHostPorts } = await import("../adapters/self-host/index.js");
    const { loadConfig } = await import("../config.js");
    const dir = mkdtempSync(join(tmpdir(), "pp-catalog-auth-"));
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const authenticatedApp = await buildApp({ ...loadConfig(), dataDir: dir, host: "127.0.0.1",
      deployMode: "self-host", singleUserAuth: true, multiUser: false, authRequired: true,
      sessionSecret: "catalog-test-session-secret" }, ports);
    try {
      const reads = vi.spyOn(ports.repository, "getSettingSnapshot");
      for (const prefix of ["", "/api/v1"]) {
        const response = await authenticatedApp.inject(`${prefix}/filaments/catalog`);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ detail: "Authentication required" });
      }
      expect(reads.mock.calls).toEqual([]);
      const registration = await authenticatedApp.inject({ method: "POST", url: "/auth/register",
        payload: { email: "catalog@example.com", password: "correct-horse-battery", display_name: "Owner" } });
      expect(registration.statusCode).toBe(200);
      const session = registration.cookies.find((cookie) => cookie.name === "pp_session");
      if (!session) throw new Error("No authenticated session");
      for (const prefix of ["", "/api/v1"]) {
        for (const toggles of ["{}", "{"]) {
          ports.repository.setSetting("feature_toggles", toggles);
          const response = await authenticatedApp.inject({ url: `${prefix}/filaments/catalog`,
            cookies: { pp_session: session.value } });
          expect(response.statusCode).toBe(toggles === "{" ? 500 : 200);
          expect(response.json()).toMatchObject(toggles === "{" ? invalid
            : { ...disabled, source: "west3d_shopify", status: "ok", custom_colors: [],
              default_spoolman_integration_id: null });
        }
      }
      expect(network.mock.calls).toEqual([]);
    } finally {
      await authenticatedApp.close();
      await ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  for (const prefix of ["", "/api/v1"]) {
    for (const resource of ["catalog"]) {
      it.each([[false, false], [false, true], [true, false], [true, true]])(
        `${prefix} ${resource} uses the owned Plan override over account %s with Plan %s`,
        async (account, plan) => {
          const profileId = repo.createProfile("Scoped inventory").id;
          repo.setSetting("feature_toggles", JSON.stringify({ spoolman: account }));
          repo.setSetting(`feature_toggles:plan:${profileId}`, JSON.stringify({ spoolman: plan }));
          const response = await app.inject(`${prefix}/filaments/catalog?profile_id=${profileId}`);
          expect(response.statusCode).toBe(200);
          expectBaseAndCustom(response.json());
          expect(response.json().spoolman_status).toBe(plan ? "ok" : "disabled");
          expect(network).toHaveBeenCalledTimes(plan ? 1 : 0);
        },
      );
      it(`${prefix} ${resource} validates scope before inventory and rejects foreign Plans`, async () => {
        repo.setSetting("feature_toggles", '{"spoolman":true}');
        const foreign = tenantStorage.run("other", () => repo.createProfile("Foreign"));
        for (const profileId of ["", "0", "-1", "1.5", "1e2", "9007199254740992", "1&profile_id=2"]) {
          expect((await app.inject(`${prefix}/filaments/catalog?profile_id=${profileId}`)).statusCode).toBe(400);
        }
        for (const profileId of [String(foreign.id), "999999"]) {
          expect((await app.inject(`${prefix}/filaments/catalog?profile_id=${profileId}`)).statusCode).toBe(404);
        }
        const profileId = repo.createProfile("Corrupt Plan").id;
        repo.setSetting(`feature_toggles:plan:${profileId}`, '{"spoolman":"yes"}');
        expect((await app.inject(`${prefix}/filaments/catalog?profile_id=${profileId}`)).json()).toEqual(invalid);
        expect(network).not.toHaveBeenCalled();
        vi.stubEnv("PP_DESKTOP_REBUILD", "0");
        expect((await app.inject(`${prefix}/filaments/catalog?profile_id=${profileId}`)).statusCode).toBe(200);
      });
    }
  }

});
