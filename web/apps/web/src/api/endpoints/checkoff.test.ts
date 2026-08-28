import { describe, expect, it } from "vitest";
import { parsePrintFileAssignmentPreview } from "./checkoff";

const BASIS = {
  suggested_units: [
    { part_id: 1, unit_index: 0, object_name: "bracket_left.stl" },
    { part_id: 2, unit_index: 0 },
  ],
  suggestion_basis: "object_names",
  unlabeled_names: ["mystery.stl"],
  plan_revision_id: 4,
};

const INSPECTED = {
  ...BASIS,
  inspected: true,
  classification: { format: "3mf", kind: "slicer_project" },
  print_ready: false,
};

const UNREADABLE = /shape this app cannot read/;

describe("parsePrintFileAssignmentPreview", () => {
  it("reads a check that read the bytes", () => {
    expect(parsePrintFileAssignmentPreview(INSPECTED)).toEqual({
      inspected: true,
      classification: { format: "3mf", kind: "slicer_project" },
      print_ready: false,
      suggested_units: [
        { part_id: 1, unit_index: 0, object_name: "bracket_left.stl" },
        { part_id: 2, unit_index: 0 },
      ],
      suggestion_basis: "object_names",
      unlabeled_names: ["mystery.stl"],
      plan_revision_id: 4,
    });
  });

  it("reads a check that never read the bytes, and gives it no classification", () => {
    const preview = parsePrintFileAssignmentPreview({ ...BASIS, inspected: false });
    expect(preview.inspected).toBe(false);
    expect(preview).not.toHaveProperty("classification");
    expect(preview).not.toHaveProperty("print_ready");
    expect(preview.plan_revision_id).toBe(4);
  });

  it("reads a sliced classification with no kind", () => {
    const preview = parsePrintFileAssignmentPreview({
      ...INSPECTED,
      classification: { format: "gcode" },
    });
    expect(preview.inspected && preview.classification).toEqual({ format: "gcode" });
  });

  it("drops a field the UI does not use rather than failing", () => {
    expect(
      parsePrintFileAssignmentPreview({ ...INSPECTED, next_action: "slice it" }),
    ).not.toHaveProperty("next_action");
  });

  it("refuses to blur the two arms together", () => {
    // Read, but with nothing to show for it.
    const { classification: _c, ...noClassification } = INSPECTED;
    expect(() => parsePrintFileAssignmentPreview(noClassification)).toThrow(UNREADABLE);
    const { print_ready: _p, ...noReadiness } = INSPECTED;
    expect(() => parsePrintFileAssignmentPreview(noReadiness)).toThrow(UNREADABLE);
    // Never read, yet claiming to know.
    expect(() =>
      parsePrintFileAssignmentPreview({
        ...BASIS,
        inspected: false,
        classification: { format: "gcode" },
      }),
    ).toThrow(UNREADABLE);
    // Not a discriminant at all.
    expect(() => parsePrintFileAssignmentPreview({ ...BASIS, inspected: "maybe" })).toThrow(
      UNREADABLE,
    );
    expect(() => parsePrintFileAssignmentPreview(BASIS)).toThrow(UNREADABLE);
  });

  it("rejects a classification this app cannot branch on", () => {
    for (const classification of [
      null,
      {},
      { format: "step" },
      { format: "3mf" },
      { format: "3mf", kind: "mystery" },
    ]) {
      expect(() => parsePrintFileAssignmentPreview({ ...INSPECTED, classification })).toThrow(
        UNREADABLE,
      );
    }
  });

  it("rejects a classification nested where the UI does not look for it", () => {
    expect(() =>
      parsePrintFileAssignmentPreview({
        ...BASIS,
        inspected: true,
        file: { classification: { format: "gcode" }, print_ready: true },
      }),
    ).toThrow(UNREADABLE);
  });

  it("rejects a suggestion basis it has no words for", () => {
    expect(() =>
      parsePrintFileAssignmentPreview({ ...INSPECTED, suggestion_basis: "vibes" }),
    ).toThrow(UNREADABLE);
  });

  it("rejects a unit that is not a Required unit coordinate", () => {
    for (const suggested of [
      "units",
      [null],
      [{ part_id: 1 }],
      [{ part_id: "1", unit_index: 0 }],
      [{ part_id: 1.5, unit_index: 0 }],
    ]) {
      expect(() =>
        parsePrintFileAssignmentPreview({ ...INSPECTED, suggested_units: suggested }),
      ).toThrow(UNREADABLE);
    }
  });

  it("rejects a reply that is not an object at all", () => {
    for (const value of [null, undefined, "ok", 7, []]) {
      expect(() => parsePrintFileAssignmentPreview(value)).toThrow(UNREADABLE);
    }
  });
});
