import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { acceptedPlanBasis } from "../db/accepted-plan-progress.js";
import { AppRepository } from "../db/repository.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import { parseRequiredUnitToken } from "../services/required-units.js";
import { acceptPlanForTest } from "../test/accept-plan.js";
import { registerPlanRoutes } from "./plans.js";

const prefixes = ["", "/api/v1", "/api/v2"];
const disabled = { detail: "Feature orders is disabled.", code: "FEATURE_DISABLED" };
const invalid = { detail: "Stored feature toggles are invalid.", code: "FEATURE_TOGGLES_INVALID" };

describe.each(prefixes)("Orders admission for PATCH %s/plans/:id", (prefix) => {
  let dataDir: string;
  let sqlite: SqliteDatabase;
  let repo: AppRepository;
  let app: FastifyInstance;
  let profileId: number;
  const planKey = () => `feature_toggles:plan:${profileId}`;

  function createPlan(name: string) {
    const source = repo.createSource({ name, url: "https://github.com/test/orders-fixture" });
    const sourceRoot = join(sqlite.reposDir, String(source.id));
    mkdirSync(join(sourceRoot, "parts"), { recursive: true });
    writeFileSync(join(sourceRoot, "parts", "widget.stl"), "solid widget");
    repo.updateSource(source.id, { local_path: sourceRoot });
    repo.updateImportRules(source.id, ["parts/"]);
    const id = repo.createProfile(name, source.id).id;
    expect(acceptPlanForTest(repo, id).merged).toBe(true);
    const accepted = repo.readAcceptedPlanOperationalSnapshot(id);
    if (accepted.kind !== "ready") throw new Error("Expected accepted fixture Plan");
    const unit = accepted.snapshot.parts[0]?.units[0];
    if (!unit) throw new Error("Expected fixture unit");
    repo.setAcceptedUnitCompletion({
      expected: acceptedPlanBasis(accepted.snapshot),
      token: parseRequiredUnitToken(unit.token),
      completed: true,
    });
    repo.updateProfileSpecialRequest(id, "Existing customer request");
    return id;
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-plan-orders-access-"));
    vi.stubEnv("PP_DESKTOP_REBUILD", "1");
    vi.stubEnv("PRINT_PARTNER_DATA_DIR", dataDir);
    sqlite = new SqliteDatabase(dataDir);
    sqlite.connect();
    repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    profileId = createPlan("Owned Plan");
    app = Fastify();
    app.addHook("onRequest", (request, _reply, done) => {
      const tenant = request.headers["x-test-tenant"];
      tenantStorage.run(typeof tenant === "string" ? tenant : "default", done);
    });
    for (const routePrefix of prefixes) {
      await app.register(async (routes) => registerPlanRoutes(routes, {
        repo, dataDir, reposDir: sqlite.reposDir, thumbsDir: join(dataDir, "thumbs"),
      }, { summaryContract: routePrefix === "/api/v1" ? "legacy-v1" : "accepted" }), { prefix: routePrefix });
    }
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function patch(payload: object, id = profileId, tenant = "default") {
    return app.inject({
      method: "PATCH", url: `${prefix}/plans/${id}`, payload,
      headers: { "x-test-tenant": tenant },
    });
  }

  function stored(id = profileId) {
    return {
      header: repo.getProfileHeader(id),
      accepted: repo.readAcceptedPlanOperationalSnapshot(id),
    };
  }

  async function denied(payload: object, status = 403, problem = disabled) {
    const before = stored();
    const response = await patch(payload);
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual(problem);
    expect(stored()).toEqual(before);
  }

  it.each(["New customer request", null, ""])("denies special_request %j before any mixed mutation", async (value) => {
    await denied({ special_request: value, name: "Must not rename", archived: true, touch_last_used: true });
  });

  it.each([
    [undefined, undefined, false],
    ["{}", "{}", false],
    ['{"orders":false}', "{}", false],
    ['{"orders":true}', "{}", true],
    ['{"orders":false}', '{"orders":true}', true],
    ['{"orders":true}', '{"orders":false}', false],
    [undefined, '{"orders":true}', true],
  ])("resolves user %j and Plan %j to %j", async (user, plan, allowed) => {
    if (user !== undefined) repo.setSetting("feature_toggles", user);
    if (plan !== undefined) repo.setSetting(planKey(), plan);
    if (!allowed) return denied({ special_request: "Changed" });
    const response = await patch({ special_request: "  Changed  ", name: "Renamed", touch_last_used: true });
    expect(response.statusCode).toBe(200);
    expect(repo.getProfileHeader(profileId)).toMatchObject({
      name: "Renamed", special_request: "Changed", last_used_at: expect.any(String),
    });
    expect(repo.getSettingSnapshot("feature_toggles")).toEqual(user === undefined
      ? { kind: "missing" } : { kind: "stored", value: user });
    expect(repo.getSettingSnapshot(planKey())).toEqual(plan === undefined
      ? { kind: "missing" } : { kind: "stored", value: plan });
  });

  it.each([null, ""])("allows clearing with %j when Orders is enabled", async (value) => {
    repo.setSetting("feature_toggles", '{"orders":true}');
    expect((await patch({ special_request: value })).statusCode).toBe(200);
    expect(repo.getProfileHeader(profileId)?.special_request).toBeNull();
  });

  it.each(["1", "true"])("enforces live user and Plan revocation with flag %j", async (flag) => {
    vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    repo.setSetting("feature_toggles", '{"orders":true}');
    expect((await patch({ special_request: "Allowed" })).statusCode).toBe(200);
    repo.setSetting("feature_toggles", '{"orders":false}');
    await denied({ special_request: "Revoked", name: "No rename" });
    repo.setSetting(planKey(), '{"orders":true}');
    expect((await patch({ special_request: "Plan opt-in" })).statusCode).toBe(200);
    repo.setSetting(planKey(), '{"orders":false}');
    await denied({ special_request: null, touch_last_used: true });
  });

  it.each(["user", "plan"])("rejects malformed %s settings without partial writes", async (layer) => {
    repo.setSetting("feature_toggles", '{"orders":true}');
    repo.setSetting(planKey(), '{"orders":true}');
    const key = layer === "user" ? "feature_toggles" : planKey();
    for (const value of ["", "{", "[]", "null", '{"orders":null}', '{"orders":"true"}', '{"farm":0}']) {
      repo.setSetting(key, value);
      await denied({ special_request: "Denied", name: "No rename", archived: true, touch_last_used: true }, 500, invalid);
      expect(repo.getSettingSnapshot(key)).toEqual({ kind: "stored", value });
    }
  });

  it.each([undefined, "{}", "broken"])("preserves ordinary edits and customer data with toggles %j", async (value) => {
    if (value !== undefined) repo.setSetting("feature_toggles", value);
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    expect((await patch({ name: "Ordinary edit", touch_last_used: true, archived: true })).statusCode).toBe(200);
    expect(repo.getProfileHeader(profileId)).toMatchObject({
      name: "Ordinary edit", last_used_at: expect.any(String), archived_at: expect.any(String),
      special_request: "Existing customer request",
    });
    expect(reads.mock.calls.filter(([key]) => key.startsWith("feature_toggles"))).toEqual([]);
  });

  it.each([undefined, "0", "false", "TRUE", "true ", "yes", "2", ""])("preserves legacy writes with flag %j", async (flag) => {
    if (flag === undefined) delete process.env.PP_DESKTOP_REBUILD;
    else vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    repo.setSetting("feature_toggles", "broken");
    repo.setSetting(planKey(), "broken");
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    expect((await patch({ special_request: "Legacy write" })).statusCode).toBe(200);
    expect(repo.getProfileHeader(profileId)?.special_request).toBe("Legacy write");
    expect(reads.mock.calls.filter(([key]) => key.startsWith("feature_toggles"))).toEqual([]);
  });

  it("checks ownership before toggles and isolates tenant and sibling Plan choices", async () => {
    const foreign = tenantStorage.run("other", () => {
      const id = createPlan("Foreign Plan");
      repo.setSetting("feature_toggles", '{"orders":true}');
      repo.setSetting(`feature_toggles:plan:${id}`, '{"orders":true}');
      return id;
    });
    const foreignBefore = tenantStorage.run("other", () => stored(foreign));
    repo.setSetting("feature_toggles", "broken");
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    for (const id of [foreign, 999999]) {
      const response = await patch({ special_request: "No access", name: "No rename", archived: true, touch_last_used: true }, id);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ detail: "Profile not found" });
    }
    expect(reads.mock.calls.filter(([key]) => key.startsWith("feature_toggles"))).toEqual([]);
    expect(tenantStorage.run("other", () => stored(foreign))).toEqual(foreignBefore);
    repo.setSetting("feature_toggles", "{}");
    const sibling = createPlan("Sibling Plan");
    repo.setSetting(`feature_toggles:plan:${sibling}`, '{"orders":true}');
    await denied({ special_request: "No inheritance from sibling or tenant" });
    expect((await patch({ special_request: "Foreign tenant allowed" }, foreign, "other")).statusCode).toBe(200);
    expect(tenantStorage.run("other", () => repo.getProfileHeader(foreign)?.special_request)).toBe("Foreign tenant allowed");
  });
});
