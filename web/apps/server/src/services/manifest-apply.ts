import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import type { AppRepository } from "../db/repository.js";
import type { PlanSnapshotPart } from "./plan-drafts.js";
import { loadKitManifest } from "./kit-manifest-store.js";
import {
  cloneManifestSelections,
  parseManifestSelections,
  selectedVariantIds,
  type ManifestSelection,
  type ManifestSelections,
} from "./manifest-selections.js";
import { findSourceManifestPath } from "./source-workspace.js";

export const CANONICAL_MANIFEST = "print-partner.manifest.yaml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

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

export type ManifestOptionGroupRule = "pick_one" | "pick_any" | "pick_n";

export type ManifestOptionGroup = {
  rule: ManifestOptionGroupRule;
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
  selections?: ManifestSelections;
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

function parseOptionGroupRule(raw: unknown, groupId: string): ManifestOptionGroupRule {
  if (raw === "pick_one" || raw === "pick_any" || raw === "pick_n") return raw;
  throw new Error(`option_groups.${groupId}.rule is invalid`);
}

function parseOptionGroupBound(
  raw: unknown,
  groupId: string,
  field: "min" | "max",
): number | null {
  if (raw == null) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`option_groups.${groupId}.${field} must be a non-negative integer`);
  }
  return raw;
}

function parseOptionGroups(raw: unknown): Record<string, ManifestOptionGroup> {
  if (!isRecord(raw)) throw new Error("option_groups must be an object");
  const out: Record<string, ManifestOptionGroup> = {};
  for (const [gid, row] of Object.entries(raw)) {
    if (!isRecord(row)) {
      throw new Error(`option_groups.${gid} must be an object`);
    }
    const minimum = parseOptionGroupBound(row.min, gid, "min");
    const maximum = parseOptionGroupBound(row.max, gid, "max");
    const rule = parseOptionGroupRule(row.rule ?? "pick_one", gid);
    if (minimum != null && maximum != null && minimum > maximum) {
      throw new Error(`option_groups.${gid}.min must not exceed max`);
    }
    if (rule === "pick_one" && ((minimum ?? 0) > 1 || (maximum ?? 1) > 1)) {
      throw new Error(`option_groups.${gid} pick_one bounds must not exceed 1`);
    }
    out[gid] = {
      rule,
      label: row.label != null ? String(row.label) : null,
      parts: parseStringList(row.parts),
      variants: parseVariants(row.variants),
      min: minimum,
      max: maximum,
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

function repositoryManifestSelectionsInputError(
  optionGroups: Readonly<Record<string, ManifestOptionGroup>>,
  selections: Readonly<ManifestSelections>,
): string | null {
  for (const [groupId, selection] of Object.entries(selections)) {
    if (Array.isArray(selection) && selection.length === 0) {
      return `selections.${groupId} must contain at least one variant id`;
    }
  }
  return manifestSelectionsInputError(optionGroups, selections, "selections");
}

export function loadManifestYaml(manifestYaml: string): ManifestDoc {
  if (!manifestYaml.trim()) {
    return { parts: [], addons: [], option_groups: {}, selections: {}, variant_dimensions: {} };
  }
  const data = yaml.load(manifestYaml);
  if (!isRecord(data)) throw new Error("manifest must be an object");
  const optionGroups =
    "option_groups" in data ? parseOptionGroups(data.option_groups) : {};
  const selections =
    "selections" in data
      ? parseManifestSelections(data.selections, "selections")
      : {};
  const selectionError = repositoryManifestSelectionsInputError(
    optionGroups,
    selections,
  );
  if (selectionError) throw new Error(selectionError);
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
    option_groups: optionGroups,
    selections,
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

function selectionExcludesPart(
  matchKey: string,
  group: ManifestOptionGroup,
  selection: string,
): boolean {
  const variant = group.variants.find((candidate) => candidate.id === selection);
  return (variant?.excludes ?? []).some((pattern) => matchKeyMatches(pattern, matchKey));
}

export function optionGroupSelectionIsComplete(
  group: ManifestOptionGroup,
  selection: ManifestSelection | undefined,
): boolean {
  const count = selectedIdsForGroup(group, selection).length;
  const minimum = group.min ?? 0;
  const maximum =
    group.rule === "pick_one"
      ? Math.min(group.max ?? 1, 1)
      : (group.max ?? Number.POSITIVE_INFINITY);
  return count >= minimum && count <= maximum;
}

function selectedIdsForGroup(
  group: ManifestOptionGroup,
  selection: ManifestSelection | undefined,
): string[] {
  const selectedIds = selectedVariantIds(selection);
  if (group.variants.length === 0) return selectedIds;
  const knownIds = new Set(group.variants.map((variant) => variant.id));
  return selectedIds.filter((variantId) => knownIds.has(variantId));
}

export function optionGroupSelectionInputError(
  groupId: string,
  group: ManifestOptionGroup,
  selection: ManifestSelection | undefined,
  path = "kit.selections",
): string | null {
  const count = selectedVariantIds(selection).length;
  if (
    Array.isArray(selection) &&
    count === 0 &&
    group.rule === "pick_one"
  ) {
    return `${path}.${groupId} must contain at least one variant id`;
  }
  const maximum =
    group.rule === "pick_one" ? Math.min(group.max ?? 1, 1) : (group.max ?? null);
  if (maximum != null && count > maximum) {
    const unit = maximum === 1 ? "variant id" : "variant ids";
    return `${path}.${groupId} must contain no more than ${maximum} ${unit}`;
  }
  return null;
}

export function manifestSelectionsInputError(
  groups: Readonly<Record<string, ManifestOptionGroup>>,
  selections: Readonly<ManifestSelections>,
  path = "kit.selections",
): string | null {
  for (const [groupId, selection] of Object.entries(selections)) {
    const group = groups[groupId];
    if (!group) continue;
    const error = optionGroupSelectionInputError(
      groupId,
      group,
      selection,
      path,
    );
    if (error) return error;
  }
  return null;
}

export function applyOptionGroupSelections<
  T extends { readonly partKey: string; readonly optionGroupId: string | null; readonly included: boolean },
>(
  inputParts: readonly T[],
  groups: Readonly<Record<string, ManifestOptionGroup>>,
  selections: Readonly<ManifestSelections>,
): T[] {
  const evaluations = Object.entries(groups).map(([groupId, group]) => {
    const selection = selections[groupId];
    return {
      groupId,
      group,
      selectedIds: selectedIdsForGroup(group, selection),
      selectionIsComplete: optionGroupSelectionIsComplete(group, selection),
    };
  });

  return inputParts.map((part) => {
    const memberships = evaluations.filter(({ groupId, group }) =>
      part.optionGroupId === null
        ? partInOptionGroup(part.partKey, groupId, group)
        : part.optionGroupId === groupId,
    );
    let included = part.included;
    if (memberships.length > 0) {
      included = memberships.some(
        ({ group, selectedIds, selectionIsComplete }) =>
          selectionIsComplete &&
          selectedIds.some((id) => selectionIncludesPart(part.partKey, group, id)),
      );
    }

    const excluded = evaluations.some(
      ({ groupId, group, selectedIds, selectionIsComplete }) =>
        selectionIsComplete &&
        (part.optionGroupId === null || part.optionGroupId === groupId) &&
        selectedIds.some((id) => selectionExcludesPart(part.partKey, group, id)),
    );
    if (excluded) included = false;
    return included === part.included ? part : { ...part, included };
  });
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
    const manifestPath = findSourceManifestPath(proj.localPath);
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

function selectionsWithManifestDefaults(
  explicit: Readonly<ManifestSelections>,
  manifests: ReturnType<typeof collectRepoManifests>,
): ManifestSelections {
  const resolved = cloneManifestSelections(explicit);
  for (const { doc } of manifests) {
    for (const [key, value] of Object.entries(doc.selections ?? {})) {
      if (!(key in resolved)) {
        resolved[key] = Array.isArray(value) ? [...value] : value;
      }
    }
  }
  return resolved;
}

export function resolvePlanManifestSelections(
  repo: AppRepository,
  profileId: number,
): ManifestSelections {
  return selectionsWithManifestDefaults(
    loadKitManifest(repo, profileId).selections,
    collectRepoManifests(repo, profileId),
  );
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
  effectiveOptionGroups?: Readonly<Record<string, ManifestOptionGroup>>,
): Array<PlanSnapshotPart & { baseRevisionPartId: number | null }> {
  const manifests = collectRepoManifests(repo, profileId);
  const overlaySelections = selectionsWithManifestDefaults(
    loadKitManifest(repo, profileId).selections,
    manifests,
  );
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
  if (effectiveOptionGroups) mergeOptionGroups(groups, { ...effectiveOptionGroups });
  return applyOptionGroupSelections(parts, groups, overlaySelections);
}
