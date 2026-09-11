import { describe, expect, it } from "vitest";
import { filenameGroupingSchema, filenameGroupKey, filenameGroupFolderName, matchFilenameGroup, miloFilenameGrouping } from "./filename-grouping.js";

describe("filename grouping", () => {
  it("preserves distinct Unicode group folders", () => {
    const definition = filenameGroupingSchema.parse({ name: "設定", rules: [{ suffix: "-A", group: "日本" }, { suffix: "-S", group: "構造" }] });
    expect(definition.rules.map((rule) => filenameGroupFolderName(rule.group))).toEqual(["日本", "構造"]);
  });
  it.each([["[a]-mount-S.stl", "Structural"], ["mount-SS.STL", "Semi-structural"], ["[a]-cover-A.stl", "Aesthetic"], ["mount.stl", "Unassigned"]])("matches %s independently of accent", (path, group) => {
    expect(matchFilenameGroup(miloFilenameGrouping, path, "base")).toBe(group);
  });
  it("detects overlaps and gives explicit source-scoped overrides precedence", () => {
    const definition = { ...miloFilenameGrouping, rules: [...miloFilenameGrouping.rules, { suffix: "S", group: "Other" }], overrides: { [filenameGroupKey("base", "mount-S.stl")]: "Structural" } };
    expect(matchFilenameGroup(definition, "mount-S.stl", "base")).toBe("Structural");
    expect(matchFilenameGroup(definition, "mount-S.stl", "other")).toBe("Conflict");
  });
  it("rejects unsafe and colliding folder names", () => {
    expect(filenameGroupingSchema.safeParse({ ...miloFilenameGrouping, rules: [{ suffix: "S", group: "../bad" }] }).success).toBe(false);
    expect(filenameGroupingSchema.safeParse({ ...miloFilenameGrouping, rules: [{ suffix: "S", group: "a b" }, { suffix: "A", group: "a_b" }] }).success).toBe(false);
  });
});
