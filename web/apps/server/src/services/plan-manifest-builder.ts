import { readFileSync } from "node:fs";
import { importRulesForProject, listStlRelativePaths, pathMatchesRules } from "@print-partner/domain";
import type { AppRepository } from "../db/repository.js";
import {
  loadManifestYaml,
  matchKeyMatches,
  mergeOptionGroups,
  type ManifestOptionGroup,
} from "./manifest-apply.js";
import { inferOptionGroupsFromPaths } from "./path-hints.js";
import { inferSiblingFolderOptionGroups } from "./repo-tree-summary.js";
import { findEditableSourceManifestPath } from "./source-workspace.js";

const CANONICAL_REPO_FILENAME = "print-partner.manifest.yaml";

type ScannedManifestPart = { match: string; relative_path: string };

type PreparedManifestSource = {
  projectId: number;
  projectName: string;
  projectRole: string | null;
  projectUrl: string | null;
  layerType: string;
  exists: boolean;
  manifestPath: string | null;
  manifestYaml: string;
  document: ReturnType<typeof loadManifestYaml>;
  scanned: ScannedManifestPart[];
  optionGroups: Record<string, ManifestOptionGroup>;
};

function scannedParts(localPath: string, importedPaths: string | null): Array<{ match: string; relative_path: string }> {
  const rules = importRulesForProject(importedPaths);
  let paths = listStlRelativePaths(localPath);
  if (rules != null) {
    paths = paths.filter((p) => pathMatchesRules(p, rules));
  }
  return paths.map((p) => ({ match: p, relative_path: p }));
}

function trackVariantSources(
  variantSources: Record<string, Record<string, Array<{ source_id: number; source_name: string }>>>,
  groups: Record<string, ManifestOptionGroup>,
  projectId: number,
  projectName: string,
  scanned: Array<{ relative_path: string }>,
) {
  for (const [gid, group] of Object.entries(groups)) {
    const byVariant = variantSources[gid] ?? {};
    for (const variant of group.variants ?? []) {
      const matchesSource = (variant.parts ?? []).some((pat) =>
        scanned.some((part) => matchKeyMatches(pat, part.relative_path)),
      );
      if (!matchesSource) continue;
      const entries = byVariant[variant.id] ?? [];
      const entry = { source_id: projectId, source_name: projectName };
      if (!entries.some((e) => e.source_id === entry.source_id)) {
        entries.push(entry);
      }
      byVariant[variant.id] = entries;
    }
    variantSources[gid] = byVariant;
  }
}

function resolveSourceOptionGroups(
  document: ReturnType<typeof loadManifestYaml>,
  scanned: ScannedManifestPart[],
): Record<string, ManifestOptionGroup> {
  const groups: Record<string, ManifestOptionGroup> = {};
  mergeOptionGroups(groups, document.option_groups ?? {});
  if (!Object.keys(document.option_groups ?? {}).length) {
    mergeOptionGroups(
      groups,
      inferOptionGroupsFromPaths(scanned.map((part) => part.relative_path)),
    );
  }
  if (!Object.keys(groups).length) {
    mergeOptionGroups(
      groups,
      inferSiblingFolderOptionGroups(scanned.map((part) => part.relative_path)),
    );
  }
  return groups;
}

function prepareManifestSources(
  repo: AppRepository,
  profileId: number,
): PreparedManifestSource[] {
  const sources: PreparedManifestSource[] = [];
  for (const layer of repo.getProfileLayers(profileId)) {
    if (!layer.project_id) continue;
    const project = repo.getProjectRow(layer.project_id);
    if (!project?.localPath) continue;

    let manifestYaml = "";
    let document = loadManifestYaml("");
    let exists = false;
    const manifestPath = findEditableSourceManifestPath({
      reposDir: repo.reposDir,
      sourceId: project.id,
      contentRoot: project.localPath,
    });
    if (manifestPath) {
      try {
        manifestYaml = readFileSync(manifestPath, "utf8");
        document = loadManifestYaml(manifestYaml);
        exists = true;
      } catch {
        manifestYaml = "";
        document = loadManifestYaml("");
      }
    }

    const scanned = scannedParts(project.localPath, project.importedPaths);
    sources.push({
      projectId: project.id,
      projectName: project.name,
      projectRole: project.role,
      projectUrl: project.url,
      layerType: layer.layer_type,
      exists,
      manifestPath,
      manifestYaml,
      document,
      scanned,
      optionGroups: resolveSourceOptionGroups(document, scanned),
    });
  }
  return sources;
}

/** The exact option groups shown in Sources and enforced by Working Plan recomputation. */
export function buildPlanOptionGroups(
  repo: AppRepository,
  profileId: number,
): Record<string, ManifestOptionGroup> {
  const merged: Record<string, ManifestOptionGroup> = {};
  for (const source of prepareManifestSources(repo, profileId)) {
    mergeOptionGroups(merged, source.optionGroups);
  }
  return merged;
}

export function buildPlanManifestBuilder(repo: AppRepository, profileId: number) {
  const mergedGroups: Record<string, ManifestOptionGroup> = {};
  const variantSources: Record<string, Record<string, Array<{ source_id: number; source_name: string }>>> = {};
  const sourceRows: Array<Record<string, unknown>> = [];

  for (const source of prepareManifestSources(repo, profileId)) {
    mergeOptionGroups(mergedGroups, source.optionGroups);
    trackVariantSources(
      variantSources,
      source.optionGroups,
      source.projectId,
      source.projectName,
      source.scanned,
    );

    sourceRows.push({
      source_id: source.projectId,
      layer_type: source.layerType,
      name: source.projectName,
      role: source.projectRole ?? "unassigned",
      url: source.projectUrl ?? "",
      exists: source.exists,
      path: CANONICAL_REPO_FILENAME,
      yaml: source.exists && source.manifestPath
        ? source.manifestYaml
        : `format: print-partner-manifest-v2\nversion: 2\nproject: ${source.projectName}\n`,
      document: {
        format: "print-partner-manifest-v2",
        version: 2,
        project: source.projectName,
        option_groups: source.document.option_groups ?? {},
      },
      scanned_parts: source.scanned,
    });
  }

  return {
    profile_id: profileId,
    sources: sourceRows,
    merged_option_groups: Object.fromEntries(
      Object.entries(mergedGroups).map(([gid, group]) => [
        gid,
        {
          rule: group.rule,
          label: group.label ?? null,
          parts: group.parts,
          variants: (group.variants ?? []).map((v) => {
            const sources = variantSources[gid]?.[v.id] ?? [];
            return {
              id: v.id,
              label: v.label ?? null,
              parts: v.parts,
              excludes: v.excludes,
              ...(sources[0]
                ? { source_id: sources[0].source_id, source_name: sources[0].source_name }
                : {}),
              ...(sources.length > 1 ? { sources } : {}),
            };
          }),
        },
      ]),
    ),
  };
}
