import type { ReviewPart } from "../api/endpoints/planManifests";
import { sourceLabelFromLayer } from "./reviewParts";

const ROOT_FOLDER = "(root)";
export type CheckoffSort = "manual" | "source" | "directory";

export function isCheckoffSort(value: unknown): value is CheckoffSort {
  return value === "manual" || value === "source" || value === "directory";
}

/** Mirror of domain folderKeyFromRelativePath (web app does not depend on domain). */
export function folderKeyFromRelativePath(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  parts.pop();
  const parent = parts.join("/");
  if (!parent || parent === ".") return ROOT_FOLDER;
  return parent;
}

export type CheckoffFolderGroup = {
  folder: string;
  parts: ReviewPart[];
};

export type CheckoffRepoGroup = {
  repoLayer: string;
  repoLabel: string;
  partCount: number;
  folders: CheckoffFolderGroup[];
};

function repoSortKey(layer: string): [number, string] {
  return layer.startsWith("base:") ? [0, layer.toLowerCase()] : [1, layer.toLowerCase()];
}

/**
 * Group checkoff parts by repo → folder, sorted to match the printable checklist
 * HTML (base source first, then add-ons; folders and files alphabetical).
 */
export function groupCheckoffParts(parts: ReviewPart[], sort: CheckoffSort = "source"): CheckoffRepoGroup[] {
  const byRepo = new Map<string, Map<string, ReviewPart[]>>();
  for (const p of parts) {
    const repo = sort === "directory" ? folderKeyFromRelativePath(p.relative_path) : p.source_layer || "unknown";
    const folder = sort === "directory" ? p.source_layer || "unknown" : folderKeyFromRelativePath(p.relative_path);
    if (!byRepo.has(repo)) byRepo.set(repo, new Map());
    const folders = byRepo.get(repo)!;
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder)!.push(p);
  }

  return [...byRepo.entries()]
    .sort((a, b) => {
      if (sort === "directory") return a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: "base" });
      const ka = repoSortKey(a[0]);
      const kb = repoSortKey(b[0]);
      return ka[0] - kb[0] || ka[1].localeCompare(kb[1]);
    })
    .map(([repoLayer, folders]) => ({
      repoLayer,
      repoLabel: sort === "directory" ? repoLayer : sourceLabelFromLayer(repoLayer),
      partCount: [...folders.values()].reduce((n, list) => n + list.length, 0),
      folders: [...folders.entries()]
        .sort(([a], [b]) => {
          if (sort !== "directory") return a.localeCompare(b, undefined, { numeric: true });
          const ka = repoSortKey(a);
          const kb = repoSortKey(b);
          return ka[0] - kb[0] || ka[1].localeCompare(kb[1], undefined, { numeric: true });
        })
        .map(([folder, folderParts]) => ({
          folder: sort === "directory" ? sourceLabelFromLayer(folder) : folder,
          parts: [...folderParts].sort((x, y) =>
            x.filename.localeCompare(y.filename, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
          ),
        })),
    }));
}
