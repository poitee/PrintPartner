/** Layered merge engine for build profiles (ported from Python merge.py). */

import { parsePartSlug } from "./parsers.js";
import { normalizeMatchKey, type ScannedPart } from "./scanner.js";
import type { NamingProfile } from "./stl-naming.js";

export type MergePart = {
  matchKey: string;
  relativePath: string;
  filename: string;
  sourceLayer: string;
  status: string;
  role: string;
  quantityAuto: number;
  partSlug: string;
  included: boolean;
  quantityOverride: number | null;
  notes: string;
  geometrySame: boolean | null;
  absolutePath: string | null;
};

export type MergeResult = {
  parts: MergePart[];
  duplicateHints: Array<[string, string, number]>;
};

export function quantityEffective(part: MergePart): number {
  return part.quantityOverride ?? part.quantityAuto;
}

export type SlugConflictPart = {
  matchKey: string;
  relativePath: string;
  filename: string;
  included: boolean;
  partSlug?: string;
};

/** Desk-loop issue text: resolve by excluding on Plan source cards (not Parts/Review). */
export function mergeConflictIssueMessage(filename: string): string {
  return `Merge conflict for ${filename} — exclude duplicates on the Plan source cards.`;
}

/** Included parts that share a slug but not the same match key (active merge conflicts). */
export function findActiveSlugConflictKeys(
  parts: SlugConflictPart[],
  profile?: NamingProfile | null,
): Set<string> {
  const slugIndex = new Map<string, string>();
  const conflictKeys = new Set<string>();

  for (const part of parts) {
    if (!part.included) continue;
    const slug =
      part.partSlug?.trim() ||
      parsePartSlug(part.relativePath || part.filename, profile);
    const key = part.matchKey;
    const otherKey = slugIndex.get(slug);
    if (otherKey && otherKey !== key) {
      conflictKeys.add(key);
      conflictKeys.add(otherKey);
    } else if (!otherKey) {
      slugIndex.set(slug, key);
    }
  }

  return conflictKeys;
}

function scannedToMerge(part: ScannedPart, status: string, source: string): MergePart {
  return {
    matchKey: part.matchKey,
    relativePath: part.relativePath,
    filename: part.filename,
    sourceLayer: source,
    status,
    role: part.role,
    quantityAuto: part.quantity,
    partSlug: part.partSlug,
    absolutePath: part.absolutePath,
    included: true,
    quantityOverride: null,
    notes: "",
    geometrySame: null,
  };
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function fuzzRatio(a: string, b: string): number {
  const s1 = a.toLowerCase();
  const s2 = b.toLowerCase();
  const longer = s1.length >= s2.length ? s1 : s2;
  const shorter = s1.length >= s2.length ? s2 : s1;
  if (longer.length === 0) return 100;
  const dist = levenshtein(longer, shorter);
  return Math.round(((longer.length - dist) / longer.length) * 100);
}

function findDuplicateHints(parts: MergePart[], threshold = 85): Array<[string, string, number]> {
  const hints: Array<[string, string, number]> = [];
  const slugs = parts.filter((p) => p.included).map((p) => [p.partSlug, p.matchKey] as const);
  const seen = new Set<string>();
  for (let i = 0; i < slugs.length; i++) {
    const [slugA, keyA] = slugs[i];
    for (let j = i + 1; j < slugs.length; j++) {
      const [slugB, keyB] = slugs[j];
      if (slugA === slugB && keyA !== keyB) continue;
      const score = fuzzRatio(slugA, slugB);
      if (score >= threshold) {
        const pair = [keyA, keyB].sort().join("|");
        if (!seen.has(pair)) {
          seen.add(pair);
          hints.push([keyA, keyB, score]);
        }
      }
    }
  }
  return hints;
}

export function mergeLayers(
  layerScans: Array<[string, ScannedPart[]]>,
  existing: Record<string, MergePart> | null = null,
  options?: { geometryCompare?: boolean },
): MergeResult {
  void options?.geometryCompare;
  const prior = existing ?? {};
  const merged: Record<string, MergePart> = {};
  const slugIndex: Record<string, string> = {};

  for (let layerIdx = 0; layerIdx < layerScans.length; layerIdx++) {
    const [layerName, scanned] = layerScans[layerIdx];
    const isBase = layerIdx === 0;
    for (const part of scanned) {
      const key = normalizeMatchKey(part.relativePath);
      const prev = merged[key];
      const oldPrior = prior[key];

      let status: string;
      if (prev == null && !isBase) status = "added";
      else if (prev == null) status = "base";
      else status = "replaced";

      const mp = scannedToMerge(part, status, layerName);
      if (oldPrior) {
        mp.quantityOverride = oldPrior.quantityOverride;
        mp.notes = oldPrior.notes;
        mp.included = oldPrior.included;
        if (!oldPrior.included) mp.status = "excluded";
      }

      merged[key] = mp;

      const otherKey = slugIndex[part.partSlug];
      if (otherKey && otherKey !== key) {
        merged[key].status = "conflict";
        if (merged[otherKey]) merged[otherKey].status = "conflict";
      } else {
        slugIndex[part.partSlug] = key;
      }
    }
  }

  const parts = Object.values(merged);
  return { parts, duplicateHints: findDuplicateHints(parts) };
}

export class MergeWouldWipeProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeWouldWipeProfileError";
  }
}

export type PartProgressRow = {
  id: number;
  unitIndex: number;
  completed: boolean;
};

export function saveMergeResultPlan(
  existingParts: MergePart[],
  result: MergeResult,
): MergePart[] {
  if (!result.parts.length && existingParts.length) {
    throw new MergeWouldWipeProfileError(
      "Scan found no STL files (check Projects → Import files… for each repo). Existing parts were not removed.",
    );
  }
  const existingByKey = new Map(existingParts.map((p) => [p.matchKey, p]));
  const newKeys = new Set(result.parts.map((p) => p.matchKey));
  const out: MergePart[] = [];

  for (const mp of result.parts) {
    const prior = existingByKey.get(mp.matchKey);
    if (prior) {
      mp.quantityOverride = prior.quantityOverride;
      mp.notes = prior.notes || mp.notes;
      mp.included = prior.included;
    }
    out.push(mp);
  }

  void newKeys;
  return out;
}
