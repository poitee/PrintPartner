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
});
