import { describe, expect, it } from "vitest";
import { formatSyncTime, shortSha } from "./runtime";

describe("runtime endpoint helpers", () => {
  it("formats sync times through the shared formatter", () => {
    expect(formatSyncTime("2026-08-25T23:00:00.000Z")).toContain("2026");
  });

  it("shortens SHAs and renders missing values", () => {
    expect(shortSha("abcdef123456")).toBe("abcdef1");
    expect(shortSha(null)).toBe("—");
  });
});
