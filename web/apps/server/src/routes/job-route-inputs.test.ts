import { describe, expect, it } from "vitest";
import { isRecord, positiveSafeInteger } from "./job-route-inputs.js";

describe("positiveSafeInteger", () => {
  it("accepts positive safe integers", () => {
    expect(positiveSafeInteger(1)).toBe(1);
  });

  it("rejects non-integers and unsafe values", () => {
    expect(positiveSafeInteger(0)).toBeNull();
    expect(positiveSafeInteger(1.2)).toBeNull();
    expect(positiveSafeInteger("1")).toBeNull();
    expect(positiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
});

describe("isRecord", () => {
  it("accepts plain object records", () => {
    expect(isRecord({ ok: true })).toBe(true);
  });

  it("rejects null and arrays", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
  });
});
