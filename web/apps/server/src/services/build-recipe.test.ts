import { describe, expect, it } from "vitest";
import { recipeToReplaySteps } from "../services/build-recipe.js";
import type { BuildRecipe } from "@print-partner/contracts";

describe("recipeToReplaySteps", () => {
  it("keeps stack preset first and retains explicit tag/addon/kit steps", () => {
    const recipe: BuildRecipe = {
      plan_id: 1,
      plan_name: "Demo",
      base: { source_name: "Voron-Trident", project_id: 1, tag: "VTr2", branch: null },
      addons: [{ source_name: "LDO-Extras", project_id: 2, tag: null, branch: "main" }],
      stack_preset: "ldo_trident_r2",
      kit_selections: { size: "300" },
      include: [],
      exclude: [],
      decision_count: 0,
      markdown: "",
    };
    const steps = recipeToReplaySteps(recipe);
    expect(steps.map((s) => s.type)).toEqual([
      "apply_stack_preset",
      "set_base",
      "add_addon",
      "update_kit_selections",
    ]);
    expect(steps[0]!.params.preset_id).toBe("ldo_trident_r2");
    expect(steps[1]!.params.tag).toBe("VTr2");
    expect(steps[2]!.params.source_name).toBe("LDO-Extras");
    expect(steps[3]!.params.selections).toEqual({ size: "300" });
  });

  it("emits only the preset when there are no supplemental refs/addons/selections", () => {
    const recipe: BuildRecipe = {
      plan_id: 3,
      plan_name: "Preset only",
      base: { source_name: "Voron-2", project_id: 1, tag: null, branch: null },
      addons: [],
      stack_preset: "voron_2.4_stock_sb_tap",
      kit_selections: {},
      include: [],
      exclude: [],
      decision_count: 0,
      markdown: "",
    };
    const steps = recipeToReplaySteps(recipe);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.type).toBe("apply_stack_preset");
  });

  it("expands base, addons, and selections without preset", () => {
    const recipe: BuildRecipe = {
      plan_id: 2,
      plan_name: "Custom",
      base: { source_name: "Voron-Trident", project_id: 1, tag: "VTr2", branch: null },
      addons: [{ source_name: "Stealthburner", project_id: 3, tag: null, branch: null }],
      stack_preset: null,
      kit_selections: { bed: "300" },
      include: [],
      exclude: [],
      decision_count: 1,
      markdown: "",
    };
    const steps = recipeToReplaySteps(recipe);
    expect(steps.map((s) => s.type)).toEqual([
      "set_base",
      "add_addon",
      "update_kit_selections",
    ]);
    expect(steps[0]!.params.tag).toBe("VTr2");
  });
});
