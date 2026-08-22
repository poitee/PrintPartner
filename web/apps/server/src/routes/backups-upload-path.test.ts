import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as backupRoutes from "./backups.js";

describe("backup multipart upload paths", () => {
  it.each([
    "../../outside.tar.gz",
    String.raw`..\..\outside.tar.gz`,
    "/absolute/outside.tar.gz",
    "odd name\u0000.tar.gz",
  ])("sanitizes %j and confines it to the unique upload directory", (filename) => {
    const tempDir = mkdtempSync(join(tmpdir(), "pp-upload-path-"));
    try {
      const pathBuilder = (
        backupRoutes as unknown as {
          safeBackupUploadPath?: (root: string, filename: string) => string;
        }
      ).safeBackupUploadPath;
      expect(pathBuilder).toBeTypeOf("function");
      if (!pathBuilder) return;

      const uploadPath = pathBuilder(tempDir, filename);
      const rel = relative(resolve(tempDir), resolve(uploadPath));
      expect(rel).not.toBe("");
      expect(rel.startsWith("..")).toBe(false);
      expect(dirname(uploadPath)).toBe(resolve(tempDir));
      expect(basename(uploadPath)).not.toContain("..");
      expect(basename(uploadPath)).toMatch(/\.tar\.gz$/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
