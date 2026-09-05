import { readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const TRANSFER_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1_000;

const TRANSFER_DIRECTORIES = ["bambu-connect", "printer-uploads"] as const;

export type TransferArtifactSweepOptions = Readonly<{
  now?: number;
  ttlMs?: number;
  protectedDirectories?: ReadonlySet<string>;
  kinds?: readonly (typeof TRANSFER_DIRECTORIES)[number][];
}>;

function childDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

function transferRoots(exportsRoot: string): string[] {
  const resolvedRoot = resolve(exportsRoot);
  return [
    resolvedRoot,
    ...childDirectories(resolvedRoot).filter((path) => {
      const name = path.slice(resolvedRoot.length + 1);
      return name.startsWith("tenant-");
    }),
  ];
}

export function sweepExpiredTransferArtifacts(
  exportsRoot: string,
  options: TransferArtifactSweepOptions = {},
): string[] {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? TRANSFER_ARTIFACT_TTL_MS;
  const protectedDirectories = new Set(
    [...(options.protectedDirectories ?? [])].map((path) => resolve(path)),
  );
  const kinds = options.kinds ?? TRANSFER_DIRECTORIES;
  const removed: string[] = [];

  for (const root of transferRoots(exportsRoot)) {
    for (const kind of kinds) {
      for (const directory of childDirectories(join(root, kind))) {
        const resolvedDirectory = resolve(directory);
        if (protectedDirectories.has(resolvedDirectory)) continue;
        try {
          if (now - statSync(resolvedDirectory).mtimeMs < ttlMs) continue;
          rmSync(resolvedDirectory, { recursive: true, force: true });
          removed.push(resolvedDirectory);
        } catch {
          // Retention is best-effort; a later sweep can retry a busy artifact.
        }
      }
    }
  }

  return removed;
}
