import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrinterHostStatus } from "@print-partner/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { StatusExecution } from "../integrations/status-execution.js";
import { createIntegrationPort, type IntegrationAdapter } from "../integrations/store.js";
import * as outbound from "../lib/outbound-url.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import * as discordNotify from "../services/discord-notify.js";
import type { sendFarmDigest } from "../services/discord-notify.js";
import { registerDiscordDigestRoute } from "./discord-digest.js";
import { registerMetricsRoutes } from "./metrics.js";

const webhook = "https://discord.example/webhook/digest";
const telemetry: PrinterHostStatus = { state: "printing", filename: "private-bambu-job.gcode", progress: 40 };
const deniedDigest = [
  { name: "Bambu", state: "unknown", active_job: null },
  { name: "Moonraker", state: "idle", active_job: null },
];
const liveDigest = [
  { name: "Bambu", state: "printing", active_job: "private-bambu-job.gcode" },
  { name: "Moonraker", state: "idle", active_job: null },
];

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred not initialized"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("metrics and Discord digest Bambu feature admission", () => {
  let root: string;
  let database: SqliteDatabase;
  let repo: AppRepository;
  let app: FastifyInstance;
  let execution: StatusExecution;
  const bambu = vi.fn<NonNullable<IntegrationAdapter["getStatus"]>>(async () => telemetry);
  const moonraker = vi.fn<NonNullable<IntegrationAdapter["getStatus"]>>(async () => ({ state: "idle" }));
  const send = vi.fn<typeof sendFarmDigest>(async () => ({ ok: true, status: 204, attempts: 1 }));

  beforeEach(async () => {
    vi.stubEnv("PP_DESKTOP_REBUILD", "1");
    root = mkdtempSync(join(tmpdir(), "pp-fleet-bambu-"));
    database = new SqliteDatabase(root);
    database.connect();
    repo = new AppRepository(getDb(database), undefined, database.reposDir);
    execution = new StatusExecution();
    bambu.mockReset().mockResolvedValue(telemetry);
    moonraker.mockReset().mockResolvedValue({ state: "idle" });
    send.mockReset().mockResolvedValue({ ok: true, status: 204, attempts: 1 });
    vi.spyOn(discordNotify, "sendFarmDigest").mockImplementation(send);
    vi.spyOn(outbound, "safeOutboundFetch").mockRejectedValue(new Error("network disabled in test"));
    const integrations = createIntegrationPort({ repo, statusExecution: execution,
      getAdapter: (type) => ({ type, getStatus: type === "bambu" ? bambu : moonraker,
        testConnection: async () => ({ ok: true }) }) });
    repo.setSetting("integrations", JSON.stringify([
      { id: "moonraker-looking-id", type: "bambu", name: "Synthetic Bambu", config: {} },
      { id: "bambu-looking-id", type: "moonraker", name: "Synthetic Moonraker", config: {} },
    ]));
    repo.setSetting("printer.fleet", JSON.stringify([
      { id: "bambu", name: "Bambu", integration_id: "moonraker-looking-id" },
      { id: "moonraker", name: "Moonraker", integration_id: "bambu-looking-id" },
    ]));
    repo.setSetting("discord_notify_webhook_url", webhook);
    app = Fastify();
    app.decorate("config", { authRequired: true });
    app.decorateRequest("tenantId", "default");
    app.decorateRequest("sessionUser", null);
    app.addHook("onRequest", (request, _reply, done) => {
      request.tenantId = "default";
      tenantStorage.run(request.tenantId, done);
    });
    await registerMetricsRoutes(app, { repo, integrations, validateApiKey: (key) => key === "valid",
      authRequired: true, version: "test" });
    await registerDiscordDigestRoute(app, { repo, integrations });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await execution.stop();
    database.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const metrics = async () => (await app.inject({ method: "GET", url: "/metrics",
    headers: { authorization: "Bearer valid" } })).body;
  async function digest() {
    const response = await app.inject({ method: "POST", url: "/api/discord-digest",
      headers: { authorization: "Bearer valid" } });
    expect(response.json()).toEqual({ ok: true, plates_overnight: 0 });
    return send.mock.lastCall?.[1].printers;
  }
  function expectCounts(body: string, idle: number, printing: number) {
    expect(body).toContain(`printers_idle ${idle}\n`);
    expect(body).toContain(`printers_printing ${printing}\n`);
  }

  it.each(['{"farm":true}', '{"farm":true,"bambu":false}'])(
    "withholds Bambu status for %j without probing it and keeps Moonraker", async (value) => {
      repo.setSetting("feature_toggles", value);
      expectCounts(await metrics(), 1, 0);
      expect(await digest()).toEqual(deniedDigest);
      expect(bambu).toHaveBeenCalledTimes(0);
      expect(moonraker).toHaveBeenCalledTimes(2);
    });

  it("supports live enable, revoke and re-enable", async () => {
    for (const enabled of [true, false, true]) {
      repo.setSetting("feature_toggles", JSON.stringify({ farm: true, bambu: enabled }));
      bambu.mockClear();
      expectCounts(await metrics(), 1, enabled ? 1 : 0);
      expect(await digest()).toEqual(enabled ? liveDigest : deniedDigest);
      expect(bambu).toHaveBeenCalledTimes(enabled ? 2 : 0);
    }
  });

  it("ignores Plan overrides for tenant-global Bambu admission", async () => {
    const plan = repo.createProfile("Override");
    repo.setSetting("feature_toggles", '{"farm":true,"bambu":false}');
    repo.setSetting(`feature_toggles:plan:${plan.id}`, '{"bambu":true}');
    expectCounts(await metrics(), 1, 0);
    expect(await digest()).toEqual(deniedDigest);
    expect(bambu).toHaveBeenCalledTimes(0);
  });

  it.each(["metrics", "digest"])("%s discards Bambu telemetry revoked while its probe is pending", async (surface) => {
    repo.setSetting("feature_toggles", '{"farm":true,"bambu":true}');
    const entered = deferred<void>();
    const pending = deferred<PrinterHostStatus>();
    bambu.mockImplementation(async () => { entered.resolve(); return pending.promise; });
    const response = surface === "metrics" ? metrics() : digest();
    await entered.promise;
    repo.setSetting("feature_toggles", '{"farm":true,"bambu":false}');
    pending.resolve(telemetry);
    if (surface === "metrics") expectCounts(String(await response), 1, 0);
    else expect(await response).toEqual(deniedDigest);
  });

  it("skips corrupt integration elements instead of dropping fleet metrics", async () => {
    const stored = JSON.parse(repo.getSetting("integrations") ?? "[]") as unknown[];
    repo.setSetting("integrations", JSON.stringify([null, ...stored]));
    repo.setSetting("feature_toggles", '{"farm":true,"bambu":false}');
    expectCounts(await metrics(), 1, 0);
    expect(await digest()).toEqual(deniedDigest);
    expect(bambu).toHaveBeenCalledTimes(0);
  });

  it.each([undefined, "0", "TRUE"])("keeps legacy probing without feature reads for flag %j", async (flag) => {
    if (flag === undefined) delete process.env.PP_DESKTOP_REBUILD;
    else vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    repo.setSetting("feature_toggles", "broken");
    const reads = vi.spyOn(repo, "getSettingSnapshot");
    expectCounts(await metrics(), 1, 1);
    expect(await digest()).toEqual(liveDigest);
    expect(reads).not.toHaveBeenCalled();
    expect(bambu).toHaveBeenCalledTimes(2);
  });
});
