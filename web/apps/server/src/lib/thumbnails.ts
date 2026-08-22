import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { statSync } from "node:fs";

const THUMB_CACHE_VERSION = "v3";
const PREVIEW_CACHE_VERSION = "v1";

function normalizeMeshHex(hex: string | null | undefined): string {
  if (!hex) return "";
  const h = hex.trim().replace(/^#/, "");
  return h.length === 6 ? h.toLowerCase() : "";
}

export function thumbnailCacheDigest(stlPath: string, role: string, meshHex?: string | null): string {
  const mtime = (() => {
    try {
      return statSync(stlPath).mtimeMs;
    } catch {
      return 0;
    }
  })();
  const colorKey = normalizeMeshHex(meshHex);
  const payload = `${resolve(stlPath)}|${mtime}|${role}|${colorKey}|${THUMB_CACHE_VERSION}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function globalThumbnailPath(
  thumbsDir: string,
  stlPath: string,
  role: string,
  meshHex?: string | null,
): string {
  return join(thumbsDir, `${thumbnailCacheDigest(stlPath, role, meshHex)}.png`);
}

export function previewCacheDigest(stlPath: string, role: string, meshHex?: string | null): string {
  const mtime = (() => {
    try {
      return statSync(stlPath).mtimeMs;
    } catch {
      return 0;
    }
  })();
  const colorKey = normalizeMeshHex(meshHex);
  const payload = `${resolve(stlPath)}|${mtime}|${role}|${colorKey}|${PREVIEW_CACHE_VERSION}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function globalPreviewPath(
  thumbsDir: string,
  stlPath: string,
  role: string,
  meshHex?: string | null,
): string {
  return join(thumbsDir, `${previewCacheDigest(stlPath, role, meshHex)}.png`);
}

export function cachedPngIfExists(path: string): string | null {
  return existsSync(path) ? path : null;
}

/** 1×1 transparent PNG for missing thumbnails. */
export const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
