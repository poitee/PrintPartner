import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import {
  applyStackPresetToProfile,
  resolveStackPresetId,
  stackPresetBaseRef,
} from "./stack-preset.js";
import { loadKitCatalog } from "./kit-catalog.js";
import { recipeToReplaySteps } from "./build-recipe.js";
import type { BuildRecipe } from "@print-partner/contracts";

describe("resolveStackPresetId", () => {
  const presets = {
    ldo_trident_r2: {
      label: "LDO Trident R2 (Voron-Trident @ VTr2 + LDO + SB)",
      base: "voron_trident",
      base_tag: "VTr2",
      addon_sources: [],
      default_selections: {},
    },
    voron_2_4_stock: {
      label: "Voron 2.4 stock",
      base: "voron_2.4",
      addon_sources: [],
      default_selections: {},
    },
  };

  it("returns exact catalog ids unchanged", () => {
    expect(resolveStackPresetId("ldo_trident_r2", presets)).toBe("ldo_trident_r2");
  });

  it("aliases invented voron_trident_r2 → ldo_trident_r2", () => {
    expect(resolveStackPresetId("voron_trident_r2", presets)).toBe("ldo_trident_r2");
    expect(resolveStackPresetId("trident_r2", presets)).toBe("ldo_trident_r2");
    expect(resolveStackPresetId("LDO_Voron_Trident_R2", presets)).toBe("ldo_trident_r2");
  });

  it("fuzzy-matches trident r2 inventions onto ldo_trident_r2", () => {
    expect(resolveStackPresetId("my_trident_r2_kit", presets)).toBe("ldo_trident_r2");
  });

  it("returns null for unknown presets", () => {
    expect(resolveStackPresetId("not_a_real_preset", presets)).toBeNull();
  });
});

describe("stackPresetBaseRef", () => {
  it("prefers base_tag over base_branch", () => {
    expect(stackPresetBaseRef({ base_tag: "VTr2", base_branch: "main" })).toEqual({
      tag: "VTr2",
    });
  });
});

describe("applyStackPresetToProfile base_tag", () => {
  let dataDir: string;
  let repo: NonNullable<ReturnType<typeof createSelfHostPorts>["repository"]>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-stack-preset-"));
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    repo = ports.repository!;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("sets Voron-Trident tag to VTr2 when applying ldo_trident_r2", () => {
    const catalog = loadKitCatalog() as {
      stack_presets?: Record<string, { base_tag?: string }>;
    };
    expect(catalog.stack_presets?.ldo_trident_r2?.base_tag).toBe("VTr2");

    const base = repo.createSource({
      name: "Voron-Trident",
      url: "https://github.com/VoronDesign/Voron-Trident.git",
      source_kind: "github",
      branch: "main",
    });
    for (const [name, url] of [
      ["Voron-Stealthburner", "https://example.com/sb.git"],
      ["LDOVoronTrident", "https://example.com/ldo.git"],
      ["Leviathan", "https://example.com/lev.git"],
    ] as const) {
      repo.createSource({ name, url, source_kind: "github" });
    }
    const plan = repo.createProfile("Trident R2", base.id);

    const result = applyStackPresetToProfile(repo, plan.id, "voron_trident_r2");
    expect(result.preset_id).toBe("ldo_trident_r2");
    expect(result.base_source_name).toBe("Voron-Trident");
    expect(result.tag).toBe("VTr2");
    expect(result.needs_sync).toBe(true);
    expect(repo.getSource(base.id)?.tag).toBe("VTr2");

    const again = applyStackPresetToProfile(repo, plan.id, "ldo_trident_r2");
    expect(again.needs_sync).toBe(false);
    expect(again.tag).toBe("VTr2");
  });
});

describe("recipeToReplaySteps catalog base_tag", () => {
  it("injects set_base @ VTr2 when recipe has ldo_trident_r2 but no live tag", () => {
    const recipe: BuildRecipe = {
      plan_id: 1,
      plan_name: "Fresh R2",
      base: { source_name: "Voron-Trident", project_id: 1, tag: null, branch: "main" },
      addons: [],
      stack_preset: "ldo_trident_r2",
      kit_selections: {},
      include: [],
      exclude: [],
      decision_count: 0,
      markdown: "",
    };
    const steps = recipeToReplaySteps(recipe);
    expect(steps[0]!.type).toBe("apply_stack_preset");
    const setBase = steps.find((s) => s.type === "set_base");
    expect(setBase?.params.tag).toBe("VTr2");
  });
});
