import { acceptPlanForTest } from "./test/accept-plan.js";
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSelfHostPorts } from "./adapters/self-host/index.js";
import {
  kitManifestSettingKey,
  loadKitManifest,
  saveKitManifest,
} from "./services/kit-manifest-store.js";
import {
  loadManifestYaml,
  selectionIncludesPart,
} from "./services/manifest-apply.js";
import { buildPlanManifestBuilder } from "./services/plan-manifest-builder.js";

describe("kit manifest store", () => {
  it("discards a stored manifest whose selections cross the JSON boundary malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-kit-invalid-selection-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository!;
    const plan = repo.createProfile("Invalid selection");

    repo.setSetting(
      kitManifestSettingKey(plan.id),
      JSON.stringify({ selections: { extras: ["skirts", "skirts"] } }),
    );

    expect(loadKitManifest(repo, plan.id).selections).toEqual({});

    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips selections through save and load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-kit-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository!;

    const source = repo.createSource({ name: "Voron-2", url: "https://github.com/a/voron" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "STLs", "stock_toolhead"), { recursive: true });
    mkdirSync(join(repoPath, "STLs", "stock_probe"), { recursive: true });
    writeFileSync(join(repoPath, "STLs", "stock_toolhead", "part.stl"), "solid a");
    writeFileSync(join(repoPath, "STLs", "stock_probe", "probe.stl"), "solid b");
    writeFileSync(
      join(repoPath, "print-partner.manifest.yaml"),
      `format: print-partner-manifest
version: 2
option_groups:
  toolhead:
    rule: pick_one
    variants:
      - id: stock
        parts: ["**/stock_toolhead/**"]
  probe:
    rule: pick_one
    variants:
      - id: stock
        parts: ["**/stock_probe/**"]
`,
    );
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["STLs/"]);

    const plan = repo.createProfile("KitPlan", source.id);
    acceptPlanForTest(repo, plan.id);

    saveKitManifest(repo, plan.id, {
      selections: { toolhead: "stock", probe: "stock" },
    });
    const loaded = loadKitManifest(repo, plan.id);
    expect(loaded.selections).toEqual({ toolhead: "stock", probe: "stock" });

    saveKitManifest(repo, plan.id, {
      selections: { extras: ["skirts", "panels"] },
    });
    expect(loadKitManifest(repo, plan.id).selections).toEqual({
      extras: ["skirts", "panels"],
    });
    saveKitManifest(repo, plan.id, {
      selections: { toolhead: "stock", probe: "stock" },
    });

    const builder = buildPlanManifestBuilder(repo, plan.id, dir);
    expect(Object.keys(builder.merged_option_groups)).toContain("toolhead");
    expect(builder.merged_option_groups.toolhead?.variants?.[0]?.id).toBe("stock");

    const selected = repo.recomputePlanDraft({
      profileId: plan.id,
      actor: "test:user",
      idempotencyKey: "selected-kit-draft",
    });
    if (selected.kind !== "created") throw new Error("selected kit draft was not created");
    expect(selected.draft.parts.every((part) => part.included)).toBe(true);

    saveKitManifest(repo, plan.id, { selections: { toolhead: "stock" } });
    const cleared = repo.recomputePlanDraft({
      profileId: plan.id,
      actor: "test:user",
      idempotencyKey: "cleared-kit-draft",
    });
    if (cleared.kind !== "created") throw new Error("cleared kit draft was not created");
    expect(
      cleared.draft.parts.some((part) => part.partKey.includes("probe") && part.included),
    ).toBe(false);

    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to sibling-folder option groups when no manifest or path-hints match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-kit-fallback-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository!;

    // EMU-like repo: no print-partner.manifest.yaml, folders imply choices.
    const source = repo.createSource({ name: "EMU", url: "https://github.com/DW-Tas/emu" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "STL", "Base", "Optional"), { recursive: true });
    mkdirSync(join(repoPath, "User_Mods", "EMU_Lite", "STL"), { recursive: true });
    mkdirSync(join(repoPath, "User_Mods", "TPU_feet", "STLs"), { recursive: true });
    writeFileSync(join(repoPath, "STL", "Base", "base_frame.stl"), "solid a");
    writeFileSync(join(repoPath, "STL", "Base", "Optional", "foot.stl"), "solid b");
    writeFileSync(join(repoPath, "User_Mods", "EMU_Lite", "STL", "lite.stl"), "solid c");
    writeFileSync(join(repoPath, "User_Mods", "TPU_feet", "STLs", "foot.stl"), "solid d");
    repo.updateSource(source.id, { local_path: repoPath });

    const plan = repo.createProfile("EMU plan", source.id);
    const builder = buildPlanManifestBuilder(repo, plan.id, dir);
    const groups = builder.merged_option_groups;

    // Optional folder → include/skip toggle.
    expect(groups["stl_base_optional"]?.variants.map((v) => v.id).sort()).toEqual([
      "include",
      "skip",
    ]);
    // Each user mod → its own include/skip group so Build pickers appear.
    expect(groups["user_mods_emu_lite"]?.rule).toBe("pick_one");
    expect(groups["user_mods_tpu_feet"]?.rule).toBe("pick_one");

    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies bounded multi-select variants to a recomputed Working Plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-kit-multi-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository!;

    const source = repo.createSource({ name: "Extras", source_kind: "local" });
    const repoPath = join(dir, "repos", String(source.id));
    for (const variant of ["skirts", "panels", "screen"]) {
      mkdirSync(join(repoPath, "extras", variant), { recursive: true });
      writeFileSync(join(repoPath, "extras", variant, `${variant}.stl`), `solid ${variant}`);
    }
    writeFileSync(
      join(repoPath, "print-partner.manifest.yaml"),
      `format: print-partner-manifest
version: 2
option_groups:
  extras:
    rule: pick_n
    min: 2
    max: 2
    variants:
      - id: skirts
        parts: ["extras/skirts/**"]
      - id: panels
        parts: ["extras/panels/**"]
      - id: screen
        parts: ["extras/screen/**"]
selections:
  extras: [skirts, panels]
`,
    );
    repo.updateSource(source.id, { local_path: repoPath });
    const plan = repo.createProfile("Extras Build", source.id);
    acceptPlanForTest(repo, plan.id);

    const builder = buildPlanManifestBuilder(repo, plan.id, dir);
    const group = builder.merged_option_groups.extras;
    expect(group).toMatchObject({ rule: "pick_n", min: 2, max: 2 });
    expect(builder.resolved_selections).toEqual({ extras: ["skirts", "panels"] });

    saveKitManifest(repo, plan.id, {
      selections: { extras: ["skirts", "panels"] },
    });
    const valid = repo.recomputePlanDraft({
      profileId: plan.id,
      actor: "test:user",
      idempotencyKey: "valid-multi-selection",
    });
    if (valid.kind !== "created") throw new Error("valid multi-select draft was not created");
    expect(
      valid.draft.parts.filter((part) => part.included).map((part) => part.filename).sort(),
    ).toEqual(["panels.stl", "skirts.stl"]);

    saveKitManifest(repo, plan.id, { selections: { extras: "skirts" } });
    const belowMinimum = repo.recomputePlanDraft({
      profileId: plan.id,
      actor: "test:user",
      idempotencyKey: "incomplete-multi-selection",
    });
    if (belowMinimum.kind !== "created") {
      throw new Error("incomplete multi-select draft was not created");
    }
    expect(belowMinimum.draft.parts.every((part) => !part.included)).toBe(true);

    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies an inferred Milo spindle choice without importing unchecked files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-kit-milo-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository!;

    const source = repo.createSource({
      name: "Milo V2.0",
      url: "https://github.com/MillenniumMachines/Milo-V2.0",
    });
    const repoPath = join(dir, "repos", String(source.id));
    const spindleRoot = join(repoPath, "STL Files", "Spindle-Mounts");
    for (const folder of [
      "65mm-Spindle-Mounts",
      "80mm-Spindle-Mounts",
      "LDO-Kit-Spindle-Mount",
    ]) {
      mkdirSync(join(spindleRoot, folder), { recursive: true });
      writeFileSync(join(spindleRoot, folder, `${folder}.stl`), `solid ${folder}`);
    }
    mkdirSync(join(repoPath, "STL Files", "Archive"), { recursive: true });
    writeFileSync(join(repoPath, "STL Files", "Archive", "unchecked.stl"), "solid unchecked");
    const electronicsPath = join(
      spindleRoot,
      "LDO-Kit-Spindle-Mount",
      "electronics",
    );
    mkdirSync(electronicsPath, { recursive: true });
    writeFileSync(join(electronicsPath, "controller.stl"), "solid controller");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["STL Files/Spindle-Mounts/"]);

    const plan = repo.createProfile("Milo V2.0", source.id);
    const builder = buildPlanManifestBuilder(repo, plan.id, dir);
    expect(builder.merged_option_groups.controller?.variants[0]?.id).toBe("stock");
    const [spindleGroupId, spindleGroup] = Object.entries(builder.merged_option_groups).find(
      ([, group]) => group.label === "Spindle-Mounts",
    ) ?? [];
    expect(spindleGroup?.variants.map((variant) => variant.id).sort()).toEqual([
      "65mm_spindle_mounts",
      "80mm_spindle_mounts",
      "ldo_kit_spindle_mount",
    ]);

    saveKitManifest(repo, plan.id, {
      selections: { [spindleGroupId!]: "ldo_kit_spindle_mount" },
    });
    const result = repo.recomputePlanDraft({
      profileId: plan.id,
      actor: "test:user",
      idempotencyKey: "milo-ldo-draft",
    });
    if (result.kind !== "created") throw new Error("Milo draft was not created");

    expect(result.draft.parts.map((part) => part.relativePath)).not.toContain(
      "STL Files/Archive/unchecked.stl",
    );
    expect(
      result.draft.parts.filter((part) => part.included).map((part) => part.relativePath),
    ).toEqual([
      "STL Files/Spindle-Mounts/LDO-Kit-Spindle-Mount/electronics/controller.stl",
      "STL Files/Spindle-Mounts/LDO-Kit-Spindle-Mount/LDO-Kit-Spindle-Mount.stl",
    ]);

    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("selectionIncludesPart matches variant globs", () => {
    const doc = loadManifestYaml(`option_groups:
  toolhead:
    rule: pick_one
    variants:
      - id: stealthburner
        parts: ["**/Stealthburner/**"]
`);
    const group = doc.option_groups!.toolhead!;
    expect(
      selectionIncludesPart("STLs/Stealthburner/hotend.stl", group, "stealthburner"),
    ).toBe(true);
    expect(selectionIncludesPart("STLs/stock_toolhead/part.stl", group, "stealthburner")).toBe(
      false,
    );
  });

  it("rejects inverted option-group bounds at the runtime parser", () => {
    expect(() =>
      loadManifestYaml(`format: print-partner-manifest
version: 2
option_groups:
  toolhead:
    rule: pick_n
    min: 2
    max: 1
    parts: ["**/toolhead/**"]
`),
    ).toThrow("option_groups.toolhead.min must not exceed max");
  });

  it("rejects option-group defaults that contradict their rule or maximum", () => {
    expect(() =>
      loadManifestYaml(`option_groups:
  toolhead:
    rule: pick_one
    max: 2
    parts: ["**/toolhead/**"]
`),
    ).toThrow("option_groups.toolhead pick_one bounds must not exceed 1");

    expect(() =>
      loadManifestYaml(`option_groups:
  extras:
    rule: pick_n
    max: 1
    variants:
      - id: skirts
        parts: ["skirts/**"]
      - id: panels
        parts: ["panels/**"]
selections:
  extras: [skirts, panels]
`),
    ).toThrow("selections.extras must contain no more than 1 variant id");
  });
});
