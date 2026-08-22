import { describe, expect, it } from "vitest";
import { partFilenameInitials } from "../components/PlanTray";

describe("partFilenameInitials", () => {
  it("uses first letters of underscore tokens", () => {
    expect(partFilenameInitials("z_belt_cover_300_x2.stl")).toBe("ZB");
  });

  it("strips accent prefix markers", () => {
    expect(partFilenameInitials("[a]_skirt_panel_x4.stl")).toBe("SP");
  });

  it("falls back to first two characters for a single token", () => {
    expect(partFilenameInitials("dinclip.stl")).toBe("DI");
  });

  it("handles empty-ish names", () => {
    expect(partFilenameInitials(".stl")).toBe("?");
  });
});
