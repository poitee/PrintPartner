import type { AppRepository } from "../db/repository.js";
import { loadKitManifest, saveKitManifest } from "../services/kit-manifest-store.js";

export function mergeSuggestedExcludes(
  currentExcludes: readonly string[],
  suggestedExcludes: unknown,
): string[] | null {
  if (!Array.isArray(suggestedExcludes)) return null;

  const excludes = suggestedExcludes.map((value) => String(value).trim()).filter(Boolean);
  if (!excludes.length) return null;

  return [...new Set([...currentExcludes, ...excludes])];
}

/** Merge confirmed Apply-card `suggested_excludes` into kit-manifest exclude. */
export function mergeConfirmedSuggestedExcludes(
  repo: AppRepository,
  planId: number,
  params: Record<string, unknown>,
): string[] | null {
  const current = loadKitManifest(repo, planId);
  const merged = mergeSuggestedExcludes(current.exclude ?? [], params.suggested_excludes);
  if (!merged) return null;

  saveKitManifest(repo, planId, { ...current, exclude: merged });
  return merged;
}
