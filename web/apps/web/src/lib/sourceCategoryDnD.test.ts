import { describe, expect, it } from "vitest";
import {
  categoryDropTargetId,
  parseCategoryDropTargetId,
  parseLibraryDragPayload,
  librarySourceDragId,
  libraryFileDragId,
} from "./sourceCategoryDnD";

describe("sourceCategoryDnD", () => {
  it("round-trips category drop target ids", () => {
    expect(parseCategoryDropTargetId(categoryDropTargetId("Mods"))).toEqual({
      category: "Mods",
    });
    expect(parseCategoryDropTargetId(categoryDropTargetId(null))).toEqual({
      category: null,
    });
    expect(parseCategoryDropTargetId("all")).toBeNull();
  });

  it("parses source and file drag payloads", () => {
    expect(parseLibraryDragPayload(librarySourceDragId(9))).toEqual({
      kind: "source",
      sourceId: 9,
    });
    expect(
      parseLibraryDragPayload(libraryFileDragId(9, "parts/a.stl")),
    ).toEqual({
      kind: "file",
      sourceId: 9,
      relativePath: "parts/a.stl",
    });
    expect(parseLibraryDragPayload("nope")).toBeNull();
  });
});
