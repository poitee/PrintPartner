import type { ReviewPart } from "../api/engine";
import { sourceLabelFromLayer } from "./reviewParts";

const ROOT_FOLDER = "(root)";

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
export function groupCheckoffParts(parts: ReviewPart[]): CheckoffRepoGroup[] {
  const byRepo = new Map<string, Map<string, ReviewPart[]>>();
  for (const p of parts) {
    const repo = p.source_layer || "unknown";
    const folder = folderKeyFromRelativePath(p.relative_path);
    if (!byRepo.has(repo)) byRepo.set(repo, new Map());
    const folders = byRepo.get(repo)!;
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder)!.push(p);
  }

  return [...byRepo.entries()]
    .sort((a, b) => {
      const ka = repoSortKey(a[0]);
      const kb = repoSortKey(b[0]);
      return ka[0] - kb[0] || ka[1].localeCompare(kb[1]);
    })
    .map(([repoLayer, folders]) => ({
      repoLayer,
      repoLabel: sourceLabelFromLayer(repoLayer),
      partCount: [...folders.values()].reduce((n, list) => n + list.length, 0),
      folders: [...folders.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([folder, folderParts]) => ({
          folder,
          parts: [...folderParts].sort((x, y) =>
            x.filename.localeCompare(y.filename, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
          ),
        })),
    }));
}
