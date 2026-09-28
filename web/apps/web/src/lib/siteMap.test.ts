import { describe, expect, it } from "vitest";
import {
  BUILD_SECTIONS,
  GLOBAL_SECTIONS,
  globalSectionPath,
} from "./siteMap";

describe("site map", () => {
  it("names the four global sections and four Build destinations", () => {
    expect([...GLOBAL_SECTIONS]).toEqual(["builds", "production", "printers", "settings"]);
    expect([...BUILD_SECTIONS]).toEqual(["sources", "plan", "production", "checkoff"]);
  });

  it("uses Builds and Production as top-level paths", () => {
    expect(globalSectionPath("builds")).toBe("/builds");
    expect(globalSectionPath("production")).toBe("/production");
    expect(globalSectionPath("printers")).toBe("/printers");
    expect(globalSectionPath("settings")).toBe("/settings");
  });
});
