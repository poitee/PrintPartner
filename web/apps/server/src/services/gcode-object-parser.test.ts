import { describe, expect, it } from "vitest";
import {
  groupObjectsByPart,
  matchObjectsToFilenames,
} from "./gcode-object-parser.js";

describe("gcode object filename matching", () => {
  it("matches generated unit suffixes to the source STL", () => {
    const grouped = groupObjectsByPart([
      "z_alignment_tool_rear_01",
      "z_alignment_tool_rear_02",
    ]);

    expect(
      matchObjectsToFilenames(grouped, ["z_alignment_tool_rear.stl"]),
    ).toEqual(
      new Map([
        ["z_alignment_tool_rear_01", ["z_alignment_tool_rear.stl"]],
        ["z_alignment_tool_rear_02", ["z_alignment_tool_rear.stl"]],
      ]),
    );
  });

  it("matches a sliced filename to the corresponding source STL", () => {
    const grouped = groupObjectsByPart(["cable_frame_anchor.bgcode"]);

    expect(
      matchObjectsToFilenames(grouped, ["cable_frame_anchor.stl"]),
    ).toEqual(
      new Map([
        ["cable_frame_anchor.bgcode", ["cable_frame_anchor.stl"]],
      ]),
    );
  });

  it("uses the shared conservative fuzzy matcher", () => {
    const grouped = groupObjectsByPart(["z_tensionr_left.stl"]);

    expect(
      matchObjectsToFilenames(grouped, [
        "z_tensioner_left.stl",
        "z_tensioner_right.stl",
      ]),
    ).toEqual(
      new Map([
        ["z_tensionr_left.stl", ["z_tensioner_left.stl"]],
      ]),
    );
  });

  it("returns all duplicate basename candidates instead of guessing", () => {
    const grouped = groupObjectsByPart(["bracket.stl"]);

    expect(
      matchObjectsToFilenames(grouped, ["kit-a/bracket.stl", "kit-b/bracket.stl"]),
    ).toEqual(
      new Map([
        ["bracket.stl", ["kit-a/bracket.stl", "kit-b/bracket.stl"]],
      ]),
    );
  });
});
