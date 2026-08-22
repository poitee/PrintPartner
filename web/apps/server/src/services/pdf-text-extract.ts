import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PDFParse } from "pdf-parse";

export const DOCS_TEXT_DIR = ".docs-text";

/** Pages per chunk written for assistant retrieval. */
export const PDF_CHUNK_PAGES = 5;

/** Files at or above this size extract in a background job (per-page). */
export const PDF_BG_EXTRACT_BYTES = 8 * 1024 * 1024;

export type PdfExtractStatus = "pending" | "ready" | "error" | "skipped" | "na";

export type PdfPageChunk = {
  pageStart: number;
  pageEnd: number;
  text: string;
};

export type PdfExtractResult = {
  status: PdfExtractStatus;
  hash: string;
  pageCount: number;
  text: string;
  chunks: PdfPageChunk[];
  cachePath: string | null;
  error?: string;
};

export type PdfTextCacheOptions = {
  /** Writable directory for extracted text and page chunks. */
  cacheRoot?: string;
  /** Read-only cache directories used by older Source layouts. */
  legacyCacheRoots?: readonly string[];
};

function safeUnderRoot(root: string, relative: string): string | null {
  const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) return null;
  const absRoot = resolve(root);
  const dest = resolve(absRoot, normalized);
  if (dest !== absRoot && !dest.startsWith(`${absRoot}/`)) return null;
  return dest;
}

export function contentHashForFile(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex").slice(0, 24);
}

export function docsTextDir(repoRoot: string): string {
  return join(repoRoot, DOCS_TEXT_DIR);
}

export function sidecarPathForHash(cacheRoot: string, hash: string): string {
  return join(cacheRoot, `${hash}.txt`);
}

export function chunkSidecarPath(cacheRoot: string, hash: string): string {
  return join(cacheRoot, `${hash}.chunks.json`);
}

function writeSidecar(
  cacheRoot: string,
  hash: string,
  text: string,
  chunks: PdfPageChunk[],
  pageCount: number,
): string {
  mkdirSync(cacheRoot, { recursive: true });
  const path = sidecarPathForHash(cacheRoot, hash);
  writeFileSync(
    chunkSidecarPath(cacheRoot, hash),
    JSON.stringify({ version: 1, pageCount, chunks }),
    "utf8",
  );
  writeFileSync(path, text, "utf8");
  return path;
}

function isPdfPageChunk(value: unknown): value is PdfPageChunk {
  if (!value || typeof value !== "object") return false;
  return (
    "pageStart" in value &&
    typeof value.pageStart === "number" &&
    "pageEnd" in value &&
    typeof value.pageEnd === "number" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

type CachedPdfChunks = {
  chunks: PdfPageChunk[];
  pageCount: number;
};

function readCachedChunks(cacheRoot: string, hash: string): CachedPdfChunks | null {
  const path = chunkSidecarPath(cacheRoot, hash);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(raw) && raw.every(isPdfPageChunk)) {
      return {
        chunks: raw,
        pageCount: raw[raw.length - 1]?.pageEnd ?? 0,
      };
    }
    if (
      raw &&
      typeof raw === "object" &&
      "version" in raw &&
      raw.version === 1 &&
      "pageCount" in raw &&
      typeof raw.pageCount === "number" &&
      Number.isSafeInteger(raw.pageCount) &&
      raw.pageCount >= 0 &&
      "chunks" in raw &&
      Array.isArray(raw.chunks) &&
      raw.chunks.every(isPdfPageChunk)
    ) {
      return { chunks: raw.chunks, pageCount: raw.pageCount };
    }
    return null;
  } catch {
    return null;
  }
}

function cacheRootsForRead(contentRoot: string, options: PdfTextCacheOptions): string[] {
  const roots = [
    options.cacheRoot ?? docsTextDir(contentRoot),
    ...(options.legacyCacheRoots ?? []),
    docsTextDir(contentRoot),
  ];
  return roots.filter((root, index) => roots.indexOf(root) === index);
}

function readSidecar(
  cacheRoot: string,
  hash: string,
): { text: string; chunks: PdfPageChunk[]; pageCount: number; cachePath: string } | null {
  const cachePath = sidecarPathForHash(cacheRoot, hash);
  if (!existsSync(cachePath)) return null;
  const text = readFileSync(cachePath, "utf8");
  const cached = readCachedChunks(cacheRoot, hash);
  const chunks = cached?.chunks ?? [{ pageStart: 1, pageEnd: 1, text }];
  return { text, chunks, pageCount: cached?.pageCount ?? 1, cachePath };
}

function findCachedSidecar(
  contentRoot: string,
  options: PdfTextCacheOptions,
  hash: string,
): ReturnType<typeof readSidecar> {
  for (const root of cacheRootsForRead(contentRoot, options)) {
    const cached = readSidecar(root, hash);
    if (cached) return cached;
  }
  return null;
}

function pagesToChunks(
  pages: Array<{ text?: string; num?: number }>,
): { text: string; chunks: PdfPageChunk[]; pageCount: number } {
  const pageCount = pages.length;
  const chunks: PdfPageChunk[] = [];
  const allParts: string[] = [];
  for (let i = 0; i < pages.length; i += PDF_CHUNK_PAGES) {
    const slice = pages.slice(i, i + PDF_CHUNK_PAGES);
    const pageStart = i + 1;
    const pageEnd = i + slice.length;
    const text = slice
      .map((p, idx) => {
        const body = String(p.text ?? "").trim();
        return body ? `--- page ${pageStart + idx} ---\n${body}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
    if (text) {
      chunks.push({ pageStart, pageEnd, text });
      allParts.push(text);
    }
  }
  return { text: allParts.join("\n\n"), chunks, pageCount };
}

export type ExtractPdfOptions = {
  /** Force re-extract even if sidecar exists. */
  force?: boolean;
  /** Optional progress callback (page-oriented). */
  onProgress?: (current: number, total: number) => void;
  /**
   * When true, extract page-by-page (better for large manuals).
   * Default: auto when file >= PDF_BG_EXTRACT_BYTES.
   */
  perPage?: boolean;
} & PdfTextCacheOptions;

/**
 * Extract text from a PDF under `contentRoot`, caching under `options.cacheRoot`.
 * When no cache root is supplied, the legacy `.docs-text` directory is used.
 * `relativePath` is relative to the repo root.
 */
export async function extractPdfText(
  contentRoot: string,
  relativePath: string,
  options: ExtractPdfOptions = {},
): Promise<PdfExtractResult> {
  const abs = safeUnderRoot(contentRoot, relativePath);
  if (!abs || !existsSync(abs)) {
    return {
      status: "error",
      hash: "",
      pageCount: 0,
      text: "",
      chunks: [],
      cachePath: null,
      error: "PDF not found",
    };
  }

  let hash: string;
  try {
    hash = contentHashForFile(abs);
  } catch (e) {
    return {
      status: "error",
      hash: "",
      pageCount: 0,
      text: "",
      chunks: [],
      cachePath: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const cacheRoot = options.cacheRoot ?? docsTextDir(contentRoot);
  const cached = options.force ? null : findCachedSidecar(contentRoot, options, hash);
  if (cached) {
    return {
      status: "ready",
      hash,
      pageCount: cached.pageCount,
      text: cached.text,
      chunks: cached.chunks,
      cachePath: cached.cachePath,
    };
  }

  const size = statSync(abs).size;
  const perPage = options.perPage ?? size >= PDF_BG_EXTRACT_BYTES;

  try {
    const data = new Uint8Array(readFileSync(abs));
    const parser = new PDFParse({ data });

    if (perPage) {
      const info = await parser.getInfo();
      const total = Math.max(1, Number(info.total) || 1);
      const pages: Array<{ text: string; num: number }> = [];
      for (let page = 1; page <= total; page++) {
        options.onProgress?.(page, total);
        const part = await parser.getText({ partial: [page] });
        const pageText =
          part.pages?.map((p) => String(p.text ?? "")).join("\n") ??
          String(part.text ?? "");
        pages.push({ text: pageText, num: page });
      }
      await parser.destroy().catch(() => undefined);
      const assembled = pagesToChunks(pages);
      const written = writeSidecar(
        cacheRoot,
        hash,
        assembled.text,
        assembled.chunks,
        assembled.pageCount,
      );
      return {
        status: "ready",
        hash,
        pageCount: assembled.pageCount,
        text: assembled.text,
        chunks: assembled.chunks,
        cachePath: written,
      };
    }

    options.onProgress?.(1, 1);
    const result = await parser.getText();
    await parser.destroy().catch(() => undefined);
    const pages = (result.pages ?? []).map((p, i) => ({
      text: String(p.text ?? ""),
      num: i + 1,
    }));
    if (pages.length === 0 && result.text) {
      pages.push({ text: String(result.text), num: 1 });
    }
    const assembled = pagesToChunks(pages);
    const written = writeSidecar(
      cacheRoot,
      hash,
      assembled.text,
      assembled.chunks,
      assembled.pageCount,
    );
    return {
      status: "ready",
      hash,
      pageCount: assembled.pageCount,
      text: assembled.text,
      chunks: assembled.chunks,
      cachePath: written,
    };
  } catch (e) {
    return {
      status: "error",
      hash,
      pageCount: 0,
      text: "",
      chunks: [],
      cachePath: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Read cached extracted text if present (no re-parse). */
export function readCachedPdfText(
  contentRoot: string,
  relativePath: string,
  options: PdfTextCacheOptions = {},
): { text: string; chunks: PdfPageChunk[]; hash: string } | null {
  const abs = safeUnderRoot(contentRoot, relativePath);
  if (!abs || !existsSync(abs)) return null;
  try {
    const hash = contentHashForFile(abs);
    const cached = findCachedSidecar(contentRoot, options, hash);
    return cached ? { text: cached.text, chunks: cached.chunks, hash } : null;
  } catch {
    return null;
  }
}

export function docTitleFromPath(path: string): string {
  const base = basename(path);
  if (/^readme\.md$/i.test(base)) return "README";
  return base;
}

export { dirname };
