import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import type { ReadStream } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveCaseInsensitiveRepoPath } from "../services/part-paths.js";
import { globalPreviewPath, globalThumbnailPath } from "./thumbnails.js";

function resolvedExistingPathUnderRoot(root: string, path: string): string | null {
  try {
    const base = realpathSync(resolve(root));
    const candidate = realpathSync(resolve(path));
    const relativePath = relative(base, candidate);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

/** Walk relative path under root using directory listings only (no user strings in join). */
function resolveFileByWalk(root: string, relativeKey: string): string | null {
  const normalized = relativeKey.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || normalized.includes("\0")) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return null;
  let current = resolve(root);
  for (const part of parts) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return null;
    }
    const match = entries.find((entry) => entry === part);
    if (!match) return null;
    current = join(current, match);
  }
  try {
    const candidate = resolvedExistingPathUnderRoot(root, current);
    if (!candidate || !statSync(candidate).isFile()) return null;
    return candidate;
  } catch {
    return null;
  }
}

function readStreamForFileUnderRoot(root: string, file: string): ReadStream | null {
  try {
    const candidate = resolvedExistingPathUnderRoot(root, file);
    if (!candidate) return null;
    if (!statSync(candidate).isFile()) return null;
    return createReadStream(candidate);
  } catch {
    return null;
  }
}

/** Resolve a relative path under root; reject traversal outside root. */
export function safePathUnderRoot(root: string, relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) return null;
  const base = resolve(root);
  const candidate = resolve(base, normalized);
  if (candidate !== base && !candidate.startsWith(`${base}/`)) return null;
  return candidate;
}

/**
 * Resolve an existing regular file to its canonical path under root.
 * Symlinks are allowed only when their final realpath remains under root.
 * The canonical return value may differ from the input (notably for macOS
 * temporary-directory aliases).
 */
export function resolvedFileUnderRoot(root: string, absolutePath: string): string | null {
  try {
    const candidate = resolvedExistingPathUnderRoot(root, absolutePath);
    if (!candidate) return null;
    if (!statSync(candidate).isFile()) return null;
    return candidate;
  } catch {
    return null;
  }
}

export function createReadStreamUnderRoot(root: string, relativePath: string): ReadStream | null {
  const file = resolveFileByWalk(root, relativePath);
  return file ? readStreamForFileUnderRoot(root, file) : null;
}

export function tenantExportDirectory(exportsRoot: string, tenantId: string): string {
  const segment =
    tenantId === "default"
      ? "tenant-default"
      : `tenant-x${Buffer.from(tenantId, "utf8").toString("hex")}`;
  return join(exportsRoot, segment);
}

export function openExportFileStream(
  dataDir: string,
  tenantId: string,
  userKey: string,
): ReadStream | null {
  return createReadStreamUnderRoot(
    tenantExportDirectory(join(dataDir, "exports"), tenantId),
    userKey,
  );
}

export function openRepoStlMeshStream(
  repoRoot: string,
  relativePath: string,
  maxBytes: number,
): ReadStream | null {
  const file =
    resolveFileByWalk(repoRoot, relativePath) ??
    resolveCaseInsensitiveRepoPath(repoRoot, relativePath);
  if (!file) return null;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
  } catch {
    return null;
  }
  return readStreamForFileUnderRoot(repoRoot, file);
}

export function openStlThumbStream(
  thumbsDir: string,
  repoRoot: string,
  relativePath: string,
  variant: "preview" | "thumb",
): ReadStream | null {
  const stl =
    resolveFileByWalk(repoRoot, relativePath) ??
    resolveCaseInsensitiveRepoPath(repoRoot, relativePath);
  if (!stl) return null;
  const thumbPath =
    variant === "preview"
      ? globalPreviewPath(thumbsDir, stl, "primary", null)
      : globalThumbnailPath(thumbsDir, stl, "primary", null);
  return readStreamForFileUnderRoot(thumbsDir, thumbPath);
}

export function readBufferUnderDataDir(dataDir: string, userPath: string): Buffer {
  const root = resolve(dataDir);
  const resolved = resolve(userPath);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error("Path must be under the Print Partner data directory");
  }
  const relative = resolved.slice(root.length).replace(/^\/+/, "");
  if (!relative || !/\.print-partner-kit(\.zip)?$/i.test(relative)) {
    throw new Error("Kit path must be a .print-partner-kit bundle under the data directory");
  }
  const file = resolveFileByWalk(root, relative);
  if (!file) throw new Error("Kit file not found");
  return readFileSync(file);
}

export function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function assertFileUnderRoot(root: string, relativePath: string, maxBytes?: number): string {
  const file = resolveFileByWalk(root, relativePath);
  if (!file || !existsSync(file)) {
    throw new Error("File not found");
  }
  const st = statSync(file);
  if (!st.isFile()) throw new Error("Not a file");
  if (maxBytes != null && st.size > maxBytes) {
    throw new Error(`File exceeds ${Math.floor(maxBytes / (1024 * 1024))}MB limit`);
  }
  return file;
}

/** Map an absolute path to a URL-safe export key under the current tenant's export directory. */
export function exportDownloadKey(
  dataDir: string,
  tenantId: string,
  absolutePath: string,
): string | null {
  const exportsRoot = tenantExportDirectory(join(dataDir, "exports"), tenantId);
  const file = resolvedFileUnderRoot(exportsRoot, absolutePath);
  if (!file) return null;
  return relative(realpathSync(exportsRoot), file).split(sep).join("/");
}

/** Resolve kit import path: must exist under dataDir (self-host local paths only). */
export function safeDataDirPath(dataDir: string, userPath: string): string | null {
  return resolvedExistingPathUnderRoot(dataDir, userPath);
}
