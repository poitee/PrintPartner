import { describe, expect, it } from "vitest";
import { DEFAULT_STL_NAMING_PROFILE } from "@print-partner/contracts";
import { sourceNamingDirty } from "./sourceDetailModel";

const base = {
  useDefaults: true,
  savedUseDefaults: true,
  overrideDraft: DEFAULT_STL_NAMING_PROFILE,
  globalNaming: DEFAULT_STL_NAMING_PROFILE,
  savedOverride: {},
};

describe("sourceNamingDirty", () => {
  it("detects default mode changes", () => {
    expect(sourceNamingDirty(base)).toBe(false);
    expect(sourceNamingDirty({ ...base, useDefaults: false })).toBe(true);
  });

  it("ignores override draft while defaults are active", () => {
    expect(
      sourceNamingDirty({
        ...base,
        overrideDraft: {
          ...DEFAULT_STL_NAMING_PROFILE,
          quantity: { ...DEFAULT_STL_NAMING_PROFILE.quantity, regex: "changed" },
        },
      }),
    ).toBe(false);
  });

  it("detects override edits against the saved merged profile", () => {
    expect(
      sourceNamingDirty({
        ...base,
        useDefaults: false,
        savedUseDefaults: false,
        overrideDraft: DEFAULT_STL_NAMING_PROFILE,
      }),
    ).toBe(false);
    expect(
      sourceNamingDirty({
        ...base,
        useDefaults: false,
        savedUseDefaults: false,
        overrideDraft: {
          ...DEFAULT_STL_NAMING_PROFILE,
          quantity: { ...DEFAULT_STL_NAMING_PROFILE.quantity, regex: "changed" },
        },
      }),
    ).toBe(true);
  });
});
