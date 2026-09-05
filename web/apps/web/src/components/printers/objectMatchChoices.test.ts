import { describe, it, expect } from "vitest";
import type { PrintFileMatchReview } from "@print-partner/contracts";
import { allocateObjectChoices } from "./objectMatchChoices";

const review: PrintFileMatchReview = {
  objects: [{ object_index: 0, name: "clip" }, { object_index: 1, name: "clip" }, { object_index: 2, name: "other" }],
  parts: [{ part_id: 7, filename: "clip.stl", relative_path: "parts/clip.stl", units: [0, 1, 2].map((unit_index) => ({ part_id: 7, unit_index })) }],
};
describe("object choice allocation", () => {
  it("starts without fuzzy choices and retains only positive tokens", () => {
    expect([...allocateObjectChoices(review, new Map(), new Set(["7:0"])).tokens]).toEqual(["7:0"]);
  });
  it("preserves copies and reserves positive units before manual choices", () => {
    const result = allocateObjectChoices(review, new Map([[0, 7], [1, 7]]), new Set(["7:0"]));
    expect(result.mappings.map((row) => row.unit_index)).toEqual([1, 2]);
    expect(result.shortages).toEqual([]);
  });
  it("reports shortage rather than reusing a unit when two groups compete", () => {
    const result = allocateObjectChoices(review, new Map([[0, 7], [1, 7], [2, 7]]), new Set(["7:0"]));
    expect(result.shortages).toHaveLength(1);
    expect(result.tokens.size).toBe(3);
  });
  it("releases allocations when a choice is cleared or a positive is unchecked", () => {
    expect(allocateObjectChoices(review, new Map([[1, 7]]), new Set()).mappings).toEqual([
      { object_index: 1, part_id: 7, unit_index: 0 },
    ]);
  });
});
