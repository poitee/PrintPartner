import { describe, expect, it } from "vitest";
import { compressRulesFromClientTree, type StlTreeNode } from "./importRulesTree";

function file(path: string, checked: boolean): StlTreeNode {
  return { kind: "file", path, name: path.split("/").pop() ?? path, checked };
}

function folder(path: string, children: StlTreeNode[]): StlTreeNode {
  return { kind: "folder", path, name: path.split("/").pop() ?? path, check_state: "partial", children };
}

describe("compressRulesFromClientTree", () => {
  it("emits a single folder rule when the whole subtree is checked", () => {
    const tree = [
      folder("A", [file("A/1.stl", true), file("A/2.stl", true)]),
    ];
    expect(compressRulesFromClientTree(tree)).toEqual(["A/"]);
  });

  it("does NOT emit the folder rule when a sibling is unchecked (the regression)", () => {
    const tree = [
      folder("A", [
        folder("A/sub", [file("A/sub/keep.stl", true), file("A/sub/drop.stl", false)]),
        file("A/other.stl", true),
      ]),
    ];
    const rules = compressRulesFromClientTree(tree);
    expect(rules).not.toContain("A/");
    expect(rules).toContain("A/sub/keep.stl");
    expect(rules).toContain("A/other.stl");
    expect(rules).not.toContain("A/sub/drop.stl");
    expect(rules).not.toContain("A/sub/");
  });

  it("emits nested folder rule for a fully-checked subfolder under a partial parent", () => {
    const tree = [
      folder("A", [
        folder("A/full", [file("A/full/x.stl", true), file("A/full/y.stl", true)]),
        file("A/loose.stl", false),
      ]),
    ];
    const rules = compressRulesFromClientTree(tree);
    expect(rules).toContain("A/full/");
    expect(rules).not.toContain("A/");
  });

  it("returns no rules when nothing is checked", () => {
    const tree = [folder("A", [file("A/1.stl", false)])];
    expect(compressRulesFromClientTree(tree)).toEqual([]);
  });
});
