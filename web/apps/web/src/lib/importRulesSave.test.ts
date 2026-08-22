import { describe, expect, it } from "vitest";
import {
  importRulesSaveStatusLabel,
  rulesEqual,
  shouldShowImportRulesRetry,
} from "./importRulesSave";

describe("rulesEqual", () => {
  it("compares rule lists regardless of order", () => {
    expect(rulesEqual(["b/", "a.stl"], ["a.stl", "b/"])).toBe(true);
  });

  it("treats folder rules with and without trailing slash as equal", () => {
    expect(rulesEqual(["parts/a"], ["parts/a/"])).toBe(true);
  });

  it("detects different rules", () => {
    expect(rulesEqual(["a.stl"], ["b.stl"])).toBe(false);
    expect(rulesEqual(["a.stl"], ["a.stl", "b.stl"])).toBe(false);
  });
});

describe("importRulesSaveStatusLabel", () => {
  it("shows saving and saved messages", () => {
    expect(importRulesSaveStatusLabel("saving")).toBe("Saving…");
    expect(importRulesSaveStatusLabel("saved")).toBe("Saved");
  });

  it("shows retry guidance on error", () => {
    expect(importRulesSaveStatusLabel("error")).toBe("Save failed — retry");
  });

  it("shows pending debounce as saving", () => {
    expect(importRulesSaveStatusLabel("pending")).toBe("Saving…");
  });

  it("hides label when idle", () => {
    expect(importRulesSaveStatusLabel("idle")).toBeNull();
  });
});

describe("shouldShowImportRulesRetry", () => {
  it("only shows retry on error", () => {
    expect(shouldShowImportRulesRetry("error")).toBe(true);
    expect(shouldShowImportRulesRetry("saved")).toBe(false);
    expect(shouldShowImportRulesRetry("saving")).toBe(false);
  });
});
