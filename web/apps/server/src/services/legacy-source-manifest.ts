import { lstat, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import {
  legacySourceManifestOverridePath,
  sourceWorkspaceRoot,
} from "./source-workspace.js";
import { MAX_JSON_BODY_BYTES } from "./upload-limits.js";

type LegacySourceManifestAbsent = Readonly<{
  kind: "absent";
  legacyPath: string;
}>;

type LegacySourceManifestUnsafe = Readonly<{
  kind: "unsafe";
  legacyPath: string;
  reason: string;
}>;

export type LegacySourceManifestFile = Readonly<{
  kind: "file";
  legacyPath: string;
  content: Buffer;
}>;

export type LegacySourceManifestObservation =
  | LegacySourceManifestAbsent
  | LegacySourceManifestUnsafe
  | LegacySourceManifestFile;

export type ArchivedLegacySourceManifest = Readonly<{
  backupPath: string;
  matchesObservedContent: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export async function inspectLegacySourceManifest(input: {
  reposDir: string;
  sourceId: number;
}): Promise<LegacySourceManifestObservation> {
  const workspaceRoot = sourceWorkspaceRoot(input.reposDir, input.sourceId);
  const legacyPath = legacySourceManifestOverridePath(input.reposDir, input.sourceId);
  let workspaceStat;
  try {
    workspaceStat = await lstat(workspaceRoot);
  } catch (error) {
    if (isMissingFile(error)) return { kind: "absent", legacyPath };
    throw error;
  }
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
    return {
      kind: "unsafe",
      legacyPath,
      reason: "Legacy Source workspace is not a real directory",
    };
  }
  const [canonicalReposDir, canonicalWorkspaceRoot] = await Promise.all([
    realpath(input.reposDir),
    realpath(workspaceRoot),
  ]);
  if (relative(canonicalReposDir, canonicalWorkspaceRoot) !== String(input.sourceId)) {
    return {
      kind: "unsafe",
      legacyPath,
      reason: "Legacy Source workspace resolves outside its storage directory",
    };
  }

  let fileStat;
  try {
    fileStat = await lstat(legacyPath);
  } catch (error) {
    if (isMissingFile(error)) return { kind: "absent", legacyPath };
    throw error;
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    return {
      kind: "unsafe",
      legacyPath,
      reason: "Legacy Source manifest is not a regular file",
    };
  }
  if (fileStat.size > MAX_JSON_BODY_BYTES) {
    return {
      kind: "unsafe",
      legacyPath,
      reason: `Legacy Source manifest exceeds the ${MAX_JSON_BODY_BYTES} byte request limit`,
    };
  }
  return { kind: "file", legacyPath, content: await readFile(legacyPath) };
}

export async function archiveLegacySourceManifest(
  observed: LegacySourceManifestFile,
  reposDir: string,
  sourceId: number,
): Promise<ArchivedLegacySourceManifest | null> {
  const current = await inspectLegacySourceManifest({ reposDir, sourceId });
  if (current.kind === "absent") return null;
  if (current.kind !== "file") {
    throw new Error("Legacy Source manifest changed during publication");
  }

  const backupDirectory = await mkdtemp(`${observed.legacyPath}.migrated-`);
  const backupPath = join(
    backupDirectory,
    `${basename(observed.legacyPath)}.migrated`,
  );
  try {
    await rename(observed.legacyPath, backupPath);
  } catch (error) {
    await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (isMissingFile(error)) return null;
    throw error;
  }

  const claimedStat = await lstat(backupPath);
  if (claimedStat.isSymbolicLink() || !claimedStat.isFile()) {
    return { backupPath, matchesObservedContent: false };
  }
  const claimedContent = await readFile(backupPath);
  return {
    backupPath,
    matchesObservedContent: claimedContent.equals(observed.content),
  };
}
