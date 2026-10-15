import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { StatusExecution } from "../integrations/status-execution.js";
import { InProcessJobRunner } from "../services/job-runner.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import { registerJobRoutes } from "./jobs.js";
import { registerTenantMiddleware } from "./auth.js";
import { loadConfig } from "../config.js";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";

const disabled = { status: 403, title: "Forbidden", detail: "Feature bambu is disabled.", code: "FEATURE_DISABLED" };
const invalid = { status: 500, title: "Internal Server Error", detail: "Stored feature toggles are invalid.", code: "FEATURE_TOGGLES_INVALID" };
const unsupported = { status: 400, title: "Bad Request", detail: "Upload is not supported for bambu" };
const urls = ["/jobs/printer-upload", "/api/v1/jobs/printer-upload"];
const bytes = Buffer.from("G1 X1 Y1\n");
type Fields = Array<[string, string]>;

function upload(fields: Fields) {
  const boundary = "----pp-printer-upload-feature-access";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="plate.gcode"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      bytes, Buffer.from("\r\n"),
      ...fields.map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
      Buffer.from(`--${boundary}--\r\n`),
    ]),
  };
}

function configureHost(repo: AppRepository, type = "bambu") {
  repo.setSetting("integrations", JSON.stringify([{ id: "host", type, name: "Workshop", config: {} }]));
  repo.setSetting("printer.fleet", JSON.stringify([{ id: "printer", integration_id: "host" }]));
}

function cleaned(exportsDir: string) {
  const staged = join(exportsDir, "printer-uploads");
  expect(existsSync(staged)).toBe(true);
  expect(readdirSync(staged)).toEqual([]);
}

describe("printer-upload Bambu HTTP feature admission", () => {
  let root: string;
  let sqlite: SqliteDatabase;
  let repo: AppRepository;
  let jobs: InProcessJobRunner;
  let app: FastifyInstance;
  let execution: StatusExecution;
  let profileId: number;

  beforeEach(async () => {
    vi.stubEnv("PP_DESKTOP_REBUILD", "1");
    vi.stubEnv("DEPLOY_MODE", "self-host");
    root = mkdtempSync(join(tmpdir(), "pp-printer-upload-access-"));
    sqlite = new SqliteDatabase(root);
    sqlite.connect();
    repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    profileId = repo.createProfile("Upload Plan").id;
    configureHost(repo);
    jobs = new InProcessJobRunner({ getRepo: () => repo, reposDir: sqlite.reposDir, exportsDir: join(root, "exports"), dataDir: root });
    vi.spyOn(jobs, "start").mockResolvedValue("upload-job");
    execution = new StatusExecution();
    vi.spyOn(execution, "probe").mockResolvedValue({ state: "idle", message: "Ready" });
    app = Fastify();
    await app.register(multipart);
    app.decorateRequest("tenantId", "default");
    app.addHook("onRequest", (request, _reply, done) => {
      const tenant = request.headers["x-test-tenant"];
      request.tenantId = typeof tenant === "string" ? tenant : "default";
      tenantStorage.run(request.tenantId, done);
    });
    for (const prefix of ["", "/api/v1"]) {
      await app.register(async (routes) => registerJobRoutes(routes, jobs, { statusExecution: execution }), { prefix });
    }
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await execution.stop();
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function fields(): Fields {
    return [["printer_id", "printer"], ["profile_id", String(profileId)], ["start", "true"]];
  }
  function request(url = urls[0], tenant = "default", metadata = fields()) {
    const body = upload(metadata);
    return app.inject({ method: "POST", url, ...body, headers: { ...body.headers, "x-test-tenant": tenant } });
  }
  async function refused(expected: typeof disabled | typeof invalid | typeof unsupported, url = urls[0], tenant = "default") {
    const response = await request(url, tenant);
    expect(response.statusCode).toBe(expected.status);
    expect(response.json()).toEqual(expected);
    cleaned(jobs.getExportsDir(tenant));
    expect(jobs.start).not.toHaveBeenCalled();
    expect(execution.probe).not.toHaveBeenCalled();
  }

  for (const url of urls) {
    it.each([undefined, "{}", '{"bambu":false}', '{"farm":true,"spoolman":true}'])(`${url} denies default or explicit off %j and cleans the staged file`, async (stored) => {
      if (stored !== undefined) repo.setSetting("feature_toggles", stored);
      await refused(disabled, url);
    });

    it.each(["", "{", "[]", "null", '{"bambu":null}', '{"bambu":"true"}', '{"bambu":true,"orders":0}'])(`${url} fails closed on corrupt tenant or selected Plan %j`, async (stored) => {
      for (const key of ["feature_toggles", `feature_toggles:plan:${profileId}`]) {
        repo.setSetting("feature_toggles", '{"bambu":true}');
        repo.setSetting(key, stored);
        await refused(invalid, url);
      }
    });

    it(`${url} reads live tenant and selected Plan choices while retaining unsupported Bambu`, async () => {
      const other = repo.createProfile("Unrelated Plan");
      repo.setSetting(`feature_toggles:plan:${other.id}`, '{"bambu":true}');
      await refused(disabled, url);
      repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":true,"future":{"option":1}}');
      await refused(unsupported, url);
      repo.setSetting("feature_toggles", '{"bambu":true}');
      repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":false}');
      await refused(disabled, url);
      repo.setSetting(`feature_toggles:plan:${profileId}`, "{}");
      await refused(unsupported, url);
      repo.setSetting("feature_toggles", '{"bambu":false}');
      await refused(disabled, url);
      repo.setSetting("feature_toggles", '{"bambu":true}');
      await refused(unsupported, url);
      repo.setSetting(`feature_toggles:plan:${other.id}`, "broken");
      await refused(unsupported, url);
      repo.setSetting(`feature_toggles:plan:${profileId}`, '{"bambu":true}');
      repo.setSetting("feature_toggles", "broken");
      await refused(invalid, url);
    });
  }

  it.each(["1", "true"])("enforces exact enabled flag %j", async (flag) => {
    vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    await refused(disabled);
  });

  it.each([undefined, "", "0", "false", "TRUE", "true ", "yes", "2"])("preserves legacy refusal without feature reads for flag %j", async (flag) => {
    if (flag === undefined) delete process.env.PP_DESKTOP_REBUILD;
    else vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    repo.setSetting("feature_toggles", "broken");
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    await refused(unsupported);
    expect(reads).not.toHaveBeenCalled();
  });

  it("isolates tenant choices and checks Plan ownership before feature reads", async () => {
    repo.setSetting("feature_toggles", '{"bambu":true}');
    const otherPlan = tenantStorage.run("other", () => {
      configureHost(repo);
      const plan = repo.createProfile("Other tenant Plan");
      repo.setSetting(`feature_toggles:plan:${plan.id}`, '{"bambu":false}');
      return plan;
    });
    await refused(unsupported);
    const denied = await request(urls[0], "other", [["printer_id", "printer"], ["plan_id", String(otherPlan.id)]]);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual(disabled);
    cleaned(jobs.getExportsDir("other"));
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    for (const metadata of [
      [["printer_id", "printer"]],
      [["printer_id", "printer"], ["profile_id", String(profileId)]],
      [["printer_id", "printer"], ["profile_id", "999999"]],
    ] satisfies Fields[]) {
      reads.mockClear();
      const response = await request(urls[0], "other", metadata);
      expect(response.statusCode).toBe(metadata.length === 1 ? 400 : 404);
      expect(response.json().detail).toBe(metadata.length === 1 ? "Pick a plan to bind this send (profile_id required)" : "Profile not found");
      expect(reads).not.toHaveBeenCalled();
      cleaned(jobs.getExportsDir("other"));
    }
    expect(jobs.start).not.toHaveBeenCalled();
    expect(execution.probe).not.toHaveBeenCalled();
  });

  it.each(["moonraker", "prusalink"])("preserves supported %s and transfers artifact ownership to the job", async (type) => {
    configureHost(repo, type);
    repo.setSetting("feature_toggles", "broken");
    repo.setSetting(`feature_toggles:plan:${profileId}`, "broken");
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ job_id: "upload-job" });
    const dir = join(jobs.getExportsDir(), "printer-uploads");
    const entries = readdirSync(dir);
    expect(entries).toHaveLength(1);
    const artifact = join(dir, entries[0]!, "plate.gcode");
    expect(readFileSync(artifact)).toEqual(bytes);
    expect(jobs.start).toHaveBeenCalledExactlyOnceWith("printer-upload", {
      printer_id: "printer", artifact_path: artifact, filename: "plate.gcode", start: true,
      host_name: "Workshop", profile_id: profileId, checkoff_units: [], unlabeled_names: undefined,
    }, "default");
    expect(execution.probe).toHaveBeenCalledOnce();
    expect(reads).not.toHaveBeenCalled();
  });

  it.each(["validation", "status", "job"])("cleans staged artifacts after %s failure", async (failure) => {
    configureHost(repo, "moonraker");
    if (failure === "status") vi.mocked(execution.probe).mockResolvedValue({ state: "printing", message: "Busy" });
    if (failure === "job") vi.mocked(jobs.start).mockRejectedValue(new Error("job launch failed"));
    const response = await request(urls[0], "default", failure === "validation" ? [["profile_id", String(profileId)]] : fields());
    expect(response.statusCode).toBe(failure === "validation" ? 400 : failure === "status" ? 409 : 500);
    expect(response.json().detail ?? response.json().message).toBe(failure === "validation" ? "printer_id is required" : failure === "status" ? "Printer is printing — wait for Idle or queue for idle" : "job launch failed");
    cleaned(jobs.getExportsDir());
  });

  it("runs authentication before multipart staging and feature reads", async () => {
    const secured = Fastify();
    registerTenantMiddleware(secured, { ...loadConfig(), authRequired: true, multiUser: true }, null);
    await secured.register(multipart);
    await registerJobRoutes(secured, jobs, { statusExecution: execution });
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    try {
      const response = await secured.inject({ method: "POST", url: urls[0], ...upload(fields()) });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ detail: "Authentication required" });
      expect(existsSync(jobs.getExportsDir())).toBe(false);
      expect(reads).not.toHaveBeenCalled();
      expect(jobs.start).not.toHaveBeenCalled();
      expect(execution.probe).not.toHaveBeenCalled();
    } finally { await secured.close(); }
  });

  it.each(["1", "true"])("guards both production HTTP aliases with flag %j", async (flag) => {
    vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    const dataDir = join(root, "production");
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const production = await buildApp({ ...loadConfig(), dataDir, authRequired: false }, ports);
    const plan = ports.repository.createProfile("Production Plan");
    configureHost(ports.repository);
    try {
      for (const url of urls) {
        for (const [stored, expected] of [
          ['{"bambu":false}', disabled], ['{"bambu":true}', unsupported], ["broken", invalid],
        ] satisfies Array<[string, typeof disabled | typeof unsupported | typeof invalid]>) {
          ports.repository.setSetting("feature_toggles", stored);
          const response = await production.inject({ method: "POST", url, ...upload([["printer_id", "printer"], ["profile_id", String(plan.id)], ["start", "true"]]) });
          expect(response.statusCode).toBe(expected.status);
          expect(response.json()).toEqual(expected);
          cleaned(join(dataDir, "exports", "tenant-default"));
        }
      }
    } finally {
      await production.close();
      await ports.db.close();
    }
  });
});
