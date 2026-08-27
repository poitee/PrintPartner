import { describe, expect, it } from "vitest";
import { sourceIdFromParams } from "./settings-route-model.js";

describe("sourceIdFromParams", () => {
  it("accepts positive integer id params", () => {
    expect(sourceIdFromParams({ id: "42" })).toBe(42);
  });

  it("rejects missing, invalid, zero, and unsafe ids", () => {
    expect(sourceIdFromParams(null)).toBeNull();
    expect(sourceIdFromParams({})).toBeNull();
    expect(sourceIdFromParams({ id: "abc" })).toBeNull();
    expect(sourceIdFromParams({ id: "0" })).toBeNull();
    expect(sourceIdFromParams({ id: String(Number.MAX_SAFE_INTEGER + 1) })).toBeNull();
  });
});
