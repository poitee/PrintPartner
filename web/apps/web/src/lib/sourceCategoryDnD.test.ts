import { describe, expect, it } from "vitest";
import {
  parseLibraryDragPayload,
  librarySourceDragId,
  libraryFileDragId,
} from "./sourceCategoryDnD";

describe("sourceCategoryDnD", () => {

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
