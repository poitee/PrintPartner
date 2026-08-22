import { unlinkSync } from "node:fs";
import type { AppRepository } from "../db/repository.js";
import {
  cachedPngIfExists,
  globalPreviewPath,
  globalThumbnailPath,
} from "../lib/thumbnails.js";
import { resolvePartFilamentHex } from "./filament-catalog.js";
import { resolvePartStl } from "./part-paths.js";
import { normalizePartRole } from "./role-filament.js";

function unlinkCachedPng(path: string): boolean {
  if (!cachedPngIfExists(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Remove cached thumbnail/preview PNGs for one STL at specific filament colors. */
export function clearPartThumbnailCacheAtHexes(
  thumbsDir: string,
  stlPath: string,
  role: string,
  hexes: Iterable<string | null | undefined>,
): number {
  const roleKey = role || "primary";
  const seen = new Set<string>();
  let cleared = 0;
  for (const hex of hexes) {
    const colorKey = hex?.trim().replace(/^#/, "").toLowerCase() ?? "";
    if (seen.has(colorKey)) continue;
    seen.add(colorKey);
    const meshHex = colorKey ? `#${colorKey}` : null;
    for (const path of [
      globalThumbnailPath(thumbsDir, stlPath, roleKey, meshHex),
      globalPreviewPath(thumbsDir, stlPath, roleKey, meshHex),
    ]) {
      if (unlinkCachedPng(path)) cleared += 1;
    }
  }
  return cleared;
}

/**
 * Remove cached thumbnail/preview PNGs for parts in a plan so the next request
 * re-renders from the current filament colors.
 */
export function clearPlanThumbnailCache(
  repo: AppRepository,
  thumbsDir: string,
  profileId: number,
  opts?: { role?: string },
): number {
  const targetRole = opts?.role != null ? normalizePartRole(opts.role) : null;
  let cleared = 0;
  for (const part of repo.getProfilePartRows(profileId)) {
    if (targetRole != null && normalizePartRole(part.role) !== targetRole) continue;
    const stl = resolvePartStl(repo, part);
    if (!stl) continue;
    const hex = resolvePartFilamentHex(part);
    cleared += clearPartThumbnailCacheAtHexes(thumbsDir, stl, part.role || "primary", [hex]);
  }
  return cleared;
}
