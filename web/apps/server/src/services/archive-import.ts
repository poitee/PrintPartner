import AdmZip from "adm-zip";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB

export type ExtractLimits = {
  maxEntries?: number;
  maxUncompressedBytes?: number;
};

/**
 * Extract entries one by one instead of `extractAllTo` so each entry path is
 * validated against zip-slip, and total uncompressed size / entry count are
 * bounded against zip bombs.
 */
function extractEntries(zip: AdmZip, destDir: string, limits: ExtractLimits = {}): number {
  const maxEntries = limits.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxBytes = limits.maxUncompressedBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES;
  const base = resolve(destDir);
  mkdirSync(base, { recursive: true });
  const entries = zip.getEntries();
  if (entries.length > maxEntries) {
    throw new Error(`Archive has too many entries (${entries.length}, max ${maxEntries})`);
  }
  let totalBytes = 0;
  let stlCount = 0;
  for (const entry of entries) {
    // Zip-slip guard: normalize separators, strip leading slashes, reject any
    // ".." segment, and require the resolved target to stay under destDir.
    const entryName = entry.entryName.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!entryName || entryName === "." || entryName.split("/").includes("..")) {
      throw new Error(`Archive entry escapes extraction directory: ${entry.entryName}`);
    }
    const target = resolve(base, entryName);
    if (!target.startsWith(base + sep)) {
      throw new Error(`Archive entry escapes extraction directory: ${entry.entryName}`);
    }
    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (totalBytes + entry.header.size > maxBytes) {
      throw new Error("Archive uncompressed size exceeds limit");
    }
    const data = entry.getData();
    totalBytes += data.length; // header sizes can lie; count real bytes
    if (totalBytes > maxBytes) {
      throw new Error("Archive uncompressed size exceeds limit");
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    if (entry.entryName.toLowerCase().endsWith(".stl")) stlCount++;
  }
  return stlCount;
}

export function extractZipToDir(zipPath: string, destDir: string, limits?: ExtractLimits): number {
  return extractEntries(new AdmZip(zipPath), destDir, limits);
}

export function extractZipBuffer(buffer: Buffer, destDir: string, limits?: ExtractLimits): number {
  return extractEntries(new AdmZip(buffer), destDir, limits);
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
  const stls = entries.filter(
    (e) => e.isFile() && e.name.toLowerCase().endsWith(".stl"),
  );
  if (dirs.length === 1 && stls.length === 0) {
    return [`${dirs[0]!.name}/`];
  }
  const rules: string[] = [];
  for (const dir of dirs) rules.push(`${dir.name}/`);
  for (const stl of stls) rules.push(stl.name);
  return rules;
}

export type UploadedFilesResult = {
  extractDir: string;
  fileCount: number;
  stlCount: number;
  suggestedImportRules: string[];
};

export function writeUploadedFiles(
  files: Array<{ relativePath: string; buffer: Buffer }>,
  sourcesDir: string,
  sourceId: number,
): UploadedFilesResult {
  if (!files.length) throw new Error("At least one file is required");
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
  for (const file of files) {
    const target = resolveSafeTarget(base, file.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.buffer);
    if (file.relativePath.toLowerCase().endsWith(".stl")) stlCount += 1;
  }
  return {
    extractDir,
    fileCount: files.length,
    stlCount,
    suggestedImportRules: discoverImportRules(extractDir),
  };
}

export function writeUploadedZip(buffer: Buffer, sourcesDir: string, sourceId: number): string {
  const dir = join(sourcesDir, String(sourceId));
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, "upload.zip");
  writeFileSync(zipPath, buffer);
  const extractDir = join(dir, "files");
  try {
    rmSync(extractDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  extractZipBuffer(buffer, extractDir);
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
