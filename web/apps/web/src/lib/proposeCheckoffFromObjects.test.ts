import { describe, expect, it } from "vitest";
import type { ReviewPart } from "../api/endpoints/planManifests";
import {
  buildObjectPreviewRows,
  buildPreviewRowsFromUnits,
  exportUnitKey,
  objectStem,
  proposeCheckoffFromObjects,
} from "./proposeCheckoffFromObjects";

function part(overrides: Partial<ReviewPart> & Pick<ReviewPart, "id" | "filename">): ReviewPart {
  const qty = overrides.quantity_effective ?? overrides.print_units?.length ?? 1;
  return {
    match_key: overrides.filename,
    relative_path: overrides.filename,
    source_layer: null,
    status: "ok",
    role: null,
    requirement: null,
    option_group_id: null,
    included: true,
    filament_color_id: null,
    quantity_auto: qty,
    quantity_override: null,
    quantity_effective: qty,
    print_units: overrides.print_units ?? Array.from({ length: qty }, () => false),
    printed_count: overrides.printed_count ?? 0,
    missing: true,
    filament_display: "",
    ...overrides,
  };
}

describe("proposeCheckoffFromObjects", () => {
  it("matches unique export-remaining names (stem_01)", () => {
    const parts = [
      part({ id: 1, filename: "bracket.stl", quantity_effective: 2, print_units: [false, false] }),
      part({ id: 2, filename: "spacer.stl", quantity_effective: 1, print_units: [false] }),
    ];
    expect(exportUnitKey("bracket.stl", 0)).toBe("bracket_01");
    const result = proposeCheckoffFromObjects(
      ["bracket_01.stl", "spacer_01.stl", "unknown_part"],
      parts,
    );
    expect(result.units).toEqual([
      { part_id: 1, unit_index: 0, object_name: "bracket_01.stl" },
      { part_id: 2, unit_index: 0, object_name: "spacer_01.stl" },
    ]);
    expect(result.unmatchedNames).toEqual(["unknown_part"]);
    expect(result.matches.every((m) => m.match === "export_name")).toBe(true);
  });

  it("keeps the Object name that justified each proposed unit", () => {
    const parts = [
      part({
        id: 1,
        filename: "bracket.stl",
        quantity_effective: 2,
        print_units: [false, false],
      }),
    ];

    expect(proposeCheckoffFromObjects(["  bracket_01.stl  ", "bracket_02"], parts).units).toEqual([
      { part_id: 1, unit_index: 0, object_name: "bracket_01.stl" },
      { part_id: 1, unit_index: 1, object_name: "bracket_02" },
    ]);
  });

  it("applies 5+3 by stem when labels share a stem", () => {
    const parts = [
      part({
        id: 10,
        filename: "bracket.stl",
        quantity_effective: 5,
        print_units: [false, false, false, false, false],
      }),
      part({
        id: 11,
        filename: "spacer.stl",
        quantity_effective: 3,
        print_units: [false, false, false],
      }),
    ];
    // Dummy spike: five bracket_* + three spacer_* EXCLUDE_OBJECT_DEFINE names.
    const names = [
      "bracket_01",
      "bracket_02",
      "bracket_03",
      "bracket_04",
      "bracket_05",
      "spacer_01",
      "spacer_02",
      "spacer_03",
    ];
    expect(objectStem("bracket_03")).toBe("bracket");
    const result = proposeCheckoffFromObjects(names, parts);
    expect(result.units).toHaveLength(8);
    expect(result.units.filter((u) => u.part_id === 10)).toHaveLength(5);
    expect(result.units.filter((u) => u.part_id === 11)).toHaveLength(3);
    expect(result.unmatchedNames).toEqual([]);
  });

  it("does not silently map a duplicate basename from two Sources", () => {
    const parts = [
      part({
        id: 1,
        filename: "kit-a/bracket.stl",
        quantity_effective: 1,
        print_units: [false],
      }),
      part({
        id: 2,
        filename: "kit-b/bracket.stl",
        quantity_effective: 1,
        print_units: [false],
      }),
    ];

    const result = proposeCheckoffFromObjects(["bracket_01", "bracket.stl"], parts);

    expect(result.units).toEqual([]);
    expect(result.unmatchedNames).toEqual(["bracket_01", "bracket.stl"]);
    expect(buildObjectPreviewRows(result, parts)).toEqual([
      { kind: "unlabeled", name: "bracket_01" },
      { kind: "unlabeled", name: "bracket.stl" },
    ]);
  });

  it("uses a preserved path to disambiguate duplicate basenames", () => {
    const parts = [
      part({ id: 1, filename: "kit-a/bracket.stl" }),
      part({ id: 2, filename: "kit-b/bracket.stl" }),
    ];

    const result = proposeCheckoffFromObjects(["kit-b/bracket.stl"], parts);

    expect(result.units).toEqual([
      { part_id: 2, unit_index: 0, object_name: "kit-b/bracket.stl" },
    ]);
    expect(result.matches[0]?.match).toBe("filename");
  });

  it("maps a unique conservative typo but preserves semantic distinctions", () => {
    const parts = [
      part({ id: 1, filename: "z_tensioner_left.stl" }),
      part({ id: 2, filename: "z_tensioner_right.stl" }),
    ];

    const matched = proposeCheckoffFromObjects(["z_tensionr_left.stl"], parts);
    expect(matched.units).toEqual([
      { part_id: 1, unit_index: 0, object_name: "z_tensionr_left.stl" },
    ]);
    expect(matched.matches[0]?.match).toBe("fuzzy");

    const refused = proposeCheckoffFromObjects(["z_tensionr_top.stl"], parts);
    expect(refused.units).toEqual([]);
    expect(refused.unmatchedNames).toEqual(["z_tensionr_top.stl"]);
  });

  it("does not propose past already-printed units", () => {
    const parts = [
      part({
        id: 1,
        filename: "bracket.stl",
        quantity_effective: 3,
        print_units: [true, false, false],
        printed_count: 1,
      }),
    ];
    const result = proposeCheckoffFromObjects(
      ["bracket_01", "bracket_02", "bracket_03"],
      parts,
    );
    // unit 0 already printed — export keys bracket_02/03 map to remaining indexes 1/2;
    // bracket_01 export name no longer has a remaining slot → stem may claim leftover.
    expect(result.units.every((u) => u.unit_index !== 0)).toBe(true);
    expect(result.units.length).toBeLessThanOrEqual(2);
  });

  it("returns empty proposal (no auto-select) when unlabeled", () => {
    const parts = [part({ id: 1, filename: "a.stl", quantity_effective: 2, print_units: [false, false] })];
    const result = proposeCheckoffFromObjects([], parts);
    expect(result.units).toEqual([]);
    expect(result.unmatchedNames).toEqual([]);
  });

  it("builds one preview list with matched ×N · remaining and unlabeled rows", () => {
    const parts = [
      part({ id: 1, filename: "[a]_CDR.stl", quantity_effective: 5, print_units: [true, true, false, false, false], printed_count: 2 }),
      part({ id: 2, filename: "[a]_motor_mount.stl", quantity_effective: 3, print_units: [true, true, false], printed_count: 2 }),
    ];
    const proposed = proposeCheckoffFromObjects(
      ["[a]_CDR_01", "[a]_CDR_02", "[a]_CDR_03", "[a]_motor_mount_01", "[c]_rear_housing.stl"],
      parts,
    );
    const rows = buildObjectPreviewRows(proposed, parts);
    expect(rows.some((r) => r.kind === "matched" && r.filename === "[a]_CDR.stl")).toBe(true);
    expect(rows.some((r) => r.kind === "unlabeled" && r.name.includes("rear_housing"))).toBe(true);
    const fromUnits = buildPreviewRowsFromUnits(proposed.units, parts, ["[c]_rear_housing.stl"]);
    expect(fromUnits.filter((r) => r.kind === "matched").length).toBeGreaterThan(0);
    expect(fromUnits.some((r) => r.kind === "unlabeled")).toBe(true);
  });
});
