import { Unzip, UnzipInflate } from "fflate";
import {
  appendFileSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileChunks } from "../lib/byte-chunks.js";
import { chargeTenantDiskBytes } from "../lib/tenant-disk-quota.js";
import { extractThreeMfMeshes } from "./three-mf-import.js";
import { MAX_SOURCE_UPLOAD_BYTES, SOURCE_UPLOAD_TOO_LARGE_DETAIL } from "./upload-limits.js";

const MAX_ZIP_ENTRIES = 10_000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
export const MAX_SOURCE_UPLOAD_FILES = MAX_ZIP_ENTRIES;
export const MAX_SOURCE_UPLOAD_PARTS = MAX_SOURCE_UPLOAD_FILES + 1;

type ExtractLimits = {
  maxEntries?: number;
  maxUncompressedBytes?: number;
};

/**
 * Extract entries one by one instead of `extractAllTo` so each entry path is
 * validated against zip-slip, and total uncompressed size / entry count are
 * bounded against zip bombs.
 */
export function extractZipFile(zipPath: string, destDir: string, limits: ExtractLimits = {}): number {
  const maxEntries = limits.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxBytes = limits.maxUncompressedBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES;
  const base = resolve(destDir);
  mkdirSync(base, { recursive: true });
  let totalBytes = 0;
  let stlCount = 0;
  let entryCount = 0;
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

type UploadedFilesResult = {
  extractDir: string;
  fileCount: number;
  stlCount: number;
  suggestedImportRules: string[];
};

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

/** Move staged uploads into the Source's file tree. */
export function writeUploadedFiles(
  files: Array<{ relativePath: string; path: string }>,
  sourcesDir: string,
  sourceId: number,
): UploadedFilesResult {
  if (!files.length) throw new Error("At least one file is required");
  const staged = files.map((file) => ({ ...file, bytes: statSync(file.path).size }));
  const uploadedBytes = staged.reduce((total, file) => total + file.bytes, 0);
  if (uploadedBytes > MAX_SOURCE_UPLOAD_BYTES) {
    throw new SourceUploadTooLargeError();
  }
  const dir = join(sourcesDir, String(sourceId));
  mkdirSync(dir, { recursive: true });
  const extractDir = join(dir, "files");
  try {
    rmSync(extractDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  mkdirSync(extractDir, { recursive: true });
  const base = resolve(extractDir);
  let stlCount = 0;
  try {
    for (const file of staged) {
      const target = resolveSafeTarget(base, file.relativePath);
      mkdirSync(dirname(target), { recursive: true });
      chargeTenantDiskBytes(file.bytes);
      renameSync(file.path, target);
      if (file.relativePath.toLowerCase().endsWith(".stl")) stlCount += 1;
    }
    stlCount += expandThreeMfFiles(extractDir);
  } catch (error) {
    rmSync(extractDir, { recursive: true, force: true });
    throw error;
  }
  return {
    extractDir,
    fileCount: files.length,
    stlCount,
    suggestedImportRules: discoverImportRules(extractDir),
  };
}

/** Move a staged ZIP into the Source directory and extract it. */
export function writeUploadedZip(stagedZip: string, sourcesDir: string, sourceId: number): string {
  const dir = join(sourcesDir, String(sourceId));
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, "upload.zip");
  const extractDir = join(dir, "files");
  try {
    rmSync(extractDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    chargeTenantDiskBytes(statSync(stagedZip).size);
    renameSync(stagedZip, zipPath);
    extractZipFile(zipPath, extractDir);
    expandThreeMfFiles(extractDir);
  } catch (error) {
    rmSync(zipPath, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
    throw error;
  }
  return extractDir;
}

export function finalizeUploadedSource(
  extractDir: string,
): { suggestedImportRules: string[]; stlCount: number } {
  let stlCount = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith(".stl")) stlCount += 1;
    }
  };
  try {
    walk(extractDir);
  } catch {
    /* ignore */
  }
  return {
    suggestedImportRules: discoverImportRules(extractDir),
    stlCount,
  };
}
