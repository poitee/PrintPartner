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
      expect(body.download_path).toBe(`/bambu-connect/handoff/${body.handoff_id}/file?profile_id=${profileId}`);
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
  it.each(prefixes)("%s downloads a Plan-only upload using the returned path", async (prefix) => {
    repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":true}');
    const staged = await request("POST", prefix);
    expect(staged.statusCode).toBe(200);
    const download = await app.inject({ method: "GET", url: `${prefix}${staged.json().download_path}` });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(bytes);
    expect(existsSync(join(root, "exports", "tenant-default", "bambu-connect", staged.json().handoff_id))).toBe(false);
  });
  it("isolates tenants and keeps legacy artifacts under tenant policy", async () => {
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
    expect(foreign.json()).toEqual({ status: 404, title: "Not Found", detail: "Profile not found" });
    const own = await app.inject({ method: "GET", url: staged.json().download_path });
    expect(own.json()).toEqual(disabled);
  });
  it.each(prefixes)("%s enforces the persisted Plan after revoke, query swapping or stripping", async (prefix) => {
    repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":true}');
    const other = repo.createProfile("Other enabled Plan");
    repo.setSetting(`feature_toggles:plan:${other.id}`, '{"bambu":true}');
    const staged = (await request("POST", prefix)).json();
    const path = `${prefix}${staged.download_path}`;
    const stripped = path.split("?")[0];
    const dir = join(root, "exports", "tenant-default", "bambu-connect", staged.handoff_id);
    expect(readFileSync(join(dir, ".plan-id"), "utf8")).toBe(String(profileId));
    repo.setSetting("feature_toggles", '{"bambu":true}');
    repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":false}');
    for (const url of [path, stripped, `${stripped}?profile_id=${other.id}`]) {
      vi.clearAllMocks();
      const denied = await app.inject({ method: "GET", url });
      expect(denied.statusCode).toBe(403);
      expect(retention.sweepExpiredTransferArtifacts).not.toHaveBeenCalled();
      expect(readFileSync(join(dir, "plate.gcode"))).toEqual(bytes);
    }
    repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":true}');
    expect((await app.inject({ method: "GET", url: `${stripped}?profile_id=${other.id}` })).statusCode).toBe(403);
    const download = await app.inject({ method: "GET", url: path });
    expect(download.rawPayload).toEqual(bytes);
    expect(existsSync(dir)).toBe(false);
  });
  it("never uses an unrelated enabled Plan to admit a legacy artifact", async () => {
    repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":true}');
    const dir = seed("default", true);
    const url = `/bambu-connect/handoff/${id}/file?profile_id=${profileId}`;
    const response = await app.inject({ method: "GET", url });
    expect(response.json()).toEqual(disabled);
    expect(retention.sweepExpiredTransferArtifacts).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "plate.gcode"))).toEqual(bytes);
    repo.setSetting("feature_toggles", '{"bambu":true}');
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    expect(existsSync(dir)).toBe(false);
  });
  it("checks query and stored Plan ownership before reading foreign settings", async () => {
    repo.setSetting("feature_toggles", '{"bambu":true}');
    const foreign = tenantStorage.run("other", () => repo.createProfile("Foreign"));
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    const dir = seed();
    expect((await app.inject({ method: "GET", url: `/bambu-connect/handoff/${id}/file?profile_id=${foreign.id}` })).statusCode).toBe(404);
    expect(reads).not.toHaveBeenCalledWith(`feature_toggles:plan:${foreign.id}`);
    noWork(dir);
    writeFileSync(join(dir, ".plan-id"), String(foreign.id));
    expect((await request("GET")).statusCode).toBe(404);
    expect(reads).not.toHaveBeenCalledWith(`feature_toggles:plan:${foreign.id}`);
    expect(retention.sweepExpiredTransferArtifacts).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "plate.gcode"))).toEqual(bytes);
  });
  it("does not expose another tenant's bound artifact with an owned enabled Plan", async () => {
    repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":true}');
    const staged = (await request("POST")).json();
    const other = tenantStorage.run("other", () => repo.createProfile("Other tenant"));
    tenantStorage.run("other", () => repo.setSetting(`feature_toggles:plan:${other.id}`, '{"bambu":true}'));
    const foreign = await app.inject({ method: "GET", url: staged.download_path.replace(`=${profileId}`, `=${other.id}`), headers: { "x-test-tenant": "other" } });
    expect(foreign.json()).toEqual(disabled);
    expect((await app.inject({ method: "GET", url: staged.download_path })).rawPayload).toEqual(bytes);
  });
  it.each(["", "{", "null", "0", "-1", "1.5", "01", "9007199254740992", "1\n"])("fails closed on malformed artifact binding %j", async (binding) => {
    repo.setSetting("feature_toggles", '{"bambu":true}');
    const dir = seed("default", true);
    writeFileSync(join(dir, ".plan-id"), binding);
    const response = await request("GET");
    expect(response.statusCode).toBe(500);
    expect(response.json().code).toBe("HANDOFF_BINDING_INVALID");
    expect(retention.sweepExpiredTransferArtifacts).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "plate.gcode"))).toEqual(bytes);
  });
  it.each(["feature_toggles", "plan"])("preserves expired bound artifacts on corrupt %s and expires them after re-enable", async (key) => {
    repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":true}');
    const staged = (await request("POST")).json();
    const dir = join(root, "exports", "tenant-default", "bambu-connect", staged.handoff_id);
    const old = new Date(Date.now() - retention.TRANSFER_ARTIFACT_TTL_MS - 1_000);
    utimesSync(dir, old, old);
    repo.setSetting(key === "plan" ? `feature_toggles:plan:${profileId}` : key, "broken");
    vi.clearAllMocks();
    for (const url of [staged.download_path, staged.download_path.split("?")[0]]) {
      repo.setSetting("feature_toggles", key === "plan" ? '{"bambu":true}' : "broken");
      const denied = await app.inject({ method: "GET", url });
      expect(denied.json()).toEqual(invalid);
      expect(retention.sweepExpiredTransferArtifacts).not.toHaveBeenCalled();
      expect(readFileSync(join(dir, "plate.gcode"))).toEqual(bytes);
    }
    repo.setSetting("feature_toggles", "{}");
    repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":false}');
    expect((await app.inject({ method: "GET", url: staged.download_path })).json()).toEqual(disabled);
    expect(existsSync(dir)).toBe(true);
    repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":true}');
    expect((await app.inject({ method: "GET", url: staged.download_path })).statusCode).toBe(404);
    expect(existsSync(dir)).toBe(false);
  });
  it.each(["bad", "0", "1&profile_id=2"])("rejects malformed query Plan %s without artifact work", async (query) => {
    repo.setSetting("feature_toggles", '{"bambu":true}');
    const dir = seed();
    expect((await app.inject({ method: "GET", url: `/bambu-connect/handoff/${id}/file?profile_id=${query}` })).statusCode).toBe(400);
    noWork(dir);
  });
  it.each([undefined, "", "0", "false", "TRUE", "true ", "yes", "2"])("preserves legacy upload and download without feature reads for flag %j", async (flag) => {
    if (flag === undefined) delete process.env.PP_DESKTOP_REBUILD;
    else vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    repo.setSetting("feature_toggles", "broken");
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    const staged = await request("POST");
    expect(staged.statusCode).toBe(200);
    expect(staged.json().download_path).toBe(`/bambu-connect/handoff/${staged.json().handoff_id}/file`);
    const stagedDir = join(root, "exports", "tenant-default", "bambu-connect", staged.json().handoff_id);
    expect(readdirSync(stagedDir)).toEqual(["plate.gcode"]);
    const dir = seed();
    writeFileSync(join(dir, ".plan-id"), "broken");
    const response = await app.inject({ method: "GET", url: `/bambu-connect/handoff/${id}/file?profile_id=bad` });
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
        ports.repository.setSetting(`feature_toggles:plan:${plan.id}`, '{"bambu":true}');
        const planOnly = await post();
        expect(planOnly.statusCode).toBe(200);
        const planDownload = await production.inject({ method: "GET", url: `${prefix}${planOnly.json().download_path}` });
        expect(planDownload.statusCode).toBe(200);
        expect(planDownload.rawPayload).toEqual(bytes);
        ports.repository.setSetting(`feature_toggles:plan:${plan.id}`, "{}");
      }
    } finally { await production.close(); ports.db.close(); }
  });
});
