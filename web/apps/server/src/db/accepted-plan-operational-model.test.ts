import { describe, expect, it } from "vitest";
import {
  chunks,
  digestFormat1Inputs,
  isCanonicalTimestamp,
  isPositiveSafeInteger,
  isSafeLayerOrder,
  isSafeRelativePath,
  SHA256_PATTERN,
  storedBoolean,
} from "./accepted-plan-operational-model.js";

describe("accepted plan operational model", () => {
  it("chunks arrays without mutating order", () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 2)).toEqual([]);
  });

  it("digests format-1 inputs in canonical source revision order", () => {
    const first = digestFormat1Inputs([
      { sourceRevisionId: 2, manifestDigest: "b" },
      { sourceRevisionId: 1, manifestDigest: "a" },
    ]);
    const second = digestFormat1Inputs([
      { sourceRevisionId: 1, manifestDigest: "a" },
      { sourceRevisionId: 2, manifestDigest: "b" },
    ]);

    expect(first).toBe(second);
    expect(first).toMatch(SHA256_PATTERN);
  });

  it("validates safe integer domains", () => {
    expect(isPositiveSafeInteger(1)).toBe(true);
    expect(isPositiveSafeInteger(0)).toBe(false);
    expect(isPositiveSafeInteger(1.5)).toBe(false);
    expect(isSafeLayerOrder(0)).toBe(true);
    expect(isSafeLayerOrder(-1)).toBe(false);
  });

  it("validates safe relative paths", () => {
    expect(isSafeRelativePath("source/layer/file.stl")).toBe(true);
    expect(isSafeRelativePath("/source/layer/file.stl")).toBe(false);
    expect(isSafeRelativePath("source/../file.stl")).toBe(false);
    expect(isSafeRelativePath("C:/source/file.stl")).toBe(false);
    expect(isSafeRelativePath("source\\file.stl")).toBe(false);
    expect(isSafeRelativePath("")).toBe(false);
  });

  it("accepts only canonical ISO timestamps", () => {
    expect(isCanonicalTimestamp("2026-01-01T00:00:00.000Z")).toBe(true);
    expect(isCanonicalTimestamp("2026-01-01")).toBe(false);
    expect(isCanonicalTimestamp("not-a-date")).toBe(false);
  });

  it("normalizes stored booleans from SQLite and Postgres values", () => {
    expect(storedBoolean(true)).toBe(true);
    expect(storedBoolean(1)).toBe(true);
    expect(storedBoolean(false)).toBe(false);
    expect(storedBoolean(0)).toBe(false);
    expect(storedBoolean("1")).toBeNull();
  });
});
