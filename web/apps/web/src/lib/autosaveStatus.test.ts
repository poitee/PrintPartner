import { describe, expect, it } from "vitest";
import { autosaveStatusLabel, shouldShowAutosaveRetry } from "./autosaveStatus";

describe("autosaveStatusLabel", () => {
  it("shows saving and saved messages", () => {
    expect(autosaveStatusLabel("saving")).toBe("Saving…");
    expect(autosaveStatusLabel("saved")).toBe("Saved");
  });

  it("shows retry guidance on error", () => {
    expect(autosaveStatusLabel("error")).toBe("Save failed — retry");
  });

  it("shows pending debounce as saving", () => {
    expect(autosaveStatusLabel("pending")).toBe("Saving…");
  });

  it("hides label when idle", () => {
    expect(autosaveStatusLabel("idle")).toBeNull();
  });
});

describe("shouldShowAutosaveRetry", () => {
  it("only shows retry on error", () => {
    expect(shouldShowAutosaveRetry("error")).toBe(true);
    expect(shouldShowAutosaveRetry("saved")).toBe(false);
    expect(shouldShowAutosaveRetry("saving")).toBe(false);
  });
});
