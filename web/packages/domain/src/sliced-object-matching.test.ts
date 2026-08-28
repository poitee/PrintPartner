import { describe, expect, it } from "vitest";
import {
  interpretSlicedObjectName,
  matchSlicedObjectName,
} from "./sliced-object-matching.js";

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
