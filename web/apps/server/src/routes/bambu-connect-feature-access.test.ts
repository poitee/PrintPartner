import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { InProcessJobRunner } from "../services/job-runner.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import * as retention from "../services/transfer-artifact-retention.js";
import { registerBambuConnectRoutes } from "./bambu-connect.js";
import { registerTenantMiddleware } from "./auth.js";
import { loadConfig } from "../config.js";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";

const disabled = { status: 403, title: "Forbidden", detail: "Feature bambu is disabled.", code: "FEATURE_DISABLED" };
const invalid = { status: 500, title: "Internal Server Error", detail: "Stored feature toggles are invalid.", code: "FEATURE_TOGGLES_INVALID" };
const id = "00000000-0000-4000-8000-000000000001";
const bytes = Buffer.from("G1 X1 Y1\n");
const prefixes = ["", "/api/v1"];
function upload(profileId: number) {
  const boundary = "----pp-bambu-admission";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="profile_id"\r\n\r\n${profileId}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="launch"\r\n\r\nfalse\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="plate.gcode"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
describe("Bambu Connect download HTTP feature admission", () => {
  let root: string;
  let sqlite: SqliteDatabase;
  let repo: AppRepository;
  let jobs: InProcessJobRunner;
  let app: FastifyInstance;
  let profileId: number;
  beforeEach(async () => {
    vi.stubEnv("PP_DESKTOP_REBUILD", "1");
    vi.stubEnv("DEPLOY_MODE", "self-host");
    root = mkdtempSync(join(tmpdir(), "pp-bambu-admission-"));
    sqlite = new SqliteDatabase(root);
    sqlite.connect();
    repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    profileId = repo.createProfile("Bambu handoff").id;
    jobs = new InProcessJobRunner({ getRepo: () => repo, reposDir: sqlite.reposDir, exportsDir: join(root, "exports"), dataDir: root });
    app = Fastify();
    await app.register(multipart);
    app.decorateRequest("tenantId", "default");
    app.addHook("onRequest", (request, _reply, done) => {
      const tenant = request.headers["x-test-tenant"];
      request.tenantId = typeof tenant === "string" ? tenant : "default";
      tenantStorage.run(request.tenantId, done);
    });
    for (const prefix of prefixes) await app.register(async (routes) => registerBambuConnectRoutes(routes, { repo, jobs }), { prefix });
    await app.ready();
    vi.spyOn(jobs, "getExportsDir");
    vi.spyOn(retention, "sweepExpiredTransferArtifacts");
  });
  afterEach(async () => {
    await app.close();
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  function seed(tenant = "default", expired = false) {
    const dir = join(root, "exports", `tenant-${tenant}`, "bambu-connect", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plate.gcode"), bytes);
    if (expired) {
      const old = new Date(Date.now() - retention.TRANSFER_ARTIFACT_TTL_MS - 1_000);
      utimesSync(dir, old, old);
    }
    return dir;
  }
  function request(method: "POST" | "GET", prefix = "", tenant = "default") {
    if (method === "GET") return app.inject({ method, url: `${prefix}/bambu-connect/handoff/${id}/file`, headers: { "x-test-tenant": tenant } });
    const body = upload(profileId);
    return app.inject({ method, url: `${prefix}/bambu-connect/handoff`, ...body, headers: { ...body.headers, "x-test-tenant": tenant } });
  }
  function noWork(dir: string) {
    expect(jobs.getExportsDir).not.toHaveBeenCalled();
    expect(retention.sweepExpiredTransferArtifacts).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "plate.gcode"))).toEqual(bytes);
    expect(readdirSync(join(dir, ".."))).toEqual([id]);
  }
  for (const prefix of prefixes) {
    it.each([undefined, "{}", '{"bambu":false}', '{"farm":true,"spoolman":true}'])(`GET ${prefix} denies default or explicit off %j before download or cleanup`, async (stored) => {
      if (stored !== undefined) repo.setSetting("feature_toggles", stored);
      const dir = seed("default", true);
      const response = await request("GET", prefix);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(disabled);
      noWork(dir);
    });
    it.each(["", "{", "[]", "null", '{"bambu":null}', '{"bambu":"true"}', '{"bambu":true,"orders":0}'])(`GET ${prefix} fails closed on corrupt choices %j`, async (stored) => {
      repo.setSetting("feature_toggles", stored);
      const dir = seed("default", true);
      const response = await request("GET", prefix);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(invalid);
      noWork(dir);
    });
    it(`${prefix} admits upload, blocks a cached download after revoke, and serves it after re-enable`, async () => {
      repo.setSetting("feature_toggles", '{"bambu":true,"future":{"option":1}}');
      const staged = await request("POST", prefix);
      expect(staged.statusCode).toBe(200);
      const body = staged.json();
      expect(body.filename).toBe("plate.gcode");
      expect(body.launched).toBe(false);
      expect(body.download_path).toBe(`/bambu-connect/handoff/${body.handoff_id}/file`);
      const dir = join(root, "exports", "tenant-default", "bambu-connect", body.handoff_id);
      expect(readFileSync(join(dir, "plate.gcode"))).toEqual(bytes);
      repo.setSetting("feature_toggles", '{"bambu":false}');
      vi.clearAllMocks();
      const denied = await app.inject({ method: "GET", url: `${prefix}${body.download_path}` });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual(disabled);
      expect(readFileSync(join(dir, "plate.gcode"))).toEqual(bytes);
      expect(jobs.getExportsDir).not.toHaveBeenCalled();
      expect(retention.sweepExpiredTransferArtifacts).not.toHaveBeenCalled();
  
      repo.setSetting("feature_toggles", '{"bambu":true}');
      const download = await app.inject({ method: "GET", url: `${prefix}${body.download_path}` });
      expect(download.statusCode).toBe(200);
      expect(download.rawPayload).toEqual(bytes);
      expect(existsSync(dir)).toBe(false);
      expect((await request("POST", prefix)).statusCode).toBe(200);
    });
    it(`${prefix} preserves enabled invalid-id and missing-file responses`, async () => {
      repo.setSetting("feature_toggles", '{"bambu":true}');
      const bad = await app.inject({ method: "GET", url: `${prefix}/bambu-connect/handoff/bad/file` });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toEqual({ status: 400, title: "Bad Request", detail: "Invalid handoff id" });
      const missing = await request("GET", prefix);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ status: 404, title: "Not Found", detail: "Handoff not found" });
    });
  }
  it("isolates tenants and ignores Plan overrides for tenant-wide file download admission", async () => {
    repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":true}');
    const dir = seed("other");
    seed();
    expect((await request("GET")).json()).toEqual(disabled);
    repo.setSetting("feature_toggles", '{"bambu":true}');
    tenantStorage.run("other", () => repo.setSetting("feature_toggles", '{"bambu":false}'));
    const staged = await request("POST");
    expect(staged.statusCode).toBe(200);
    repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":false}');
    vi.clearAllMocks();

    expect((await request("GET", "", "other")).json()).toEqual(disabled);
    noWork(dir);
    expect((await request("GET")).rawPayload).toEqual(bytes);
    expect(readFileSync(join(dir, "plate.gcode"))).toEqual(bytes);
    tenantStorage.run("other", () => repo.setSetting("feature_toggles", '{"bambu":true}'));
    const foreign = await app.inject({ method: "GET", url: staged.json().download_path, headers: { "x-test-tenant": "other" } });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ status: 404, title: "Not Found", detail: "Handoff not found" });
    const own = await app.inject({ method: "GET", url: staged.json().download_path });
    expect(own.statusCode).toBe(200);
    expect(own.rawPayload).toEqual(bytes);
  });
  it.each([undefined, "", "0", "false", "TRUE", "true ", "yes", "2"])("preserves legacy upload and download without feature reads for flag %j", async (flag) => {
    if (flag === undefined) delete process.env.PP_DESKTOP_REBUILD;
    else vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    repo.setSetting("feature_toggles", "broken");
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    expect((await request("POST")).statusCode).toBe(200);
    const dir = seed();
    const response = await request("GET");
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(existsSync(dir)).toBe(false);
    expect(reads).not.toHaveBeenCalled();
  });
  it("runs authentication before feature and artifact work", async () => {
    const secured = Fastify();
    await secured.register(multipart);
    registerTenantMiddleware(secured, { ...loadConfig(), authRequired: true, multiUser: true }, null);
    await registerBambuConnectRoutes(secured, { repo, jobs });
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    const dir = seed();
    try {
      const response = await secured.inject({ method: "GET", url: `/bambu-connect/handoff/${id}/file` });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ detail: "Authentication required" });
      expect(reads).not.toHaveBeenCalled();
      noWork(dir);
    } finally { await secured.close(); }
  });
  it.each(["1", "true"])("guards both production aliases under exact flag %j", async (flag) => {
    vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    const dataDir = join(root, "production");
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const production = await buildApp({ ...loadConfig(), dataDir, authRequired: false }, ports);
    const plan = ports.repository.createProfile("Production handoff");
    try {
      for (const prefix of prefixes) {
        const post = () => production.inject({ method: "POST", url: `${prefix}/bambu-connect/handoff`, ...upload(plan.id) });
        ports.repository.setSetting("feature_toggles", '{"bambu":true}');
        const staged = await post();
        expect(staged.statusCode).toBe(200);
        const file = `${prefix}${staged.json().download_path}`;
        ports.repository.setSetting("feature_toggles", "broken");
    
        const corrupt = await production.inject({ method: "GET", url: file });
        expect(corrupt.statusCode).toBe(500);
        expect(corrupt.json()).toEqual(invalid);
        ports.repository.setSetting("feature_toggles", '{"bambu":false}');
        expect((await production.inject({ method: "GET", url: file })).json()).toEqual(disabled);
        ports.repository.setSetting("feature_toggles", '{"bambu":true}');
        const download = await production.inject({ method: "GET", url: file });
        expect(download.statusCode).toBe(200);
        expect(download.rawPayload).toEqual(bytes);
        ports.repository.setSetting("feature_toggles", '{"bambu":false}');
      }
    } finally { await production.close(); ports.db.close(); }
  });
});
