import { describe, expect, it } from "vitest";
import {
  detectVariantFolderCandidates,
  inferSiblingFolderOptionGroups,
  summarizeRepoTreePaths,
} from "./repo-tree-summary.js";
import { EMU_STL_FIXTURE, EMU_TREE_FIXTURE } from "./emu-tree.fixture.js";

describe("summarizeRepoTreePaths (EMU-like fixture)", () => {
  it("summarizes top-level dirs with recursive STL counts", () => {
    const summary = summarizeRepoTreePaths(EMU_TREE_FIXTURE);
    expect(summary.total_stls).toBe(EMU_STL_FIXTURE.length);
    expect(summary.total_docs).toBeGreaterThan(0);
    expect(summary.truncated).toBe(false);

    const byPath = Object.fromEntries(summary.top_level_dirs.map((d) => [d.path, d]));
    expect(byPath["STL"]?.stl_count).toBe(16);
    expect(byPath["User_Mods"]?.stl_count).toBe(4);
    expect(byPath["PCB (recommended options)"]?.stl_count).toBe(3);
    // STL dir sorts first (most STLs).
    expect(summary.top_level_dirs[0]?.path).toBe("STL");
    // Subdirs are surfaced for drilling in.
    expect(byPath["STL"]?.subdirs.map((s) => s.name)).toContain("Combiner");
  });

  it("detects variant / optional-mod / options folders", () => {
    const candidates = detectVariantFolderCandidates(EMU_TREE_FIXTURE);
    const byId = Object.fromEntries(candidates.map((c) => [c.group_id, c]));

    // PCB choice: sibling boards under an "(recommended options)" folder.
    const pcb = byId["pcb_recommended_options"];
    expect(pcb?.kind).toBe("variant");
    expect(pcb?.options.map((o) => o.id).sort()).toEqual(["hatch_board", "multi_led_button"]);

    // User_Mods: each subfolder is an optional mod.
    const mods = byId["user_mods"];
    expect(mods?.kind).toBe("optional_mod");
    expect(mods?.options.map((o) => o.id).sort()).toEqual([
      "emu_lite",
      "emu_split_base",
      "tpu_feet",
    ]);

    // Deprecated options: default (current parent files) is suggested.
    const deprecated = byId["stl_combiner_deprecated_options"];
    expect(deprecated?.kind).toBe("variant");
    expect(deprecated?.suggested_option).toBe("default");
    expect(deprecated?.options[0]?.id).toBe("default");
    expect(deprecated?.options.some((o) => o.deprecated)).toBe(true);

    // "(Option)" and "Optional" folders become optional includes.
    expect(byId["stl_base_optional"]?.kind).toBe("optional_mod");
    expect(byId["stl_filamentalist_option_tpu_cdr"]?.kind).toBe("optional_mod");
    expect(byId["stl_stepper_options"]?.kind).toBe("optional_mod");

    // "… Version" folder becomes a default-vs-alternative variant on the parent.
    const psf = byId["stl_tension_compression_sensor"];
    expect(psf?.kind).toBe("variant");
    expect(psf?.suggested_option).toBe("default");
    expect(psf?.options).toHaveLength(2);
  });

  it("detects numeric sibling sets as config choices", () => {
    const candidates = detectVariantFolderCandidates([
      "STL/Lanes/3 Lane/frame.stl",
      "STL/Lanes/4 Lane/frame.stl",
      "STL/Lanes/5 Lane/frame.stl",
      "STL/common/base.stl",
    ]);
    const config = candidates.find((c) => c.kind === "config");
    expect(config?.dir).toBe("STL/Lanes");
    expect(config?.options.map((o) => o.label).sort()).toEqual(["3 Lane", "4 Lane", "5 Lane"]);
  });

  it("does not invent candidates for plain structural trees", () => {
    const candidates = detectVariantFolderCandidates([
      "STLs/frame/part_a.stl",
      "STLs/frame/part_b.stl",
      "STLs/gantry/part_c.stl",
      "docs/README.md",
    ]);
    expect(candidates).toEqual([]);
  });
});

describe("inferSiblingFolderOptionGroups (Build picker fallback)", () => {
  it("derives pick_one groups from variant folders (STL paths only)", () => {
    const groups = inferSiblingFolderOptionGroups(EMU_STL_FIXTURE);

    // Deprecated options: default variant lists the parent's direct STLs explicitly.
    const deprecated = groups["stl_combiner_deprecated_options"];
    expect(deprecated?.rule).toBe("pick_one");
    const defaultVariant = deprecated?.variants.find((v) => v.id === "default");
    expect(defaultVariant?.parts.sort()).toEqual([
      "STL/Combiner/combiner_body.stl",
      "STL/Combiner/combiner_cap.stl",
    ]);
    expect(deprecated?.variants.length).toBe(4);

    // PSF version: default vs alternative folder.
    const psf = groups["stl_tension_compression_sensor"];
    expect(psf?.variants.map((v) => v.id).sort()).toEqual([
      "default",
      "proportional_sync_feedback_psf_version",
    ]);

    // Each user mod gets its own include/skip group.
    for (const gid of ["user_mods_emu_lite", "user_mods_emu_split_base", "user_mods_tpu_feet"]) {
      expect(groups[gid]?.variants.map((v) => v.id).sort()).toEqual(["include", "skip"]);
    }
    const lite = groups["user_mods_emu_lite"];
    expect(lite?.variants.find((v) => v.id === "include")?.parts).toEqual([
      "User_Mods/EMU_Lite/*",
    ]);

    // Single optional folders become include/skip toggles.
    expect(groups["stl_base_optional"]?.variants.map((v) => v.id).sort()).toEqual([
      "include",
      "skip",
    ]);
  });

  it("returns nothing for repos without variant-looking folders", () => {
    expect(
      inferSiblingFolderOptionGroups(["STLs/frame/a.stl", "STLs/gantry/b.stl"]),
    ).toEqual({});
  });
});
