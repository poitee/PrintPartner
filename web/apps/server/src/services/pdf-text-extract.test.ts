import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chunkSidecarPath,
  contentHashForFile,
  docsTextDir,
  extractPdfText,
  readCachedPdfText,
  sidecarPathForHash,
} from "./pdf-text-extract.js";

const cleanupDirs: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pp-pdf-cache-"));
  cleanupDirs.push(root);
  return root;
}

function minimalPdf(text: string): string {
  const stream = `BT\n/F1 12 Tf\n72 72 Td\n(${text}) Tj\nET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xrefOffset = body.length;
  body += "xref\n0 6\n0000000000 65535 f \n";
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return body;
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PDF text cache roots", () => {
  it("writes extracted text to a cache root outside immutable content", async () => {
    const root = tempRoot();
    const contentRoot = join(root, "revisions", "commit-a");
    const cacheRoot = join(root, "derived", "a".repeat(64), "pdf-text");
    mkdirSync(contentRoot, { recursive: true });
    writeFileSync(join(contentRoot, "manual.pdf"), minimalPdf("Print Partner"), "binary");

    const result = await extractPdfText(contentRoot, "manual.pdf", { cacheRoot });

    expect(result.status).toBe("ready");
    expect(result.cachePath).toBe(sidecarPathForHash(cacheRoot, result.hash));
    if (!result.cachePath) throw new Error("Expected extracted PDF cache path");
    expect(existsSync(result.cachePath)).toBe(true);
    expect(existsSync(docsTextDir(contentRoot))).toBe(false);
  });

  it("reads legacy sidecars while preferring the new cache root", () => {
    const root = tempRoot();
    const contentRoot = join(root, "revisions", "commit-a");
    const cacheRoot = join(root, "derived", "a".repeat(64), "pdf-text");
    const legacyRoot = join(root, ".docs-text");
    mkdirSync(contentRoot, { recursive: true });
    mkdirSync(cacheRoot, { recursive: true });
    mkdirSync(legacyRoot, { recursive: true });
    const pdfPath = join(contentRoot, "manual.pdf");
    writeFileSync(pdfPath, "legacy PDF bytes", "utf8");
    const hash = contentHashForFile(pdfPath);
    writeFileSync(sidecarPathForHash(legacyRoot, hash), "legacy text", "utf8");
    writeFileSync(chunkSidecarPath(legacyRoot, hash), "[]", "utf8");

    expect(
      readCachedPdfText(contentRoot, "manual.pdf", {
        cacheRoot,
        legacyCacheRoots: [legacyRoot],
      })?.text,
    ).toBe("legacy text");

    writeFileSync(sidecarPathForHash(cacheRoot, hash), "current text", "utf8");
    expect(
      readCachedPdfText(contentRoot, "manual.pdf", {
        cacheRoot,
        legacyCacheRoots: [legacyRoot],
      })?.text,
    ).toBe("current text");
  });

  it("preserves the true page count when trailing pages produce no text chunks", async () => {
    const root = tempRoot();
    const contentRoot = join(root, "revisions", "commit-a");
    const cacheRoot = join(root, "derived", "a".repeat(64), "pdf-text");
    mkdirSync(contentRoot, { recursive: true });
    writeFileSync(join(contentRoot, "manual.pdf"), minimalPdf("Only first page"), "binary");
    const fresh = await extractPdfText(contentRoot, "manual.pdf", { cacheRoot });
    expect(fresh.status).toBe("ready");
    writeFileSync(
      chunkSidecarPath(cacheRoot, fresh.hash),
      JSON.stringify({ version: 1, pageCount: 4, chunks: fresh.chunks }),
      "utf8",
    );

    const cached = await extractPdfText(contentRoot, "manual.pdf", { cacheRoot });

    expect(cached.status).toBe("ready");
    expect(cached.pageCount).toBe(4);
  });
});
