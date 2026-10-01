import { describe, expect, it } from "vitest";
import {
  suggestSlicedObjectNames,
  interpretSlicedObjectName,
  matchSlicedObjectName,
  createSlicedObjectMatcher,
} from "./sliced-object-matching.js";

describe("import name suggestions", () => {
  it("ranks equivalent dimension spelling without treating it as automatic evidence", () => {
    expect(suggestSlicedObjectNames("wago_221-415_mount_3by5.stl", [
      "wago_221-415_mount_3x6.stl", "wago_221-415_mount_3x5.stl", "other.stl",
    ])).toEqual(["wago_221-415_mount_3x5.stl"]);
  });
  it("does not suggest opposite directions or different dimensions", () => {
    expect(suggestSlicedObjectNames("mount_left_350.stl", [
      "mount_right_350.stl", "mount_left_250.stl", "mount_left_350_rev.stl",
    ])).toEqual(["mount_left_350_rev.stl"]);
  });
});

describe("prepared sliced object matcher", () => {
  it("preserves path priority and duplicate candidate order", () => {
    const match = createSlicedObjectMatcher([
      "kit-b/bracket.stl", "kit-a/bracket.stl", "kit-a/bracket.stl",
    ]);
    expect(match("kit-b/bracket.stl")).toEqual({
      kind: "matched", filename: "kit-b/bracket.stl", basis: "path",
    });
    expect(match("bracket.stl")).toEqual({
      kind: "ambiguous", basis: "filename",
      filenames: ["kit-b/bracket.stl", "kit-a/bracket.stl", "kit-a/bracket.stl"],
    });
    expect(match("kit-a/bracket.stl")).toEqual({
      kind: "ambiguous", basis: "path",
      filenames: ["kit-a/bracket.stl", "kit-a/bracket.stl"],
    });
  });

  it("owns a snapshot of filenames without freezing the caller's array", () => {
    const filenames = ["frame_left.stl"];
    const match = createSlicedObjectMatcher(filenames);
    filenames.splice(0, 1, "frame_right.stl");
    expect(match("frame_left.stl_id_7_copy_2")).toEqual({
      kind: "matched", filename: "frame_left.stl", basis: "filename",
    });
    expect(match("frame_right.stl").kind).toBe("unmatched");
    expect(matchSlicedObjectName("frame_right.stl", filenames)).toEqual({
      kind: "matched", filename: "frame_right.stl", basis: "filename",
    });
  });

  it.each([
    ["'caf%C3%A9%2Fframe-left.STL.gcode'", ["café/frame_left.stl"]],
    ["frame_left_02.stl", ["frame_left.stl"]],
    ["z_tensionr_left.stl", ["z_tensioner_left.stl", "z_tensioner_right.stl"]],
    ["tensioner_fron.stl", ["tensioner_front.stl", "tensioner_from.stl"]],
    ["motor_mount_2.stl", ["motor_mount_3.stl"]],
    ["xy_joint_x.stl", ["xy_joint_y.stl"]],
    ["%not-a-path", ["not_a_path.stl", "other.stl"]],
    ["", ["frame_left.stl"]],
    ["unknown.stl", []],
  ])("retains scalar matching decisions for %s", (raw, filenames) => {
    expect(createSlicedObjectMatcher(filenames)(raw)).toEqual(
      matchSlicedObjectName(raw, filenames),
    );
  });
});

describe("interpretSlicedObjectName", () => {
  it.each([
    ["frame_left.stl_id_7_copy_2", "frame_left", 2],
    ["'frame_left_stl__Instance_3_'", "frame_left", 2],
    ["frame_left.stl (Instance 2)", "frame_left", 1],
    ["plates/frame-left.STL.gcode", "frame_left", null],
  ])("unwraps slicer object labels: %s", (raw, expected, copyIndex) => {
    const interpreted = interpretSlicedObjectName(raw);
    expect(interpreted.basenameKey).toBe(expected);
    expect(interpreted.copyIndex).toBe(copyIndex);
  });
});

describe("matchSlicedObjectName", () => {
  it("matches exact paths before duplicate basenames", () => {
    expect(
      matchSlicedObjectName("kit-a/bracket.stl", [
        "kit-a/bracket.stl",
        "kit-b/bracket.stl",
      ]),
    ).toMatchObject({ kind: "matched", filename: "kit-a/bracket.stl", basis: "path" });
  });

  it("does not guess between duplicate basenames", () => {
    expect(
      matchSlicedObjectName("bracket.stl", ["kit-a/bracket.stl", "kit-b/bracket.stl"]),
    ).toEqual({
      kind: "ambiguous",
      basis: "filename",
      filenames: ["kit-a/bracket.stl", "kit-b/bracket.stl"],
    });
  });

  it("recognizes slicer and exported-unit suffixes", () => {
    expect(
      matchSlicedObjectName("z_alignment_tool_rear_02.stl", [
        "z_alignment_tool_rear.stl",
      ]),
    ).toMatchObject({
      kind: "matched",
      filename: "z_alignment_tool_rear.stl",
      basis: "unit_suffix",
    });
  });

  it("accepts a unique, bounded typo", () => {
    expect(
      matchSlicedObjectName("z_tensionr_left.stl", [
        "z_tensioner_left.stl",
        "z_tensioner_right.stl",
      ]),
    ).toMatchObject({
      kind: "matched",
      filename: "z_tensioner_left.stl",
      basis: "fuzzy",
    });
  });

  it.each([
    ["z_tensionr_left.stl", ["z_tensioner_right.stl"]],
    ["motor_mount_2.stl", ["motor_mount_3.stl"]],
    ["xy_joint_x.stl", ["xy_joint_y.stl"]],
  ])("refuses fuzzy matches that change semantic tokens", (raw, filenames) => {
    expect(matchSlicedObjectName(raw, filenames).kind).toBe("unmatched");
  });

  it("returns close candidates without selecting an unsafe fuzzy tie", () => {
    const result = matchSlicedObjectName("tensioner_fron.stl", [
      "tensioner_front.stl",
      "tensioner_from.stl",
    ]);
    expect(result.kind).not.toBe("matched");
  });
});
