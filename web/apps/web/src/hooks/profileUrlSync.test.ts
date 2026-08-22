import { describe, expect, it } from "vitest";
import {
  parseProfileParam,
  profileIdFromUrl,
  searchParamsWithProfile,
} from "./profileUrlSync";

describe("parseProfileParam", () => {
  it("parses positive integers", () => {
    expect(parseProfileParam("42")).toBe(42);
  });

  it("rejects invalid values", () => {
    expect(parseProfileParam(null)).toBeNull();
    expect(parseProfileParam("")).toBeNull();
    expect(parseProfileParam("0")).toBeNull();
    expect(parseProfileParam("-1")).toBeNull();
    expect(parseProfileParam("abc")).toBeNull();
  });
});

describe("profileIdFromUrl", () => {
  const valid = [1, 2, 3];

  it("returns url id when it differs from selection", () => {
    expect(profileIdFromUrl(2, valid, 1)).toBe(2);
  });

  it("returns undefined when url matches selection (avoids sync fight)", () => {
    expect(profileIdFromUrl(2, valid, 2)).toBeUndefined();
  });

  it("returns undefined for unknown or missing url ids", () => {
    expect(profileIdFromUrl(null, valid, 1)).toBeUndefined();
    expect(profileIdFromUrl(99, valid, 1)).toBeUndefined();
  });
});

describe("searchParamsWithProfile", () => {
  it("sets profile when selection changes", () => {
    const prev = new URLSearchParams("profile=1");
    const next = searchParamsWithProfile(prev, 2);
    expect(next?.get("profile")).toBe("2");
  });

  it("returns undefined when url already matches selection", () => {
    const prev = new URLSearchParams("profile=2");
    expect(searchParamsWithProfile(prev, 2)).toBeUndefined();
  });

  it("removes profile param when selection is cleared", () => {
    const prev = new URLSearchParams("profile=2&foo=bar");
    const next = searchParamsWithProfile(prev, null);
    expect(next?.has("profile")).toBe(false);
    expect(next?.get("foo")).toBe("bar");
  });

  it("does not loop when user picks a new plan before url catches up", () => {
    const prev = new URLSearchParams("profile=1");
    // State is already 2; url still says 1 — state->url should update, not no-op.
    const next = searchParamsWithProfile(prev, 2);
    expect(next?.get("profile")).toBe("2");
    // After url catches up, further writes are no-ops.
    const settled = new URLSearchParams("profile=2");
    expect(searchParamsWithProfile(settled, 2)).toBeUndefined();
    expect(profileIdFromUrl(2, [1, 2, 3], 2)).toBeUndefined();
  });
});
