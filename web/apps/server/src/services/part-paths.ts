import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { safeRepoPath } from "@print-partner/domain";
import type { AppRepository, PartDbRow } from "../db/repository.js";

export type ProfileStlIndex = {
  byLayer: Map<string, string>;
  fallbackRoots: string[];
};

function resolvedRepoFile(repoRoot: string, path: string): string | null {
  try {
    const root = realpathSync(resolve(repoRoot));
    const file = realpathSync(resolve(path));
    const relativePath = relative(root, file);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath) ||
      !statSync(file).isFile()
    ) {
      return null;
    }
    return file;
  } catch {
    return null;
  }
}

/** Case-insensitive path walk for Linux Docker volumes (macOS dev may differ). */
export function resolveCaseInsensitiveRepoPath(
  repoRoot: string,
  relativePath: string,
): string | null {
  const segments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!segments.length) return null;
  let current = resolve(repoRoot);
  for (const segment of segments) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return null;
    }
    const match = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
    if (!match) return null;
    current = join(current, match);
  }
  return resolvedRepoFile(repoRoot, current);
}

export function resolveRepoStlPath(repoRoot: string, relativePath: string): string | null {
  const exact = safeRepoPath(repoRoot, relativePath);
  const resolvedExact = exact ? resolvedRepoFile(repoRoot, exact) : null;
  if (resolvedExact) return resolvedExact;
  return resolveCaseInsensitiveRepoPath(repoRoot, relativePath);
}

export function buildProfileStlIndex(repo: AppRepository, profileId: number): ProfileStlIndex {
  const byLayer = new Map<string, string>();
  const fallbackRoots: string[] = [];
  const seen = new Set<string>();

  const acceptedRoots = repo.getAcceptedProfileStlRoots(profileId);
  if (acceptedRoots) {
    for (const accepted of acceptedRoots) {
      byLayer.set(accepted.sourceLayer, accepted.rootPath);
      if (!seen.has(accepted.rootPath)) {
        seen.add(accepted.rootPath);
        fallbackRoots.push(accepted.rootPath);
      }
    }
    return { byLayer, fallbackRoots };
  }

  for (const layer of repo.getProfileLayers(profileId)) {
    if (!layer.project_id) continue;
    const proj = repo.getProjectRow(layer.project_id);
    if (!proj?.localPath) continue;
    const label = `${layer.layer_type}:${layer.project_name ?? layer.project_id}`;
    byLayer.set(label, proj.localPath);
    if (!seen.has(proj.localPath)) {
      seen.add(proj.localPath);
      fallbackRoots.push(proj.localPath);
    }
  }
  return { byLayer, fallbackRoots };
}

export function resolvePartStlPath(part: PartDbRow, index: ProfileStlIndex): string | null {
  if (part.sourceLayer && index.byLayer.has(part.sourceLayer)) {
    const safe = resolveRepoStlPath(index.byLayer.get(part.sourceLayer)!, part.relativePath);
    if (safe) return safe;
  }
  for (const root of index.fallbackRoots) {
    const safe = resolveRepoStlPath(root, part.relativePath);
    if (safe) return safe;
  }
  return null;
}

export function resolvePartStl(repo: AppRepository, part: PartDbRow): string | null {
  return resolvePartStlPath(part, buildProfileStlIndex(repo, part.profileId));
}
