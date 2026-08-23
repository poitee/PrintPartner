import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { SourceSummary } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import {
  LocalSourceSnapshotStore,
  sourceRelativePath,
  type SnapshotFile,
  type SnapshotFileKind,
} from "./local-source-snapshot.js";

export const DEFAULT_LOCAL_SNAPSHOT_STL_LIMIT = 500;
export const DEFAULT_LOCAL_SNAPSHOT_DOCS_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_LOCAL_SNAPSHOT_TOTAL_BYTES = 1024 * 1024 * 1024;

type CollectedSnapshotFile = {
  relativePath: string;
  absolutePath: string;
  kind: SnapshotFileKind;
  sizeHintBytes: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifySnapshotPath(path: string): SnapshotFileKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".stl")) return "stl";
  if (lower.endsWith(".3mf") || lower.endsWith(".zip")) return "artifact";
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

async function collectSnapshotFiles(root: string): Promise<CollectedSnapshotFile[]> {
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
  files: readonly CollectedSnapshotFile[];
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

export async function publishLocalSourceWorkingTree(input: {
  repo: AppRepository;
  reposDir: string;
  sourceId: number;
  workingTree: string;
  maxStlFiles?: number;
  maxDocumentationBytes?: number;
  maxTotalBytes?: number;
}): Promise<SourceSummary> {
  const observed = input.repo.getProjectRow(input.sourceId);
  if (!observed) throw new Error("Source not found");

  const maxStlFiles = input.maxStlFiles ?? DEFAULT_LOCAL_SNAPSHOT_STL_LIMIT;
  const maxDocumentationBytes = input.maxDocumentationBytes ?? DEFAULT_LOCAL_SNAPSHOT_DOCS_BYTES;
  const maxTotalBytes = input.maxTotalBytes ?? DEFAULT_LOCAL_SNAPSHOT_TOTAL_BYTES;
  const liveFiles = await collectSnapshotFiles(input.workingTree);
  assertSnapshotResourceLimits({
    files: liveFiles,
    maxStlFiles,
    maxDocumentationBytes,
    maxTotalBytes,
  });
  await mkdir(input.reposDir, { recursive: true });
  const stagingRoot = await mkdtemp(join(input.reposDir, ".local-source-"));
  let snapshot: Awaited<ReturnType<LocalSourceSnapshotStore["materialize"]>>;
  try {
    for (const file of liveFiles) {
      const stagedPath = resolveUnderRoot(stagingRoot, file.relativePath);
      if (!stagedPath) throw new Error(`Unsafe Source snapshot path: ${file.relativePath}`);
      await mkdir(dirname(stagedPath), { recursive: true });
      await copyFile(file.absolutePath, stagedPath);
    }
    const collected = await collectSnapshotFiles(stagingRoot);
    assertSnapshotResourceLimits({
      files: collected,
      maxStlFiles,
      maxDocumentationBytes,
      maxTotalBytes,
    });

    const upstreamRevisionKey = await digestWorkingTree(collected);
    const files: SnapshotFile[] = collected.map((file) => ({
      path: sourceRelativePath(file.relativePath),
      kind: file.kind,
      sizeHintBytes: file.sizeHintBytes,
    }));
    const store = new LocalSourceSnapshotStore({ reposDir: input.reposDir });
    snapshot = await store.materialize({
      sourceId: input.sourceId,
      upstreamRevisionKey,
      files,
      selection: {
        maxStlFiles,
        maxDocumentationBytes,
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

  const revision = input.repo.recordSourceRevision({
    sourceId: input.sourceId,
    upstreamRevisionKey: snapshot.upstreamRevisionKey,
    manifestDigest: snapshot.manifestDigest,
    snapshotLocator: snapshot.snapshotLocator,
    syncedAt: new Date().toISOString(),
    completeness: "complete",
  });
  const activated = input.repo.activateSourceRevision({
    sourceId: input.sourceId,
    revisionId: revision.id,
    observed,
  });
  input.repo.markSourceRevisionCurrent(input.sourceId, revision.id);
  return activated;
}
