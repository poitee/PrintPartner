import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolvedFileUnderRoot } from "./secure-path.js";

const README_NAMES = ["README.md", "readme.md", "Readme.md"] as const;

export function findReadme(repoPath: string): string | null {
  const root = resolve(repoPath);
  for (const name of README_NAMES) {
    const candidate = resolvedFileUnderRoot(root, join(root, name));
    if (candidate) return candidate;
  }
  return null;
}

export function readReadmeText(repoPath: string): string | null {
  const readme = findReadme(repoPath);
  if (!readme) return null;
  try {
    return readFileSync(readme, "utf8");
  } catch {
    return null;
  }
}
