import { describe, expect, it } from "vitest";
import {
  parseImportRulesJson,
  pathMatchesRules,
  serializeImportRules,
} from "./import-rules.js";

describe("import-rules", () => {
  it("matches file and folder rules", () => {
    const rules = ["parts/accent/", "frame.stl"];
    expect(pathMatchesRules("parts/accent/bracket.stl", rules)).toBe(true);
    expect(pathMatchesRules("frame.stl", rules)).toBe(true);
    expect(pathMatchesRules("parts/primary/block.stl", rules)).toBe(false);
  });

  it("parses legacy null", () => {
    expect(parseImportRulesJson(null)).toBeNull();
  });

  it("parses empty opt-in", () => {
    expect(parseImportRulesJson("[]")).toEqual([]);
  });

  it("serializes roundtrip", () => {
    const raw = serializeImportRules(["parts/a/", "b.stl"]);
    expect(parseImportRulesJson(raw)).toEqual(["parts/a/", "b.stl"]);
  });
});
