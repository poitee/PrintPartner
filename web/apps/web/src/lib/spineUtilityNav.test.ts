import { describe, expect, it } from "vitest";
import { spineUtilityNavItems } from "./spineUtilityNav";

describe("spineUtilityNavItems", () => {
  it("places Source Library directly under Builds", () => {
    expect(spineUtilityNavItems(7).map((item) => item.id)).toEqual([
      "builds",
      "library",
      "production",
      "printers",
      "settings",
      "help",
    ]);
    expect(spineUtilityNavItems(7)[1]).toMatchObject({
      id: "library",
      to: "/library",
      path: "/library",
      label: "Source Library",
    });
    expect(spineUtilityNavItems(7).map((item) => item.path)).not.toContain("/plan");
  });

  it("labels Builds and Production in the global sections", () => {
    const labels = spineUtilityNavItems(null).map((item) => item.label);
    expect(labels).toEqual([
      "Builds",
      "Source Library",
      "All Production",
      "Printers",
      "Settings",
      "Help",
    ]);
    expect(labels).not.toContain("Plans");
    expect(labels).not.toContain("All plans");
  });

  it("routes Builds through /builds with the active profile", () => {
    expect(spineUtilityNavItems(12)[0]).toMatchObject({
      id: "builds",
      to: "/builds?profile=12",
      path: "/builds",
      label: "Builds",
    });
    expect(spineUtilityNavItems(12)[2]).toMatchObject({
      id: "production",
      to: "/production",
      path: "/production",
      label: "All Production",
    });
  });
});
