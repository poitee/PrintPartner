import { describe, expect, it } from "vitest";
import {
  isKitStudioPath,
  withProfile,
} from "./routes";

describe("withProfile", () => {
  it("appends profile query when id is set", () => {
    expect(withProfile("/plate", 42)).toBe("/plate?profile=42");
  });

  it("leaves path unchanged when id is null", () => {
    expect(withProfile("/plate", null)).toBe("/plate");
  });

  it("uses ampersand when path already has query", () => {
    expect(withProfile("/plate?foo=1", 3)).toBe("/plate?foo=1&profile=3");
  });
});

describe("path matchers", () => {
  it("detects kit studio paths", () => {
    expect(isKitStudioPath("/plans/12/studio")).toBe(true);
    expect(isKitStudioPath("/build")).toBe(false);
  });
});
