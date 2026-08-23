import { describe, expect, it } from "vitest";
import type { ProductionGroupingRule } from "@print-partner/contracts";
import { productionPackingBuckets } from "./production-packing-rules.js";

const units = [
  { token: "a", objectName: "a", filename: "a.stl", sourceDirectory: "XY", sourceLayer: "base", role: "primary", filamentColorId: "green" },
  { token: "b", objectName: "b", filename: "b.stl", sourceDirectory: "XY", sourceLayer: "base", role: "primary", filamentColorId: "orange" },
  { token: "c", objectName: "c", filename: "c.stl", sourceDirectory: "skirts", sourceLayer: "base", role: "accent", filamentColorId: "green" },
] as const;

function buckets(rules: ProductionGroupingRule[]) {
  return productionPackingBuckets(units, rules).map((bucket) => bucket.map((unit) => unit.token));
}

describe("production packing rules", () => {
  it("separates different values and preserves stable source order", () => {
    expect(buckets([{ id: "color", enabled: true, kind: "separate_by", field: "color" }])).toEqual([
      ["a", "c"],
      ["b"],
    ]);
  });

  it("isolates a requested directory without hard-coding directory names", () => {
    expect(buckets([{
      id: "xy",
      enabled: true,
      kind: "keep_together",
      field: "source_directory",
      value: "XY",
    }])).toEqual([["a", "b"], ["c"]]);
  });

  it("ignores disabled and printer-assignment rules during plate grouping", () => {
    expect(buckets([
      { id: "off", enabled: false, kind: "separate_by", field: "color" },
      { id: "printer", enabled: true, kind: "assign_to_printer", field: "role", value: "accent", printer_id: "p1" },
    ])).toEqual([["a", "b", "c"]]);
  });

  it("uses editable material assignments when separating by material", () => {
    expect(buckets([
      { id: "xy-abs", enabled: true, kind: "set_material", field: "source_directory", value: "XY", material_type: "ABS" },
      { id: "skirts-asa", enabled: true, kind: "set_material", field: "source_directory", value: "skirts", material_type: "ASA" },
      { id: "materials", enabled: true, kind: "separate_by", field: "material" },
    ])).toEqual([["a", "b"], ["c"]]);
  });
});
