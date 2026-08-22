import { acceptPlanForTest } from "../test/accept-plan.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { InProcessJobRunner } from "../routes/jobs.js";
import { invokeAssistantTool, applyAssistantAction } from "./tools.js";
import { inferStackPresetId, summarizeOtherBuildsAsExamples } from "./example-builds.js";
import { buildAssistantSystemPrompt } from "./assistant-context.js";

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

  it("mutating tools only propose actions", async () => {
    const source = repo.createSource({
      name: "Voron-2",
      url: "https://example.com/v2.git",
      source_kind: "github",
    });
    const plan = repo.createProfile("Plan", source.id);
    const { content, proposedAction } = await invokeAssistantTool(
      "apply_stack_preset",
      { plan_id: plan.id, preset_id: "voron_2.4_stock_sb_tap" },
      { repo },
    );
    expect(proposedAction?.type).toBe("apply_stack_preset");
    expect(proposedAction?.params.preset_id).toBe("voron_2.4_stock_sb_tap");
    expect(JSON.parse(content).status).toBe("proposed");
    // Layers unchanged until apply
    expect(repo.getProfileLayers(plan.id).length).toBeGreaterThanOrEqual(1);
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
    const prompt = buildAssistantSystemPrompt({ repo, toolsAvailable: true });
    expect(prompt).toContain("Domain pack");
    expect(prompt).toContain('"LDO Trident R2" → source=Voron-Trident tag=VTr2');
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
      name: "Voron-Trident",
      url: "https://example.com/t.git",
      source_kind: "github",
    });
    const tap = repo.createSource({
      name: "Voron-Tap",
      url: "https://example.com/tap.git",
      source_kind: "github",
    });
    const klicky = repo.createSource({
      name: "Klicky-Probe",
      url: "https://example.com/k.git",
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
          { repo },
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
      name: "Voron-2",
      url: "https://example.com/v2.git",
      source_kind: "github",
    });
    const tap = repo.createSource({
      name: "Voron-Tap",
      url: "https://example.com/tap.git",
      source_kind: "github",
    });
    const klicky = repo.createSource({
      name: "Klicky-Probe",
      url: "https://example.com/k.git",
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
      { plan_id: plan.id, source_name: "Klicky-Probe" },
      { repo },
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
