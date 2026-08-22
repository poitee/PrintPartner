import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const README_NAMES = ["README.md", "readme.md", "Readme.md"] as const;

export function findReadme(repoPath: string): string | null {
  for (const name of README_NAMES) {
    const candidate = join(repoPath, name);
    if (existsSync(candidate)) return candidate;
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
