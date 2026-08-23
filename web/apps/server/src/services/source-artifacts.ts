import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

export type SourceArtifactFormat = "stl" | "3mf" | "zip";

export type SourceArtifact = Readonly<{
  path: string;
  format: SourceArtifactFormat;
  printable: boolean;
  byte_size: number;
  sha256: string;
}>;

const ARTIFACT_FORMATS = new Map<string, SourceArtifactFormat>([
  [".stl", "stl"],
  [".3mf", "3mf"],
  [".zip", "zip"],
]);

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function scanSourceArtifacts(sourceRoot: string): SourceArtifact[] {
  let root: string;
  try {
    root = realpathSync(resolve(sourceRoot));
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }

  const artifacts: SourceArtifact[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (lstatSync(absolute).isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const format = ARTIFACT_FORMATS.get(extname(entry.name).toLowerCase());
      if (!format) continue;
      const resolvedFile = realpathSync(absolute);
      if (!isInside(root, resolvedFile)) continue;
      const bytes = readFileSync(resolvedFile);
      artifacts.push({
        path: relative(root, resolvedFile).split(sep).join("/"),
        format,
        printable: format === "stl" || format === "3mf",
        byte_size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

export function listPrintableArtifactPaths(sourceRoot: string): string[] {
  return scanSourceArtifacts(sourceRoot)
    .filter((artifact) => artifact.printable)
    .map((artifact) => artifact.path);
}
