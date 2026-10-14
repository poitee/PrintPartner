import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrinterSendQueueItem } from "@print-partner/contracts";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { StatusExecution } from "../integrations/status-execution.js";
import { createIntegrationPort } from "../integrations/store.js";
import { getIntegrationAdapter } from "../integrations/registry.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import { InProcessJobRunner } from "../services/job-runner.js";
import { saveFleet } from "../services/printer-fleet.js";
import { patchPlanFeatures, selectFarmSuggestionItems } from "../services/plan-features.js";
import { registerPlanRoutes } from "./plans.js";
import { registerPrinterSendQueueRoutes } from "./printer-send-queue.js";

const invalid = { detail: "Stored feature toggles are invalid.", code: "FEATURE_TOGGLES_INVALID" };
const defaults = {
  farm: { enabled: false, source: "default" },
  orders: { enabled: false, source: "default" },
  bambu: { enabled: false, source: "default" },
  spoolman: { enabled: false, source: "default" },
};

describe("plan features and aggregate farm suggestions", () => {
  let dataDir: string;
  let sqlite: SqliteDatabase;
  let repo: AppRepository;
  let app: FastifyInstance;
  let statusExecution: StatusExecution;
  let profileId: number;
  const planKey = () => `feature_toggles:plan:${profileId}`;
  const url = () => `/plans/${profileId}/features`;

  async function createApp() {
    const jobs = new InProcessJobRunner({ getRepo: () => repo, reposDir: sqlite.reposDir,
      exportsDir: join(dataDir, "exports"), dataDir });
    const integrations = createIntegrationPort({ repo, getAdapter: getIntegrationAdapter, statusExecution });
    app = Fastify();
    app.decorateRequest("tenantId", "default");
    app.addHook("onRequest", (request, _reply, done) => {
      const tenant = request.headers["x-test-tenant"];
      request.tenantId = typeof tenant === "string" ? tenant : "default";
      tenantStorage.run(request.tenantId, done);
    });
    for (const prefix of ["", "/api/v1", "/api/v2"]) {
      await app.register(async (routes) => registerPlanRoutes(routes, {
        repo, dataDir, reposDir: sqlite.reposDir, thumbsDir: join(dataDir, "thumbs"),
      }), { prefix });
    }
    await registerPrinterSendQueueRoutes(app, { repo, integrations, jobs });
    await app.ready();
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-plan-features-"));
    vi.stubEnv("PP_DESKTOP_REBUILD", "1");
    vi.stubEnv("PRINT_PARTNER_DATA_DIR", dataDir);
    sqlite = new SqliteDatabase(dataDir);
    sqlite.connect();
    repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    profileId = repo.createProfile("Owned plan").id;
    statusExecution = new StatusExecution();
    saveFleet(repo, [{ id: "printer", name: "Printer", model: "Printer", bed_width_mm: 250,
      bed_depth_mm: 250, bed_height_mm: 250, margin_mm: 4, max_filament_slots: 1,
      integration_id: "host", loaded_filaments: [] }]);
    await createApp();
  });
  afterEach(async () => {
    await app.close();
    await statusExecution.stop();
    sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const suggestions = () => app.inject("/printer-send-queue/suggestions?idle_integration_ids=host");
  const patch = (payload: unknown, target = url()) => app.inject({
    method: "PATCH", url: target, headers: { "content-type": "application/json" }, payload: JSON.stringify(payload),
  });
  function queue(id: string, plan?: number): PrinterSendQueueItem {
    return { id, filename: `${id}.gcode`, artifact_path: `/tmp/${id}.gcode`, printer_id: "printer",
      wait_for_idle: true, start: true, state: "queued", created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z", ...(plan === undefined ? {} : { profile_id: plan }),
      checkoff_units: [{ part_id: 1, unit_index: 0 }] };
  }
  function saveQueue(items: PrinterSendQueueItem[]) {
    repo.setSetting("printer.send_queue", JSON.stringify(items));
  }
  function expectedSuggestion(ids: string[]) {
    return { suggestions: [{ printer_id: "printer", printer_name: "Printer", integration_id: "host",
      items: ids.map((id) => ({ item_id: id, filename: `${id}.gcode`, filament_color_ids: [], overlap: 0 })),
      item_count: ids.length }] };
  }

  it("root and versioned handlers resolve defaults, explicit false and null inheritance live", async () => {
    for (const prefix of ["", "/api/v1", "/api/v2"]) {
      expect((await app.inject(`${prefix}${url()}`)).json()).toEqual({
        profile_id: profileId, overrides: {}, effective: defaults,
      });
    }
    repo.setSetting("feature_toggles", '{"farm":true,"orders":false}');
    let response = await patch({ farm: false, orders: true });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ profile_id: profileId, overrides: { farm: false, orders: true },
      effective: { ...defaults, farm: { enabled: false, source: "plan" }, orders: { enabled: true, source: "plan" } } });
    response = await patch({ farm: null }, `/api/v1${url()}`);
    expect(response.json()).toEqual({ profile_id: profileId, overrides: { orders: true },
      effective: { ...defaults, farm: { enabled: true, source: "user" }, orders: { enabled: true, source: "plan" } } });
    response = await patch({ orders: null }, `/api/v2${url()}`);
    expect(response.json()).toEqual({ profile_id: profileId, overrides: {},
      effective: { ...defaults, farm: { enabled: true, source: "user" }, orders: { enabled: false, source: "user" } } });
    expect(repo.getSettingSnapshot(planKey())).toEqual({ kind: "stored", value: "{}" });
    repo.setSetting("feature_toggles", '{"farm":false}');
    expect((await patch({ farm: true })).json().effective.farm).toEqual({ enabled: true, source: "plan" });
    expect((await patch({})).json().overrides).toEqual({ farm: true });
  });

  it("keeps Node keys and defaults aligned with the canonical Rust feature registry", async () => {
    const rust = readFileSync(new URL("../../../../../rust/crates/pp-domain/src/features.rs", import.meta.url), "utf8");
    const registry = [...rust.matchAll(/\w+ => \(\s*"([^"]+)",\s*"[^"]*",\s*"[^"]*",\s*(true|false)\s*\)/g)];
    const effective = (await app.inject(url())).json().effective;
    expect(effective).toEqual(Object.fromEntries(registry.map((match) => [match[1], {
      enabled: match[2] === "true", source: "default",
    }])));
  });

  it("inherits authentication through the real root and versioned app registration", async () => {
    const { buildApp } = await import("../app.js");
    const { createSelfHostPorts } = await import("../adapters/self-host/index.js");
    const { loadConfig } = await import("../config.js");
    const dir = mkdtempSync(join(tmpdir(), "pp-feature-auth-"));
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const owned = ports.repository.createProfile("Authenticated plan").id;
    const authenticatedApp = await buildApp({ ...loadConfig(), dataDir: dir, host: "127.0.0.1",
      deployMode: "self-host", singleUserAuth: true, multiUser: false, authRequired: true,
      sessionSecret: "feature-test-session-secret" }, ports);
    try {
      const reads = vi.spyOn(ports.repository, "getSettingSnapshot");
      for (const prefix of ["", "/api/v1", "/api/v2"]) {
        for (const method of ["GET", "PATCH"] satisfies Array<"GET" | "PATCH">) {
          const response = await authenticatedApp.inject({ method, url: `${prefix}/plans/${owned}/features`,
            ...(method === "PATCH" ? { payload: { farm: true } } : {}) });
          expect(response.statusCode).toBe(401);
        }
      }
      expect(reads.mock.calls).toEqual([]);
      const registration = await authenticatedApp.inject({ method: "POST", url: "/auth/register",
        payload: { email: "features@example.com", password: "correct-horse-battery", display_name: "Owner" } });
      expect(registration.statusCode).toBe(200);
      const session = registration.cookies.find((cookie) => cookie.name === "pp_session");
      if (!session) throw new Error("No authenticated session");
      for (const prefix of ["", "/api/v1", "/api/v2"]) {
        const response = await authenticatedApp.inject({ method: "PATCH", url: `${prefix}/plans/${owned}/features`,
          cookies: { pp_session: session.value }, payload: { farm: true } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ profile_id: owned, overrides: { farm: true },
          effective: { ...defaults, farm: { enabled: true, source: "plan" } } });
      }
    } finally {
      await authenticatedApp.close();
      await ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists API views and suggestions through SQLite close and reopen", async () => {
    expect((await patch({ farm: true, spoolman: false })).statusCode).toBe(200);
    saveQueue([queue("owned", profileId)]);
    expect((await suggestions()).json()).toEqual(expectedSuggestion(["owned"]));
    await app.close();
    sqlite.close();
    sqlite = new SqliteDatabase(dataDir);
    sqlite.connect();
    repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    await createApp();
    const response = await app.inject(`/api/v2${url()}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      profile_id: profileId, overrides: { farm: true, spoolman: false }, effective: {
        ...defaults, farm: { enabled: true, source: "plan" }, spoolman: { enabled: false, source: "plan" },
      },
    });
    expect((await suggestions()).json()).toEqual(expectedSuggestion(["owned"]));
    expect(repo.getSettingSnapshot(planKey())).toEqual({ kind: "stored", value: '{"farm":true,"spoolman":false}' });
  });

  it("preserves unknown nested and prototype-like properties while clearing known overrides", async () => {
    repo.setSetting(planKey(), '{"farm":true,"future":{"nested":[null,1]},"__proto__":{"farm":false},"constructor":["saved"]}');
    expect((await patch({ farm: null, bambu: false })).json().overrides).toEqual({ bambu: false });
    expect(JSON.parse(repo.getSetting(planKey()) ?? "null")).toEqual(JSON.parse(
      '{"future":{"nested":[null,1]},"__proto__":{"farm":false},"constructor":["saved"],"bambu":false}',
    ));
  });

  it("preserves every unknown numeric token across patches, clears and a conflicting writer", async () => {
    const future = '{"limit":9007199254740993,"negative":-9007199254740993,"array":[1e400,1E-400,-0,1.2300e+05,{"n":123456789012345678901234567890}],"plain":[true,false,null,"9007199254740993"]}';
    const retained = `"future":${future},"__proto__":{"n":9007199254740995},"constructor":[1e+030]`;
    repo.setSetting(planKey(), `{${retained}}`);
    repo.setSetting("feature_toggles", `{"farm":true,"future":${future}}`);
    expect((await app.inject(url())).json()).toEqual({ profile_id: profileId, overrides: {},
      effective: { ...defaults, farm: { enabled: true, source: "user" } } });
    const patches = [
      { body: { farm: false }, suffix: ',"farm":false' },
      { body: { orders: true }, suffix: ',"farm":false,"orders":true' },
      { body: {}, suffix: ',"farm":false,"orders":true' },
      { body: { farm: null }, suffix: ',"orders":true' },
      { body: { orders: null }, suffix: "" },
    ];
    for (const { body, suffix } of patches) {
      expect((await patch(body)).statusCode).toBe(200);
      expect(repo.getSettingSnapshot(planKey())).toEqual({ kind: "stored", value: `{${retained}${suffix}}` });
    }
    const otherSqlite = new SqliteDatabase(dataDir);
    otherSqlite.connect();
    const otherRepo = new AppRepository(getDb(otherSqlite), undefined, otherSqlite.reposDir);
    const original = repo.compareAndSetOwnedPlanFeatures.bind(repo);
    const writes = vi.spyOn(repo, "compareAndSetOwnedPlanFeatures").mockImplementationOnce((input) => {
      otherRepo.setSetting(planKey(), `{${retained},"newer":{"n":9007199254740997}}`);
      return original(input);
    });
    try {
      expect((await patch({ farm: true })).json()).toEqual({ profile_id: profileId, overrides: { farm: true },
        effective: { ...defaults, farm: { enabled: true, source: "plan" } } });
      expect(otherRepo.getSettingSnapshot(planKey())).toEqual({ kind: "stored",
        value: `{${retained},"newer":{"n":9007199254740997},"farm":true}` });
      expect(writes.mock.calls).toHaveLength(2);
    } finally { otherSqlite.close(); }
    expect((await patch({ farm: null })).statusCode).toBe(200);
    expect(repo.getSettingSnapshot(planKey())).toEqual({ kind: "stored",
      value: `{${retained},"newer":{"n":9007199254740997}}` });
  });

  it.each([true, false])("duplicates archived plan farm %j verbatim and enforces it on the copy", async (farm) => {
    const value = `{"farm":${farm},"future":{"limit":9007199254740993,"array":[1e400,null,"saved"]}}`;
    repo.setSetting("feature_toggles", `{"farm":${!farm}}`);
    repo.setSetting(planKey(), value);
    getDb(sqlite).update(schema.buildProfiles).set({ archivedAt: "2026-10-14T00:00:00Z" })
      .where(eq(schema.buildProfiles.id, profileId)).run();
    const copy = repo.duplicateProfile(profileId, "Template copy", { clearCheckoff: true });
    expect(copy.archived_at).toBeNull();
    expect(repo.getSettingSnapshot(`feature_toggles:plan:${copy.id}`)).toEqual({ kind: "stored", value });
    expect(repo.getSettingSnapshot(planKey())).toEqual({ kind: "stored", value });
    for (const id of [profileId, copy.id]) {
      expect((await app.inject(`/plans/${id}/features`)).json()).toEqual({ profile_id: id, overrides: { farm },
        effective: { ...defaults, farm: { enabled: farm, source: "plan" } } });
    }
    saveQueue([queue("template-copy", copy.id), queue("legacy")]);
    expect((await suggestions()).json()).toEqual(expectedSuggestion(farm ? ["template-copy"] : ["legacy"]));
  });

  it.each([undefined, "", "{}", '{"future":{"n":9007199254740993}}'])(
    "duplicates the exact missing or stored feature snapshot %j", async (value) => {
      if (value !== undefined) repo.setSetting(planKey(), value);
      const copy = repo.duplicateProfile(profileId, "Snapshot copy");
      expect(repo.getSettingSnapshot(`feature_toggles:plan:${copy.id}`)).toEqual(value === undefined
        ? { kind: "missing" } : { kind: "stored", value });
      const response = await app.inject(`/plans/${copy.id}/features`);
      if (value === "") {
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual(invalid);
      } else {
        expect(response.json()).toEqual({ profile_id: copy.id, overrides: {}, effective: defaults });
      }
    });

  it("cannot duplicate a foreign plan or its feature snapshot", () => {
    const foreign = tenantStorage.run("other", () => {
      const id = repo.createProfile("Foreign template").id;
      repo.setSetting(`feature_toggles:plan:${id}`, '{"farm":true,"future":9007199254740993}');
      return id;
    });
    const settingWrites = vi.spyOn(repo, "setSetting");
    expect(() => repo.duplicateProfile(foreign, "Forbidden copy")).toThrow("Profile not found");
    expect(settingWrites.mock.calls).toEqual([]);
    expect(repo.listProfileHeaders().map((profile) => profile.id)).toEqual([profileId]);
    expect(tenantStorage.run("other", () => repo.getSettingSnapshot(`feature_toggles:plan:${foreign}`)))
      .toEqual({ kind: "stored", value: '{"farm":true,"future":9007199254740993}' });
  });

  it.each([null, [], "", { farm: 1 }, { farm: "true" }, { farm: {} }, { farm: true, tenant_id: "other" },
    { future: true }, { constructor: true }, JSON.parse('{"__proto__":true}')])(
    "rejects invalid patch %j without writes", async (body) => {
      repo.setSetting(planKey(), '{"orders":false}');
      const writes = vi.spyOn(repo, "compareAndSetOwnedPlanFeatures");
      expect((await patch(body)).statusCode).toBe(400);
      expect(repo.getSettingSnapshot(planKey())).toEqual({ kind: "stored", value: '{"orders":false}' });
      expect(writes.mock.calls).toEqual([]);
    });

  it.each(["0", "-1", "1.5", "1e0", "0x1", "01", "%20", "%20%31", "9007199254740992", "Infinity"])(
    "rejects coercion or unsafe ID %s before storage", async (id) => {
      const reads = vi.spyOn(repo, "getSettingSnapshot");
      const writes = vi.spyOn(repo, "compareAndSetOwnedPlanFeatures");
      expect((await patch({ farm: true }, `/plans/${id}/features`)).statusCode).toBe(400);
      expect((await app.inject(`/plans/${id}/features`)).statusCode).toBe(400);
      expect(reads.mock.calls).toEqual([]);
      expect(writes.mock.calls).toEqual([]);
    });

  it("rejects empty and non-string IDs at the service boundary", () => {
    for (const id of ["", " ", 1, true, null]) {
      expect(patchPlanFeatures(repo, { id }, { farm: true })).toEqual({ kind: "invalid_input" });
    }
    expect(repo.getSettingSnapshot(planKey())).toEqual({ kind: "missing" });
  });

  it("does not read or write settings for missing, foreign and deleted plans", async () => {
    const foreign = tenantStorage.run("other", () => repo.createProfile("Foreign").id);
    repo.setSetting(planKey(), '{"farm":true}');
    repo.deleteProfile(profileId);
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    const writes = vi.spyOn(repo, "compareAndSetOwnedPlanFeatures");
    for (const id of [foreign, profileId, 999999]) {
      for (const method of ["GET", "PATCH"] satisfies Array<"GET" | "PATCH">) {
        const response = await app.inject({ method, url: `/plans/${id}/features`,
          ...(method === "PATCH" ? { payload: { farm: true } } : {}) });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ detail: "Plan not found" });
      }
    }
    expect(reads.mock.calls).toEqual([]);
    expect(writes.mock.calls).toEqual([]);
  });

  it.each(["{", "", "[]", "null", '"text"', '{"farm":null}', '{"orders":0}', '{"bambu":"true"}', '{"spoolman":[]}'])(
    "fails closed on corrupt layer %j without repairing it", async (value) => {
      for (const key of ["feature_toggles", planKey()]) {
        repo.setSetting("feature_toggles", '{"farm":true}');
        repo.setSetting(planKey(), '{"farm":true}');
        repo.setSetting(key, value);
        const writes = vi.spyOn(repo, "compareAndSetOwnedPlanFeatures");
        for (const response of [await app.inject(url()), await patch({ farm: true })]) {
          expect(response.statusCode).toBe(500);
          expect(response.json()).toEqual(invalid);
        }
        expect(repo.getSettingSnapshot(key)).toEqual({ kind: "stored", value });
        expect(writes.mock.calls).toEqual([]);
        writes.mockRestore();
      }
    });

  it.each([undefined, "TRUE", "True", " true", "true ", "0", "false", ""])(
    "bypasses all feature storage with flag %j", async (flag) => {
      if (flag === undefined) delete process.env.PP_DESKTOP_REBUILD;
      else vi.stubEnv("PP_DESKTOP_REBUILD", flag);
      repo.setSetting("feature_toggles", "invalid");
      repo.setSetting(planKey(), "invalid");
      saveQueue([queue("legacy"), queue("owned", profileId)]);
      const reads = vi.spyOn(repo, "getSettingSnapshot");
      const writes = vi.spyOn(repo, "compareAndSetOwnedPlanFeatures");
      for (const prefix of ["", "/api/v1", "/api/v2"]) {
        expect((await app.inject(`${prefix}${url()}`)).statusCode).toBe(404);
        expect((await patch({ farm: true }, `${prefix}${url()}`)).statusCode).toBe(404);
      }
      expect((await suggestions()).json()).toEqual(expectedSuggestion(["legacy", "owned"]));
      expect(reads.mock.calls).toEqual([]);
      expect(writes.mock.calls).toEqual([]);
    });

  it("enables the feature API for exact true", async () => {
    vi.stubEnv("PP_DESKTOP_REBUILD", "true");
    expect((await patch({ farm: false })).json().effective.farm).toEqual({ enabled: false, source: "plan" });
  });

  it("reapplies a patch after a real conflicting SQLite writer without losing newer features", async () => {
    const otherSqlite = new SqliteDatabase(dataDir);
    otherSqlite.connect();
    const otherRepo = new AppRepository(getDb(otherSqlite), undefined, otherSqlite.reposDir);
    const original = repo.compareAndSetOwnedPlanFeatures.bind(repo);
    const writes = vi.spyOn(repo, "compareAndSetOwnedPlanFeatures").mockImplementationOnce((input) => {
      otherRepo.setSetting(planKey(), '{"orders":true,"future":[1]}');
      return original(input);
    });
    try {
      const response = await patch({ farm: false });
      expect(response.statusCode).toBe(200);
      expect(response.json().overrides).toEqual({ farm: false, orders: true });
      expect(JSON.parse(otherRepo.getSetting(planKey()) ?? "null")).toEqual({ orders: true, future: [1], farm: false });
      expect(writes.mock.calls).toHaveLength(2);
    } finally { otherSqlite.close(); }
  });

  it.each([undefined, '{}'])("rejects a patch if a second SQLite connection deletes the plan before CAS with %j", async (stored) => {
    if (stored !== undefined) repo.setSetting(planKey(), stored);
    const otherSqlite = new SqliteDatabase(dataDir);
    otherSqlite.connect();
    const otherRepo = new AppRepository(getDb(otherSqlite), undefined, otherSqlite.reposDir);
    const original = repo.compareAndSetOwnedPlanFeatures.bind(repo);
    vi.spyOn(repo, "compareAndSetOwnedPlanFeatures").mockImplementationOnce((input) => {
      otherRepo.deleteProfile(profileId);
      return original(input);
    });
    try {
      const response = await patch({ farm: true });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ detail: "Plan not found" });
      expect(otherRepo.getSettingSnapshot(planKey())).toEqual({ kind: "missing" });
    } finally { otherSqlite.close(); }
  });

  it("deletes retained plan settings and preserves a foreign plan's settings", () => {
    const keys = [`production_setup:${profileId}`, `role_filaments_${profileId}`, planKey()];
    for (const key of keys) repo.setSetting(key, '{"retained":true}');
    const otherSqlite = new SqliteDatabase(dataDir);
    otherSqlite.connect();
    const otherRepo = new AppRepository(getDb(otherSqlite), undefined, otherSqlite.reposDir);
    try {
      tenantStorage.run("other", () => otherRepo.deleteProfile(profileId));
      expect(keys.map((key) => repo.getSettingSnapshot(key))).toEqual([
        { kind: "stored", value: '{"retained":true}' },
        { kind: "stored", value: '{"retained":true}' },
        { kind: "stored", value: '{"retained":true}' },
      ]);
      const foreign = tenantStorage.run("other", () => {
        const id = otherRepo.createProfile("Foreign retained plan").id;
        otherRepo.setSetting(`feature_toggles:plan:${id}`, '{"farm":true}');
        return id;
      });
      repo.setSetting(`feature_toggles:plan:${foreign}`, '{"future":true}');
      otherRepo.deleteProfile(foreign);
      expect(repo.getSettingSnapshot(`feature_toggles:plan:${foreign}`)).toEqual({ kind: "stored", value: '{"future":true}' });
      expect(tenantStorage.run("other", () => otherRepo.getSettingSnapshot(`feature_toggles:plan:${foreign}`)))
        .toEqual({ kind: "stored", value: '{"farm":true}' });
      otherRepo.deleteProfile(profileId);
      expect(repo.getOwnedProfileIdentity(profileId)).toBeNull();
      expect(keys.map((key) => repo.getSettingSnapshot(key))).toEqual([
        { kind: "missing" }, { kind: "missing" }, { kind: "missing" },
      ]);
    } finally { otherSqlite.close(); }
  });

  it("stops after five CAS conflicts and preserves the latest writer", async () => {
    const original = repo.compareAndSetOwnedPlanFeatures.bind(repo);
    let version = 0;
    const writes = vi.spyOn(repo, "compareAndSetOwnedPlanFeatures").mockImplementation((input) => {
      repo.setSetting(planKey(), JSON.stringify({ orders: true, future: ++version }));
      return original(input);
    });
    const response = await patch({ farm: true });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ detail: "Plan features changed; reload and retry" });
    expect(writes.mock.calls).toHaveLength(5);
    expect(repo.getSettingSnapshot(planKey())).toEqual({ kind: "stored", value: '{"orders":true,"future":5}' });
  });

  it("rechecks corruption and ownership after a CAS conflict", async () => {
    const original = repo.compareAndSetOwnedPlanFeatures.bind(repo);
    const writes = vi.spyOn(repo, "compareAndSetOwnedPlanFeatures").mockImplementationOnce((input) => {
      repo.setSetting(planKey(), "");
      return original(input);
    });
    expect((await patch({ farm: true })).json()).toEqual(invalid);
    expect(writes.mock.calls).toHaveLength(1);
    writes.mockRestore();
    repo.setSetting(planKey(), "{}");
    const deletion = vi.spyOn(repo, "compareAndSetOwnedPlanFeatures").mockImplementationOnce(() => {
      repo.deleteProfile(profileId);
      return false;
    });
    expect((await patch({ farm: true })).statusCode).toBe(404);
    expect(deletion.mock.calls).toHaveLength(1);
    expect(repo.getSettingSnapshot(planKey())).toEqual({ kind: "missing" });
  });

  it("filters aggregate suggestions by live stored plans while leaving the manual queue readable", async () => {
    const hidden = repo.createProfile("Hidden plan").id;
    const foreign = tenantStorage.run("other", () => repo.createProfile("Foreign").id);
    repo.setSetting("feature_toggles", '{"farm":false}');
    repo.setSetting(planKey(), '{"farm":true}');
    repo.setSetting(`feature_toggles:plan:${hidden}`, '{"farm":false}');
    repo.setSetting(`feature_toggles:plan:${foreign}`, "corrupt foreign row");
    const items = [queue("eligible-a", profileId), queue("eligible-b", profileId),
      queue("hidden", hidden), queue("foreign", foreign), queue("missing", 999999), queue("legacy")];
    saveQueue(items);
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    const filaments = vi.spyOn(repo, "listParts");
    expect((await suggestions()).json()).toEqual(expectedSuggestion(["eligible-a", "eligible-b"]));
    expect(reads.mock.calls.filter(([key]) => key === planKey())).toEqual([]);
    expect(reads.mock.calls.some(([key]) => key === `feature_toggles:plan:${foreign}`)).toBe(false);
    expect(filaments.mock.calls).toEqual([[profileId, 10_000, 0], [profileId, 10_000, 0]]);
    expect((await app.inject("/printer-send-queue")).json()).toEqual({ items });
    expect((await patch({ farm: false })).statusCode).toBe(200);
    const denial = await suggestions();
    expect(denial.statusCode).toBe(403);
    expect(denial.json()).toEqual({ status: 403, title: "Forbidden", detail: "Feature farm is disabled.", code: "FEATURE_DISABLED" });
    repo.setSetting("feature_toggles", '{"farm":true}');
    expect((await suggestions()).json()).toEqual(expectedSuggestion(["legacy"]));
    saveQueue([queue("hidden", hidden)]);
    expect((await suggestions()).json()).toEqual({ suggestions: [] });
  });

  it("reads bounded owned-plan batches from SQLite and retains duplicate queue items across the batch boundary", () => {
    const ids = repo.transaction(() => Array.from({ length: 501 }, (_, index) => repo.createProfile(`Batch ${index}`).id));
    const first = ids[0];
    const last = ids[500];
    if (first === undefined || last === undefined) throw new Error("Batch fixture is incomplete");
    const foreign = tenantStorage.run("other", () => {
      const id = repo.createProfile("Foreign batch plan").id;
      repo.setSetting(`feature_toggles:plan:${id}`, "corrupt foreign setting");
      return id;
    });
    repo.setSetting("feature_toggles", '{"farm":false}');
    repo.setSetting(`feature_toggles:plan:${first}`, '{"farm":true}');
    repo.setSetting(`feature_toggles:plan:${last}`, '{"farm":true}');
    const queued = ids.map((id, index) => queue(`batch-${index}`, id));
    saveQueue([...queued, queue("duplicate-first", first), queue("duplicate-last", last),
      queue("foreign", foreign), queue("missing", 999999), queue("legacy")]);
    const raw = new Database(sqlite.dbPath);
    const queries: Array<{ query: string; params: unknown[] }> = [];
    const counted = new AppRepository(drizzle(raw, { schema,
      logger: { logQuery: (query, params) => queries.push({ query, params }) },
    }), undefined, sqlite.reposDir);
    try {
      const result = selectFarmSuggestionItems(counted);
      expect(result.kind).toBe("allowed");
      if (result.kind !== "allowed") throw new Error("Expected allowed farm selection");
      expect(result.items.map((item) => item.id)).toEqual(["batch-0", "batch-500", "duplicate-first", "duplicate-last"]);
      const batches = queries.filter(({ query }) => query.includes('left join "app_settings"'));
      expect(batches.map(({ params }) => params.length)).toEqual([502, 5]);
      expect(queries.filter(({ query }) => query.includes('from "build_profiles"'))).toHaveLength(2);
      repo.setSetting(`feature_toggles:plan:${last}`, "");
      expect(selectFarmSuggestionItems(counted)).toEqual({ kind: "invalid_storage" });
      expect(counted.getOwnedPlanFeatureSnapshots([first, ids[1] ?? first, last, foreign, 999999])).toEqual([
        { profileId: first, snapshot: { kind: "stored", value: '{"farm":true}' } },
        { profileId: ids[1], snapshot: { kind: "missing" } },
        { profileId: last, snapshot: { kind: "stored", value: "" } },
      ]);
    } finally { raw.close(); }
  });

  it("profileless legacy items inherit user farm and missing plan overrides inherit both ways", async () => {
    saveQueue([queue("legacy"), queue("owned", profileId)]);
    repo.setSetting("feature_toggles", '{"farm":true}');
    expect((await suggestions()).json()).toEqual(expectedSuggestion(["legacy", "owned"]));
    repo.setSetting("feature_toggles", '{"farm":false}');
    expect((await suggestions()).statusCode).toBe(403);
    expect((await patch({ farm: true })).statusCode).toBe(200);
    expect((await suggestions()).json()).toEqual(expectedSuggestion(["owned"]));
    expect((await patch({ farm: null })).statusCode).toBe(200);
    expect((await suggestions()).statusCode).toBe(403);
  });

  it("corrupt owned plans fail the whole suggestion request before fleet or wanted-filament reads", async () => {
    const broken = repo.createProfile("Broken").id;
    repo.setSetting("feature_toggles", '{"farm":true}');
    repo.setSetting(planKey(), '{"farm":true}');
    saveQueue([queue("eligible", profileId), queue("broken", broken)]);
    const reads = vi.spyOn(repo, "getSetting");
    const filaments = vi.spyOn(repo, "listParts");
    for (const value of ["", '{"orders":null}', "[]"]) {
      repo.setSetting(`feature_toggles:plan:${broken}`, value);
      const response = await suggestions();
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ status: 500, title: "Internal Server Error", ...invalid });
      expect(reads.mock.calls).toEqual([["printer.send_queue"]]);
      expect(filaments.mock.calls).toEqual([]);
      reads.mockClear();
    }
  });

  it("global farm access ignores enabled and disabled queued plan rows", async () => {
    const { readFarmAccess } = await import("../lib/farm-access.js");
    saveQueue([queue("owned", profileId)]);
    repo.setSetting("feature_toggles", '{"farm":false}');
    repo.setSetting(planKey(), '{"farm":true}');
    expect((await suggestions()).json()).toEqual(expectedSuggestion(["owned"]));
    expect(readFarmAccess(() => repo)).toEqual({
      kind: "disabled", error: "Feature farm is disabled.", code: "FEATURE_DISABLED",
    });
    repo.setSetting("feature_toggles", '{"farm":true}');
    repo.setSetting(planKey(), '{"farm":false}');
    expect((await suggestions()).json()).toEqual({ suggestions: [] });
    expect(readFarmAccess(() => repo)).toEqual({ kind: "allowed" });
  });

  it("invalid user storage fails before queue reads, even with an enabled plan", async () => {
    repo.setSetting("feature_toggles", "");
    repo.setSetting(planKey(), '{"farm":true}');
    saveQueue([queue("eligible", profileId)]);
    const reads = vi.spyOn(repo, "getSetting");
    const response = await suggestions();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ status: 500, title: "Internal Server Error", ...invalid });
    expect(reads.mock.calls).toEqual([]);
  });
});
