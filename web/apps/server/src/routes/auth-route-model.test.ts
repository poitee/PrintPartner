import { describe, expect, it } from "vitest";
import { defaultDisplayName, isValidEmailInput, normalizeEmailInput } from "./auth-route-model.js";

describe("auth route model", () => {
  it("normalizes email-like input", () => {
    expect(normalizeEmailInput("  USER@Example.COM ")).toBe("user@example.com");
    expect(normalizeEmailInput(null)).toBe("");
  });

  it("validates basic email presence", () => {
    expect(isValidEmailInput("user@example.com")).toBe(true);
    expect(isValidEmailInput("user")).toBe(false);
    expect(isValidEmailInput("")).toBe(false);
  });

  it("derives display names", () => {
    expect(defaultDisplayName({ displayName: "  Pat  ", email: "user@example.com" })).toBe("Pat");
    expect(defaultDisplayName({ displayName: "", email: "user@example.com" })).toBe("user");
    expect(defaultDisplayName({ displayName: "", email: "" })).toBe("User");
  });
});
