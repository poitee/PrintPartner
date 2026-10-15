import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AssistantProposedAction } from "@print-partner/contracts";
import { AppRepository } from "../db/repository.js";
import { SqliteDatabase, getDb } from "../db/client.js";
import { loadConfig } from "../config.js";
import { acceptPlanForTest, editAcceptedPartsForTest } from "../test/accept-plan.js";
import { registerPartRoutes } from "./parts.js";
import { registerPlanRoutes } from "./plans.js";
import { createProductMcpServer } from "../mcp/product-mcp.js";
import { StatusExecution } from "../integrations/status-execution.js";
import { InProcessJobRunner } from "../services/job-runner.js";
import { newBuildPlanningBrief, readBuildPlanningBrief, saveBuildPlanningBrief } from "../services/build-planning.js";
import { buildSpoolLookup } from "../services/farm-filament.js";
import { saveFleet } from "../services/printer-fleet.js";
import { saveRoleFilamentDefault } from "../services/role-filament-store.js";

const color = "spoolman:inventory:filament:7";
const spool = "spoolman:inventory:spool:11";

describe("Spoolman workflow admission", () => {
  let dir: string;
  let sqlite: SqliteDatabase;
  let repo: AppRepository;
  let app: FastifyInstance;
  let profileId: number;
  let partId: number;
  const network = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
    String(url).includes("/filament")
      ? [{ id: 7, name: "Red", material: "PLA", color_hex: "ff0000" }]
      : [{ id: 11, filament_id: 7, remaining_weight: 480 }],
  ), { headers: { "content-type": "application/json" } }));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pp-workflow-access-"));
    vi.stubEnv("PP_DESKTOP_REBUILD", "1");
    vi.stubEnv("DEPLOY_MODE", "self-host");
    vi.stubEnv("PRINT_PARTNER_DATA_DIR", dir);
    vi.stubGlobal("fetch", network);
    network.mockClear();
    sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const source = repo.createSource({ name: "Workflow", url: "https://github.com/example/workflow" });
    const sourceDir = join(sqlite.reposDir, String(source.id));
    mkdirSync(join(sourceDir, "parts"), { recursive: true });
    writeFileSync(join(sourceDir, "parts", "widget.stl"), "solid widget");
    repo.updateSource(source.id, { local_path: sourceDir });
    repo.updateImportRules(source.id, ["parts/"]);
    profileId = repo.createProfile("Scoped workflow", source.id).id;
    acceptPlanForTest(repo, profileId);
    partId = repo.getProfilePartRows(profileId)[0]!.id;
    repo.setSetting("integrations", JSON.stringify([{ id: "inventory", type: "spoolman", name: "Inventory",
      config: { base_url: "http://127.0.0.1:7912" }, created_at: "2026-10-15", updated_at: "2026-10-15" }]));
    repo.setSetting("default_spoolman_integration_id", "inventory");
    app = Fastify();
    const deps = { repo, dataDir: dir, reposDir: sqlite.reposDir, thumbsDir: join(dir, "thumbs") };
    for (const prefix of ["", "/api/v1"]) {
      await app.register(async (routes) => {
        await registerPartRoutes(routes, deps);
        await registerPlanRoutes(routes, deps);
      }, { prefix });
    }
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function planAccess(enabled: boolean) {
    repo.setSetting(`feature_toggles:plan:${profileId}`, JSON.stringify({ spoolman: enabled }));
  }

  for (const prefix of ["", "/api/v1"]) {
    it(`${prefix} permits unchanged optional defaults but rejects changed inventory references`, async () => {
      planAccess(true);
      expect((await app.inject({ method: "PATCH", url: `${prefix}/parts/${partId}`,
        payload: { filament_color_id: color, spoolman_spool_id: spool } })).statusCode).toBe(200);
      planAccess(false);
      saveRoleFilamentDefault(repo, profileId, "primary", { filament_color_id: color, spoolman_spool_id: spool });
      const apply = () => app.inject({ method: "POST", url: `${prefix}/plans/${profileId}/apply-role-colors`,
        payload: { refresh_thumbnails: false } });
      const unchanged = await apply();
      expect(unchanged.statusCode, unchanged.body).toBe(200);
      expect(repo.getPartRow(partId)).toMatchObject({ filamentColorId: color, spoolmanSpoolId: spool });
      for (const changed of [{ filament_color_id: `${color}0`, spoolman_spool_id: spool },
        { filament_color_id: color, spoolman_spool_id: `${spool}0` }]) {
        saveRoleFilamentDefault(repo, profileId, "primary", changed);
        expect((await apply()).statusCode).toBe(403);
        expect(repo.getPartRow(partId)).toMatchObject({ filamentColorId: color, spoolmanSpoolId: spool });
      }
      expect(network).not.toHaveBeenCalled();
    });
    it.each(["accent", "future-role", "excluded"])(`${prefix} ignores unused optional defaults for %s`, async (unused) => {
      planAccess(false);
      saveRoleFilamentDefault(repo, profileId, "primary", { filament_custom_hex: "#123456" });
      saveRoleFilamentDefault(repo, profileId, unused === "excluded" ? "primary" : unused,
        { filament_color_id: color, spoolman_spool_id: spool });
      if (unused === "excluded") editAcceptedPartsForTest(repo, profileId, [{ projectionPartId: partId, included: false }]);
      const response = await app.inject({ method: "POST", url: `${prefix}/plans/${profileId}/apply-role-colors`,
        payload: { refresh_thumbnails: false } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().updated).toBe(unused === "excluded" ? 0 : 1);
      expect(repo.getProfilePartRows(profileId)[0]).toMatchObject({ filamentColorId: null,
        filamentCustomHex: unused === "excluded" ? null : "#123456" });
      expect(network).not.toHaveBeenCalled();
    });
    it.each([[false, false], [false, true], [true, false], [true, true]])(
      `${prefix} admits assignments using account %s and Plan %s`, async (account, plan) => {
        repo.setSetting("feature_toggles", JSON.stringify({ spoolman: account }));
        planAccess(plan);
        const response = await app.inject({ method: "PATCH", url: `${prefix}/parts/${partId}`,
          payload: { filament_color_id: color, spoolman_spool_id: spool } });
        expect(response.statusCode).toBe(plan ? 200 : 403);
        expect(repo.getPartRow(partId)?.filamentColorId).toBe(plan ? color : null);
        expect(network).not.toHaveBeenCalled();
      },
    );
    it(`${prefix} rejects new role, part, and saved-default assignments before mutation`, async () => {
      repo.setSetting("feature_toggles", '{"spoolman":true}');
      planAccess(false);
      const before = repo.getPartRow(partId);
      for (const payload of [{ filament_color_id: color }, { spoolman_spool_id: spool }]) {
        const part = await app.inject({ method: "PATCH", url: `${prefix}/parts/${partId}`, payload });
        expect(part.statusCode).toBe(403);
        expect(part.json().code).toBe("FEATURE_DISABLED");
        const role = await app.inject({ method: "PUT", url: `${prefix}/plans/${profileId}/role-filament`,
          payload: { role: "primary", ...payload } });
        expect(role.statusCode).toBe(403);
      }
      saveRoleFilamentDefault(repo, profileId, "primary", { filament_color_id: color,
        filament_custom_hex: null, spoolman_spool_id: spool });
      expect((await app.inject({ method: "POST", url: `${prefix}/plans/${profileId}/apply-role-colors`, payload: {} })).statusCode).toBe(403);
      expect(repo.getPartRow(partId)).toEqual(before);
      expect(network).not.toHaveBeenCalled();
      expect((await app.inject({ method: "PATCH", url: `${prefix}/parts/${partId}`,
        payload: { filament_custom_hex: "#123456", spoolman_spool_id: null } })).statusCode).toBe(200);
    });

    it(`${prefix} preserves stored assignments and hides live observations after revocation`, async () => {
      planAccess(true);
      expect((await app.inject({ method: "PATCH", url: `${prefix}/parts/${partId}`,
        payload: { filament_color_id: color, spoolman_spool_id: spool } })).statusCode).toBe(200);
      planAccess(false);
      for (const payload of [{ spoolman_spool_id: spool }, { spoolman_spool_id: null }]) {
        expect((await app.inject({ method: "PATCH", url: `${prefix}/parts/${partId}`, payload })).statusCode).toBe(200);
      }
      expect(repo.getPartRow(partId)?.filamentColorId).toBe(color);
      const review = await app.inject(`${prefix}/plans/${profileId}/review`);
      expect(review.statusCode).toBe(200);
      expect(review.body).toContain(color);
      expect(review.body).not.toContain('"remaining_weight":480');
      expect(network).not.toHaveBeenCalled();
    });
  }

  it("keeps denied farm inventory unknown even when a Plan opts in", async () => {
    planAccess(true);
    const lookup = await buildSpoolLookup(repo, [color]);
    expect(lookup(color)).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });

  async function mcp() {
    const statusExecution = new StatusExecution();
    const pending = new Map<string, AssistantProposedAction>();
    const jobs = new InProcessJobRunner({ getRepo: () => repo, reposDir: sqlite.reposDir,
      exportsDir: join(dir, "exports"), dataDir: dir });
    const server = createProductMcpServer({ getRepo: () => repo, jobs, config: loadConfig(), pending, statusExecution });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "workflow-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, pending, close: async () => { await client.close(); await server.close(); await statusExecution.stop(); } };
  }

  it("enforces Plan access through real MCP review and assignment confirmation", async () => {
    planAccess(true);
    await app.inject({ method: "PATCH", url: `/parts/${partId}`, payload: { filament_color_id: color, spoolman_spool_id: spool } });
    saveBuildPlanningBrief(repo, newBuildPlanningBrief(profileId, "Primary color is Red.", []));
    const session = await mcp();
    try {
      await session.client.callTool({ name: "propose_assign_role_filament", arguments: { plan_id: profileId,
        assignment: { role: "primary", inventory_kind: "spoolman", inventory_id: color, color_hex: "#ff0000" } } });
      const action = [...session.pending.values()][0];
      expect(action).toBeDefined();
      planAccess(false);
      const before = readBuildPlanningBrief(repo, profileId);
      const applied = await session.client.callTool({ name: "confirm_apply", arguments: { action_id: action!.id } });
      expect(applied.isError).toBe(true);
      expect(JSON.stringify(applied.content)).toContain("disabled");
      expect(readBuildPlanningBrief(repo, profileId)).toEqual(before);
      const review = await session.client.callTool({ name: "get_plan_review", arguments: { plan_id: profileId } });
      expect(review.isError).toBeFalsy();
      expect(JSON.stringify(review.content)).toContain(color);
      expect(network).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });
  it("rechecks MCP assignment access after awaiting live inventory", async () => {
    planAccess(true);
    saveBuildPlanningBrief(repo, newBuildPlanningBrief(profileId, "Primary color is Red.", []));
    const session = await mcp();
    try {
      await session.client.callTool({ name: "propose_assign_role_filament", arguments: { plan_id: profileId,
        assignment: { role: "primary", inventory_kind: "spoolman", inventory_id: color, color_hex: "#ff0000" } } });
      const action = [...session.pending.values()][0]!;
      const before = readBuildPlanningBrief(repo, profileId);
      network.mockImplementationOnce(async () => {
        planAccess(false);
        return new Response(JSON.stringify([{ id: 7, name: "Red", color_hex: "ff0000" }]));
      });
      const applied = await session.client.callTool({ name: "confirm_apply", arguments: { action_id: action.id } });
      expect(applied.isError).toBe(true);
      expect(JSON.stringify(applied.content)).toContain("FEATURE_DISABLED");
      expect(readBuildPlanningBrief(repo, profileId)).toEqual(before);
      expect(network).toHaveBeenCalledTimes(1);
    } finally { await session.close(); }
  });

  it("uses the Plan override for live MCP review and assignment while farm inventory remains account scoped", async () => {
    repo.setSetting("feature_toggles", '{"farm":true,"spoolman":false}');
    planAccess(true);
    await app.inject({ method: "PATCH", url: `/parts/${partId}`, payload: { filament_color_id: color, spoolman_spool_id: spool } });
    saveBuildPlanningBrief(repo, newBuildPlanningBrief(profileId, "Primary color is Red.", []));
    saveFleet(repo, [{ id: "printer", name: "Printer", model: "Generic", bed_width_mm: 250,
      bed_depth_mm: 250, bed_height_mm: 250, margin_mm: 4, max_filament_slots: 1,
      loaded_filaments: [{ slot: 1, filament_color_id: color, label: "Red" }] }]);
    const session = await mcp();
    try {
      const review = await session.client.callTool({ name: "get_plan_review", arguments: { plan_id: profileId } });
      expect(JSON.stringify(review.content)).toContain("Red");
      expect(network.mock.calls.length).toBeGreaterThan(0);
      network.mockClear();
      await session.client.callTool({ name: "get_farm_status", arguments: {} });
      expect(network).not.toHaveBeenCalled();
      await session.client.callTool({ name: "propose_assign_role_filament", arguments: { plan_id: profileId,
        assignment: { role: "primary", inventory_kind: "spoolman", inventory_id: color, color_hex: "#ff0000" } } });
      const action = [...session.pending.values()][0]!;
      const applied = await session.client.callTool({ name: "confirm_apply", arguments: { action_id: action.id } });
      expect(applied.isError).toBeFalsy();
      expect(readBuildPlanningBrief(repo, profileId)?.role_filaments).toContainEqual(expect.objectContaining({ inventory_id: color }));
    } finally { await session.close(); }
  });

});
