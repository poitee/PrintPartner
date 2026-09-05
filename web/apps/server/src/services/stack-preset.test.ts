import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test-fixtures/kit-workspace",
);

function writeOverLimitPreset(dataDir: string): string {
  const sourceDirectory = join(dataDir, "repos", "bounded-preset");
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(
    join(sourceDirectory, "print-partner.manifest.yaml"),
    `format: print-partner-manifest
version: 2
option_groups:
  extras:
    rule: pick_n
    max: 1
    variants:
      - id: skirts
        parts: ["skirts/**"]
      - id: panels
        parts: ["panels/**"]
`,
  );
  writeFileSync(
    join(dataDir, "kit-catalog.yaml"),
    `version: 1
bases:
  bounded:
    source_name: Bounded-Printer
addon_categories: {}
stack_presets:
  invalid_bundle:
    label: Invalid bundle
    base: bounded
    base_tag: future
    addon_sources: []
    default_selections:
      extras: [skirts, panels]
`,
  );
  return sourceDirectory;
}

describe("resolveStackPresetId", () => {
  const presets = {
    example_kit_r2: {
      label: "Example Kit R2",
      base: "example_printer",
      base_tag: "EX-R2",
      addon_sources: [],
      default_selections: {},
    },
    example_stock: {
      label: "Example Printer stock",
      base: "example_printer",
      addon_sources: [],
      default_selections: {},
    },
  };

  it("returns exact catalog ids unchanged", () => {
    expect(resolveStackPresetId("example_kit_r2", presets)).toBe("example_kit_r2");
  });

  it("matches on label and on separator differences", () => {
    expect(resolveStackPresetId("Example Kit R2", presets)).toBe("example_kit_r2");
    expect(resolveStackPresetId("Example_Kit_R2", presets)).toBe("example_kit_r2");
  });

  it("matches a longer invented id that contains a catalog id", () => {
    expect(resolveStackPresetId("my_example_kit_r2_build", presets)).toBe("example_kit_r2");
  });

  it("returns null for unknown presets", () => {
    expect(resolveStackPresetId("not_a_real_preset", presets)).toBeNull();
  });

  it("never maps an invented id onto an unrelated preset", () => {
    // No built-in alias table: an id the catalog does not describe stays unknown.
    expect(resolveStackPresetId("some_other_vendor_r2", presets)).toBeNull();
  });
});

describe("stackPresetBaseRef", () => {
  it("prefers base_tag over base_branch", () => {
    expect(stackPresetBaseRef({ base_tag: "EX-R2", base_branch: "main" })).toEqual({
      tag: "EX-R2",
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

  it("sets the base source tag from the catalog preset", () => {
    const catalog = loadKitCatalog(FIXTURE) as {
      stack_presets?: Record<string, { base_tag?: string }>;
    };
    expect(catalog.stack_presets?.example_kit_r2?.base_tag).toBe("EX-R2");

    const base = repo.createSource({
      name: "Example-Printer",
      url: "https://github.com/ExampleOrg/Example-Printer.git",
      source_kind: "github",
      branch: "main",
    });
    for (const [name, url] of [
      ["Example-Toolhead", "https://example.com/toolhead.git"],
      ["Example-Probe", "https://example.com/probe.git"],
    ] as const) {
      repo.createSource({ name, url, source_kind: "github" });
    }
    const plan = repo.createProfile("Example R2", base.id);

    const result = applyStackPresetToProfile(repo, plan.id, "Example Kit R2", FIXTURE);
    expect(result.preset_id).toBe("example_kit_r2");
    expect(result.base_source_name).toBe("Example-Printer");
    expect(result.tag).toBe("EX-R2");
    expect(result.needs_sync).toBe(true);
    expect(repo.getSource(base.id)?.tag).toBe("EX-R2");

    const again = applyStackPresetToProfile(repo, plan.id, "example_kit_r2", FIXTURE);
    expect(again.needs_sync).toBe(false);
    expect(again.tag).toBe("EX-R2");
  });

  it("rejects a preset the shipped catalog does not define", () => {
    const base = repo.createSource({
      name: "Example-Printer",
      url: "https://example.com/p.git",
      source_kind: "github",
    });
    const plan = repo.createProfile("Example", base.id);
    expect(() => applyStackPresetToProfile(repo, plan.id, "example_kit_r2", null)).toThrow(
      /Unknown stack preset/,
    );
  });

  it("preserves array selections from an external catalog preset", () => {
    writeFileSync(
      join(dataDir, "kit-catalog.yaml"),
      `version: 1
bases:
  example_printer:
    source_name: Example-Printer
addon_categories: {}
stack_presets:
  panel_bundle:
    label: Panel bundle
    base: example_printer
    addon_sources: []
    default_selections:
      extras: [skirts, panels]
`,
    );
    const base = repo.createSource({
      name: "Example-Printer",
      source_kind: "local",
    });
    const plan = repo.createProfile("Panel bundle", base.id);

    const result = applyStackPresetToProfile(
      repo,
      plan.id,
      "panel_bundle",
      dataDir,
    );

    expect(result.selections).toEqual({ extras: ["skirts", "panels"] });
  });

  it("rejects malformed catalog selections before changing the plan", () => {
    writeFileSync(
      join(dataDir, "kit-catalog.yaml"),
      `version: 1
bases:
  example_printer:
    source_name: Example-Printer
addon_categories: {}
stack_presets:
  broken:
    label: Broken preset
    base: example_printer
    addon_sources: []
    default_selections:
      extras: [skirts, 4]
`,
    );
    repo.createSource({ name: "Example-Printer", source_kind: "local" });
    const plan = repo.createProfile("Unchanged plan");

    expect(() =>
      applyStackPresetToProfile(repo, plan.id, "broken", dataDir),
    ).toThrow("stack_presets.broken.default_selections.extras[1]");
    expect(repo.getProfileLayers(plan.id)).toEqual([]);
  });

  it("rejects an over-limit preset before changing refs or layers", () => {
    const targetDirectory = writeOverLimitPreset(dataDir);
    const original = repo.createSource({
      name: "Original-Printer",
      source_kind: "local",
    });
    const target = repo.createSource({
      name: "Bounded-Printer",
      source_kind: "github",
      branch: "main",
      local_path: targetDirectory,
    });
    const plan = repo.createProfile("Unchanged bounded plan", original.id);

    expect(() =>
      applyStackPresetToProfile(repo, plan.id, "invalid_bundle", dataDir),
    ).toThrow(
      "stack_presets.invalid_bundle.default_selections.extras must contain no more than 1 variant id",
    );
    expect(repo.getProfileLayers(plan.id).map((layer) => layer.project_id)).toEqual([
      original.id,
    ]);
    expect(repo.getSource(target.id)).toMatchObject({ branch: "main", tag: null });
  });
});

describe("recipeToReplaySteps catalog base_tag", () => {
  it("injects set_base at the catalog tag when the recipe has no live tag", () => {
    const recipe: BuildRecipe = {
      plan_id: 1,
      plan_name: "Fresh R2",
      base: { source_name: "Example-Printer", project_id: 1, tag: null, branch: "main" },
      addons: [],
      stack_preset: "example_kit_r2",
      kit_selections: {},
      include: [],
      exclude: [],
      decision_count: 0,
      markdown: "",
    };
    const steps = recipeToReplaySteps(recipe, FIXTURE);
    expect(steps[0]!.type).toBe("apply_stack_preset");
    const setBase = steps.find((s) => s.type === "set_base");
    expect(setBase?.params.tag).toBe("EX-R2");
  });
});
