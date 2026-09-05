import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { SourceSummary } from "@print-partner/contracts";
import type {
  AppRepository,
  SourceActivationObservation,
} from "../db/repository.js";
import {
  LocalSourceSnapshotStore,
  SOURCE_SNAPSHOT_MANIFEST_FILE,
  sourceRelativePath,
  type PublishedSourceSnapshot,
  type SnapshotFile,
  type SnapshotFileKind,
} from "./local-source-snapshot.js";
import { loadManifestYaml } from "./manifest-apply.js";
import { SOURCE_MANIFEST_FILENAME } from "./source-workspace.js";

export const DEFAULT_LOCAL_SNAPSHOT_STL_LIMIT = 500;
export const DEFAULT_LOCAL_SNAPSHOT_DOCS_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_LOCAL_SNAPSHOT_TOTAL_BYTES = 1024 * 1024 * 1024;

type CollectedSnapshotFile = {
  relativePath: string;
  absolutePath: string;
  kind: SnapshotFileKind;
  sizeHintBytes: number;
};

type SnapshotResource = Pick<
  CollectedSnapshotFile,
  "relativePath" | "kind" | "sizeHintBytes"
>;

export class InvalidSourceManifestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidSourceManifestError";
  }
}

export class SourceManifestContentUnavailableError extends Error {
  constructor() {
    super("Source has no local content available under the active filesystem policy");
    this.name = "SourceManifestContentUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifySnapshotPath(path: string): SnapshotFileKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".stl")) return "stl";
  if (lower.endsWith(".3mf") || lower.endsWith(".zip")) return "artifact";
  if (path === SOURCE_MANIFEST_FILENAME) return "artifact";
  if (!lower.endsWith(".md") && !lower.endsWith(".pdf")) return null;
  if (lower.endsWith(".pdf")) return "pdf";
  const base = lower.split("/").pop() ?? lower;
  if (base === "readme.md" || base.startsWith("readme.")) return "readme";
  return "md";
}

function resolveUnderRoot(root: string, relativePath: string): string | null {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) return null;
  const base = resolve(root);
  const target = resolve(base, normalized);
  if (target !== base && !target.startsWith(`${base}${sep}`)) return null;
  return target;
}

async function collectSnapshotFiles(
  root: string,
  excludeManagedSnapshots = false,
): Promise<CollectedSnapshotFile[]> {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const files: CollectedSnapshotFile[] = [];
  const walk = async (dir: string, relative: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        const segments = rel.split("/");
        if (
          excludeManagedSnapshots &&
          segments.length === 2 &&
          segments[0]?.toLocaleLowerCase("en-US") === "revisions"
        ) {
          try {
            const marker = await lstat(join(abs, SOURCE_SNAPSHOT_MANIFEST_FILE));
            if (marker.isFile() && !marker.isSymbolicLink()) continue;
          } catch (error) {
            if (!isRecord(error) || error.code !== "ENOENT") throw error;
          }
        }
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = classifySnapshotPath(rel);
      if (!kind) continue;
      const stat = await lstat(abs);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      sourceRelativePath(rel);
      files.push({
        relativePath: rel,
        absolutePath: abs,
        kind,
        sizeHintBytes: stat.size,
      });
    }
  };
  await walk(root, "");
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function assertSnapshotResourceLimits(input: {
  files: readonly SnapshotResource[];
  maxStlFiles: number;
  maxDocumentationBytes: number;
  maxTotalBytes: number;
}): void {
  const stlCount = input.files.filter((file) => file.kind === "stl").length;
  if (stlCount > input.maxStlFiles) {
    throw new Error(
      `Local Source contains ${stlCount} STL files, exceeding the limit of ${input.maxStlFiles}`,
    );
  }
  const nonStlBytes = input.files
    .filter((file) => file.kind !== "stl")
    .reduce((sum, file) => sum + file.sizeHintBytes, 0);
  if (nonStlBytes > input.maxDocumentationBytes) {
    throw new Error(
      `Local Source documentation exceeds the ${input.maxDocumentationBytes} byte limit, including non-STL artifacts`,
    );
  }
  const totalBytes = input.files.reduce((sum, file) => sum + file.sizeHintBytes, 0);
  if (totalBytes > input.maxTotalBytes) {
    throw new Error(`Local Source total stored bytes exceeds the ${input.maxTotalBytes} byte limit`);
  }
}

async function digestWorkingTree(files: readonly CollectedSnapshotFile[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    const contentHash = createHash("sha256");
    for await (const chunk of createReadStream(file.absolutePath)) {
      contentHash.update(chunk);
    }
    const contentDigest = contentHash.digest("hex");
    hash.update(
      JSON.stringify({
        path: file.relativePath,
        size: file.sizeHintBytes,
        sha256: contentDigest,
      }),
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

function resourcesWithManifest(
  files: readonly CollectedSnapshotFile[],
  manifestYaml: string | undefined,
): SnapshotResource[] {
  if (manifestYaml === undefined) return [...files];
  return [
    ...files.filter((file) => file.relativePath !== SOURCE_MANIFEST_FILENAME),
    {
      relativePath: SOURCE_MANIFEST_FILENAME,
      kind: "artifact" as const,
      sizeHintBytes: Buffer.byteLength(manifestYaml),
    },
  ];
}

async function materializeLocalSourceWorkingTree(input: {
  reposDir: string;
  sourceId: number;
  workingTree: string;
  manifestYaml?: string;
  maxStlFiles: number;
  maxDocumentationBytes: number;
  maxTotalBytes: number;
}): Promise<PublishedSourceSnapshot> {
  const sourceWorkspace = resolve(input.reposDir, String(input.sourceId));
  const liveFiles = await collectSnapshotFiles(
    input.workingTree,
    resolve(input.workingTree) === sourceWorkspace,
  );
  assertSnapshotResourceLimits({
    files: resourcesWithManifest(liveFiles, input.manifestYaml),
    maxStlFiles: input.maxStlFiles,
    maxDocumentationBytes: input.maxDocumentationBytes,
    maxTotalBytes: input.maxTotalBytes,
  });
  await mkdir(input.reposDir, { recursive: true });
  const stagingRoot = await mkdtemp(join(input.reposDir, ".local-source-"));
  try {
    for (const file of liveFiles) {
      if (
        input.manifestYaml !== undefined &&
        file.relativePath === SOURCE_MANIFEST_FILENAME
      ) {
        continue;
      }
      const stagedPath = resolveUnderRoot(stagingRoot, file.relativePath);
      if (!stagedPath) throw new Error(`Unsafe Source snapshot path: ${file.relativePath}`);
      await mkdir(dirname(stagedPath), { recursive: true });
      await copyFile(file.absolutePath, stagedPath);
    }
    if (input.manifestYaml !== undefined) {
      await writeFile(
        join(stagingRoot, SOURCE_MANIFEST_FILENAME),
        input.manifestYaml,
        { encoding: "utf8", flag: "wx" },
      );
    }
    const collected = await collectSnapshotFiles(stagingRoot);
    assertSnapshotResourceLimits({
      files: collected,
      maxStlFiles: input.maxStlFiles,
      maxDocumentationBytes: input.maxDocumentationBytes,
      maxTotalBytes: input.maxTotalBytes,
    });

    const upstreamRevisionKey = await digestWorkingTree(collected);
    const files: SnapshotFile[] = collected.map((file) => ({
      path: sourceRelativePath(file.relativePath),
      kind: file.kind,
      sizeHintBytes: file.sizeHintBytes,
    }));
    const store = new LocalSourceSnapshotStore({ reposDir: input.reposDir });
    return await store.materialize({
      sourceId: input.sourceId,
      upstreamRevisionKey,
      files,
      selection: {
        maxStlFiles: input.maxStlFiles,
        maxDocumentationBytes: input.maxDocumentationBytes,
        omittedFiles: [],
      },
      openFile: async (file) => {
        const absolutePath = resolveUnderRoot(stagingRoot, file.path);
        if (!absolutePath) throw new Error(`Unsafe Source snapshot path: ${file.path}`);
        const stat = await lstat(absolutePath);
        return {
          stream: createReadStream(absolutePath),
          contentLengthBytes: stat.size,
        };
      },
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

function registerAndActivateSnapshot(input: {
  repo: AppRepository;
  sourceId: number;
  observed: SourceActivationObservation;
  snapshot: PublishedSourceSnapshot;
  sourceVersion: string;
  markRemoteCurrent: boolean;
  recordLegacyManifestCutover: boolean;
}): SourceSummary {
  const revision = input.repo.recordSourceRevision({
    sourceId: input.sourceId,
    upstreamRevisionKey: input.snapshot.upstreamRevisionKey,
    manifestDigest: input.snapshot.manifestDigest,
    snapshotLocator: input.snapshot.snapshotLocator,
    syncedAt: new Date().toISOString(),
    completeness: "complete",
  });
  const activated = input.repo.activateSourceRevision({
    sourceId: input.sourceId,
    revisionId: revision.id,
    observed: input.observed,
    sourceVersion: input.sourceVersion,
    recordLegacyManifestCutover: input.recordLegacyManifestCutover,
  });
  if (input.markRemoteCurrent) {
    input.repo.markSourceRevisionCurrent(input.sourceId, revision.id);
  }
  return activated;
}

export async function publishLocalSourceWorkingTree(input: {
  repo: AppRepository;
  reposDir: string;
  sourceId: number;
  workingTree: string;
  maxStlFiles?: number;
  maxDocumentationBytes?: number;
  maxTotalBytes?: number;
}): Promise<SourceSummary> {
  const observed = input.repo.getSourceActivationObservation(input.sourceId);
  if (!observed) throw new Error("Source not found");

  const maxStlFiles = input.maxStlFiles ?? DEFAULT_LOCAL_SNAPSHOT_STL_LIMIT;
  const maxDocumentationBytes = input.maxDocumentationBytes ?? DEFAULT_LOCAL_SNAPSHOT_DOCS_BYTES;
  const maxTotalBytes = input.maxTotalBytes ?? DEFAULT_LOCAL_SNAPSHOT_TOTAL_BYTES;
  const snapshot = await materializeLocalSourceWorkingTree({
    reposDir: input.reposDir,
    sourceId: input.sourceId,
    workingTree: input.workingTree,
    maxStlFiles,
    maxDocumentationBytes,
    maxTotalBytes,
  });
  return registerAndActivateSnapshot({
    repo: input.repo,
    sourceId: input.sourceId,
    observed,
    snapshot,
    sourceVersion: snapshot.upstreamRevisionKey,
    markRemoteCurrent: true,
    recordLegacyManifestCutover: false,
  });
}

export async function publishSourceManifestRevision(input: {
  repo: AppRepository;
  sourceId: number;
  manifestYaml: string;
  observed?: SourceActivationObservation;
}): Promise<SourceSummary> {
  try {
    loadManifestYaml(input.manifestYaml);
  } catch (error) {
    throw new InvalidSourceManifestError(
      error instanceof Error ? error.message : "Source manifest is invalid",
      { cause: error },
    );
  }

  const observed = input.observed
    ?? input.repo.getSourceActivationObservation(input.sourceId);
  if (!observed) throw new Error("Source not found");
  const source = input.repo.getProjectRow(input.sourceId);
  if (!source?.localPath) throw new SourceManifestContentUnavailableError();

  let snapshot: PublishedSourceSnapshot;
  if (observed.currentSourceRevisionId != null) {
    if (!observed.lastCommitSha) {
      throw new Error("Tracked Source has no upstream version");
    }
    const activeRevision = input.repo.getSourceRevision(observed.currentSourceRevisionId);
    if (!activeRevision || activeRevision.source_id !== input.sourceId) {
      throw new Error("Active Source revision is unavailable");
    }
    const expectedLocator = `${input.sourceId}/revisions/${activeRevision.upstream_revision_key}`;
    if (activeRevision.snapshot_locator !== expectedLocator) {
      throw new Error("Active Source revision has an unsupported snapshot locator");
    }
    snapshot = await new LocalSourceSnapshotStore({ reposDir: input.repo.reposDir })
      .deriveFileReplacement({
        sourceId: input.sourceId,
        baseRevisionKey: activeRevision.upstream_revision_key,
        sourceVersion: observed.lastCommitSha,
        replacement: {
          path: sourceRelativePath(SOURCE_MANIFEST_FILENAME),
          kind: "artifact",
          content: Buffer.from(input.manifestYaml),
        },
      });
  } else {
    snapshot = await materializeLocalSourceWorkingTree({
      reposDir: input.repo.reposDir,
      sourceId: input.sourceId,
      workingTree: source.localPath,
      manifestYaml: input.manifestYaml,
      maxStlFiles: DEFAULT_LOCAL_SNAPSHOT_STL_LIMIT,
      maxDocumentationBytes: DEFAULT_LOCAL_SNAPSHOT_DOCS_BYTES,
      maxTotalBytes: DEFAULT_LOCAL_SNAPSHOT_TOTAL_BYTES,
    });
  }

  return registerAndActivateSnapshot({
    repo: input.repo,
    sourceId: input.sourceId,
    observed,
    snapshot,
    sourceVersion: observed.lastCommitSha ?? snapshot.upstreamRevisionKey,
    markRemoteCurrent: false,
    recordLegacyManifestCutover: true,
  });
}
