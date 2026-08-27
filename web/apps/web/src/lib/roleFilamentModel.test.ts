import { describe, expect, it } from "vitest";
import { DEFAULT_ROLE_LABELS, normalizeFilamentHex, roleFilamentLabel } from "./roleFilamentModel";

describe("role filament labels", () => {
  it("uses the default STL naming role labels and falls back to the id", () => {
    expect(DEFAULT_ROLE_LABELS.primary).toBe("Primary");
    expect(roleFilamentLabel("primary")).toBe("Primary");
    expect(roleFilamentLabel("custom-role")).toBe("custom-role");
  });
});

describe("normalizeFilamentHex", () => {
  it("normalizes 6-digit and 3-digit hex values", () => {
    expect(normalizeFilamentHex(" C41230 ")).toBe("#c41230");
    expect(normalizeFilamentHex("#abc")).toBe("#aabbcc");
  });

  it("rejects invalid colors", () => {
    expect(normalizeFilamentHex("red")).toBeNull();
    expect(normalizeFilamentHex("#1234")).toBeNull();
  });
});
