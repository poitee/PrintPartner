import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { safeRepoPath } from "@print-partner/domain";
import type { AppRepository } from "../db/repository.js";
import type { PlanSnapshotPart } from "./plan-drafts.js";
import { loadKitManifest } from "./kit-manifest-store.js";
import { findEditableSourceManifestPath } from "./source-workspace.js";

export const CANONICAL_MANIFEST = "print-partner.manifest.yaml";

export function matchKeyMatches(pattern: string, matchKey: string): boolean {
  const pat = pattern.replace(/\\/g, "/").toLowerCase().trim();
  const key = matchKey.replace(/\\/g, "/").toLowerCase().trim();
  if (pat === key) return true;
  const re = globToRegExp(pat);
  if (re.test(key)) return true;
  if (!pat.includes("/") && key.includes("/")) {
    return re.test(key.split("/").pop() ?? key);
  }
  return false;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export type ManifestVariant = {
  id: string;
  label?: string | null;
  parts: string[];
  excludes?: string[];
};

export type ManifestOptionGroup = {
  rule: string;
  label?: string | null;
  parts: string[];
  variants: ManifestVariant[];
  min?: number | null;
  max?: number | null;
};

export type ManifestPartRule = {
  match: string;
  requirement?: string;
  option_group?: string;
  default_included?: boolean;
};

export type ManifestDoc = {
  project?: string;
  parts?: ManifestPartRule[];
  addons?: Array<{ parts?: ManifestPartRule[]; project?: string; source_id?: string }>;
  option_groups?: Record<string, ManifestOptionGroup>;
  selections?: Record<string, string>;
  variant_dimensions?: Record<string, Array<string | number>>;
};

function parseStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x));
}

function parseVariants(raw: unknown): ManifestVariant[] {
  if (!Array.isArray(raw)) return [];
  const out: ManifestVariant[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = String(row.id ?? "").trim();
    if (!id) continue;
    out.push({
      id,
      label: row.label != null ? String(row.label) : null,
      parts: parseStringList(row.parts),
      excludes: parseStringList(row.excludes),
    });
  }
  return out;
}

function parseOptionGroups(raw: unknown): Record<string, ManifestOptionGroup> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ManifestOptionGroup> = {};
  for (const [gid, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    out[gid] = {
      rule: String(row.rule ?? "pick_one"),
      label: row.label != null ? String(row.label) : null,
      parts: parseStringList(row.parts),
      variants: parseVariants(row.variants),
      min: row.min != null ? Number(row.min) : null,
      max: row.max != null ? Number(row.max) : null,
    };
  }
  return out;
}

function parsePartRules(raw: unknown): ManifestPartRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: ManifestPartRule[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") rules.push({ match: entry });
    else if (entry && typeof entry === "object" && "match" in entry) {
      const e = entry as Record<string, unknown>;
      rules.push({
        match: String(e.match),
        requirement: e.requirement != null ? String(e.requirement) : undefined,
        option_group: e.option_group != null ? String(e.option_group) : undefined,
        default_included:
          e.default_included != null ? Boolean(e.default_included) : undefined,
      });
    }
  }
  return rules;
}

function parseVariantDimensions(raw: unknown): Record<string, Array<string | number>> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, Array<string | number>> = {};
  for (const [dim, values] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(values)) continue;
    out[dim] = values.filter(
      (v): v is string | number => typeof v === "string" || typeof v === "number",
    );
  }
  return out;
}

export function loadManifestYaml(manifestYaml: string): ManifestDoc {
  if (!manifestYaml.trim()) {
    return { parts: [], addons: [], option_groups: {}, selections: {}, variant_dimensions: {} };
  }
  const data = yaml.load(manifestYaml) as Record<string, unknown>;
  return {
    project: data.project != null ? String(data.project) : undefined,
    parts: parsePartRules(data.parts),
    addons: Array.isArray(data.addons)
      ? data.addons.map((a) => {
          const row = a as Record<string, unknown>;
          return {
            parts: parsePartRules(row.parts),
            project: row.project != null ? String(row.project) : undefined,
            source_id: row.source_id != null ? String(row.source_id) : undefined,
          };
        })
      : [],
    option_groups: parseOptionGroups(data.option_groups),
    selections:
      data.selections && typeof data.selections === "object"
        ? (data.selections as Record<string, string>)
        : {},
    variant_dimensions: parseVariantDimensions(data.variant_dimensions),
  };
}

export function optionGroupPatterns(group: ManifestOptionGroup): string[] {
  const patterns = [...group.parts];
  for (const variant of group.variants) {
    patterns.push(...variant.parts);
  }
  return patterns;
}

export function mergeOptionGroups(
  target: Record<string, ManifestOptionGroup>,
  incoming: Record<string, ManifestOptionGroup>,
): void {
  for (const [gid, group] of Object.entries(incoming)) {
    if (!target[gid]) {
      target[gid] = {
        rule: group.rule,
        label: group.label,
        parts: [...group.parts],
        variants: group.variants.map((v) => ({
          id: v.id,
          label: v.label,
          parts: [...v.parts],
          excludes: [...(v.excludes ?? [])],
        })),
        min: group.min,
        max: group.max,
      };
      continue;
    }
    const existing = target[gid];
    const mergedParts = [...new Set([...existing.parts, ...group.parts])];
    const variantsById = new Map(existing.variants.map((v) => [v.id, { ...v, parts: [...v.parts], excludes: [...(v.excludes ?? [])] }]));
    for (const variant of group.variants) {
      const cur = variantsById.get(variant.id);
      if (cur) {
        cur.parts = [...new Set([...cur.parts, ...variant.parts])];
        cur.excludes = [...new Set([...(cur.excludes ?? []), ...(variant.excludes ?? [])])];
        if (variant.label && !cur.label) cur.label = variant.label;
      } else {
        variantsById.set(variant.id, {
          id: variant.id,
          label: variant.label,
          parts: [...variant.parts],
          excludes: [...(variant.excludes ?? [])],
        });
      }
    }
    target[gid] = {
      rule: existing.rule || group.rule,
      label: existing.label || group.label,
      parts: mergedParts,
      variants: [...variantsById.values()],
      min: existing.min ?? group.min,
      max: existing.max ?? group.max,
    };
  }
}

export function partInOptionGroup(matchKey: string, _groupId: string, group: ManifestOptionGroup): boolean {
  return optionGroupPatterns(group).some((pat) => matchKeyMatches(pat, matchKey));
}

export function selectionIncludesPart(
  matchKey: string,
  group: ManifestOptionGroup,
  selection: string,
): boolean {
  if (!selection) return false;
  for (const variant of group.variants) {
    if (variant.id === selection) {
      return variant.parts.some((pat) => matchKeyMatches(pat, matchKey));
    }
  }
  return matchKeyMatches(selection, matchKey);
}

export function applyOptionGroupSelections<
  T extends { readonly partKey: string; readonly optionGroupId: string | null; readonly included: boolean },
>(
  inputParts: readonly T[],
  groups: Readonly<Record<string, ManifestOptionGroup>>,
  selections: Readonly<Record<string, string>>,
): T[] {
  let parts = [...inputParts];
  for (const [groupId, group] of Object.entries(groups)) {
    if ((group.rule ?? "pick_one") !== "pick_one") continue;
    const selection = selections[groupId];
    parts = parts.map((part) => {
      if (part.optionGroupId != null && part.optionGroupId !== groupId) return part;
      const inGroup =
        part.optionGroupId === groupId || partInOptionGroup(part.partKey, groupId, group);
      if (!inGroup) return part;
      return {
        ...part,
        included: selection
          ? selectionIncludesPart(part.partKey, group, selection)
          : false,
      };
    });
  }
  return parts;
}

export function findRepoManifestPath(localPath: string): string | null {
  return safeRepoPath(localPath, CANONICAL_MANIFEST);
}

function loadCommunityManifest(slug: string): ManifestDoc | null {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../data/manifests");
  try {
    return loadManifestYaml(readFileSync(join(dir, `${slug}.yaml`), "utf8"));
  } catch {
    return null;
  }
}

export function collectRepoManifests(
  repo: AppRepository,
  profileId: number,
): Array<{ projectName: string; doc: ManifestDoc; source: string }> {
  const found: Array<{ projectName: string; doc: ManifestDoc; source: string }> = [];
  for (const layer of repo.getProfileLayers(profileId)) {
    if (!layer.project_id) continue;
    const proj = repo.getProjectRow(layer.project_id);
    if (!proj?.localPath) continue;
    const manifestPath = findEditableSourceManifestPath({
      reposDir: repo.reposDir,
      sourceId: proj.id,
      contentRoot: proj.localPath,
    });
    if (manifestPath) {
      try {
        found.push({
          projectName: proj.name,
          doc: loadManifestYaml(readFileSync(manifestPath, "utf8")),
          source: "repo",
        });
      } catch {
        /* skip invalid */
      }
    }
    const slug = proj.manifestCommunitySlug;
    if (slug) {
      const doc = loadCommunityManifest(slug);
      if (doc) found.push({ projectName: proj.name, doc, source: "community" });
    }
  }
  return found;
}

function ruleForPart(
  part: { readonly matchKey: string },
  layerProject: string | null,
  manifests: Array<{ projectName: string; doc: ManifestDoc; source: string }>,
): { rule: ManifestPartRule; source: string } | null {
  for (const { projectName, doc, source } of manifests) {
    if (doc.project && layerProject && doc.project !== layerProject && projectName !== layerProject) {
      continue;
    }
    for (const rule of doc.parts ?? []) {
      if (matchKeyMatches(rule.match, part.matchKey)) return { rule, source };
    }
    for (const addon of doc.addons ?? []) {
      for (const rule of addon.parts ?? []) {
        if (matchKeyMatches(rule.match, part.matchKey)) return { rule, source };
      }
    }
  }
  return null;
}

export function applyManifestToDraftParts(
  repo: AppRepository,
  profileId: number,
  inputParts: readonly (PlanSnapshotPart & { readonly baseRevisionPartId: number | null })[],
): Array<PlanSnapshotPart & { baseRevisionPartId: number | null }> {
  const manifests = collectRepoManifests(repo, profileId);
  const overlaySelections = { ...loadKitManifest(repo, profileId).selections };
  for (const { doc } of manifests) {
    for (const [key, value] of Object.entries(doc.selections ?? {})) {
      if (!(key in overlaySelections)) overlaySelections[key] = value;
    }
  }
  const parts = inputParts.map((part) => {
    const layerLabel = part.sourceLayer.split(":", 2)[1] ?? null;
    const matched = ruleForPart({ matchKey: part.partKey }, layerLabel, manifests);
    if (!matched) return { ...part };
    return {
      ...part,
      requirement: matched.rule.requirement ?? part.requirement,
      optionGroupId: matched.rule.option_group ?? part.optionGroupId,
      manifestSource: matched.source,
      included:
        matched.rule.default_included != null && matched.source === "kit"
          ? matched.rule.default_included
          : part.included,
    };
  });

  const groups: Record<string, ManifestOptionGroup> = {};
  for (const { doc } of manifests) mergeOptionGroups(groups, doc.option_groups ?? {});
  return applyOptionGroupSelections(parts, groups, overlaySelections);
}
