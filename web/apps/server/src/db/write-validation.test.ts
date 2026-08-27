import { describe, expect, it } from "vitest";
import { requiredText, sha256Digest } from "./write-validation.js";

describe("requiredText", () => {
  it("trims and returns non-empty text", () => {
    expect(requiredText("  value  ", "Field")).toBe("value");
  });

  it("rejects blank text", () => {
    expect(() => requiredText(" ", "Field")).toThrow("Field is required");
  });
});

describe("sha256Digest", () => {
  it("normalizes a SHA-256 digest", () => {
    expect(sha256Digest(` ${"A".repeat(64)} `, "Digest")).toBe("a".repeat(64));
  });

  it("rejects invalid digests", () => {
    expect(() => sha256Digest("abc", "Digest")).toThrow(
      "Digest must be a SHA-256 hex digest",
    );
    expect(() => sha256Digest("g".repeat(64), "Digest")).toThrow(
      "Digest must be a SHA-256 hex digest",
    );
  });
});
