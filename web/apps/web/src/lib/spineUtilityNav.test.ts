import { describe, expect, it } from "vitest";
import { spineUtilityNavItems } from "./spineUtilityNav";

describe("spineUtilityNavItems", () => {
  it("orders Builds · Production · Printers · Settings · Help", () => {
    expect(spineUtilityNavItems(7).map((item) => item.id)).toEqual([
      "builds",
      "production",
      "printers",
      "settings",
      "help",
    ]);
    expect(spineUtilityNavItems(7).map((item) => item.path)).not.toContain("/library");
    expect(spineUtilityNavItems(7).map((item) => item.path)).not.toContain("/plan");
  });

  it("labels Builds and Production in the global sections", () => {
    const labels = spineUtilityNavItems(null).map((item) => item.label);
    expect(labels).toEqual(["Builds", "Production", "Printers", "Settings", "Help"]);
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
    expect(spineUtilityNavItems(12)[1]).toMatchObject({
      id: "production",
      to: "/production",
      path: "/production",
      label: "Production",
    });
  });
});
