import { describe, expect, it } from "vitest";
import { draftPartMatchError, resolveDraftPart } from "./planDraftPartMatch";

function draftPart(over: Partial<{ part_key: string; relative_path: string; source_layer: string }> & {
  draft_part_id: number;
}) {
  return {
    draft_part_id: over.draft_part_id,
    part_key: over.part_key ?? "frame/bracket.stl",
    relative_path: over.relative_path ?? "frame/bracket.stl",
    source_layer: over.source_layer ?? "base:Voron",
  };
}

const row = {
  match_key: "frame/bracket.stl",
  relative_path: "frame/bracket.stl",
  source_layer: "base:Voron",
};

describe("resolveDraftPart", () => {
  it("resolves a unique part_key", () => {
    const match = resolveDraftPart([draftPart({ draft_part_id: 17 })], row);
    expect(match).toEqual({ kind: "resolved", part: expect.objectContaining({ draft_part_id: 17 }) });
  });

  it("disambiguates duplicate part_keys by source layer and path", () => {
    const match = resolveDraftPart(
      [
        draftPart({ draft_part_id: 17, source_layer: "base:Voron" }),
        draftPart({ draft_part_id: 18, source_layer: "overlay:Mods" }),
      ],
      row,
    );
    expect(match).toEqual({
      kind: "resolved",
      part: expect.objectContaining({ draft_part_id: 17 }),
    });
  });

  it("resolves by relative path when the draft keys the part differently", () => {
    const match = resolveDraftPart([draftPart({ draft_part_id: 17, part_key: "bracket.stl" })], row);
    expect(match).toEqual({
      kind: "resolved",
      part: expect.objectContaining({ draft_part_id: 17 }),
    });
  });

  it("resolves keys that differ only by case or slash shape", () => {
    const match = resolveDraftPart(
      [draftPart({ draft_part_id: 17, part_key: "Frame\\Bracket.STL", relative_path: "other.stl" })],
      row,
    );
    expect(match).toEqual({
      kind: "resolved",
      part: expect.objectContaining({ draft_part_id: 17 }),
    });
  });

  it("reports ambiguity when duplicates cannot be narrowed", () => {
    const match = resolveDraftPart(
      [draftPart({ draft_part_id: 17 }), draftPart({ draft_part_id: 18 })],
      row,
    );
    expect(match).toEqual({ kind: "ambiguous", count: 2 });
  });

  it("reports a missing part rather than guessing", () => {
    const match = resolveDraftPart(
      [draftPart({ draft_part_id: 17, part_key: "frame/motor.stl", relative_path: "frame/motor.stl" })],
      row,
    );
    expect(match).toEqual({ kind: "missing" });
  });

  it("names both failures for the user", () => {
    expect(draftPartMatchError({ kind: "missing" }, "bracket.stl")).toMatch(
      /not in the saved draft.*Rebuild the Plan/s,
    );
    expect(draftPartMatchError({ kind: "ambiguous", count: 2 }, "bracket.stl")).toMatch(
      /2 Parts matching bracket\.stl/,
    );
  });
});
