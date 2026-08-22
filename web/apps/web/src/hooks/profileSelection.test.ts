import { describe, expect, it } from "vitest";
import {
  reconcileSelectedProfileId,
  shouldBlockUrlProfileSync,
} from "./profileSelection";

describe("reconcileSelectedProfileId", () => {
  it("clears selection when the list becomes empty", () => {
    expect(reconcileSelectedProfileId([], 3, [3])).toBeNull();
    expect(reconcileSelectedProfileId([], null, [])).toBeUndefined();
  });

  it("picks the first plan when nothing is selected", () => {
    expect(reconcileSelectedProfileId([1, 2], null, [])).toBe(1);
  });

  it("keeps a selection that still exists", () => {
    expect(reconcileSelectedProfileId([1, 2], 2, [1, 2])).toBeUndefined();
  });

  it("falls back after a known plan is deleted", () => {
    expect(reconcileSelectedProfileId([1], 2, [1, 2])).toBe(1);
  });

  it("falls back on first hydrate with a stale stored id", () => {
    expect(reconcileSelectedProfileId([1, 2], 99, [])).toBe(1);
  });

  it("keeps a newly created selection until the list catches up", () => {
    expect(reconcileSelectedProfileId([1], 42, [1])).toBeUndefined();
  });
});

describe("shouldBlockUrlProfileSync", () => {
  it("blocks stale URL while local selection is pending", () => {
    expect(shouldBlockUrlProfileSync(1, 42, 42)).toBe(true);
  });

  it("does not block once the URL matches the pending selection", () => {
    expect(shouldBlockUrlProfileSync(42, 42, 42)).toBe(false);
  });

  it("does not block when nothing is pending", () => {
    expect(shouldBlockUrlProfileSync(1, null, 42)).toBe(false);
  });

  it("does not block when selection drifted away from pending", () => {
    expect(shouldBlockUrlProfileSync(1, 42, 1)).toBe(false);
  });
});
