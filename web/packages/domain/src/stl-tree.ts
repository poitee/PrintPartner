import { importRulesForProject, pathMatchesRules } from "./import-rules.js";
import { listStlRelativePaths } from "./scanner.js";
import { buildPathTree, iterPathSegments, type PathTreeNode } from "./path-tree.js";

export type StlTreeFileNode = {
  kind: "file";
  path: string;
  name: string;
  checked: boolean;
};

export type StlTreeFolderNode = {
  kind: "folder";
  path: string;
  name: string;
  check_state: "checked" | "unchecked" | "partial";
  children: StlTreeNode[];
};

export type StlTreeNode = StlTreeFileNode | StlTreeFolderNode;

function fileChecked(rel: string, rules: string[] | null): boolean {
  if (rules === null) return true;
  if (!rules.length) return false;
  return pathMatchesRules(rel, rules);
}

function folderCheckState(
  path: string,
  allStls: string[],
  rules: string[] | null,
): "checked" | "unchecked" | "partial" {
  const prefix = path ? `${path}/` : "";
  const under = allStls.filter((f) => f.startsWith(prefix) || (!path && !f.includes("/")));
  if (!under.length) return "unchecked";
  const checked = under.filter((f) => fileChecked(f, rules)).length;
  if (checked === 0) return "unchecked";
  if (checked === under.length) return "checked";
  return "partial";
}

function nodeToDict(node: PathTreeNode, allStls: string[], rules: string[] | null): StlTreeNode[] {
  const out: StlTreeNode[] = [];
  const subKeys = [...node.subdirs.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  for (const seg of subKeys) {
    const sub = node.subdirs.get(seg)!;
    out.push({
      kind: "folder",
      path: sub.path,
      name: sub.name || seg,
      check_state: folderCheckState(sub.path, allStls, rules),
      children: nodeToDict(sub, allStls, rules),
    });
  }
  for (const rel of [...node.files].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
    const [, filename] = iterPathSegments(rel);
    out.push({
      kind: "file",
      path: rel,
      name: filename,
      checked: fileChecked(rel, rules),
    });
  }
  return out;
}

export function buildStlTreePayload(
  repoRoot: string,
  importedPathsRaw: string | null | undefined,
): {
  legacy_import_all: boolean;
  total: number;
  selected: number;
  nodes: StlTreeNode[];
} {
  const rules = importRulesForProject(importedPathsRaw);
  const allStls = listStlRelativePaths(repoRoot);
  const pathRoot = buildPathTree(allStls);
  const nodes = nodeToDict(pathRoot, allStls, rules);
  let selected: number;
  if (rules === null) selected = allStls.length;
  else if (!rules.length) selected = 0;
  else selected = allStls.filter((p) => pathMatchesRules(p, rules)).length;
  return {
    legacy_import_all: rules === null,
    total: allStls.length,
    selected,
    nodes,
  };
}

export function collectCheckedFiles(nodes: StlTreeNode[]): string[] {
  const checked: string[] = [];
  const walk = (items: StlTreeNode[]) => {
    for (const item of items) {
      if (item.kind === "file" && item.checked) checked.push(item.path);
      if (item.kind === "folder") walk(item.children);
    }
  };
  walk(nodes);
  return checked;
}

/**
 * Compress tree nodes into minimal rules. Emits a folder rule only when the whole
 * subtree is checked (`check_state === "checked"`); partial folders recurse so
 * unchecked siblings are never re-included. Unlike `compressRulesFromFiles`, this
 * is total-aware because the tree carries every file under each folder.
 */
export function rulesFromTreeNodes(nodes: StlTreeNode[]): string[] {
  const rules: string[] = [];
  const walk = (items: StlTreeNode[]) => {
    for (const item of items) {
      if (item.kind === "file") {
        if (item.checked) rules.push(item.path);
        continue;
      }
      if (item.check_state === "checked") {
        rules.push(item.path.endsWith("/") ? item.path : `${item.path}/`);
      } else if (item.check_state === "partial") {
        walk(item.children);
      }
    }
  };
  walk(nodes);
  return rules;
}
