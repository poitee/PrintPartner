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

export function buildPlanManifestBuilder(repo: AppRepository, profileId: number) {
  const mergedGroups: Record<string, ManifestOptionGroup> = {};
  const variantSources: Record<string, Record<string, Array<{ source_id: number; source_name: string }>>> = {};
  const sourceRows: Array<Record<string, unknown>> = [];

  for (const layer of repo.getProfileLayers(profileId)) {
    if (!layer.project_id) continue;
    const proj = repo.getProjectRow(layer.project_id);
    if (!proj?.localPath) continue;

    let doc = loadManifestYaml("");
    let exists = false;
    const manifestPath = findEditableSourceManifestPath({
      reposDir: repo.reposDir,
      sourceId: proj.id,
      contentRoot: proj.localPath,
    });
    if (manifestPath) {
      try {
        doc = loadManifestYaml(readFileSync(manifestPath, "utf8"));
        exists = true;
      } catch {
        /* keep empty doc */
      }
    }

    const scanned = scannedParts(proj.localPath, proj.importedPaths);
    const layerGroups: Record<string, ManifestOptionGroup> = {};
    mergeOptionGroups(layerGroups, doc.option_groups ?? {});
    if (!Object.keys(doc.option_groups ?? {}).length) {
      mergeOptionGroups(layerGroups, inferOptionGroupsFromPaths(scanned.map((p) => p.relative_path)));
    }
    // Sibling-folder fallback: repos without manifest YAML or path-hint matches
    // (e.g. EMU) still get Build pickers derived from variant-looking folders.
    if (!Object.keys(layerGroups).length) {
      mergeOptionGroups(
        layerGroups,
        inferSiblingFolderOptionGroups(scanned.map((p) => p.relative_path)),
      );
    }
    mergeOptionGroups(mergedGroups, layerGroups);
    trackVariantSources(variantSources, layerGroups, proj.id, proj.name, scanned);

    sourceRows.push({
      source_id: proj.id,
      layer_type: layer.layer_type,
      name: proj.name,
      role: proj.role ?? "unassigned",
      url: proj.url ?? "",
      exists,
      path: CANONICAL_REPO_FILENAME,
      yaml: exists && manifestPath ? readFileSync(manifestPath, "utf8") : `format: print-partner-manifest-v2\nversion: 2\nproject: ${proj.name}\n`,
      document: {
        format: "print-partner-manifest-v2",
        version: 2,
        project: proj.name,
        option_groups: doc.option_groups ?? {},
      },
      scanned_parts: scanned,
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
