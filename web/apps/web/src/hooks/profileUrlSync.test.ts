import { describe, expect, it } from "vitest";
import {
  parseProfileParam,
  searchParamsWithProfile,
  shouldSyncProfileToPath,
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

describe("shouldSyncProfileToPath", () => {
  it("keeps global Production independent from the selected build", () => {
    expect(shouldSyncProfileToPath("/production")).toBe(false);
    expect(shouldSyncProfileToPath("/export")).toBe(true);
  });

  it("does not compete with the legacy studio redirect", () => {
    expect(shouldSyncProfileToPath("/plans/2/studio")).toBe(false);
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
    // State is already 2 while the URL still says 1. State-to-URL sync must update it.
    const next = searchParamsWithProfile(prev, 2);
    expect(next?.get("profile")).toBe("2");
    // After url catches up, further writes are no-ops.
    const settled = new URLSearchParams("profile=2");
    expect(searchParamsWithProfile(settled, 2)).toBeUndefined();
  });
});
