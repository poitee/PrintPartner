import { describe, expect, it } from "vitest";
import type { ReviewPart } from "../api/engine";
import { groupPartsByRole, partsSummaryLine, partSourceNote } from "./partsGroups";

function part(overrides: Partial<ReviewPart> & { id: number }): ReviewPart {
  return {
    match_key: "k",
    relative_path: "gantry/a.stl",
    filename: "a.stl",
    source_layer: "base:Trident",
    status: "ok",
    role: "primary",
    requirement: null,
    option_group_id: null,
    included: true,
    filament_color_id: null,
    quantity_auto: 1,
    quantity_override: null,
    quantity_effective: 1,
    print_units: [false],
    printed_count: 0,
    missing: false,
    filament_display: "Matte Black",
    filament_hex: "#1f2937",
    ...overrides,
  };
}

describe("groupPartsByRole", () => {
  it("orders primary before accent and titles with filament", () => {
    const groups = groupPartsByRole([
      part({ id: 1, role: "accent", filament_display: "Rust", filament_hex: "#c64f1f", filename: "a.stl" }),
      part({ id: 2, role: "primary", filename: "b.stl" }),
      part({ id: 3, role: "primary", filename: "c.stl", relative_path: "skirts/c.stl" }),
    ]);
    expect(groups.map((g) => g.roleKey)).toEqual(["primary", "accent"]);
    expect(groups[0]!.title).toBe("Primary · Matte Black");
    expect(groups[0]!.parts).toHaveLength(2);
    expect(groups[1]!.title).toBe("Accent · Rust");
  });

  it("buckets null role as unassigned", () => {
    const groups = groupPartsByRole([part({ id: 1, role: null })]);
    expect(groups[0]!.roleKey).toBe("unassigned");
    expect(groups[0]!.title).toContain("Unassigned");
  });
});

describe("partsSummaryLine", () => {
  it("includes role counts and non-missing warnings", () => {
    const line = partsSummaryLine(
      [part({ id: 1 }), part({ id: 2, role: "accent", included: true })],
      { primary: 1, accent: 1 },
      3,
    );
    expect(line).toBe("2 parts · 1 primary · 1 accent · 3 warnings");
  });

  it("omits warnings when count is zero (missing STLs are desk-loop / tray only)", () => {
    const line = partsSummaryLine(
      [part({ id: 1, missing: true }), part({ id: 2, role: "accent", missing: true })],
      { primary: 1, accent: 1 },
      0,
    );
    expect(line).toBe("2 parts · 1 primary · 1 accent");
  });
});

describe("partSourceNote", () => {
  it("joins source and folder", () => {
    expect(partSourceNote(part({ id: 1 }))).toBe("Trident / gantry");
  });
});
