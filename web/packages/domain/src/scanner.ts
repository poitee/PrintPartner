/** Walk repo directories and collect STL parts (ported from Python scanner.py). */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathMatchesRules } from "./import-rules.js";
import { parseStlPath } from "./parsers.js";
import type { NamingProfile } from "./stl-naming.js";

export type ScannedPart = {
  relativePath: string;
  filename: string;
  matchKey: string;
  partSlug: string;
  role: string;
  quantity: number;
  absolutePath: string;
};

export function normalizeMatchKey(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").toLowerCase().replace(/^\/+|\/+$/g, "");
}

export function safeRepoPath(repoRoot: string, relativePath: string): string | null {
  try {
    const root = resolve(repoRoot);
    const candidate = resolve(root, relativePath);
    if (!candidate.startsWith(root + "/") && candidate !== root) return null;
    return candidate;
  } catch {
    return null;
  }
}

function walkStlFiles(dir: string, root: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkStlFiles(full, root, out);
    } else if (st.isFile() && name.toLowerCase().endsWith(".stl")) {
      out.push(full);
    }
  }
}

export function scanRepo(
  repoRoot: string,
  sourceLayer = "base",
  importRules: string[] | null = null,
  namingProfile?: NamingProfile | null,
): ScannedPart[] {
  void sourceLayer;
  let root: string;
  try {
    root = resolve(repoRoot);
    const st = statSync(root);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }

  const stlPaths: string[] = [];
  walkStlFiles(root, root, stlPaths);

  const parts: ScannedPart[] = [];
  for (const stl of stlPaths) {
    const rel = stl.slice(root.length + 1).replace(/\\/g, "/");
    if (importRules != null && !pathMatchesRules(rel, importRules)) continue;
    const parsed = parseStlPath(rel, namingProfile);
    parts.push({
      relativePath: rel,
      filename: parsed.filename,
      matchKey: normalizeMatchKey(rel),
      partSlug: parsed.partSlug,
      role: parsed.role,
      quantity: parsed.quantity,
      absolutePath: stl,
    });
  }

  return parts.sort((a, b) => a.matchKey.localeCompare(b.matchKey));
}

export function listStlRelativePaths(repoRoot: string): string[] {
  let root: string;
  try {
    root = resolve(repoRoot);
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  const stlPaths: string[] = [];
  walkStlFiles(root, root, stlPaths);
  return stlPaths
    .map((p) => p.slice(root.length + 1).replace(/\\/g, "/"))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
