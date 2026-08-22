import { describe, expect, it } from "vitest";
import { planHasUnsetRoleColors, roleColorIsSet } from "./roleColorSet";

describe("roleColorIsSet", () => {
  it("treats custom hex as set", () => {
    expect(
      roleColorIsSet({ filament_color_id: null, filament_custom_hex: "#c41230" }),
    ).toBe(true);
  });

  it("treats catalog id as set", () => {
    expect(
      roleColorIsSet({ filament_color_id: "bambu:red", filament_custom_hex: null }),
    ).toBe(true);
  });

  it("treats empty as unset", () => {
    expect(roleColorIsSet({ filament_color_id: null, filament_custom_hex: null })).toBe(
      false,
    );
    expect(roleColorIsSet({ filament_color_id: "  ", filament_custom_hex: "" })).toBe(
      false,
    );
  });
});

describe("planHasUnsetRoleColors", () => {
  it("ignores roles with zero parts", () => {
    expect(
      planHasUnsetRoleColors([
        {
          part_count: 0,
          filament_color_id: null,
          filament_custom_hex: null,
        },
        {
          part_count: 10,
          filament_color_id: null,
          filament_custom_hex: "#112233",
        },
      ]),
    ).toBe(false);
  });

  it("flags roles with parts and no color", () => {
    expect(
      planHasUnsetRoleColors([
        {
          part_count: 5,
          filament_color_id: null,
          filament_custom_hex: null,
        },
      ]),
    ).toBe(true);
  });
});
