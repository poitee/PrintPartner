import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AssistantProposedAction } from "@print-partner/contracts";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { createProductMcpServer } from "../mcp/product-mcp.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import { registerAssistantRoutes } from "../routes/assistant.js";
import { newBuildPlanningBrief, readBuildPlanningBrief, saveBuildPlanningBrief } from "../services/build-planning.js";
import { InProcessJobRunner } from "../services/job-runner.js";
import { applyAssistantAction, invokeAssistantTool } from "./tools.js";

const request = "  Build a printer with a USB umbilical.\nKeep this customer wording.  ";
const input = { name: "Customer Build", request, urls: [], idempotency_key: "customer-build" };
const denied = { error: "Feature orders is disabled.", code: "FEATURE_DISABLED" };
const invalid = { error: "Stored feature toggles are invalid.", code: "FEATURE_TOGGLES_INVALID" };
const deniedApply = { ok: false, status: 403, code: "FEATURE_DISABLED", detail: denied.error };
const invalidApply = { ok: false, status: 409, code: "FEATURE_TOGGLES_INVALID", detail: invalid.error };

function forgedAction(planId = 0): AssistantProposedAction {
  return { id: "forged-build", type: "propose_create_build", plan_id: planId,
    label: "Create Build", summary: "Customer request", params: { ...input } };
}

describe("assistant Create Build Orders admission", () => {
  let root: string;
  let database: SqliteDatabase;
  let repo: AppRepository;
  let jobs: InProcessJobRunner;
  let clients: Client[];
  let apps: ReturnType<typeof Fastify>[];

  beforeEach(() => {
    vi.stubEnv("PP_DESKTOP_REBUILD", "1");
    vi.stubEnv("HOST", "127.0.0.1");
    root = mkdtempSync(join(tmpdir(), "pp-create-build-orders-"));
    vi.stubEnv("PRINT_PARTNER_DATA_DIR", root);
    database = new SqliteDatabase(root);
    database.connect();
    repo = new AppRepository(getDb(database), undefined, database.reposDir);
    jobs = new InProcessJobRunner({ getRepo: () => repo, reposDir: database.reposDir,
      exportsDir: join(root, "exports"), dataDir: root });
    clients = [];
    apps = [];
  });

  afterEach(async () => {
    for (const client of clients) await client.close();
    for (const app of apps) await app.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function propose(selectors: Record<string, unknown> = {}, activePlanId?: number) {
    return invokeAssistantTool("propose_create_build", { ...input, ...selectors }, { repo, dataDir: root, activePlanId });
  }

  function apply(action = forgedAction()) {
    return applyAssistantAction(action, { repo, jobs, dataDir: root });
  }

  async function proposedAction() {
    const result = await propose();
    if (!result.proposedAction) throw new Error(`Expected proposal, got ${result.content}`);
    return result.proposedAction;
  }

  async function mcp() {
    const server = createProductMcpServer({ getRepo: () => repo, jobs, config: loadConfig(), pending: new Map() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "create-build-orders-test", version: "1" });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  async function mcpCall(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    if (!Array.isArray(result.content)) throw new Error("Missing MCP content");
    const text = result.content[0];
    if (!text || text.type !== "text" || typeof text.text !== "string") throw new Error("Missing MCP text");
    return { body: JSON.parse(text.text), isError: result.isError === true };
  }

  it.each([undefined, "{}", '{"orders":false}'])("rejects proposal and forged apply for tenant settings %j", async (stored) => {
    if (stored !== undefined) repo.setSetting("feature_toggles", stored);
    const ordinary = repo.createProfile("Ordinary Plan");
    expect(repo.getProfileHeader(ordinary.id)?.special_request).toBe(null);
    const before = repo.listProfileHeaders();
    expect(await propose()).toEqual({ content: JSON.stringify(denied) });
    expect(await apply()).toEqual(deniedApply);
    expect(repo.listProfileHeaders()).toEqual(before);
    expect(repo.getSetting("build_planning.create.customer-build")).toBe(null);
    expect(readBuildPlanningBrief(repo, ordinary.id)).toBe(null);
  });

  it.each(["broken", "null", "[]", '{"orders":"true"}'])("fails closed for corrupt tenant settings %j", async (stored) => {
    repo.setSetting("feature_toggles", stored);
    expect(await propose()).toEqual({ content: JSON.stringify(invalid) });
    expect(await apply()).toEqual(invalidApply);
    expect(repo.listProfileHeaders()).toEqual([]);
    expect(repo.getSetting("feature_toggles")).toBe(stored);
    expect(repo.getSetting("build_planning.create.customer-build")).toBe(null);
  });

  it.each(["1", "true"])("creates the request and brief once under exact opt-in %j", async (flag) => {
    vi.stubEnv("PP_DESKTOP_REBUILD", flag);
    repo.setSetting("feature_toggles", '{"orders":true}');
    const action = await proposedAction();
    expect(action).toMatchObject({ type: "propose_create_build", plan_id: 0, params: input });
    expect(repo.listProfileHeaders()).toEqual([]);
    const created = await apply(action);
    const id = Number(repo.getSetting("build_planning.create.customer-build"));
    expect(created).toEqual({ ok: true, result: { plan_id: id, name: "Customer Build" } });
    expect(repo.getProfileHeader(id)?.special_request).toBe(request.trim());
    expect(readBuildPlanningBrief(repo, id)).toMatchObject({ build_id: id, special_request: request });
    const before = repo.listProfileHeaders();
    const brief = readBuildPlanningBrief(repo, id);
    expect(await apply(action)).toEqual({ ok: true, result: { plan_id: id, name: "Customer Build", idempotent_replay: true } });
    expect(repo.listProfileHeaders()).toEqual(before);
    expect(readBuildPlanningBrief(repo, id)).toEqual(brief);
  });

  it.each(['{"orders":false}', "broken"])("rechecks settings changed after proposal to %j", async (stored) => {
    repo.setSetting("feature_toggles", '{"orders":true}');
    const action = await proposedAction();
    repo.setSetting("feature_toggles", stored);
    expect(await apply(action)).toEqual(stored === "broken" ? invalidApply : deniedApply);
    expect(repo.listProfileHeaders()).toEqual([]);
    expect(repo.getSetting("build_planning.create.customer-build")).toBe(null);
    repo.setSetting("feature_toggles", '{"orders":true}');
    expect(await apply(action)).toMatchObject({ ok: true, result: { name: "Customer Build" } });
  });

  it("preserves stored customer data and read-only idempotent replay after disable", async () => {
    repo.setSetting("feature_toggles", '{"orders":true}');
    const action = await proposedAction();
    await apply(action);
    const id = Number(repo.getSetting("build_planning.create.customer-build"));
    const before = repo.listProfileHeaders();
    const brief = readBuildPlanningBrief(repo, id);
    repo.setSetting("feature_toggles", '{"orders":false}');
    expect(await apply(action)).toEqual({ ok: true, result: { plan_id: id, name: "Customer Build", idempotent_replay: true } });
    expect(repo.listProfileHeaders()).toEqual(before);
    expect(readBuildPlanningBrief(repo, id)).toEqual(brief);
    expect(repo.getSetting("build_planning.create.customer-build")).toBe(String(id));
    repo.setSetting("feature_toggles", '{"orders":true}');
    expect(await apply(action)).toEqual({ ok: true, result: { plan_id: id, name: "Customer Build", idempotent_replay: true } });
    expect(repo.listProfileHeaders()).toEqual(before);
  });

  it("uses tenant admission for new Builds regardless of active, supplied or forged Plan selectors", async () => {
    const existing = repo.createProfile("Existing customer");
    repo.updateProfileSpecialRequest(existing.id, "Saved request");
    saveBuildPlanningBrief(repo, newBuildPlanningBrief(existing.id, "Saved request", []));
    const before = repo.listProfileHeaders();
    const brief = readBuildPlanningBrief(repo, existing.id);
    repo.setSetting(`feature_toggles:plan:${existing.id}`, '{"orders":true}');
    expect(await propose({ plan_id: existing.id, profile_id: existing.id }, existing.id)).toEqual({ content: JSON.stringify(denied) });
    expect(await apply(forgedAction(existing.id))).toEqual(deniedApply);
    expect(repo.listProfileHeaders()).toEqual(before);
    expect(readBuildPlanningBrief(repo, existing.id)).toEqual(brief);
    repo.setSetting("feature_toggles", '{"orders":true}');
    repo.setSetting(`feature_toggles:plan:${existing.id}`, "broken");
    const proposed = await propose({ plan_id: existing.id }, existing.id);
    expect(proposed.proposedAction).toMatchObject({ type: "propose_create_build", plan_id: 0 });
    expect(await apply(forgedAction(existing.id))).toMatchObject({ ok: true, result: { name: "Customer Build" } });
    expect(repo.getProfileHeader(existing.id)).toEqual(before[0]);
    expect(readBuildPlanningBrief(repo, existing.id)).toEqual(brief);
  });

  it("isolates tenant settings and idempotency keys", async () => {
    repo.setSetting("feature_toggles", '{"orders":false}');
    const otherId = await tenantStorage.run("other", async () => {
      repo.setSetting("feature_toggles", '{"orders":true}');
      const action = await proposedAction();
      expect(await apply(action)).toMatchObject({ ok: true, result: { name: "Customer Build" } });
      return Number(repo.getSetting("build_planning.create.customer-build"));
    });
    expect(await propose()).toEqual({ content: JSON.stringify(denied) });
    expect(await apply(forgedAction(otherId))).toEqual(deniedApply);
    expect(repo.getSetting("build_planning.create.customer-build")).toBe(null);
    expect(repo.getProfileHeader(otherId)).toBe(null);
    repo.setSetting("feature_toggles", '{"orders":true}');
    expect(await apply()).toMatchObject({ ok: true, result: { name: "Customer Build" } });
    expect(Number(repo.getSetting("build_planning.create.customer-build"))).not.toBe(otherId);
    expect(tenantStorage.run("other", () => repo.getProfileHeader(otherId)?.special_request)).toBe(request.trim());
  });

  it.each([undefined, "0", "false", "TRUE", "True", " true", "true ", "yes", "2", ""])(
    "keeps legacy proposal and apply without feature reads for flag %j", async (flag) => {
      if (flag === undefined) delete process.env.PP_DESKTOP_REBUILD;
      else vi.stubEnv("PP_DESKTOP_REBUILD", flag);
      repo.setSetting("feature_toggles", "broken");
      const reads = vi.spyOn(repo, "getSettingSnapshot");
      const action = await proposedAction();
      expect(action).toMatchObject({ type: "propose_create_build", plan_id: 0, params: input });
      expect(await apply(action)).toMatchObject({ ok: true, result: { name: "Customer Build" } });
      expect(reads.mock.calls.filter(([key]) => key.startsWith("feature_toggles"))).toEqual([]);
      const id = Number(repo.getSetting("build_planning.create.customer-build"));
      expect(repo.getProfileHeader(id)?.special_request).toBe(request.trim());
      expect(readBuildPlanningBrief(repo, id)).toMatchObject({ special_request: request });
    });

  it("rejects disabled MCP proposals and rechecks pending confirmations in the same session", async () => {
    const client = await mcp();
    expect(await mcpCall(client, "propose_create_build", input)).toEqual({ body: denied, isError: true });
    expect(await mcpCall(client, "list_pending_actions", {})).toEqual({ body: { actions: [] }, isError: false });
    repo.setSetting("feature_toggles", '{"orders":true}');
    await mcpCall(client, "propose_create_build", input);
    const pending = await mcpCall(client, "list_pending_actions", {});
    const id: string = pending.body.actions[0].id;
    repo.setSetting("feature_toggles", '{"orders":false}');
    expect(await mcpCall(client, "confirm_apply", { action_id: id })).toEqual({ body: deniedApply, isError: true });
    expect(repo.listProfileHeaders()).toEqual([]);
    repo.setSetting("feature_toggles", '{"orders":true}');
    expect(await mcpCall(client, "list_pending_actions", {})).toEqual(pending);
    const confirmed = await mcpCall(client, "confirm_apply", { action_id: id });
    const planId = Number(repo.getSetting("build_planning.create.customer-build"));
    expect(confirmed).toEqual({ body: { ok: true, result: { plan_id: planId, name: "Customer Build" } }, isError: false });
    expect(repo.getProfileHeader(planId)?.special_request).toBe(request.trim());
  });

  it.each([['{"orders":false}', 403, "Forbidden", denied], ["broken", 409, "Conflict", invalid]] as const)(
    "returns HTTP admission problems without trusting a supplied action for %j", async (stored, status, title, problem) => {
      repo.setSetting("feature_toggles", stored);
      const app = Fastify();
      apps.push(app);
      app.decorateRequest("tenantId", "default");
      await registerAssistantRoutes(app, { repo, jobs, config: loadConfig() });
      const response = await app.inject({ method: "POST", url: "/assistant/actions/apply", payload: { action: forgedAction() } });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ detail: problem.error, title, status, code: problem.code });
      expect(repo.listProfileHeaders()).toEqual([]);
      expect(repo.getSetting("build_planning.create.customer-build")).toBe(null);
    });
});
