import { Unzip, UnzipInflate } from "fflate";
import * as zlib from "node:zlib";
import { InvalidSourceArchiveError, readZipDirectory } from "./zip-directory.js";
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
import { tenantSourceUploadPrefix } from "../lib/secure-path.js";
import { chargeTenantDiskBytes } from "../lib/tenant-disk-quota.js";
import { extractThreeMfMeshes } from "./three-mf-import.js";
import { MAX_SOURCE_UPLOAD_BYTES, SOURCE_UPLOAD_TOO_LARGE_DETAIL } from "./upload-limits.js";

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

const crc32 = zlib.crc32 ?? ((bytes: Uint8Array, previous = 0): number => {
  let checksum = previous ^ 0xffffffff;
  for (const byte of bytes) {
    checksum = (checksum >>> 8) ^ CRC32_TABLE[(checksum ^ byte) & 0xff]!;
  }
  return (checksum ^ 0xffffffff) >>> 0;
});

const MAX_ZIP_ENTRIES = 10_000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
export const MAX_SOURCE_UPLOAD_FILES = MAX_ZIP_ENTRIES;
export const MAX_SOURCE_UPLOAD_PARTS = MAX_SOURCE_UPLOAD_FILES + 1;

type ExtractLimits = {
  maxEntries?: number;
  maxUncompressedBytes?: number;
};

type ValidationBudget = {
  remainingEntries: number;
  remainingBytes: number;
};

function validationBudget(limits: ExtractLimits): ValidationBudget {
  return {
    remainingEntries: limits.maxEntries ?? MAX_ZIP_ENTRIES,
    remainingBytes: limits.maxUncompressedBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES,
  };
}

/**
 * Extract entries one by one instead of `extractAllTo` so each entry path is
 * validated against zip-slip, and total uncompressed size / entry count are
 * bounded against zip bombs.
 */
export function extractZipFile(zipPath: string, destDir: string, limits: ExtractLimits = {}): number {
  return processZipFile(zipPath, destDir, limits);
}

function processZipFile(
  zipPath: string,
  destDir: string | null,
  limits: ExtractLimits = {},
  budget = validationBudget(limits),
  directory = readZipDirectory(zipPath, Math.min(limits.maxEntries ?? MAX_ZIP_ENTRIES, budget.remainingEntries)),
): number {
  const maxEntries = limits.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxBytes = limits.maxUncompressedBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES;
  const entries = new Map(directory.map((entry) => [entry.name, entry]));
  if (directory.reduce((total, entry) => total + entry.size, 0) > Math.min(maxBytes, budget.remainingBytes)) {
    throw new Error("Archive uncompressed size exceeds limit");
  }
  const base = resolve(destDir ?? ".");
  if (destDir) mkdirSync(base, { recursive: true });
  const targets = new Set<string>();
  let completed = 0;
  let totalBytes = 0;
  let stlCount = 0;
  let entryCount = 0;
  let failure: Error | null = null;
  const unzip = new Unzip((file) => {
    if (failure) {
      file.terminate();
      return;
    }
    const expected = entries.get(file.name);
    if (!expected) throw new InvalidSourceArchiveError();
    entries.delete(file.name);
    entryCount += 1;
    budget.remainingEntries -= 1;
    if (entryCount > maxEntries || budget.remainingEntries < 0) {
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
    if (targets.has(target)) throw new Error(`Archive has duplicate path: ${entryName}`);
    targets.add(target);
    const directory = entryName.endsWith("/");
    if (directory && destDir) mkdirSync(target, { recursive: true });
    if (file.originalSize != null && (totalBytes + file.originalSize > maxBytes || file.originalSize > budget.remainingBytes)) {
      failure = new Error("Archive uncompressed size exceeds limit");
      file.terminate();
      return;
    }
    if (destDir) mkdirSync(dirname(target), { recursive: true });
    let started = false;
    let bytes = 0;
    let checksum = 0;
    file.ondata = (error, chunk, final) => {
      if (error) {
        failure = error;
        return;
      }
      totalBytes += chunk.length;
      budget.remainingBytes -= chunk.length;
      if (totalBytes > maxBytes || budget.remainingBytes < 0) {
        failure = new Error("Archive uncompressed size exceeds limit");
        file.terminate();
        return;
      }
      bytes += chunk.length;
      checksum = crc32(chunk, checksum);
      if (final) {
        if (bytes !== expected.size || checksum !== expected.crc) {
          failure = new InvalidSourceArchiveError();
          return;
        }
        completed += 1;
      }
      if (!destDir || directory) return;
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
  if (entries.size || completed !== entryCount) throw new InvalidSourceArchiveError();
  return stlCount;
}

export class SourceUploadTooLargeError extends Error {
  constructor() {
    super(SOURCE_UPLOAD_TOO_LARGE_DETAIL);
    this.name = "SourceUploadTooLargeError";
  }
}

export function createSourceUploadStaging(sourcesDir: string, tenantId: string): string {
  mkdirSync(sourcesDir, { recursive: true });
  return mkdtempSync(join(sourcesDir, tenantSourceUploadPrefix(tenantId)));
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

function expandThreeMfFiles(extractDir: string, limits: ExtractLimits, budget: ValidationBudget): number {
  const maxTotalBytes = limits.maxUncompressedBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES;
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
  let declaredEntriesRemaining = budget.remainingEntries;
  let declaredBytesRemaining = budget.remainingBytes;
  const children = paths.map((path) => {
    const directory = readZipDirectory(path, Math.min(limits.maxEntries ?? MAX_ZIP_ENTRIES, declaredEntriesRemaining));
    declaredEntriesRemaining -= directory.length;
    declaredBytesRemaining -= directory.reduce((total, entry) => total + entry.size, 0);
    if (declaredBytesRemaining < 0) throw new Error("Nested 3MF uncompressed size exceeds limit");
    return { path, directory };
  });
  for (const { path, directory } of children) {
    processZipFile(path, null, limits, budget, directory);
    const result = extractThreeMfMeshes(fileChunks(path), extractDir, path, { maxOutputBytes: remainingBytes });
    derivedStlCount += result.files.length;
    remainingBytes -= result.files.reduce((total, file) => total + file.byteSize, 0);
  }
  return derivedStlCount;
}


export function writeUploadedFiles(
  files: Array<{ relativePath: string; path: string }>,
  stagingDir: string,
  limits: ExtractLimits = {},
): UploadedFilesResult {
  if (!files.length) throw new Error("At least one file is required");
  const budget = validationBudget(limits);
  if (files.length > budget.remainingEntries) {
    throw new Error(`Archive has too many entries (${files.length}, max ${budget.remainingEntries})`);
  }
  const staged = files.map((file) => ({ ...file, bytes: statSync(file.path).size }));
  const uploadedBytes = staged.reduce((total, file) => total + file.bytes, 0);
  if (uploadedBytes > MAX_SOURCE_UPLOAD_BYTES) {
    throw new SourceUploadTooLargeError();
  }
  budget.remainingEntries -= files.length;
  budget.remainingBytes -= uploadedBytes;
  if (budget.remainingBytes < 0) throw new Error("Uploaded source exceeds the total size limit");
  const extractDir = join(stagingDir, "files");
  mkdirSync(extractDir);
  const base = resolve(extractDir);
  const targets = new Set<string>();
  let stlCount = 0;
  try {
    for (const file of staged) {
      const target = resolveSafeTarget(base, file.relativePath);
      if (targets.has(target)) throw new Error(`Duplicate uploaded file path: ${file.relativePath}`);
      targets.add(target);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(file.path, target);
      if (file.relativePath.toLowerCase().endsWith(".stl")) stlCount += 1;
    }
    stlCount += expandThreeMfFiles(extractDir, limits, budget);
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

export function writeUploadedZip(stagedZip: string, stagingDir: string, limits: ExtractLimits = {}): string {
  const budget = validationBudget(limits);
  const extractDir = join(stagingDir, "files");
  mkdirSync(extractDir);
  try {
    processZipFile(stagedZip, extractDir, limits, budget);
    expandThreeMfFiles(extractDir, limits, budget);
  } catch (error) {
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
