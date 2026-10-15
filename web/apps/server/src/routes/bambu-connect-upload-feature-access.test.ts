import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { MAX_PRINT_FILE_UPLOAD_BYTES } from "../services/upload-limits.js";
import { InProcessJobRunner } from "../services/job-runner.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import * as bambu from "../services/bambu-connect.js";
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
function upload(fields: Array<[string, string]>, tail: Array<[string, string]> = []) {
  const boundary = "----pp-bambu-upload-admission";
  const field = ([name, value]: [string, string]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      ...fields.map(field),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="plate.gcode"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      bytes, Buffer.from("\r\n"), ...tail.map(field), Buffer.from(`--${boundary}--\r\n`),
    ]),
  };
}
describe("Bambu Connect upload HTTP feature admission", () => {
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
    repo.setSetting("integrations", JSON.stringify([{ id: "bambu-host", type: "bambu", name: "Workshop", config: {} }]));
    repo.setSetting("printer.fleet", JSON.stringify([{ id: "bambu-printer", integration_id: "bambu-host" }]));
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
    vi.spyOn(bambu, "tryLaunchBambuConnectUrl").mockResolvedValue({ launched: true });
    vi.spyOn(repo, "setSetting");
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
  function request(prefix = "", tenant = "default", fields: Array<[string, string]> = [["profile_id", String(profileId)], ["launch", "true"], ["printer_id", "bambu-printer"]], tail: Array<[string, string]> = []) {
    const body = upload(fields, tail);
    return app.inject({ method: "POST", url: `${prefix}/bambu-connect/handoff`, ...body, headers: { ...body.headers, "x-test-tenant": tenant } });
  }
  function noWork(dir: string) {
    expect(jobs.getExportsDir).not.toHaveBeenCalled();
    expect(retention.sweepExpiredTransferArtifacts).not.toHaveBeenCalled();
    expect(bambu.tryLaunchBambuConnectUrl).not.toHaveBeenCalled();
    expect(repo.setSetting).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "plate.gcode"))).toEqual(bytes);
    expect(readdirSync(join(dir, ".."))).toEqual([id]);
  }
  for (const prefix of prefixes) {
    it.each([undefined, "{}", '{"bambu":false}', '{"farm":true,"spoolman":true}'])(`${prefix} denies default or explicit off %j without side effects`, async (stored) => {
      if (stored !== undefined) repo.setSetting("feature_toggles", stored);
      const dir = seed("default", true);
      vi.clearAllMocks();
      const response = await request(prefix);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(disabled);
      noWork(dir);
    });
    it.each(["", "{", "[]", "null", '{"bambu":null}', '{"bambu":"true"}', '{"bambu":true,"orders":0}'])(`${prefix} fails closed on corrupt tenant or selected Plan choices %j`, async (stored) => {
      const dir = seed("default", true);
      for (const key of ["feature_toggles", `feature_toggles:plan:${profileId}`]) {
        repo.setSetting("feature_toggles", '{"bambu":true}');
        repo.setSetting(key, stored);
        vi.clearAllMocks();
        const response = await request(prefix);
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual(invalid);
        noWork(dir);
      }
    });
    it(`${prefix} honors only the selected Plan, including revoke and re-enable`, async () => {
      const other = repo.createProfile("Other Plan");
      repo.setSetting(`feature_toggles:plan:${other.id}`, '{"bambu":true}');
      const dir = seed("default", true);
      vi.clearAllMocks();
      expect((await request(prefix)).json()).toEqual(disabled);
      noWork(dir);
      repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":true,"future":{"option":1}}');
      const admitted = await request(prefix, "default", [["plan_id", String(profileId)], ["launch", "true"], ["printer_id", "bambu-printer"]]);
      expect(admitted.statusCode).toBe(200);
      expect(admitted.json().launched).toBe(true);
      expect(admitted.json().checkoff_link_id).toEqual(expect.any(String));
      expect(JSON.parse(repo.getSetting("printer.checkoff_links") ?? "[]")).toEqual([
        expect.objectContaining({ profile_id: profileId, started: true }),
      ]);
      expect(bambu.tryLaunchBambuConnectUrl).toHaveBeenCalledOnce();
      expect(existsSync(dir)).toBe(false);
      expect(readFileSync(join(root, "exports", "tenant-default", "bambu-connect", admitted.json().handoff_id, "plate.gcode"))).toEqual(bytes);
      repo.setSetting("feature_toggles", '{"bambu":true}');
      repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":false}');
      seed("default", true);
      vi.clearAllMocks();
      expect((await request(prefix)).json()).toEqual(disabled);
      expect(jobs.getExportsDir).not.toHaveBeenCalled();
      expect(retention.sweepExpiredTransferArtifacts).not.toHaveBeenCalled();
      expect(bambu.tryLaunchBambuConnectUrl).not.toHaveBeenCalled();
      expect(repo.setSetting).not.toHaveBeenCalled();
      repo.setSetting(`feature_toggles:plan:${profileId}`, "{}");
      expect((await request(prefix)).statusCode).toBe(200);
    });
  }
  it("does not let an enabled Plan rescue corrupt tenant settings or another corrupt Plan deny admission", async () => {
    repo.setSetting("feature_toggles", "broken");
    repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":true}');
    const dir = seed("default", true);
    vi.clearAllMocks();
    expect((await request()).json()).toEqual(invalid);
    noWork(dir);
    const other = repo.createProfile("Corrupt other Plan");
    repo.setSetting(`feature_toggles:plan:${other.id}`, "broken");
    repo.setSetting("feature_toggles", "{}");
    expect((await request()).statusCode).toBe(200);
  });
  it("isolates tenant settings and requires ownership before reading Plan overrides", async () => {
    repo.setSetting("feature_toggles", '{"bambu":true}');
    const otherPlan = tenantStorage.run("other", () => repo.createProfile("Other tenant"));
    tenantStorage.run("other", () => repo.setSetting(`feature_toggles:plan:${otherPlan.id}`, '{"bambu":false}'));
    const dir = seed("other", true);
    vi.clearAllMocks();
    expect((await request("", "other", [["profile_id", String(otherPlan.id)]])).json()).toEqual(disabled);
    noWork(dir);
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    const foreign = await request("", "other");
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().detail).toBe("Profile not found");
    expect(reads).not.toHaveBeenCalledWith(`feature_toggles:plan:${profileId}`);
    noWork(dir);
    tenantStorage.run("other", () => repo.setSetting("feature_toggles", '{"bambu":true}'));
    expect((await request("", "other", [["profile_id", String(otherPlan.id)]])).statusCode).toBe(403);
    tenantStorage.run("other", () => repo.setSetting(`feature_toggles:plan:${otherPlan.id}`, "{}"));
    expect((await request("", "other", [["profile_id", String(otherPlan.id)]])).statusCode).toBe(200);
  });
  it.each(["profile_id", "plan_id"])("rejects duplicate %s before file and refuses to change Plan after file", async (field) => {
    repo.setSetting("feature_toggles", '{"bambu":true}');
    const other = repo.createProfile("Denied Plan");
    repo.setSetting(`feature_toggles:plan:${other.id}`, '{"bambu":false}');
    const dir = seed("default", true);
    vi.clearAllMocks();
    const early = await request("", "default", [["profile_id", String(profileId)], [field, String(other.id)]]);
    expect(early.statusCode).toBe(400);
    noWork(dir);
    const late = await request("", "default", [["profile_id", String(profileId)], ["launch", "true"]], [[field, String(other.id)]]);
    expect(late.statusCode).toBe(400);
    expect(bambu.tryLaunchBambuConnectUrl).not.toHaveBeenCalled();
    expect(repo.setSetting).not.toHaveBeenCalled();
    expect(readdirSync(join(root, "exports", "tenant-default", "bambu-connect"))).toEqual([]);
  });
  it.each(["0", "-1", "bad", ""])("rejects invalid Plan ID %j before side effects", async (value) => {
    repo.setSetting("feature_toggles", '{"bambu":true}');
    const dir = seed("default", true);
    vi.clearAllMocks();
    expect((await request("", "default", [["profile_id", value]])).statusCode).toBe(400);
    noWork(dir);
  });
  it("requires the Plan before the file without staging file-first uploads", async () => {
    repo.setSetting("feature_toggles", '{"bambu":true}');
    const dir = seed("default", true);
    vi.clearAllMocks();
    const response = await request("", "default", [], [["profile_id", String(profileId)]]);
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toBe("Pick a plan before the file (profile_id or plan_id required)");
    noWork(dir);
  });
  it.each([undefined, "", "0", "false", "TRUE", "true ", "yes", "2"])("preserves legacy file-first uploads without feature reads for flag %j", async (flag) => {
    if (flag === undefined) delete process.env.PP_DESKTOP_REBUILD;
    else vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    repo.setSetting("feature_toggles", "broken");
    repo.setSetting(`feature_toggles:plan:${profileId}`, "broken");
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    const response = await request("", "default", [], [["profile_id", String(profileId)], ["launch", "false"]]);
    expect(response.statusCode).toBe(200);
    expect(response.json().launched).toBe(false);
    expect(reads).not.toHaveBeenCalled();
  });
  it("cleans up an admitted upload when launch fails", async () => {
    repo.setSetting("feature_toggles", '{"bambu":true}');
    vi.mocked(bambu.tryLaunchBambuConnectUrl).mockRejectedValueOnce(new Error("Launch failed"));
    const response = await request();
    expect(response.statusCode).toBe(500);
    expect(readdirSync(join(root, "exports", "tenant-default", "bambu-connect"))).toEqual([]);
    expect(repo.getSetting("printer.checkoff_links")).toBeNull();
  });
  it("preserves the print upload byte limit and removes partial staging", async () => {
    repo.setSetting("feature_toggles", '{"bambu":true}');
    const body = upload([["profile_id", String(profileId)], ["launch", "true"]]);
    const fileStart = body.payload.indexOf(bytes);
    const chunk = Buffer.alloc(1024 * 1024, 65);
    async function* payload() {
      yield body.payload.subarray(0, fileStart);
      for (let size = 0; size <= MAX_PRINT_FILE_UPLOAD_BYTES; size += chunk.length) yield chunk;
      yield body.payload.subarray(fileStart + bytes.length);
    }
    vi.clearAllMocks();
    const response = await app.inject({ method: "POST", url: "/bambu-connect/handoff", headers: body.headers, payload: Readable.from(payload()) });
    expect(response.statusCode).toBe(413);
    expect(bambu.tryLaunchBambuConnectUrl).not.toHaveBeenCalled();
    expect(repo.setSetting).not.toHaveBeenCalled();
    expect(readdirSync(join(root, "exports", "tenant-default", "bambu-connect"))).toEqual([]);
  });
  it("runs authentication before feature and artifact work", async () => {
    const secured = Fastify();
    await secured.register(multipart);
    registerTenantMiddleware(secured, { ...loadConfig(), authRequired: true, multiUser: true }, null);
    await registerBambuConnectRoutes(secured, { repo, jobs });
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    const dir = seed();
    vi.clearAllMocks();
    try {
      const response = await secured.inject({ method: "POST", url: "/bambu-connect/handoff", ...upload([["profile_id", String(profileId)]]) });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ detail: "Authentication required" });
      expect(reads).not.toHaveBeenCalled();
      noWork(dir);
    } finally { await secured.close(); }
  });
  it.each(["1", "true"])("guards both buildApp aliases under exact flag %j", async (flag) => {
    vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    const dataDir = join(root, "production");
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const production = await buildApp({ ...loadConfig(), dataDir, authRequired: false }, ports);
    const plan = ports.repository.createProfile("Production handoff");
    try {
      for (const prefix of prefixes) {
        const post = () => production.inject({ method: "POST", url: `${prefix}/bambu-connect/handoff`, ...upload([["profile_id", String(plan.id)], ["launch", "true"]]) });
        expect((await post()).json()).toEqual(disabled);
        ports.repository.setSetting(`feature_toggles:plan:${plan.id}`, '{"bambu":true}');
        expect((await post()).statusCode).toBe(200);
        ports.repository.setSetting(`feature_toggles:plan:${plan.id}`, "broken");
        expect((await post()).json()).toEqual(invalid);
        ports.repository.setSetting(`feature_toggles:plan:${plan.id}`, "{}");
      }
    } finally { await production.close(); ports.db.close(); }
  });
});
