import { describe, expect, it } from "vitest";
import { DEFAULT_STL_NAMING_PROFILE, type RoleFilamentRow } from "../api/engine";
import { meshColorForStlPath, parseStlRole } from "./rolePreviewColor";

describe("meshColorForStlPath", () => {
  const roleFilaments: RoleFilamentRow[] = [
    {
      role: "primary",
      filament_color_id: null,
      filament_custom_hex: "#111111",
      filament_hex: "#111111",
      filament_display: "Custom",
      spoolman_spool_id: null,
      part_count: 2,
    },
    {
      role: "accent",
      filament_color_id: null,
      filament_custom_hex: "#00ff00",
      filament_hex: "#00ff00",
      filament_display: "Green",
      spoolman_spool_id: null,
      part_count: 1,
    },
  ];

  it("maps accent marker filenames to accent role color", () => {
    expect(parseStlRole("parts/[a]_bracket.stl", DEFAULT_STL_NAMING_PROFILE)).toBe("accent");
    expect(meshColorForStlPath("parts/[a]_bracket.stl", DEFAULT_STL_NAMING_PROFILE, roleFilaments)).toBe(
      "#00ff00",
    );
  });

  it("uses primary color when no role marker matches", () => {
    expect(meshColorForStlPath("parts/widget.stl", DEFAULT_STL_NAMING_PROFILE, roleFilaments)).toBe(
      "#111111",
    );
  });
});
