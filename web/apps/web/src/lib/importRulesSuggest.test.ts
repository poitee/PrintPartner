import { describe, expect, it } from "vitest";
import type { StlTreeNode } from "../api/importRulesTree";
import { suggestRulesFromTopLevelFolders } from "./importRulesSuggest";

describe("importRulesSuggest", () => {
  it("suggests top-level folders and skips junk", () => {
    const nodes: StlTreeNode[] = [
      { kind: "folder", path: "PrintedParts", name: "PrintedParts", check_state: "unchecked", children: [] },
      { kind: "folder", path: "Library", name: "Library", check_state: "unchecked", children: [] },
      { kind: "folder", path: ".github", name: ".github", check_state: "unchecked", children: [] },
      { kind: "folder", path: "STLs", name: "STLs", check_state: "unchecked", children: [] },
    ];
    expect(suggestRulesFromTopLevelFolders(nodes)).toEqual([
      "PrintedParts/",
      "STLs/",
    ]);
  });
});
