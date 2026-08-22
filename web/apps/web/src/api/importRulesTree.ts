import { fetchStlTree, type StlTreeNode } from "./engine";

export { fetchStlTree };
export type { StlTreeNode };

export function collectCheckedFiles(nodes: StlTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (items: StlTreeNode[]) => {
    for (const item of items) {
      if (item.kind === "file" && item.checked) out.push(item.path);
      else if (item.kind === "folder") walk(item.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Compress a checkbox tree into minimal import rules for PUT import-rules.
 *
 * Walks the tree (which knows every file under each folder, checked or not) so a
 * folder rule is emitted ONLY when the whole subtree is selected. Partial folders
 * recurse; checked leaf files are emitted individually. This is the correct,
 * total-aware version — `compressRulesFromFiles` cannot tell a full folder from a
 * partial one because it only sees the checked subset.
 */
export function compressRulesFromClientTree(nodes: StlTreeNode[]): string[] {
  const rules: string[] = [];
  const walk = (items: StlTreeNode[]) => {
    for (const item of items) {
      if (item.kind === "file") {
        if (item.checked) rules.push(item.path);
        continue;
      }
      const state = folderCheckState(item.children);
      if (state === "checked") {
        rules.push(item.path.endsWith("/") ? item.path : `${item.path}/`);
      } else if (state === "partial") {
        walk(item.children);
      }
    }
  };
  walk(nodes);
  return rules;
}

export function compressRulesFromFiles(checkedFiles: string[]): string[] {
  const allFiles = new Set(checkedFiles);
  if (allFiles.size === 0) return [];

  const dirPrefixes = new Set<string>();
  for (const f of allFiles) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirPrefixes.add(parts.slice(0, i).join("/"));
    }
  }

  const rules: string[] = [];
  const used = new Set<string>();
  const sorted = [...dirPrefixes].sort(
    (a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b),
  );

  for (const prefix of sorted) {
    const prefixFiles = [...allFiles].filter((f) => f.startsWith(`${prefix}/`));
    if (prefixFiles.length === 0) continue;
    if (prefixFiles.every((f) => used.has(f))) continue;
    if (prefixFiles.every((f) => allFiles.has(f))) {
      rules.push(`${prefix}/`);
      for (const f of prefixFiles) used.add(f);
    }
  }

  for (const f of [...allFiles].sort()) {
    if (!used.has(f)) rules.push(f);
  }
  return rules;
}

export function folderCheckState(children: StlTreeNode[]): "checked" | "unchecked" | "partial" {
  let checked = 0;
  let total = 0;
  const walk = (items: StlTreeNode[]) => {
    for (const item of items) {
      if (item.kind === "file") {
        total += 1;
        if (item.checked) checked += 1;
      } else {
        const state = folderCheckState(item.children);
        total += 1;
        if (state === "checked") checked += 1;
        else if (state === "partial") {
          checked += 0.5;
        }
      }
    }
  };
  walk(children);
  if (total === 0) return "unchecked";
  if (checked === 0) return "unchecked";
  if (checked === total) return "checked";
  return "partial";
}

export function setFolderChecked(nodes: StlTreeNode[], folderPath: string, checked: boolean): StlTreeNode[] {
  return nodes.map((n) => {
    if (n.kind === "folder") {
      if (n.path === folderPath) {
        return {
          ...n,
          check_state: checked ? "checked" : "unchecked",
          children: setAllChecked(n.children, checked),
        };
      }
      return { ...n, children: setFolderChecked(n.children, folderPath, checked) };
    }
    return n;
  });
}

export function setFileChecked(
  nodes: StlTreeNode[],
  filePath: string,
  checked: boolean,
): StlTreeNode[] {
  return nodes.map((n) => {
    if (n.kind === "file") {
      return n.path === filePath ? { ...n, checked } : n;
    }
    return { ...n, children: setFileChecked(n.children, filePath, checked) };
  });
}

export function setAllChecked(nodes: StlTreeNode[], checked: boolean): StlTreeNode[] {
  return nodes.map((n) => {
    if (n.kind === "file") return { ...n, checked };
    return {
      ...n,
      check_state: checked ? "checked" : "unchecked",
      children: setAllChecked(n.children, checked),
    };
  });
}

export function refreshFolderStates(nodes: StlTreeNode[]): StlTreeNode[] {
  return nodes.map((n) => {
    if (n.kind === "file") return n;
    const children = refreshFolderStates(n.children);
    return { ...n, children, check_state: folderCheckState(children) };
  });
}

export function nodeMatchesFilter(node: StlTreeNode, needle: string): boolean {
  if (!needle) return true;
  if (node.path.toLowerCase().includes(needle)) return true;
  if (node.kind === "folder") {
    return node.children.some((c) => nodeMatchesFilter(c, needle));
  }
  return false;
}

export function collectVisibleFilePaths(nodes: StlTreeNode[], filter: string): string[] {
  const needle = filter.trim().toLowerCase();
  const out: string[] = [];
  const walk = (items: StlTreeNode[]) => {
    for (const item of items) {
      if (item.kind === "file") {
        if (!needle || item.path.toLowerCase().includes(needle)) out.push(item.path);
      } else if (nodeMatchesFilter(item, needle)) {
        walk(item.children);
      }
    }
  };
  walk(nodes);
  return out;
}

export function setFilesChecked(
  nodes: StlTreeNode[],
  paths: Set<string>,
  checked: boolean,
): StlTreeNode[] {
  return nodes.map((n) => {
    if (n.kind === "file") {
      return paths.has(n.path) ? { ...n, checked } : n;
    }
    return { ...n, children: setFilesChecked(n.children, paths, checked) };
  });
}

export type ImportRulesSort = "path" | "name";

export function sortTreeNodes(nodes: StlTreeNode[], sortBy: ImportRulesSort): StlTreeNode[] {
  const sorted = [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    const aKey = a.kind === "file" ? (sortBy === "name" ? a.name : a.path) : a.path;
    const bKey = b.kind === "file" ? (sortBy === "name" ? b.name : b.path) : b.path;
    return aKey.localeCompare(bKey);
  });
  return sorted.map((n) =>
    n.kind === "folder" ? { ...n, children: sortTreeNodes(n.children, sortBy) } : n,
  );
}
