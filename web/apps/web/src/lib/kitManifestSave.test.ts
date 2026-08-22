import { describe, expect, it } from "vitest";
import { kitManifestSaveStatusLabel, selectionsEqual } from "./kitManifestSave";

describe("selectionsEqual", () => {
  it("compares selection maps regardless of key order", () => {
    expect(selectionsEqual({ toolhead: "sb", probe: "tap" }, { probe: "tap", toolhead: "sb" })).toBe(
      true,
    );
    expect(selectionsEqual({ toolhead: "sb" }, { toolhead: "stock" })).toBe(false);
  });
});

describe("kitManifestSaveStatusLabel", () => {
  it("shows pending debounce as saving", () => {
    expect(kitManifestSaveStatusLabel("pending")).toBe("Saving…");
  });

  it("shows saving and saved states", () => {
    expect(kitManifestSaveStatusLabel("saving")).toBe("Saving…");
    expect(kitManifestSaveStatusLabel("saved")).toBe("Saved");
  });
});
