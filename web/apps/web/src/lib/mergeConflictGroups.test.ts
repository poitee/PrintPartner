import { describe, expect, it } from "vitest";
import { groupMergeConflictsByFilename } from "./mergeConflictGroups";

describe("groupMergeConflictsByFilename", () => {
  it("groups merge_conflict issues by filename", () => {
    const groups = groupMergeConflictsByFilename([
      {
        severity: "warning",
        code: "merge_conflict",
        message: "Merge conflict for widget.stl — exclude duplicates on the Plan source cards.",
      },
      {
        severity: "warning",
        code: "merge_conflict",
        message: "Merge conflict for widget.stl — exclude duplicates on the Plan source cards.",
      },
      {
        severity: "warning",
        code: "merge_conflict",
        message: "Merge conflict for bracket.stl — exclude duplicates on the Plan source cards.",
      },
    ]);
    expect(groups).toEqual([
      ["bracket.stl", 1],
      ["widget.stl", 2],
    ]);
  });
});
