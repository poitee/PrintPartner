import { describe, expect, it } from "vitest";
import { isRecord, positiveSafeInteger } from "./guards.js";

describe("isRecord", () => {
  it("accepts objects but not arrays or null", () => {
    expect(isRecord({ value: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });
});

describe("positiveSafeInteger", () => {
  it("accepts positive safe integers only", () => {
    expect(positiveSafeInteger(1)).toBe(1);
    expect(positiveSafeInteger(0)).toBeNull();
    expect(positiveSafeInteger(1.2)).toBeNull();
    expect(positiveSafeInteger("1")).toBeNull();
    expect(positiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
});
