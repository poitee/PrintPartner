/** Build nested directory trees from relative file paths (ported from Python path_tree.py). */

export type PathTreeNode = {
  name: string;
  path: string;
  subdirs: Map<string, PathTreeNode>;
  files: string[];
};

export function iterPathSegments(relativePath: string): [string[], string] {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return [[], ""];
  const parts = normalized.split("/");
  if (parts.length === 1) return [[], parts[0]];
  return [parts.slice(0, -1), parts.at(-1) ?? ""];
}

function ensureSubdir(parent: PathTreeNode, segment: string): PathTreeNode {
  const path = parent.path ? `${parent.path}/${segment}` : segment;
  let sub = parent.subdirs.get(segment);
  if (!sub) {
    sub = { name: segment, path, subdirs: new Map(), files: [] };
    parent.subdirs.set(segment, sub);
  }
  return sub;
}

export function buildPathTree(relativePaths: string[]): PathTreeNode {
  const root: PathTreeNode = { name: "", path: "", subdirs: new Map(), files: [] };
  for (const rel of relativePaths) {
    const [dirParts] = iterPathSegments(rel);
    let parent = root;
    for (const seg of dirParts) {
      parent = ensureSubdir(parent, seg);
    }
    parent.files.push(rel);
  }
  return root;
}
