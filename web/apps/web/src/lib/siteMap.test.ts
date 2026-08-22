import { describe, expect, it } from "vitest";
import {
  BUILD_SECTIONS,
  GLOBAL_SECTIONS,
  buildSectionFromPath,
  buildSectionPath,
  globalSectionFromPath,
  globalSectionPath,
} from "./siteMap";

describe("site map", () => {
  it("names the four global sections and four Build destinations", () => {
    expect([...GLOBAL_SECTIONS]).toEqual(["builds", "production", "printers", "settings"]);
    expect([...BUILD_SECTIONS]).toEqual(["sources", "plan", "checkoff", "production"]);
  });

  it("uses Builds and Production as top-level paths", () => {
    expect(globalSectionPath("builds")).toBe("/builds");
    expect(globalSectionPath("production")).toBe("/production");
    expect(globalSectionPath("printers")).toBe("/printers");
    expect(globalSectionPath("settings")).toBe("/settings");
  });

  it("maps Build destinations to their route paths", () => {
    expect(buildSectionPath("sources", 7)).toBe("/sources?profile=7");
    expect(buildSectionPath("plan", 7)).toBe("/plan?profile=7");
    expect(buildSectionPath("checkoff", 7)).toBe("/progress?profile=7");
    expect(buildSectionPath("production", 7)).toBe("/export?profile=7");
  });

  it("keeps Global Production and Build Production on distinct paths", () => {
    expect(globalSectionFromPath("/")).toBe("builds");
    expect(globalSectionFromPath("/plans")).toBe("builds");
    expect(globalSectionFromPath("/production")).toBe("production");
    expect(globalSectionFromPath("/export")).toBeNull();
    expect(buildSectionFromPath("/sources")).toBe("sources");
    expect(buildSectionFromPath("/build")).toBe("sources");
    expect(buildSectionFromPath("/plan")).toBe("plan");
    expect(buildSectionFromPath("/parts")).toBe("plan");
    expect(buildSectionFromPath("/review")).toBe("plan");
    expect(buildSectionFromPath("/checkoff")).toBe("checkoff");
    expect(buildSectionFromPath("/export")).toBe("production");
    expect(buildSectionFromPath("/production")).toBeNull();
    expect(buildSectionFromPath("/library")).toBeNull();
  });
});
