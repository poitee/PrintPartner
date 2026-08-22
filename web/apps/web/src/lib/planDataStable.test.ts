import { describe, expect, it } from "vitest";
import { partRowsEqual } from "./planDataStable";
import type { PartRow } from "../api/engine";

const samplePart = (id: number): PartRow => ({
  id,
  match_key: `parts/a-${id}.stl`,
  relative_path: `parts/a-${id}.stl`,
  filename: `a-${id}.stl`,
  source_layer: "base:printer",
  status: "base",
  role: null,
  requirement: "required",
  option_group_id: null,
  included: true,
  filament_color_id: null,
  quantity_auto: 1,
  quantity_override: null,
  quantity_effective: 1,
});

describe("partRowsEqual", () => {
  it("returns true when kit-relevant fields match", () => {
    const a = [samplePart(1)];
    const b = [{ ...samplePart(1) }];
    expect(partRowsEqual(a, b)).toBe(true);
  });

  it("returns false when included changes", () => {
    const a = [samplePart(1)];
    const b = [{ ...samplePart(1), included: false }];
    expect(partRowsEqual(a, b)).toBe(false);
  });
});

