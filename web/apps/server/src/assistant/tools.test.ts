import { acceptPlanForTest } from "../test/accept-plan.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { InProcessJobRunner } from "../routes/jobs.js";
import { encodeAcceptedPlate3mf, type StlMesh } from "@print-partner/domain";
import { invokeAssistantTool, applyAssistantAction } from "./tools.js";
import { inferStackPresetId, summarizeOtherBuildsAsExamples } from "./example-builds.js";
import { buildAssistantSystemPrompt } from "./assistant-context.js";
import { hydrateBuildPlanningBrief, newBuildPlanningBrief, readBuildPlanningBrief, saveBuildPlanningBrief } from "../services/build-planning.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test-fixtures/kit-workspace",
);

describe("assistant tools + example builds", () => {
  let dataDir: string;
  let repo: NonNullable<ReturnType<typeof createSelfHostPorts>["repository"]>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-ai-tools-"));
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    repo = ports.repository!;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("list_plans and list_sources return tenant-scoped JSON", async () => {
    const source = repo.createSource({
      name: "Voron-2",
      url: "https://example.com/v2.git",
      source_kind: "github",
    });
    const plan = repo.createProfile("My 2.4", source.id);

    const plans = JSON.parse((await invokeAssistantTool("list_plans", {}, { repo })).content);
    expect(plans.plans).toContainEqual({
      id: plan.id,
      name: "My 2.4",
      part_count: 0,
      build_stale: false,
    });

    const sources = JSON.parse((await invokeAssistantTool("list_sources", {}, { repo })).content);
    expect(sources.sources.some((s: { name: string }) => s.name === "Voron-2")).toBe(true);
  });

  it("exposes plan option groups and searchable Source inventory", async () => {
    const source = repo.createSource({ name: "Options", source_kind: "local" });
    const sourcePath = join(dataDir, "options");
    mkdirSync(join(sourcePath, "STLs", "screen"), { recursive: true });
    writeFileSync(join(sourcePath, "STLs", "screen", "screen_rail.stl"), "solid screen");
    writeFileSync(join(sourcePath, "README.md"), "Screen options");
    repo.updateSource(source.id, { local_path: sourcePath, last_synced_at: new Date().toISOString(), last_commit_sha: "a".repeat(64) });
    const plan = repo.createProfile("Options plan", source.id);
    const optionGroups = JSON.parse((await invokeAssistantTool("get_plan_option_groups", { plan_id: plan.id }, { repo })).content);
    expect(optionGroups.plan_id).toBe(plan.id);
    expect(optionGroups.sources).toEqual(expect.arrayContaining([expect.objectContaining({ source_id: source.id })]));
    const inventory = JSON.parse((await invokeAssistantTool("get_source_inventory", { source_id: source.id }, { repo })).content);
    expect(inventory.sync.synchronized).toBe(true);
    expect(inventory.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ path: "STLs/screen/screen_rail.stl" })]));
    const found = JSON.parse((await invokeAssistantTool("search_source_files", { source_id: source.id, query: "screen_rail" }, { repo })).content);
    expect(found.files).toEqual([{ path: "STLs/screen/screen_rail.stl", byte_size: 12 }]);
  });

  it("proposes and confirms Source metadata changes", async () => {
    const source = repo.createSource({ name: "Before", url: "https://example.com/before.git", source_kind: "git" });
    const proposal = await invokeAssistantTool("propose_update_source", {
      source_id: source.id,
      patch: { name: "After", branch: "release", metadata: { vendor: "Example" } },
    }, { repo });
    expect(JSON.parse(proposal.content).status).toBe("proposed");
    expect(repo.getSource(source.id)?.name).toBe("Before");
    const applied = await applyAssistantAction(proposal.proposedAction!, { repo, jobs: { start: async () => "unused" } as never });
    expect(applied.ok).toBe(true);
    expect(repo.getSource(source.id)).toEqual(expect.objectContaining({ name: "After", branch: "release" }));
    expect(repo.getSource(source.id)?.metadata).toEqual(expect.objectContaining({ vendor: "Example" }));
  });

  it("publishes confirmed MCP file imports as a Source revision", async () => {
    const source = repo.createSource({ name: "Uploads", source_kind: "local" });
    const content = Buffer.from("solid uploaded").toString("base64");
    const proposal = await invokeAssistantTool("propose_import_source_files", {
      source_id: source.id,
      files: [{ path: "parts/uploaded.stl", content_base64: content }],
    }, { repo });
    expect(JSON.parse(proposal.content).status).toBe("proposed");
    const applied = await applyAssistantAction(proposal.proposedAction!, {
      repo,
      dataDir,
      jobs: { start: async () => "unused" } as never,
    });
    expect(applied.ok).toBe(true);
    expect(repo.getSource(source.id)?.last_commit_sha).toMatch(/^[a-f0-9]{64}$/);
    expect(applied.result?.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ path: "parts/uploaded.stl" })]));
  });

  it("imports an incompatible-slicer 3MF into verify-first checkoff and exposes progress", async () => {
    const source = repo.createSource({ name: "Checkoff parts", source_kind: "local" });
    const sourcePath = join(dataDir, "checkoff-source");
    mkdirSync(sourcePath, { recursive: true });
    writeFileSync(join(sourcePath, "bracket.stl"), `solid bracket\n  facet normal 0 0 1\n    outer loop\n      vertex 0 0 0\n      vertex 10 0 0\n      vertex 0 10 0\n    endloop\n  endfacet\nendsolid bracket\n`);
    repo.updateSource(source.id, { local_path: sourcePath, last_synced_at: new Date().toISOString(), last_commit_sha: "d".repeat(64) });
    repo.updateImportRules(source.id, ["bracket.stl"]);
    const plan = repo.createProfile("3MF checkoff plan", source.id);
    acceptPlanForTest(repo, plan.id);
    const accepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    expect(accepted.kind).toBe("ready");
    if (accepted.kind !== "ready") return;
    const part = accepted.snapshot.parts.find((candidate) => candidate.included && candidate.units.length > 0);
    expect(part).toBeDefined();
    if (!part) return;
    const unit = part.units[0]!;
    const mesh: StlMesh = {
      vertices: [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
      faces: [[0, 1, 2]],
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 0, widthMm: 10, depthMm: 10, heightMm: 0 },
    };
    const threeMf = Buffer.from(encodeAcceptedPlate3mf([{ token: unit.token, objectName: unit.objectName, xUm: 0, yUm: 0, mesh }])).toString("base64");

    const before = JSON.parse((await invokeAssistantTool("get_plan_checkoff", { plan_id: plan.id }, { repo })).content);
    expect(before.state).toBe("ready");
    expect(before.parts.find((row: { part_id: number }) => row.part_id === part.projectionPartId).printed_count).toBe(0);

    const imported = await invokeAssistantTool("propose_import_3mf_checkoff", { plan_id: plan.id, filename: "foreign-slicer.3mf", content_base64: threeMf }, { repo });
    const importedApplied = await applyAssistantAction(imported.proposedAction!, { repo, dataDir, jobs: { start: async () => "unused" } as never });
    expect(importedApplied.ok).toBe(true);
    const link = importedApplied.result?.link as { id: string; state: string; units: unknown[] };
    expect(link.state).toBe("awaiting_verify");
    expect(link.units).toHaveLength(1);

    const verified = await invokeAssistantTool("propose_verify_printer_checkoff", { link_id: link.id, decisions: [{ part_id: part.projectionPartId, unit_index: unit.unitIndex, result: "confirmed" }] }, { repo });
    const verifiedApplied = await applyAssistantAction(verified.proposedAction!, { repo, jobs: { start: async () => "unused" } as never });
    expect(verifiedApplied.ok).toBe(true);
    const after = JSON.parse((await invokeAssistantTool("get_plan_checkoff", { plan_id: plan.id }, { repo })).content);
    expect(after.parts.find((row: { part_id: number }) => row.part_id === part.projectionPartId).printed_count).toBe(1);
  });

  it("persists confirmed checklist items and named custom filament", async () => {
    const plan = repo.createProfile("Checklist plan");
    saveBuildPlanningBrief(repo, newBuildPlanningBrief(plan.id, "Build it", []));
    const checklist = await invokeAssistantTool("propose_add_build_checklist_items", { plan_id: plan.id, items: [{ title: "Test fit the panels", category: "test_fit" }] }, { repo });
    const checklistResult = await applyAssistantAction(checklist.proposedAction!, { repo, jobs: { start: async () => "unused" } as never });
    expect(checklistResult.ok).toBe(true);
    expect(readBuildPlanningBrief(repo, plan.id)?.checklist_items).toEqual([expect.objectContaining({ title: "Test fit the panels", required: true, completed: false })]);

    const filament = await invokeAssistantTool("propose_add_custom_filament", { display_name: "Customer Orange", hex: "#ff6600", product_line: "External" }, { repo });
    expect(repo.getSetting("custom_filament_probe")).toBeNull();
    const filamentResult = await applyAssistantAction(filament.proposedAction!, { repo, dataDir, jobs: { start: async () => "unused" } as never });
    expect(filamentResult).toMatchObject({ ok: true, result: { filament: { display_name: "Customer Orange", hex: "#ff6600" } } });
  });

  it("mutating tools only propose actions", async () => {
    const source = repo.createSource({
      name: "Example-Printer",
      url: "https://example.com/p.git",
      source_kind: "github",
    });
    const plan = repo.createProfile("Plan", source.id);
    const { content, proposedAction } = await invokeAssistantTool(
      "apply_stack_preset",
      { plan_id: plan.id, preset_id: "example_kit_r2" },
      { repo, dataDir: FIXTURE },
    );
    expect(proposedAction?.type).toBe("apply_stack_preset");
    expect(proposedAction?.params.preset_id).toBe("example_kit_r2");
    expect(JSON.parse(content).status).toBe("proposed");
    // Layers unchanged until apply
    expect(repo.getProfileLayers(plan.id).length).toBeGreaterThanOrEqual(1);
  });

  it("attaches an uploaded STL/3MF Source to Build planning after confirmation", async () => {
    const source = repo.createSource({ name: "Customer project files", source_kind: "local" });
    const sourcePath = join(dataDir, "sources", String(source.id));
    mkdirSync(sourcePath, { recursive: true });
    writeFileSync(join(sourcePath, "frame.stl"), "solid frame");
    writeFileSync(join(sourcePath, "project.3mf"), "3mf bytes");
    repo.updateSource(source.id, {
      local_path: sourcePath,
      last_synced_at: new Date().toISOString(),
      last_commit_sha: "c".repeat(64),
    });
    const plan = repo.createProfile("Uploaded project");
    saveBuildPlanningBrief(repo, newBuildPlanningBrief(plan.id, "Build these uploaded files", []));

    const proposal = await invokeAssistantTool(
      "propose_import_build_inputs",
      { plan_id: plan.id, inputs: [{ source_id: source.id, filenames: ["frame.stl", "project.3mf"] }] },
      { repo },
    );
    expect(readBuildPlanningBrief(repo, plan.id)?.evidence).toHaveLength(0);

    const applied = await applyAssistantAction(proposal.proposedAction!, {
      repo,
      jobs: { start: async () => "unused" } as never,
    });
    expect(applied.ok).toBe(true);
    expect(readBuildPlanningBrief(repo, plan.id)?.evidence).toEqual([
      expect.objectContaining({
        source_id: source.id,
        input_kind: "upload",
        filenames: ["frame.stl", "project.3mf"],
        sync_status: "synced",
        pinned_revision: "c".repeat(64),
      }),
    ]);
  });

  it("stores informational-page extracts with retrieval provenance", async () => {
    const plan = repo.createProfile("Documented project");
    saveBuildPlanningBrief(repo, newBuildPlanningBrief(plan.id, "Use the assembly guide", []));
    const proposal = await invokeAssistantTool(
      "propose_import_build_inputs",
      {
        plan_id: plan.id,
        inputs: [{
          url: "https://example.com/assembly-guide",
          title: "Assembly guide",
          extract: "Use four M3 heat-set inserts.",
        }],
      },
      { repo },
    );
    const applied = await applyAssistantAction(proposal.proposedAction!, {
      repo,
      jobs: { start: async () => "unused" } as never,
    });
    expect(applied.ok).toBe(true);
    expect(readBuildPlanningBrief(repo, plan.id)?.evidence[0]).toEqual(
      expect.objectContaining({
        title: "Assembly guide",
        extract: "Use four M3 heat-set inserts.",
        retrieved_at: expect.any(String),
        content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it("marks a requested role color satisfied when its exact catalog filament is assigned", async () => {
    const plan = repo.createProfile("Colored project");
    saveBuildPlanningBrief(
      repo,
      newBuildPlanningBrief(plan.id, "Primary color is British Racing Green.", []),
    );
    const proposal = await invokeAssistantTool(
      "propose_assign_role_filament",
      {
        plan_id: plan.id,
        assignment: {
          role: "primary",
          requested_name: "British Racing Green",
          inventory_kind: "catalog",
          inventory_id: "abs-matte::british-racing-green",
          color_hex: "#bfb8a9",
        },
      },
      { repo },
    );
    const applied = await applyAssistantAction(proposal.proposedAction!, {
      repo,
      jobs: { start: async () => "unused" } as never,
    });
    expect(applied.ok).toBe(true);
    expect(readBuildPlanningBrief(repo, plan.id)?.requirements).toContainEqual(
      expect.objectContaining({ key: "color_primary", status: "satisfied" }),
    );
  });

  it("rejects fabricated catalog filament assignments", async () => {
    const plan = repo.createProfile("Fabricated color");
    saveBuildPlanningBrief(repo, newBuildPlanningBrief(plan.id, "Primary color is Forest Green.", []));
    const proposal = await invokeAssistantTool("propose_assign_role_filament", {
      plan_id: plan.id,
      assignment: {
        role: "primary",
        requested_name: "Forest Green",
        inventory_kind: "catalog",
        inventory_id: "made-up-id",
        color_hex: "#285238",
      },
    }, { repo });
    const result = await applyAssistantAction(proposal.proposedAction!, {
      repo,
      jobs: { start: async () => "unused" } as never,
    });
    expect(result).toMatchObject({ ok: false, detail: expect.stringMatching(/inventory/i) });
    expect(readBuildPlanningBrief(repo, plan.id)?.requirements[0]?.status).toBe("unverified");
  });

  it("rejects unverified Spoolman and unconfirmed custom assignments", async () => {
    const plan = repo.createProfile("Unverified inventory");
    saveBuildPlanningBrief(repo, newBuildPlanningBrief(plan.id, "Primary color is Green.", []));
    for (const assignment of [
      { role: "primary", requested_name: "Green", inventory_kind: "spoolman", inventory_id: "spoolman:missing:filament:9", color_hex: "#008000" },
      { role: "primary", requested_name: "Green", inventory_kind: "custom", color_hex: "#008000" },
    ]) {
      const proposal = await invokeAssistantTool("propose_assign_role_filament", { plan_id: plan.id, assignment }, { repo });
      const result = await applyAssistantAction(proposal.proposedAction!, {
        repo, jobs: { start: async () => "unused" } as never,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects invalid planning source roles without changing evidence", async () => {
    const source = repo.createSource({ name: "Project", source_kind: "local" });
    const plan = repo.createProfile("Role validation");
    const brief = newBuildPlanningBrief(plan.id, "Build it", []);
    brief.evidence.push({
      id: "evidence-1",
      url: `printpartner:source:${source.id}`,
      normalized_url: `printpartner:source:${source.id}`,
      kind: "model_source",
      source_id: source.id,
    });
    saveBuildPlanningBrief(repo, brief);

    const result = await applyAssistantAction({
      id: "bad-role",
      type: "propose_set_build_source_roles",
      plan_id: plan.id,
      label: "Set roles",
      summary: "test",
      params: { roles: [{ evidence_id: "evidence-1", role: "structural-base" }] },
    }, { repo, jobs: { start: async () => "unused" } as never });

    expect(result).toMatchObject({ ok: false, detail: expect.stringMatching(/role/i) });
    expect(readBuildPlanningBrief(repo, plan.id)?.evidence[0]?.source_role).toBeUndefined();
  });

  it("rejects role assignments for unknown evidence", async () => {
    const plan = repo.createProfile("Evidence validation");
    saveBuildPlanningBrief(repo, newBuildPlanningBrief(plan.id, "Build it", []));

    const result = await applyAssistantAction({
      id: "unknown-evidence",
      type: "propose_set_build_source_roles",
      plan_id: plan.id,
      label: "Set roles",
      summary: "test",
      params: { roles: [{ evidence_id: "missing", role: "addon" }] },
    }, { repo, jobs: { start: async () => "unused" } as never });

    expect(result).toMatchObject({ ok: false, detail: expect.stringMatching(/evidence/i) });
  });

  it("rebuilds and records a fresh planning draft after confirmation", async () => {
    const source = repo.createSource({ name: "Printable project", source_kind: "local" });
    const sourcePath = join(dataDir, "printable-project");
    mkdirSync(sourcePath, { recursive: true });
    writeFileSync(join(sourcePath, "bracket.stl"), [
      "solid bracket",
      "facet normal 0 0 1 outer loop",
      "vertex 0 0 0 vertex 1 0 0 vertex 0 1 0",
      "endloop endfacet",
      "endsolid bracket",
    ].join("\n"));
    repo.updateSource(source.id, {
      local_path: sourcePath,
      last_synced_at: new Date().toISOString(),
      last_commit_sha: "a".repeat(40),
    });
    const plan = repo.createProfile("Rebuilt project", source.id);
    const brief = newBuildPlanningBrief(plan.id, "Print the bracket", []);
    brief.evidence.push({
      id: "printable",
      url: `printpartner:source:${source.id}`,
      normalized_url: `printpartner:source:${source.id}`,
      kind: "model_source",
      input_kind: "upload",
      source_id: source.id,
      source_role: "structural_base",
    });
    saveBuildPlanningBrief(repo, hydrateBuildPlanningBrief(repo, brief));

    const result = await applyAssistantAction({
      id: "planning-rebuild",
      type: "propose_rebuild_plan",
      plan_id: plan.id,
      label: "Rebuild",
      summary: "test",
      params: { idempotency_key: "customer-rebuild" },
    }, { repo, jobs: { start: async () => "unused" } as never });

    expect(result).toMatchObject({ ok: true, result: { draft_id: expect.any(Number) } });
    const saved = readBuildPlanningBrief(repo, plan.id);
    expect(saved?.draft_id).toEqual(expect.any(Number));
    expect(repo.getPlanDraft(plan.id, saved!.draft_id!)?.parts).toHaveLength(1);

    const replay = await applyAssistantAction({
      id: "planning-rebuild",
      type: "propose_rebuild_plan",
      plan_id: plan.id,
      label: "Rebuild",
      summary: "test",
      params: { idempotency_key: "customer-rebuild" },
    }, { repo, jobs: { start: async () => "unused" } as never });
    expect(replay).toMatchObject({
      ok: true,
      result: { draft_id: saved!.draft_id, recompute: "existing" },
    });

    writeFileSync(join(sourcePath, "second.stl"), "solid second\nendsolid second\n");
    repo.updateSource(source.id, {
      last_synced_at: new Date().toISOString(),
      last_commit_sha: "b".repeat(40),
    });
    saveBuildPlanningBrief(repo, hydrateBuildPlanningBrief(repo, saved!));
    const refreshed = await applyAssistantAction({
      id: "planning-rebuild",
      type: "propose_rebuild_plan",
      plan_id: plan.id,
      label: "Rebuild",
      summary: "test",
      params: { idempotency_key: "customer-rebuild" },
    }, { repo, jobs: { start: async () => "unused" } as never });
    expect(refreshed.ok).toBe(true);
    const refreshedBrief = readBuildPlanningBrief(repo, plan.id)!;
    expect(refreshedBrief.draft_id).not.toBe(saved!.draft_id);
    expect(repo.getPlanDraft(plan.id, refreshedBrief.draft_id!)?.parts).toHaveLength(2);
  });

  it("rolls back planning layer changes when rebuild fails", async () => {
    const original = repo.createSource({ name: "Original", source_kind: "local" });
    const originalPath = join(dataDir, "original");
    mkdirSync(originalPath, { recursive: true });
    writeFileSync(join(originalPath, "part.stl"), "solid part\nendsolid part\n");
    repo.updateSource(original.id, { local_path: originalPath });
    const empty = repo.createSource({ name: "Empty", source_kind: "local" });
    const emptyPath = join(dataDir, "empty");
    mkdirSync(emptyPath, { recursive: true });
    repo.updateSource(empty.id, { local_path: emptyPath });
    const plan = repo.createProfile("Atomic rebuild", original.id);
    const brief = newBuildPlanningBrief(plan.id, "Use empty", []);
    brief.evidence.push({
      id: "empty", url: `printpartner:source:${empty.id}`,
      normalized_url: `printpartner:source:${empty.id}`, kind: "model_source",
      source_id: empty.id, source_role: "structural_base",
    });
    saveBuildPlanningBrief(repo, brief);

    const result = await applyAssistantAction({
      id: "failed-rebuild", type: "propose_rebuild_plan", plan_id: plan.id,
      label: "Rebuild", summary: "test", params: {},
    }, { repo, jobs: { start: async () => "unused" } as never });

    expect(result.ok).toBe(false);
    expect(repo.getProfileLayers(plan.id).find((layer) => layer.layer_type === "base")?.project_id)
      .toBe(original.id);
  });

  it("applies a reviewed source choice to the recomputed draft", async () => {
    const stl = (x: number) => [
      "solid bracket", "facet normal 0 0 1 outer loop",
      `vertex 0 0 0 vertex ${x} 0 0 vertex 0 1 0`,
      "endloop endfacet", "endsolid bracket",
    ].join("\n");
    const official = repo.createSource({ name: "Official", source_kind: "local" });
    const vendor = repo.createSource({ name: "Vendor", source_kind: "local" });
    const officialPath = join(dataDir, "official-choice");
    const vendorPath = join(dataDir, "vendor-choice");
    mkdirSync(join(officialPath, "parts"), { recursive: true });
    mkdirSync(join(vendorPath, "parts"), { recursive: true });
    mkdirSync(join(vendorPath, "unrelated"), { recursive: true });
    writeFileSync(join(officialPath, "parts/bracket.stl"), stl(1));
    writeFileSync(join(vendorPath, "parts/bracket.stl"), stl(2));
    writeFileSync(join(vendorPath, "unrelated/bonus.stl"), stl(3));
    for (const [source, localPath, sha] of [[official, officialPath, "a"], [vendor, vendorPath, "b"]] as const) {
      repo.updateSource(source.id, {
        local_path: localPath,
        last_synced_at: new Date().toISOString(),
        last_commit_sha: sha.repeat(40),
      });
    }
    const plan = repo.createProfile("Resolved project", official.id);
    const brief = newBuildPlanningBrief(plan.id, "Use official bracket", []);
    brief.evidence = [
      { id: "official", url: "https://example.test/official", normalized_url: "https://example.test/official", kind: "canonical_design", source_id: official.id, source_role: "structural_base" },
      { id: "vendor", url: "https://example.test/vendor", normalized_url: "https://example.test/vendor", kind: "vendor_overlay", source_id: vendor.id, source_role: "overlay" },
    ];
    brief.contributions = [{
      id: "vendor-parts", evidence_id: "vendor", slot: "bracket",
      responsibility: "printable_parts", path_scopes: ["parts/**"], confidence: "high",
      evidence_text: "Use only the bracket family", status: "confirmed",
    }];
    const hydrated = hydrateBuildPlanningBrief(repo, brief);
    saveBuildPlanningBrief(repo, hydrated);
    const groupId = hydrated.differences[0]!.group_id;
    const resolved = await applyAssistantAction({
      id: "resolve-choice", type: "propose_resolve_build_differences", plan_id: plan.id,
      label: "Resolve", summary: "test",
      params: { group_id: groupId, resolution: "choose_source_a", rationale: "Official geometry" },
    }, { repo, jobs: { start: async () => "unused" } as never });
    expect(resolved.ok).toBe(true);
    const rebuilt = await applyAssistantAction({
      id: "rebuild-choice", type: "propose_rebuild_plan", plan_id: plan.id,
      label: "Rebuild", summary: "test", params: {},
    }, { repo, jobs: { start: async () => "unused" } as never });
    expect(rebuilt.ok).toBe(true);
    const saved = readBuildPlanningBrief(repo, plan.id)!;
    const draft = repo.getPlanDraft(plan.id, saved.draft_id!)!;
    expect(draft.parts.filter((part) => part.included).map((part) => part.sourceLayer))
      .toEqual(["base:Official"]);
    expect(draft.parts.some((part) => part.sourceLayer === "addon:Vendor")).toBe(false);
    expect(draft.parts.some((part) => part.relativePath === "unrelated/bonus.stl")).toBe(false);

    const changedRoles = readBuildPlanningBrief(repo, plan.id)!;
    changedRoles.evidence = changedRoles.evidence.map((evidence) =>
      evidence.id === "vendor" ? { ...evidence, source_role: "evidence" } : evidence,
    );
    changedRoles.draft_id = undefined;
    saveBuildPlanningBrief(repo, changedRoles);
    const rebuiltWithoutVendor = await applyAssistantAction({
      id: "rebuild-without-vendor", type: "propose_rebuild_plan", plan_id: plan.id,
      label: "Rebuild", summary: "test", params: {},
    }, { repo, jobs: { start: async () => "unused" } as never });
    expect(rebuiltWithoutVendor.ok).toBe(true);
    expect(repo.getProfileLayers(plan.id).some((layer) => layer.project_id === vendor.id)).toBe(false);
  });

  it("invalidates a reviewed draft when a difference decision changes", async () => {
    const plan = repo.createProfile("Invalidated decision");
    const brief = newBuildPlanningBrief(plan.id, "Build", []);
    brief.differences = [{
      id: "one", group_id: "group", family: "parts", kind: "changed",
      source_a: "A", source_b: "B", path_a: "part.stl", path_b: "part.stl", detail: "changed",
    }];
    brief.draft_id = 12;
    saveBuildPlanningBrief(repo, brief);
    const result = await applyAssistantAction({
      id: "changed-choice", type: "propose_resolve_build_differences", plan_id: plan.id,
      label: "Resolve", summary: "test",
      params: { group_id: "group", resolution: "choose_source_a", rationale: "Choose A" },
    }, { repo, jobs: { start: async () => "unused" } as never });
    expect(result.ok).toBe(true);
    expect(readBuildPlanningBrief(repo, plan.id)?.draft_id).toBeUndefined();
  });

  it("refuses assistant rebuild actions before starting a job", async () => {
    const plan = repo.createProfile("Review first");
    let starts = 0;
    const result = await applyAssistantAction(
      {
        id: "legacy-rebuild",
        type: "start_recompute",
        plan_id: plan.id,
        label: "Rebuild",
        summary: "Legacy assistant action",
        params: {},
      },
      {
        repo,
        jobs: {
          start: async () => {
            starts += 1;
            return "unexpected";
          },
        } as never,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/Plan page/),
    });
    expect(starts).toBe(0);
  });

  it("applyAssistantAction set_base mutates after confirm", async () => {
    const base = repo.createSource({
      name: "Voron-2",
      url: "https://example.com/v2.git",
      source_kind: "github",
    });
    const other = repo.createSource({
      name: "OtherKit",
      url: "https://example.com/other.git",
      source_kind: "github",
    });
    repo.updateSource(other.id, { last_synced_at: new Date().toISOString() });
    const plan = repo.createProfile("Plan", base.id);
    const result = await applyAssistantAction(
      {
        id: "a1",
        type: "set_base",
        plan_id: plan.id,
        label: "Set base",
        summary: "test",
        params: { source_name: "OtherKit" },
      },
      {
        repo,
        jobs: { start: async () => "j1" } as never,
      },
    );
    expect(result.ok).toBe(true);
    const layers = repo.getProfileLayers(plan.id);
    const baseLayer = layers.find((l) => l.layer_type === "base");
    expect(baseLayer?.project_id).toBe(other.id);
  });

  it("duplicate_plan returns header fields without reading a profile summary", async () => {
    const plan = repo.createProfile("Template");
    const result = await applyAssistantAction(
      {
        id: "duplicate-plan",
        type: "duplicate_plan",
        plan_id: plan.id,
        label: "Duplicate plan",
        summary: "Create a working copy",
        params: { name: "Working copy", clear_checkoff: true },
      },
      {
        repo,
        jobs: new InProcessJobRunner({
          getRepo: () => repo,
          reposDir: dataDir,
          exportsDir: dataDir,
          dataDir,
        }),
      },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        plan_id: expect.any(Number),
        name: "Working copy",
        part_count: 0,
        clear_checkoff: true,
      },
    });
  });

  it("summarizeOtherBuildsAsExamples excludes active plan and documents non-training", () => {
    const source = repo.createSource({
      name: "Voron-2",
      url: "https://example.com/v2.git",
      source_kind: "github",
    });
    const a = repo.createProfile("Alpha", source.id);
    const b = repo.createProfile("Beta", source.id);
    const listProfileHeaders = repo.listProfileHeaders.bind(repo);
    let headerListReads = 0;
    repo.listProfileHeaders = () => {
      headerListReads += 1;
      return listProfileHeaders();
    };
    repo.getProfileHeader = () => {
      throw new Error("Example rendering must reuse the bulk header row");
    };
    const text = summarizeOtherBuildsAsExamples({
      repo,
      excludePlanId: a.id,
    });
    expect(headerListReads).toBe(1);
    expect(text).toContain("NOT model training");
    expect(text).toContain("Beta");
    expect(text).not.toContain(`#${a.id}:`);
    expect(text).toContain(`#${b.id}`);
  });

  it("system prompt includes example builds when enabled", () => {
    const source = repo.createSource({
      name: "Voron-2",
      url: "https://example.com/v2.git",
      source_kind: "github",
    });
    const active = repo.createProfile("Active", source.id);
    repo.createProfile("Reference", source.id);
    const prompt = buildAssistantSystemPrompt({
      repo,
      planId: active.id,
      useOtherBuildsAsExamples: true,
      catalog: {
        bases: {},
        addon_categories: {},
        stack_presets: {},
      },
      workflowGuide: "wf",
    });
    expect(prompt).toContain("few-shot examples");
    expect(prompt).toContain("Reference");
    expect(prompt).toMatch(/NOT model training|not training data/i);
  });

  it("inferStackPresetId matches addon overlap", () => {
    const catalog = {
      bases: { voron_2_4: { source_name: "Voron-2" } },
      stack_presets: {
        v24_sb_tap: {
          base: "voron_2_4",
          addon_sources: ["Voron-Stealthburner", "Voron-Tap"],
        },
      },
    };
    expect(
      inferStackPresetId(catalog, "Voron-2", ["Voron-Stealthburner", "Voron-Tap"]),
    ).toBe("v24_sb_tap");
  });

  it("resolves model-suffixed source names like 'Voron-Trident R2-0'", async () => {
    for (const name of ["Voron-Trident", "Voron-2", "LDOVoronTrident"]) {
      repo.createSource({
        name,
        url: `https://example.com/${name}.git`,
        source_kind: "github",
      });
    }
    const plan = repo.createProfile("Plan", undefined);
    const { content, proposedAction } = await invokeAssistantTool(
      "set_source_git_ref",
      { plan_id: plan.id, source_name: "Voron-Trident R2-0", tag: "VTr2" },
      { repo },
    );
    expect(JSON.parse(content).status).toBe("proposed");
    expect(proposedAction?.params?.source_name).toBe("Voron-Trident");
  });

  it("unknown source names return did-you-mean suggestions", async () => {
    for (const name of ["Voron-Trident", "LDOVoronTrident"]) {
      repo.createSource({
        name,
        url: `https://example.com/${name}.git`,
        source_kind: "github",
      });
    }
    const plan = repo.createProfile("Plan", undefined);
    const { content } = await invokeAssistantTool(
      "set_base",
      { plan_id: plan.id, source_name: "Trydent kit" },
      { repo },
    );
    const parsed = JSON.parse(content);
    expect(parsed.error).toContain("Source not found");
    expect(parsed.error).toContain("Did you mean");
    expect(parsed.error).toContain("Voron-Trident");
  });

  it("system prompt includes domain pack aliases for tag resolution", () => {
    repo.createSource({
      name: "Example-Printer",
      url: "https://example.com/p.git",
      source_kind: "github",
    });
    const prompt = buildAssistantSystemPrompt({ repo, toolsAvailable: true, dataDir: FIXTURE });
    expect(prompt).toContain("Domain pack");
    expect(prompt).toContain('"the example r2 / example kit r2" → source=Example-Printer tag=EX-R2');
  });

  it("system prompt ships no curated pack or catalog content of its own", () => {
    const prompt = buildAssistantSystemPrompt({ repo, toolsAvailable: true });
    // The pack format is documented in the rules; no curated entries render.
    expect(prompt).not.toContain("### Phrase aliases");
    expect(prompt).not.toContain("### Stack recipes");
    expect(prompt).not.toContain("### Source digests");
    expect(prompt).not.toMatch(/\bvoron\b|\btrident\b|\bklicky\b|\bstealthburner\b/i);
  });

  it("start_sync proposes and apply enqueues a sync job", async () => {
    const source = repo.createSource({
      name: "Voron-Trident",
      url: "https://example.com/trident.git",
      source_kind: "github",
    });
    const plan = repo.createProfile("Plan", source.id);
    const { content, proposedAction } = await invokeAssistantTool(
      "start_sync",
      { plan_id: plan.id, source_name: "Voron-Trident" },
      { repo },
    );
    expect(JSON.parse(content).status).toBe("proposed");
    expect(proposedAction?.type).toBe("start_sync");
    expect(proposedAction?.params?.project_ids).toEqual([source.id]);

    const started: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const result = await applyAssistantAction(proposedAction!, {
      repo,
      jobs: {
        start: async (kind: string, payload: Record<string, unknown>) => {
          started.push({ kind, payload });
          return "sync-job-1";
        },
      } as never,
    });
    expect(result.ok).toBe(true);
    expect(result.job_id).toBe("sync-job-1");
    expect(started).toEqual([
      { kind: "sync", payload: { project_ids: [source.id] } },
    ]);
  });

  it("search_plan_parts returns part_id matches by filename", async () => {
    const source = repo.createSource({
      name: "Voron-2",
      url: "https://example.com/v2.git",
      source_kind: "github",
    });
    const repoPath = join(dataDir, "repos", String(source.id));
    mkdirSync(join(repoPath, "STLs", "Extras"), { recursive: true });
    writeFileSync(join(repoPath, "STLs", "Extras", "klicky_probe.stl"), "solid klicky");
    repo.updateSource(source.id, {
      local_path: repoPath,
      last_synced_at: new Date().toISOString(),
    });
    repo.updateImportRules(source.id, ["STLs/"]);
    const plan = repo.createProfile("Plan", source.id);
    acceptPlanForTest(repo, plan.id);

    const found = JSON.parse(
      (
        await invokeAssistantTool(
          "search_plan_parts",
          { plan_id: plan.id, query: "klicky" },
          { repo },
        )
      ).content,
    );
    expect(found.count).toBeGreaterThanOrEqual(1);
    expect(found.parts[0].filename.toLowerCase()).toContain("klicky");
    expect(typeof found.parts[0].part_id).toBe("number");
    expect(found.hint).toMatch(/ui_highlight_part/);
  });

  it("system prompt pairs ui_* with show/open and keeps rebuild review on Plan", () => {
    const prompt = buildAssistantSystemPrompt({ repo, toolsAvailable: true });
    expect(prompt).toContain("search_plan_parts");
    expect(prompt).toContain("start_sync");
    expect(prompt).toContain("Direct the user to Plan");
    expect(prompt).not.toContain("propose_sync_and_update");
    expect(prompt).toContain("ui_focus_kit_option");
    expect(prompt).toMatch(/pair.*ui_\*|Always pair/i);
  });

  it("ui_focus_kit_option proposes a UI action", async () => {
    const plan = repo.createProfile("Kit plan");
    const result = await invokeAssistantTool(
      "ui_focus_kit_option",
      { plan_id: plan.id, group_id: "motor_option", stl_filter: "extruder" },
      { repo },
    );
    expect(result.proposedAction?.type).toBe("ui_focus_kit_option");
    expect(result.proposedAction?.params.group_id).toBe("motor_option");
    expect(result.proposedAction?.params.stl_filter).toBe("extruder");
  });

  it("start_sync proposes Source sync without rebuilding the Plan", async () => {
    const source = repo.createSource({
      name: "Voron-Trident",
      url: "https://example.com/trident.git",
      source_kind: "github",
    });
    const plan = repo.createProfile("Sync plan", source.id);
    const result = await invokeAssistantTool(
      "start_sync",
      { plan_id: plan.id, source_name: "Voron-Trident" },
      { repo },
    );
    expect(result.proposedAction?.type).toBe("start_sync");
    expect(result.proposedAction?.label).toBe("Sync Voron-Trident");
  });

  it("check_stack_compatibility warns on dual probes", async () => {
    const base = repo.createSource({
      name: "Example-Printer",
      url: "https://example.com/t.git",
      source_kind: "github",
    });
    const tap = repo.createSource({
      name: "Example-Probe",
      url: "https://example.com/probe.git",
      source_kind: "github",
    });
    const klicky = repo.createSource({
      name: "Example-Alt-Probe",
      url: "https://example.com/alt.git",
      source_kind: "github",
    });
    for (const s of [base, tap, klicky]) {
      repo.updateSource(s.id, { last_synced_at: new Date().toISOString() });
    }
    const plan = repo.createProfile("Dual probe", base.id);
    repo.addAddonLayer(plan.id, tap.id);
    repo.addAddonLayer(plan.id, klicky.id);

    const raw = JSON.parse(
      (
        await invokeAssistantTool(
          "check_stack_compatibility",
          { plan_id: plan.id },
          { repo, dataDir: FIXTURE },
        )
      ).content,
    );
    expect(raw.warnings?.length ?? 0).toBeGreaterThan(0);
    expect(
      (raw.conflicts ?? []).length > 0 ||
        (raw.warnings ?? []).some(
          (w: { code: string }) =>
            w.code === "compat_conflict" ||
            w.code === "compat_slot" ||
            w.code === "merge_conflict_curated",
        ),
    ).toBe(true);
  });

  it("add_addon soft-enforcement includes warnings for conflicting probe", async () => {
    const base = repo.createSource({
      name: "Example-Printer",
      url: "https://example.com/v2.git",
      source_kind: "github",
    });
    const tap = repo.createSource({
      name: "Example-Probe",
      url: "https://example.com/probe.git",
      source_kind: "github",
    });
    const klicky = repo.createSource({
      name: "Example-Alt-Probe",
      url: "https://example.com/alt.git",
      source_kind: "github",
    });
    for (const s of [base, tap, klicky]) {
      repo.updateSource(s.id, {
        local_path: join(dataDir, "repos", String(s.id)),
        last_synced_at: new Date().toISOString(),
      });
      mkdirSync(join(dataDir, "repos", String(s.id)), { recursive: true });
    }
    const plan = repo.createProfile("Plan", base.id);
    repo.addAddonLayer(plan.id, tap.id);

    const { content, proposedAction } = await invokeAssistantTool(
      "add_addon",
      { plan_id: plan.id, source_name: "Example-Alt-Probe" },
      { repo, dataDir: FIXTURE },
    );
    expect(proposedAction?.type).toBe("add_addon");
    const parsed = JSON.parse(content);
    expect(parsed.status).toBe("proposed");
    expect((parsed.warnings?.length ?? 0) + (parsed.conflicts?.length ?? 0)).toBeGreaterThan(0);
  });

  it("propose_add_source Apply creates source", async () => {
    const { proposedAction } = await invokeAssistantTool(
      "propose_add_source",
      {
        name: "New-Mod",
        url: "https://github.com/example/New-Mod",
        source_kind: "github",
        tag: "main",
      },
      { repo },
    );
    expect(proposedAction?.type).toBe("propose_add_source");
    const result = await applyAssistantAction(proposedAction!, {
      repo,
      jobs: { start: async () => "x" } as never,
    });
    expect(result.ok).toBe(true);
    expect(repo.listSources().some((s) => s.name === "New-Mod")).toBe(true);
  });

  it("propose_add_source Apply chains a Sync follow-up card when a plan is active", async () => {
    const plan = repo.createProfile("Chain plan");
    const { proposedAction } = await invokeAssistantTool(
      "propose_add_source",
      {
        name: "EMU",
        url: "https://github.com/DW-Tas/emu",
        source_kind: "github",
        plan_id: plan.id,
      },
      { repo, activePlanId: plan.id },
    );
    expect(proposedAction?.plan_id).toBe(plan.id);
    const result = await applyAssistantAction(proposedAction!, {
      repo,
      jobs: { start: async () => "x" } as never,
    });
    expect(result.ok).toBe(true);
    const followUp = (result.result as { follow_up_action?: { type: string; params: Record<string, unknown> } })
      .follow_up_action;
    expect(followUp?.type).toBe("start_sync");
    expect(followUp?.params.project_ids).toHaveLength(1);
  });

  it("propose_add_source Apply without a plan returns needs_sync but no follow-up card", async () => {
    const { proposedAction } = await invokeAssistantTool(
      "propose_add_source",
      { name: "Orphan-Mod", url: "https://github.com/example/orphan", source_kind: "github" },
      { repo },
    );
    const result = await applyAssistantAction(proposedAction!, {
      repo,
      jobs: { start: async () => "x" } as never,
    });
    expect(result.ok).toBe(true);
    const res = result.result as { needs_sync?: boolean; follow_up_action?: unknown };
    expect(res.needs_sync).toBe(true);
    expect(res.follow_up_action).toBeUndefined();
  });

  it("inspect_repo_tree rejects non-GitHub URLs with a sync-first hint", async () => {
    const raw = JSON.parse(
      (
        await invokeAssistantTool(
          "inspect_repo_tree",
          { url: "https://www.printables.com/model/12345-some-mod" },
          { repo },
        )
      ).content,
    );
    expect(raw.error).toMatch(/Not a GitHub URL/i);
    expect(raw.hint).toMatch(/propose_add_source/);
  });

  it("inspect_repo_tree summarizes a synced source from local STLs", async () => {
    const source = repo.createSource({
      name: "EMU",
      url: "https://github.com/DW-Tas/emu",
      source_kind: "github",
    });
    const repoPath = join(dataDir, "repos", String(source.id));
    mkdirSync(join(repoPath, "STL", "Base", "Optional"), { recursive: true });
    mkdirSync(join(repoPath, "User_Mods", "EMU_Lite", "STL"), { recursive: true });
    mkdirSync(join(repoPath, "User_Mods", "TPU_feet", "STLs"), { recursive: true });
    writeFileSync(join(repoPath, "STL", "Base", "base_frame.stl"), "solid a");
    writeFileSync(join(repoPath, "STL", "Base", "Optional", "foot.stl"), "solid b");
    writeFileSync(join(repoPath, "User_Mods", "EMU_Lite", "STL", "lite.stl"), "solid c");
    writeFileSync(join(repoPath, "User_Mods", "TPU_feet", "STLs", "foot.stl"), "solid d");
    repo.updateSource(source.id, {
      local_path: repoPath,
      last_synced_at: new Date().toISOString(),
    });

    const raw = JSON.parse(
      (await invokeAssistantTool("inspect_repo_tree", { source_name: "EMU" }, { repo })).content,
    );
    expect(raw.banner).toMatch(/UNTRUSTED/i);
    expect(raw.origin).toBe("local_synced_stls");
    expect(raw.total_stls).toBe(4);
    expect(
      raw.variant_candidates.some((c: { group_id: string }) => c.group_id === "user_mods"),
    ).toBe(true);
  });

  it("detect_build_decisions surfaces decisions for a synced EMU-like source", async () => {
    const source = repo.createSource({
      name: "EMU",
      url: "https://github.com/DW-Tas/emu",
      source_kind: "github",
    });
    const repoPath = join(dataDir, "repos", String(source.id));
    mkdirSync(join(repoPath, "STL", "Combiner", "Deprecated Options", "Encoder_no_sensor"), {
      recursive: true,
    });
    mkdirSync(join(repoPath, "User_Mods", "EMU_Lite", "STL"), { recursive: true });
    mkdirSync(join(repoPath, "User_Mods", "EMU_Split_base", "STL"), { recursive: true });
    writeFileSync(join(repoPath, "STL", "Combiner", "combiner_body.stl"), "solid a");
    writeFileSync(
      join(repoPath, "STL", "Combiner", "Deprecated Options", "Encoder_no_sensor", "old.stl"),
      "solid b",
    );
    writeFileSync(join(repoPath, "User_Mods", "EMU_Lite", "STL", "lite.stl"), "solid c");
    writeFileSync(join(repoPath, "User_Mods", "EMU_Split_base", "STL", "split.stl"), "solid d");
    writeFileSync(
      join(repoPath, "README.md"),
      "# EMU\nOff-the-shelf electronics (EBB42 with EBB36 also fully compatible). Solo Lane Boards (SLB).\nSupports single lane, dual lane, or multi-lane expandable setups.\nOptionally install Klicky-Probe for probing.",
    );
    repo.updateSource(source.id, {
      local_path: repoPath,
      last_synced_at: new Date().toISOString(),
    });
    const plan = repo.createProfile("EMU plan", source.id);

    const raw = JSON.parse(
      (
        await invokeAssistantTool(
          "detect_build_decisions",
          { source_name: "EMU", plan_id: plan.id },
          { repo, activePlanId: plan.id },
        )
      ).content,
    );
    expect(raw.banner).toMatch(/UNTRUSTED/i);
    expect(raw.method).toBe("heuristic");
    expect(raw.decision_count).toBeGreaterThanOrEqual(2);
    const ids = raw.decisions.map((d: { id: string }) => d.id);
    expect(ids).toContain("user_mods");
    expect(ids).toContain("electronics_board");
    expect(ids).toContain("lane_count");
    const mods = raw.decisions.find((d: { id: string }) => d.id === "user_mods");
    expect(mods.kind).toBe("optional_mod");
    expect(mods.options.map((o: { id: string }) => o.id)).toContain("none");
    expect(raw.hint).toMatch(/Candidates only|ONE decision at a time/i);
  });

  it("propose_add_source rejects storefront product URLs", async () => {
    const raw = JSON.parse(
      (
        await invokeAssistantTool(
          "propose_add_source",
          {
            name: "Trianglelabs-EMU",
            url: "https://trianglelab.net/products/emu-5-lane-kit",
            source_kind: "github",
          },
          { repo },
        )
      ).content,
    );
    expect(raw.error).toMatch(/Not a GitHub source URL/i);
    expect(raw.hint).toMatch(/ingest_guide_url/i);
  });

  it("ingest_guide_text tool returns GuideExtract", async () => {
    // Vocabulary comes from this workspace's own sources.
    repo.createSource({ name: "Voron-Trident", url: "https://example.com/t.git", source_kind: "github" });
    repo.createSource({ name: "Voron-Tap", url: "https://example.com/tap.git", source_kind: "github" });
    const raw = JSON.parse(
      (
        await invokeAssistantTool(
          "ingest_guide_text",
          {
            text: "Voron-Trident guide. Install Voron-Tap. Replaces stock probe. https://github.com/VoronDesign/Voron-Tap",
          },
          { repo },
        )
      ).content,
    );
    expect(raw.ok).toBe(true);
    expect(raw.extract.required_addons).toEqual(expect.arrayContaining(["Voron-Tap"]));
    expect(raw.banner).toMatch(/UNTRUSTED/i);
  });

  it("add_addon Apply merges confirmed suggested_excludes into kit manifest", async () => {
    const base = repo.createSource({
      name: "Voron-2",
      url: "https://example.com/v2.git",
      source_kind: "github",
    });
    const tap = repo.createSource({
      name: "Voron-Tap",
      url: "https://example.com/tap.git",
      source_kind: "github",
    });
    for (const s of [base, tap]) {
      repo.updateSource(s.id, {
        local_path: join(dataDir, "repos", String(s.id)),
        last_synced_at: new Date().toISOString(),
      });
      mkdirSync(join(dataDir, "repos", String(s.id)), { recursive: true });
    }
    const plan = repo.createProfile("Plan", base.id);
    const { proposedAction } = await invokeAssistantTool(
      "add_addon",
      { plan_id: plan.id, source_name: "Voron-Tap" },
      { repo },
    );
    expect(proposedAction?.type).toBe("add_addon");
    const params = {
      ...(proposedAction!.params ?? {}),
      suggested_excludes: ["nozzle_probe", "z_endstop"],
    };
    const result = await applyAssistantAction(
      { ...proposedAction!, params },
      { repo, jobs: { start: async () => "x" } as never },
    );
    expect(result.ok).toBe(true);
    expect(result.result?.exclude).toEqual(
      expect.arrayContaining(["nozzle_probe", "z_endstop"]),
    );
    // Without suggested_excludes on the action, exclude is untouched.
    const klicky = repo.createSource({
      name: "Klicky-Probe",
      url: "https://example.com/k.git",
      source_kind: "github",
    });
    repo.updateSource(klicky.id, {
      local_path: join(dataDir, "repos", String(klicky.id)),
      last_synced_at: new Date().toISOString(),
    });
    mkdirSync(join(dataDir, "repos", String(klicky.id)), { recursive: true });
    const bare = await invokeAssistantTool(
      "add_addon",
      { plan_id: plan.id, source_name: "Klicky-Probe" },
      { repo },
    );
    const bareParams = { ...(bare.proposedAction!.params ?? {}) };
    delete bareParams.suggested_excludes;
    await applyAssistantAction(
      { ...bare.proposedAction!, params: bareParams },
      { repo, jobs: { start: async () => "x" } as never },
    );
    const { loadKitManifest } = await import("../services/kit-manifest-store.js");
    const kit = loadKitManifest(repo, plan.id);
    expect(kit.exclude).toEqual(expect.arrayContaining(["nozzle_probe", "z_endstop"]));
  });

  it("blocks re-propose of dismissed add_addon fingerprint", async () => {
    const base = repo.createSource({
      name: "Voron-2",
      url: "https://example.com/v2.git",
      source_kind: "github",
    });
    const addon = repo.createSource({
      name: "Bad-Addon",
      url: "https://example.com/bad.git",
      source_kind: "github",
    });
    repo.updateSource(addon.id, {
      local_path: join(dataDir, "repos", String(addon.id)),
      last_synced_at: new Date().toISOString(),
    });
    mkdirSync(join(dataDir, "repos", String(addon.id)), { recursive: true });
    const plan = repo.createProfile("Plan", base.id);

    const first = await invokeAssistantTool(
      "add_addon",
      { plan_id: plan.id, source_name: "Bad-Addon" },
      { repo, activePlanId: plan.id },
    );
    expect(first.proposedAction?.type).toBe("add_addon");

    const { logDismissedAction } = await import("../services/plan-decisions.js");
    logDismissedAction(repo, first.proposedAction!);

    const again = await invokeAssistantTool(
      "add_addon",
      { plan_id: plan.id, source_name: "Bad-Addon" },
      { repo, activePlanId: plan.id },
    );
    expect(again.proposedAction).toBeUndefined();
    expect(JSON.parse(again.content).error).toBe("user_dismissed");
  });

  it("digest Prefer line appears after applying the same action twice", async () => {
    const base = repo.createSource({
      name: "Voron-2",
      url: "https://example.com/v2.git",
      source_kind: "github",
    });
    const other = repo.createSource({
      name: "OtherKit",
      url: "https://example.com/other.git",
      source_kind: "github",
    });
    repo.updateSource(other.id, { last_synced_at: new Date().toISOString() });
    const plan = repo.createProfile("Plan", base.id);

    for (let i = 0; i < 2; i += 1) {
      const result = await applyAssistantAction(
        {
          id: `a${i}`,
          type: "set_base",
          plan_id: plan.id,
          label: "Set base",
          summary: "test",
          params: { source_name: "OtherKit" },
        },
        { repo, jobs: { start: async () => "j1" } as never },
      );
      expect(result.ok).toBe(true);
    }

    const { buildPreferencesDigest } = await import("./preferences-digest.js");
    const digest = buildPreferencesDigest(repo, plan.id);
    expect(digest).toContain("Prefer (2×): set_base source_name=OtherKit");
  });

  it("fetch_web_page returns plain text without storing guide evidence", async () => {
    const { fetchWebPageText } = await import("../services/guide-ingest.js");
    const html = `<html><head><title>Kit Docs</title></head><body><p>Hello kit world</p></body></html>`;
    const fetchFn = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const page = await fetchWebPageText("https://example.com/docs", {
      fetchFn: fetchFn as never,
    });
    expect(page.ok).toBe(true);
    expect(page.title).toBe("Kit Docs");
    expect(page.text).toMatch(/Hello kit world/);
    expect(page.untrusted_banner).toMatch(/UNTRUSTED/i);

    // Tool path: mock via fetch_web_page by stubbing at module level is heavy;
    // exercise the handler with a real call that will fail SSRF on private — use public mock via vi.
    const { vi } = await import("vitest");
    const outbound = await import("../lib/outbound-url.js");
    const spy = vi.spyOn(outbound, "safeOutboundFetch").mockResolvedValue(
      new Response(html, { status: 200 }),
    );
    try {
      const raw = JSON.parse(
        (
          await invokeAssistantTool(
            "fetch_web_page",
            { url: "https://example.com/docs" },
            { repo },
          )
        ).content,
      );
      expect(raw.ok).toBe(true);
      expect(raw.text).toMatch(/Hello kit world/);
      expect(raw.title).toBe("Kit Docs");
    } finally {
      spy.mockRestore();
    }
  });

  it("read_source_file reads text, rejects traversal and binary, caps size", async () => {
    const source = repo.createSource({
      name: "EMU",
      url: "https://github.com/DW-Tas/emu",
      source_kind: "github",
    });
    const repoPath = join(dataDir, "repos", String(source.id));
    mkdirSync(join(repoPath, "docs"), { recursive: true });
    writeFileSync(join(repoPath, "README.md"), "# EMU\nHello from README\n");
    writeFileSync(join(repoPath, "docs", "notes.md"), "notes body");
    writeFileSync(join(repoPath, "part.stl"), "solid x\0binary");
    const big = "x".repeat(120 * 1024);
    writeFileSync(join(repoPath, "big.md"), big);
    repo.updateSource(source.id, {
      local_path: repoPath,
      last_synced_at: new Date().toISOString(),
    });

    const ok = JSON.parse(
      (
        await invokeAssistantTool(
          "read_source_file",
          { source: "EMU", path: "README.md" },
          { repo },
        )
      ).content,
    );
    expect(ok.text).toMatch(/Hello from README/);
    expect(ok.untrusted_banner).toMatch(/UNTRUSTED/i);

    const traversal = JSON.parse(
      (
        await invokeAssistantTool(
          "read_source_file",
          { source: "EMU", path: "../etc/passwd" },
          { repo },
        )
      ).content,
    );
    expect(traversal.error).toMatch(/traversal|Invalid path/i);

    const binaryExt = JSON.parse(
      (
        await invokeAssistantTool(
          "read_source_file",
          { source: "EMU", path: "part.stl" },
          { repo },
        )
      ).content,
    );
    expect(binaryExt.error).toMatch(/binary/i);

    const capped = JSON.parse(
      (
        await invokeAssistantTool(
          "read_source_file",
          { source: "EMU", path: "big.md" },
          { repo },
        )
      ).content,
    );
    expect(capped.truncated).toBe(true);
    expect(capped.text.length).toBeLessThanOrEqual(100 * 1024);
  });

  it("web_search returns structured result with untrusted banner", async () => {
    const { vi } = await import("vitest");
    const outbound = await import("../lib/outbound-url.js");
    const html = `
      <a class="result__a" href="https://example.com/a">Title A</a>
      <a class="result__snippet">Snippet A</a>
    `;
    const spy = vi.spyOn(outbound, "safeOutboundFetch").mockResolvedValue(
      new Response(html, { status: 200 }),
    );
    try {
      const raw = JSON.parse(
        (
          await invokeAssistantTool("web_search", { query: "voron tap" }, { repo })
        ).content,
      );
      expect(raw.untrusted_banner).toMatch(/UNTRUSTED/i);
      expect(raw.provider).toBeTruthy();
      expect(Array.isArray(raw.hits)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
