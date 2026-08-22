import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { safeRepoPath } from "@print-partner/domain";
import type { AppRepository, PartDbRow } from "../db/repository.js";

export type ProfileStlIndex = {
  byLayer: Map<string, string>;
  fallbackRoots: string[];
};

/** Case-insensitive path walk for Linux Docker volumes (macOS dev may differ). */
export function resolveCaseInsensitiveRepoPath(
  repoRoot: string,
  relativePath: string,
): string | null {
  const segments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!segments.length) return null;
  let current = resolve(repoRoot);
  const root = current;
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
  try {
    if (!statSync(current).isFile()) return null;
    if (!current.startsWith(root + "/") && current !== root) return null;
    return current;
  } catch {
    return null;
  }
}

export function resolveRepoStlPath(repoRoot: string, relativePath: string): string | null {
  const exact = safeRepoPath(repoRoot, relativePath);
  if (exact && existsSync(exact)) return exact;
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
