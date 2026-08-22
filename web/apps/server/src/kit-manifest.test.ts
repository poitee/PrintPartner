import { acceptPlanForTest } from "./test/accept-plan.js";
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSelfHostPorts } from "./adapters/self-host/index.js";
import { loadKitManifest, saveKitManifest } from "./services/kit-manifest-store.js";
import {
  loadManifestYaml,
  selectionIncludesPart,
} from "./services/manifest-apply.js";
import { buildPlanManifestBuilder } from "./services/plan-manifest-builder.js";

describe("kit manifest store", () => {
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

    const builder = buildPlanManifestBuilder(repo, plan.id);
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
    const builder = buildPlanManifestBuilder(repo, plan.id);
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
});
