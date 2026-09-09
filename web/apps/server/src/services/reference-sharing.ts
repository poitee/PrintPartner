import { zipSync, strToU8 } from "fflate";
import {
  isSharePublisherUrl, referenceShareSchema,
  type ReferenceShare, type ReferenceShareExport,
} from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import { importRulesForProject } from "@print-partner/domain";
import { getColorById } from "./filament-catalog.js";

function sourceReference(
  row: NonNullable<ReturnType<AppRepository["getProjectRow"]>>,
  key: string,
): ReferenceShare["sources"][number] {
  const publisher = row.sourceKind !== "local" && isSharePublisherUrl(row.url);
  return {
    key,
    name: row.name,
    location: publisher ? { kind: "publisher", url: row.url } : { kind: "manual" },
    revision: {
      branch: publisher ? row.branch : null,
      tag: publisher ? row.tag : null,
      commit: publisher && /^[a-fA-F0-9]{40,64}$/.test(row.lastCommitSha ?? "")
        ? row.lastCommitSha : null,
    },
    file_rules: importRulesForProject(row.importedPaths) ?? [],
  };
}

export function referenceShareWarnings(manifest: ReferenceShare): string[] {
  const warnings = [
    "No model files are included. Recipients must obtain files from the original publishers.",
    "Review names, relative paths, options, and source visibility before sharing. Private repositories may still have publisher URLs.",
  ];
  for (const source of manifest.sources) {
    if (source.location.kind === "manual") {
      warnings.push(`${source.name}: original files must be located manually; no shareable publisher URL is included.`);
    } else if (!source.revision.commit) {
      warnings.push(`${source.name}: no immutable commit is recorded; the recipient must verify the revision.`);
    }
  }
  return warnings;
}

export function exportBuildReferenceShare(repo: AppRepository, profileId: number): ReferenceShareExport {
  const recipe = repo.readEditableKitRecipe(profileId);
  const sources: ReferenceShare["sources"] = [];
  const keys = new Map<number, string>();
  const layerKeys = new Map<string, string>();
  const layers: Array<{ source: string; role: string }> = [];
  for (const layer of repo.getProfileLayers(profileId)) {
    if (layer.project_id == null) continue;
    const row = repo.getProjectRow(layer.project_id);
    if (!row) throw new Error("A Build Source is unavailable");
    let key = keys.get(row.id);
    if (!key) {
      key = `source-${sources.length + 1}`;
      keys.set(row.id, key);
      sources.push(sourceReference(row, key));
    }
    layerKeys.set(`${layer.layer_type}:${row.name}`, key);
    layers.push({ source: key, role: layer.layer_type });
  }
  const manifest = referenceShareSchema.parse({
    format: "printpartner-reference-share", version: 1, kind: "build",
    title: recipe.profile.name, sources, layers,
    selections: recipe.kitManifest.selections,
    include: recipe.kitManifest.include,
    exclude: recipe.kitManifest.exclude,
    replacements: recipe.kitManifest.replacements,
    parts: recipe.workingParts.map((part) => {
      const key = layerKeys.get(part.sourceLayer);
      if (!key) throw new Error("A part has an unresolved Source; refresh the Build before sharing");
      return {
        source: key, path: part.relativePath, quantity: part.quantityEffective,
        included: part.included, role: part.role,
        color: part.filamentCustomHex ?? (part.filamentColorId ? getColorById(part.filamentColorId)?.hex : null) ?? null,
      };
    }),
  });
  if (Buffer.byteLength(serializeReferenceShare(manifest), "utf8") > 4 * 1024 * 1024) {
    throw new Error("Reference manifest exceeds the 4 MiB sharing limit");
  }
  return { manifest, warnings: referenceShareWarnings(manifest) };
}

export function serializeReferenceShare(manifest: ReferenceShare): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function referenceShareGitBundle(manifest: ReferenceShare): Uint8Array {
  const readme = `# PrintPartner reference manifest

This repository contains a ${manifest.kind} recipe, not model files.

1. Review printpartner.share.json for the required sources, file selections, and quantities.
2. Obtain models from their original publishers using your own authorized access.
3. Follow the original creators' attribution and license terms. This manifest grants no model rights.

Local-only sources require the recipient to locate files independently. A branch or tag may change; verify revisions before building.

Current PrintPartner supports exporting and validating this format. Automatic Build creation from it is not yet available.

## Share through Git

Copy these text files into a repository you own, inspect the diff, and commit them with your usual Git client. Choose repository visibility deliberately. No account credentials belong in the repository.

Do not add models, previews, sliced files, backups, or printer settings. The ignore rules are a reminder, not an enforcement mechanism. Review every commit.
`;
  const ignore = "*.stl\n*.STL\n*.3mf\n*.3MF\n*.obj\n*.step\n*.stp\n*.gcode\n*.bgcode\n*.zip\n*.tar.gz\n.env*\n";
  const mtime = new Date("1980-01-01T00:00:00Z");
  return zipSync({
    "printpartner.share.json": [strToU8(serializeReferenceShare(manifest)), { mtime }],
    "README.md": [strToU8(readme), { mtime }],
    ".gitignore": [strToU8(ignore), { mtime }],
  });
}
