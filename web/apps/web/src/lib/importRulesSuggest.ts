import type { StlTreeNode } from "../api/importRulesTree";

/** Top-level folder names excluded from import-rule suggestions. */
export const IMPORT_RULE_JUNK_FOLDERS = new Set([
  "library",
  "manual",
  ".github",
  "images",
  "img",
  "assets",
  "docs",
  "documentation",
  ".git",
  ".vscode",
  ".idea",
  "node_modules",
]);

/** Suggest folder-prefix import rules from top-level STL tree folders. */
export function suggestRulesFromTopLevelFolders(nodes: StlTreeNode[]): string[] {
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== "folder") continue;
    const name = (node.path.split("/")[0] || node.name || "").trim();
    const key = name.toLowerCase();
    if (!name || IMPORT_RULE_JUNK_FOLDERS.has(key)) continue;
    const rule = node.path ? `${node.path.replace(/\\/g, "/")}/` : `${name}/`;
    if (!seen.has(rule)) {
      seen.add(rule);
      rules.push(rule);
    }
  }
  return rules.sort((a, b) => a.localeCompare(b));
}
