import { Unzip, UnzipInflate } from "fflate";
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SourceSummary } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import { fileChunks } from "../lib/byte-chunks.js";
import { chargeTenantDiskBytes } from "../lib/tenant-disk-quota.js";
import { prepareLocalSourcePublication } from "./local-source-revision.js";
import { extractThreeMfMeshes } from "./three-mf-import.js";
import { MAX_SOURCE_UPLOAD_BYTES, SOURCE_UPLOAD_TOO_LARGE_DETAIL } from "./upload-limits.js";

const MAX_ZIP_ENTRIES = 10_000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
export const MAX_SOURCE_UPLOAD_FILES = MAX_ZIP_ENTRIES;
export const MAX_SOURCE_UPLOAD_PARTS = MAX_SOURCE_UPLOAD_FILES + 1;

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_EOCD_BYTES = 22;
const ZIP64_EOCD_LOCATOR_BYTES = 20;
const ZIP64_EOCD_BYTES = 56;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const INCOMPLETE_ZIP_DETAIL = "Upload is not a complete ZIP archive";

const WORKING_FILES = "files";
const WORKING_ARCHIVE = "upload.zip";

type ExtractLimits = {
  maxEntries?: number;
  maxUncompressedBytes?: number;
};

function readAt(descriptor: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = readSync(descriptor, buffer, 0, length, position);
  return buffer.subarray(0, read);
}

function declaredZipEntryCount(zipPath: string): number | null {
  const descriptor = openSync(zipPath, "r");
  try {
    const size = fstatSync(descriptor).size;
    const tailStart = Math.max(0, size - ZIP_EOCD_BYTES - ZIP_MAX_COMMENT_BYTES - ZIP64_EOCD_LOCATOR_BYTES);
    const tail = readAt(descriptor, tailStart, size - tailStart);
    for (let offset = tail.length - ZIP_EOCD_BYTES; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue;
      const entries = tail.readUInt16LE(offset + 10);
      if (entries !== 0xffff) return entries;
      const locator = offset - ZIP64_EOCD_LOCATOR_BYTES;
      if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_EOCD_LOCATOR_SIGNATURE) return null;
      const recordOffset = Number(tail.readBigUInt64LE(locator + 8));
      if (!Number.isSafeInteger(recordOffset) || recordOffset + ZIP64_EOCD_BYTES > size) return null;
      const record = readAt(descriptor, recordOffset, ZIP64_EOCD_BYTES);
      if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) return null;
      return Number(record.readBigUInt64LE(32));
    }
    return null;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Extract entries one by one instead of `extractAllTo` so each entry path is
 * validated against zip-slip, and total uncompressed size / entry count are
 * bounded against zip bombs. fflate's streaming Unzip reads only local file
 * headers, so a truncated archive extracts without error. The streamed entry
 * count must match the end-of-central-directory record.
 */
export function extractZipFile(zipPath: string, destDir: string, limits: ExtractLimits = {}): number {
  const maxEntries = limits.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxBytes = limits.maxUncompressedBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES;
  const declaredEntries = declaredZipEntryCount(zipPath);
  if (declaredEntries === null) throw new Error(INCOMPLETE_ZIP_DETAIL);
  const base = resolve(destDir);
  mkdirSync(base, { recursive: true });
  let totalBytes = 0;
  let stlCount = 0;
  let entryCount = 0;
  let fileCount = 0;
  let failure: Error | null = null;
  const unzip = new Unzip((file) => {
    entryCount += 1;
    if (entryCount > maxEntries) {
      failure = new Error(`Archive has too many entries (${entryCount}, max ${maxEntries})`);
      file.terminate();
      return;
    }
    let entryName: string;
    let target: string;
    try {
      entryName = sanitizeRelativeEntryPath(file.name);
      target = resolveSafeTarget(base, entryName);
    } catch (error) {
      failure = error instanceof Error ? new Error(`Archive entry escapes extraction directory: ${file.name}`) : new Error("Unsafe archive entry");
      file.terminate();
      return;
    }
    if (entryName.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      file.terminate();
      return;
    }
    if (file.originalSize != null && totalBytes + file.originalSize > maxBytes) {
      failure = new Error("Archive uncompressed size exceeds limit");
      file.terminate();
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    let started = false;
    file.ondata = (error, chunk, final) => {
      if (error) {
        failure = error;
        return;
      }
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        failure = new Error("Archive uncompressed size exceeds limit");
        file.terminate();
        return;
      }
      if (!started) {
        chargeTenantDiskBytes(chunk.length);
        writeFileSync(target, chunk);
        started = true;
      } else if (chunk.length > 0) {
        chargeTenantDiskBytes(chunk.length);
        appendFileSync(target, chunk);
      }
      if (final && !started) writeFileSync(target, Buffer.alloc(0));
    };
    fileCount += 1;
    if (entryName.toLowerCase().endsWith(".stl")) stlCount += 1;
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (const [chunk, final] of fileChunks(zipPath)) {
      unzip.push(chunk, final);
      if (failure) break;
    }
  } catch (error) {
    if (!failure) throw error;
  }
  if (failure) throw failure;
  if (entryCount !== declaredEntries) throw new Error(INCOMPLETE_ZIP_DETAIL);
  if (fileCount === 0) throw new Error("ZIP archive contains no files");
  return stlCount;
}

export class SourceUploadTooLargeError extends Error {
  constructor() {
    super(SOURCE_UPLOAD_TOO_LARGE_DETAIL);
    this.name = "SourceUploadTooLargeError";
  }
}

/** Staging sits beside the Source directories so publishing is a rename, outside the per-Source quota scan. */
export function createSourceUploadStaging(sourcesDir: string): string {
  mkdirSync(sourcesDir, { recursive: true });
  return mkdtempSync(join(sourcesDir, ".upload-"));
}

/** Write one uploaded file to disk, failing as soon as it passes the byte budget. */
export async function streamSourceUpload(
  file: Readable & { truncated?: boolean },
  path: string,
  maxBytes: number,
): Promise<number> {
  let written = 0;
  const budget = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      written += chunk.length;
      if (written > maxBytes) done(new SourceUploadTooLargeError());
      else done(null, chunk);
    },
  });
  await pipeline(file, budget, createWriteStream(path, { flags: "wx" }));
  if (file.truncated) throw new SourceUploadTooLargeError();
  return written;
}

function sanitizeRelativeEntryPath(relativePath: string): string {
  const entryName = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!entryName || entryName === "." || entryName.split("/").includes("..")) {
    throw new Error(`File path escapes extraction directory: ${relativePath}`);
  }
  return entryName;
}

function resolveSafeTarget(base: string, relativePath: string): string {
  const entryName = sanitizeRelativeEntryPath(relativePath);
  const target = resolve(base, entryName);
  if (!target.startsWith(base + sep)) {
    throw new Error(`File path escapes extraction directory: ${relativePath}`);
  }
  return target;
}

export function discoverImportRules(extractDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(extractDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory());
  const printableFiles = entries.filter(
    (entry) => entry.isFile() && /\.(?:stl|3mf)$/i.test(entry.name),
  );
  if (dirs.length === 1 && printableFiles.length === 0) {
    return [`${dirs[0]!.name}/`];
  }
  const rules: string[] = [];
  for (const dir of dirs) rules.push(`${dir.name}/`);
  for (const file of printableFiles) rules.push(file.name);
  return rules;
}

export type StagedSource = Readonly<{
  extractDir: string;
  archive: string | null;
  stlCount: number;
  suggestedImportRules: string[];
}>;

function storedBytes(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  walk(root);
  return total;
}

function expandThreeMfFiles(extractDir: string, maxTotalBytes = MAX_ZIP_UNCOMPRESSED_BYTES): number {
  const paths: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "_3mf") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith(".3mf")) paths.push(full);
    }
  };
  walk(extractDir);
  let derivedStlCount = 0;
  let remainingBytes = maxTotalBytes - storedBytes(extractDir);
  if (remainingBytes < 0) throw new Error("Uploaded source exceeds the total size limit");
  for (const path of paths) {
    const result = extractThreeMfMeshes(fileChunks(path), extractDir, path, { maxOutputBytes: remainingBytes });
    derivedStlCount += result.files.length;
    remainingBytes -= result.files.reduce((total, file) => total + file.byteSize, 0);
  }
  return derivedStlCount;
}

export function stageUploadedFiles(
  files: Array<{ relativePath: string; path: string }>,
  staging: string,
): StagedSource {
  if (!files.length) throw new Error("At least one file is required");
  const staged = files.map((file) => ({ ...file, bytes: statSync(file.path).size }));
  const uploadedBytes = staged.reduce((total, file) => total + file.bytes, 0);
  if (uploadedBytes > MAX_SOURCE_UPLOAD_BYTES) {
    throw new SourceUploadTooLargeError();
  }
  const extractDir = join(staging, WORKING_FILES);
  mkdirSync(extractDir);
  const base = resolve(extractDir);
  let stlCount = 0;
  for (const file of staged) {
    const target = resolveSafeTarget(base, file.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    chargeTenantDiskBytes(file.bytes);
    renameSync(file.path, target);
    if (file.relativePath.toLowerCase().endsWith(".stl")) stlCount += 1;
  }
  stlCount += expandThreeMfFiles(extractDir);
  return {
    extractDir,
    archive: null,
    stlCount,
    suggestedImportRules: discoverImportRules(extractDir),
  };
}

export function stageUploadedZip(zipPath: string, staging: string): StagedSource {
  const extractDir = join(staging, WORKING_FILES);
  chargeTenantDiskBytes(statSync(zipPath).size);
  extractZipFile(zipPath, extractDir);
  expandThreeMfFiles(extractDir);
  return {
    extractDir,
    archive: zipPath,
    stlCount: countStlFiles(extractDir),
    suggestedImportRules: discoverImportRules(extractDir),
  };
}

function countStlFiles(dir: string): number {
  let stlCount = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) stlCount += countStlFiles(join(dir, entry.name));
    else if (entry.name.toLowerCase().endsWith(".stl")) stlCount += 1;
  }
  return stlCount;
}

function replaceSourceWorkingFiles(staged: StagedSource, sourcesDir: string, sourceId: number): string {
  const dir = join(sourcesDir, String(sourceId));
  mkdirSync(dir, { recursive: true });
  const retired = mkdtempSync(join(sourcesDir, ".retired-"));
  const moves: Array<[from: string, name: string]> = [[staged.extractDir, WORKING_FILES]];
  if (staged.archive) moves.push([staged.archive, WORKING_ARCHIVE]);
  const installed = new Set<string>();
  try {
    for (const [from, name] of moves) {
      if (existsSync(join(dir, name))) renameSync(join(dir, name), join(retired, name));
      renameSync(from, join(dir, name));
      installed.add(name);
    }
  } catch (error) {
    for (const [, name] of moves) {
      if (installed.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
      if (existsSync(join(retired, name))) renameSync(join(retired, name), join(dir, name));
    }
    rmSync(retired, { recursive: true, force: true });
    throw error;
  }
  rmSync(retired, { recursive: true, force: true });
  return join(dir, WORKING_FILES);
}

export async function publishStagedSource(input: {
  repo: AppRepository;
  reposDir: string;
  sourcesDir: string;
  sourceId: number;
  staged: StagedSource;
}): Promise<{ source: SourceSummary; workingFiles: string }> {
  const activate = await prepareLocalSourcePublication({
    repo: input.repo,
    reposDir: input.reposDir,
    sourceId: input.sourceId,
    workingTree: input.staged.extractDir,
  });
  const source = activate();
  const workingFiles = replaceSourceWorkingFiles(input.staged, input.sourcesDir, input.sourceId);
  const existingRules = input.repo.getProjectRow(input.sourceId)?.importedPaths?.trim();
  if ((!existingRules || existingRules === "[]") && input.staged.suggestedImportRules.length > 0) {
    input.repo.updateImportRules(input.sourceId, input.staged.suggestedImportRules);
  }
  return { source, workingFiles };
}
