import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Zip, ZipPassThrough } from "fflate";
import { acceptedPlateZipEpoch, folderKeyFromRelativePath } from "@print-partner/domain";
import type { AcceptedPlanBasis } from "../db/accepted-plan-progress.js";
import { openVerifiedAcceptedArtifact } from "./accepted-artifacts.js";
import { ACCEPTED_PART_MESH_MAX_BYTES } from "./accepted-part-media.js";
import type {
  AcceptedExportPart,
  CaptureAcceptedOperationalExportResult,
} from "./accepted-operational-export.js";

const ROLE_ORDER = ["primary", "accent", "clear", "opaque"] as const;
const MAX_TOTAL_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_SELECTED_UNITS = 10_000;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

export type StlPackGroupBy = "color" | "color_dir";
export type AcceptedStlBundleSelection = "all" | "missing";

export const STL_EXPORT_MISSING_HINT =
  "Sync Sources and fix Review blockers, then export again.";

export type AcceptedStlBundleWarning = Readonly<{
  code: "artifact_unavailable";
  relativePath: string;
  sourceLayer: string;
}>;

export type MaterializeAcceptedStlBundleResult =
  | {
      readonly kind: "materialized";
      readonly basis: AcceptedPlanBasis | null;
      readonly rootPath: string;
      readonly bundlePath: string | null;
      readonly fileCounts: Readonly<Record<string, number>>;
      readonly warnings: readonly AcceptedStlBundleWarning[];
    }
  | { readonly kind: "output_failure" }
  | { readonly kind: "limit_exceeded" };

type SelectedPart = Readonly<{
  part: AcceptedExportPart;
  units: readonly number[];
}>;

type ExpectedFile = Readonly<{
  relativePath: string;
  size: number;
  sha256: string;
}>;

function safeFolderName(folderKey: string): string {
  if (folderKey === "(root)") return "_root";
  const safe = folderKey.replace(/\//g, "_").replace(/[^\w\-.]+/g, "_");
  return !safe || safe === "." || safe === ".." ? "_root" : safe;
}

function entryName(part: AcceptedExportPart, unit: number, usedNames: Set<string>): string {
  const stem = basename(part.filename, ".stl") || part.filename;
  const base = `${stem}_${String(unit).padStart(2, "0")}.stl`;
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }
  const parent = folderKeyFromRelativePath(part.relativePath);
  const prefix = parent.replace(/\//g, "_").replace(/[^\w\-.]+/g, "_");
  const collisionBase = prefix && prefix !== "(root)"
    ? `${prefix}_${base}`
    : `${part.partKey.slice(0, 40).replace(/[^\w\-.]+/g, "_")}_${base}`;
  let candidate = collisionBase;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${basename(collisionBase, ".stl")}_${suffix}.stl`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function isUnderRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function ensureDirectoryPath(root: string, segments: readonly string[]): string | null {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") return null;
    }
    try {
      const stats = lstatSync(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
      const resolved = realpathSync(current);
      if (!isUnderRoot(root, resolved)) return null;
      current = resolved;
    } catch {
      return null;
    }
  }
  return current;
}

function writeChunk(descriptor: number, chunk: Uint8Array, start: number): number {
  let position = 0;
  while (position < chunk.length) {
    const written = writeSync(
      descriptor,
      chunk,
      position,
      chunk.length - position,
      start + position,
    );
    if (written === 0) throw new Error("Accepted STL export write made no progress");
    position += written;
  }
  return start + chunk.length;
}

async function writeVerifiedStream(
  path: string,
  createStream: () => ReturnType<typeof createReadStream>,
  expected: Readonly<{ size: number; sha256: string }>,
): Promise<boolean> {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let position = 0;
  let valid = false;
  try {
    const hash = createHash("sha256");
    for await (const chunk of createStream()) {
      hash.update(chunk);
      position = writeChunk(descriptor, chunk, position);
    }
    valid = position === expected.size && hash.digest("hex") === expected.sha256;
    if (valid) fsyncSync(descriptor);
    return valid;
  } finally {
    closeSync(descriptor);
    if (!valid) rmSync(path, { force: true });
  }
}

function writeLease(
  path: string,
  lease: {
    readonly size: number;
    readonly expectedSha256: string;
    createReadStream(): ReturnType<typeof createReadStream>;
  },
): Promise<boolean> {
  return writeVerifiedStream(path, () => lease.createReadStream(), {
    size: lease.size,
    sha256: lease.expectedSha256,
  });
}

function copyVerifiedStagedFile(path: string, source: string, expected: ExpectedFile): Promise<boolean> {
  return writeVerifiedStream(path, () => createReadStream(source), expected);
}

function hashRegularFile(path: string): string | null {
  let descriptor: number | null = null;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (descriptor != null) closeSync(descriptor);
  }
}

async function writeZip(
  root: string,
  files: readonly ExpectedFile[],
  target: string,
  maxBytes: number,
): Promise<
  | { readonly kind: "written"; readonly file: ExpectedFile }
  | { readonly kind: "limit_exceeded" }
> {
  const descriptor = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let position = 0;
  let zipError: Error | null = null;
  let limitExceeded = false;
  const archive = new Zip((error, chunk) => {
    if (error) {
      zipError = error;
      return;
    }
    if (position + chunk.length > maxBytes) {
      limitExceeded = true;
      return;
    }
    position = writeChunk(descriptor, chunk, position);
  });
  try {
    for (const file of files) {
      const entry = new ZipPassThrough(file.relativePath);
      entry.mtime = acceptedPlateZipEpoch();
      archive.add(entry);
      for await (const chunk of createReadStream(join(root, ...file.relativePath.split("/")))) {
        entry.push(chunk);
        if (limitExceeded) return { kind: "limit_exceeded" };
      }
      entry.push(new Uint8Array(), true);
      if (zipError) throw zipError;
      if (limitExceeded) return { kind: "limit_exceeded" };
    }
    archive.end();
    if (zipError) throw zipError;
    if (limitExceeded) return { kind: "limit_exceeded" };
    fsyncSync(descriptor);
  } finally {
    archive.terminate();
    closeSync(descriptor);
  }
  return {
    kind: "written",
    file: {
      relativePath: "accepted-stl.zip",
      size: position,
      sha256: hashRegularFile(target) ?? "",
    },
  };
}

function expectedDirectories(files: readonly ExpectedFile[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.relativePath.split("/").slice(0, -1);
    for (let index = 1; index <= parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return [...directories].sort();
}

function treeEntries(
  root: string,
  directory = root,
  prefix = "",
): { files: string[]; directories: string[] } | null {
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
  if (!isUnderRoot(root, realpathSync(directory))) return null;
  const files: string[] = [];
  const directories: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return null;
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile()) {
      files.push(entryPath);
      continue;
    }
    if (!entry.isDirectory()) return null;
    directories.push(entryPath);
    const nested = treeEntries(root, join(directory, entry.name), entryPath);
    if (!nested) return null;
    files.push(...nested.files);
    directories.push(...nested.directories);
  }
  return { files, directories };
}

function publishedTreeMatches(directory: string, expected: readonly ExpectedFile[]): boolean {
  try {
    const actual = treeEntries(directory);
    if (!actual) return false;
    if (actual.files.sort().join("\0") !== expected.map((file) => file.relativePath).sort().join("\0")) {
      return false;
    }
    if (actual.directories.sort().join("\0") !== expectedDirectories(expected).join("\0")) {
      return false;
    }
    return expected.every((file) => {
      const path = join(directory, ...file.relativePath.split("/"));
      const stats = lstatSync(path);
      return stats.isFile() && !stats.isSymbolicLink() && stats.size === file.size && hashRegularFile(path) === file.sha256;
    });
  } catch {
    return false;
  }
}

function publicationKey(
  files: readonly ExpectedFile[],
  warnings: readonly AcceptedStlBundleWarning[],
): string {
  const identity = {
    files: files
      .map((file) => ({
        relativePath: file.relativePath,
        size: file.size,
        sha256: file.sha256,
      }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    warnings: warnings
      .map((warning) => ({
        code: warning.code,
        relativePath: warning.relativePath,
        sourceLayer: warning.sourceLayer,
      }))
      .sort((left, right) =>
        `${left.relativePath}\0${left.sourceLayer}`.localeCompare(
          `${right.relativePath}\0${right.sourceLayer}`,
        ),
      ),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function acceptedArtifactDescriptorKey(part: AcceptedExportPart): string {
  const artifact = part.artifact;
  if (artifact.kind === "unavailable") return `unavailable:${part.revisionPartId}`;
  return JSON.stringify([
    artifact.sourceId,
    artifact.sourceRevisionId,
    artifact.snapshotRoot,
    artifact.relativePath,
    artifact.expectedSha256,
  ]);
}

function publish(stage: string, finalDirectory: string, expected: readonly ExpectedFile[]): boolean {
  try {
    lstatSync(finalDirectory);
    const matches = publishedTreeMatches(finalDirectory, expected);
    rmSync(stage, { recursive: true, force: true });
    return matches;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      rmSync(stage, { recursive: true, force: true });
      return false;
    }
  }
  try {
    renameSync(stage, finalDirectory);
    return true;
  } catch {
    const matches = publishedTreeMatches(finalDirectory, expected);
    rmSync(stage, { recursive: true, force: true });
    return matches;
  }
}

function selectedParts(
  capture: Extract<CaptureAcceptedOperationalExportResult, { readonly kind: "ready" | "empty" }>,
  selection: AcceptedStlBundleSelection,
): readonly SelectedPart[] {
  if (capture.kind === "empty") return [];
  return capture.export.parts
    .filter((part) => part.included)
    .map((part) => ({
      part,
      units: part.units
        .filter((unit) => selection === "all" || !unit.completed)
        .map((unit) => unit.unitIndex + 1),
    }))
    .filter((entry) => entry.units.length > 0);
}

export async function materializeAcceptedStlBundle(input: Readonly<{
  capture: Extract<CaptureAcceptedOperationalExportResult, { readonly kind: "ready" | "empty" }>;
  reposDir: string;
  tenantExportsDir: string;
  selection: AcceptedStlBundleSelection;
  groupBy: StlPackGroupBy;
  roleOrder: readonly string[];
  publishedBytesLimit?: number;
}>): Promise<MaterializeAcceptedStlBundleResult> {
  const selected = selectedParts(input.capture, input.selection);
  const selectedUnitCount = selected.reduce((total, entry) => total + entry.units.length, 0);
  if (selectedUnitCount > MAX_SELECTED_UNITS) return { kind: "limit_exceeded" };

  const profile = input.capture.kind === "ready" ? input.capture.export.profile : input.capture.profile;
  const basis = input.capture.kind === "ready" ? input.capture.export.basis : null;
  const revisionSegment = basis ? `revision-${basis.revisionId}` : "empty";
  const warnings: AcceptedStlBundleWarning[] = [];
  const expected: ExpectedFile[] = [];
  const fileCounts: Record<string, number> = {};
  const usedNames = new Map<string, Set<string>>();
  const countedArtifacts = new Set<string>();
  let totalSourceBytes = 0;
  let totalOutputBytes = 0;
  const publishedBytesLimit = Math.min(
    MAX_OUTPUT_BYTES,
    Math.max(0, input.publishedBytesLimit ?? MAX_OUTPUT_BYTES),
  );
  let stage: string | null = null;
  try {
    const tenantRoot = resolve(input.tenantExportsDir);
    mkdirSync(tenantRoot, { recursive: true, mode: 0o700 });
    const tenantStats = lstatSync(tenantRoot);
    if (!tenantStats.isDirectory() || tenantStats.isSymbolicLink()) {
      return { kind: "output_failure" };
    }
    const resolvedTenantRoot = realpathSync(tenantRoot);
    const publicationParent = ensureDirectoryPath(resolvedTenantRoot, [
      "accepted-stl",
      `profile-${profile.id}`,
      revisionSegment,
      input.selection,
      input.groupBy,
    ]);
    if (!publicationParent) return { kind: "output_failure" };
    stage = mkdtempSync(join(publicationParent, ".tmp-"));
    for (const entry of selected) {
      const opened = openVerifiedAcceptedArtifact({
        reposDir: input.reposDir,
        artifact: entry.part.artifact,
        maxBytes: ACCEPTED_PART_MESH_MAX_BYTES,
      });
      if (opened.kind !== "verified") {
        warnings.push({
          code: "artifact_unavailable",
          relativePath: entry.part.relativePath,
          sourceLayer: entry.part.sourceLayer,
        });
        continue;
      }
      try {
        const artifactKey = acceptedArtifactDescriptorKey(entry.part);
        if (!countedArtifacts.has(artifactKey)) {
          countedArtifacts.add(artifactKey);
          totalSourceBytes += opened.lease.size;
        }
        totalOutputBytes += opened.lease.size * entry.units.length;
        if (totalSourceBytes > MAX_TOTAL_SOURCE_BYTES || totalOutputBytes > publishedBytesLimit) {
          return { kind: "limit_exceeded" };
        }
        const stagedSource = join(stage, `.part-${entry.part.revisionPartId}.source`);
        const sourceIsValid = await writeLease(stagedSource, opened.lease);
        if (!sourceIsValid) {
          warnings.push({
            code: "artifact_unavailable",
            relativePath: entry.part.relativePath,
            sourceLayer: entry.part.sourceLayer,
          });
          continue;
        }
        try {
          const role = input.roleOrder.includes(entry.part.role) ? entry.part.role : ROLE_ORDER[0];
          const roleFolder = safeFolderName(role);
          const folder = input.groupBy === "color"
            ? roleFolder
            : `${roleFolder}/${safeFolderName(folderKeyFromRelativePath(entry.part.relativePath))}`;
          const names = usedNames.get(folder) ?? new Set<string>();
          usedNames.set(folder, names);
          const directory = join(stage, ...folder.split("/"));
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          for (const unit of entry.units) {
            const filename = entryName(entry.part, unit, names);
            const relativePath = `${folder}/${filename}`;
            const expectedFile = {
              relativePath,
              size: opened.lease.size,
              sha256: opened.lease.expectedSha256,
            };
            const copied = await copyVerifiedStagedFile(
              join(stage, ...relativePath.split("/")),
              stagedSource,
              expectedFile,
            );
            if (!copied) return { kind: "output_failure" };
            expected.push(expectedFile);
            fileCounts[role] = (fileCounts[role] ?? 0) + 1;
          }
        } finally {
          rmSync(stagedSource, { force: true });
        }
      } finally {
        opened.lease.close();
      }
    }
    let hasBundle = false;
    if (expected.length > 0) {
      const zip = await writeZip(
        stage,
        expected,
        join(stage, "accepted-stl.zip"),
        publishedBytesLimit - totalOutputBytes,
      );
      if (zip.kind === "limit_exceeded") return { kind: "limit_exceeded" };
      if (!zip.file.sha256) return { kind: "output_failure" };
      expected.push(zip.file);
      hasBundle = true;
    }
    const finalDirectory = join(publicationParent, `content-${publicationKey(expected, warnings)}`);
    const bundlePath = hasBundle ? join(finalDirectory, "accepted-stl.zip") : null;
    if (!publish(stage, finalDirectory, expected)) return { kind: "output_failure" };
    return {
      kind: "materialized",
      basis,
      rootPath: finalDirectory,
      bundlePath,
      fileCounts,
      warnings,
    };
  } catch {
    return { kind: "output_failure" };
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
  }
}

export function exportStlPackJobMessage(result: {
  file_total?: number;
  warnings?: string[];
}): string {
  const fileTotal = result.file_total ?? 0;
  const warnings = result.warnings ?? [];
  if (fileTotal === 0) {
    if (warnings.length > 0) return warnings[0]!;
    return `No STL files exported. ${STL_EXPORT_MISSING_HINT}`;
  }
  if (warnings.length > 0) {
    return `Exported ${fileTotal} file(s) with ${warnings.length} warning(s)`;
  }
  return "Complete";
}
