import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readBufferUnderDataDir,
  resolvedFileUnderRoot,
  safePathUnderRoot,
  tenantExportDirectory,
  trimmedString,
} from "./secure-path.js";

describe("secure-path", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pp-secure-"));
    dirs.push(dir);
    return dir;
  }

  it("rejects traversal in safePathUnderRoot", () => {
    const root = tempDir();
    expect(safePathUnderRoot(root, "../etc/passwd")).toBeNull();
    expect(safePathUnderRoot(root, "ok/file.txt")).not.toBeNull();
  });

  it("resolvedFileUnderRoot rejects paths outside root", () => {
    const root = tempDir();
    const file = join(root, "kit.json");
    writeFileSync(file, "{}");
    expect(resolvedFileUnderRoot(root, file)).toBe(realpathSync(file));
    expect(resolvedFileUnderRoot(root, "/etc/passwd")).toBeNull();
  });

  it("resolvedFileUnderRoot rejects symlinks that escape root", () => {
    const parent = tempDir();
    const root = join(parent, "exports");
    mkdirSync(root);
    const secret = join(parent, "secret.txt");
    const link = join(root, "artifact.3mf");
    writeFileSync(secret, "secret");
    symlinkSync(secret, link);

    expect(resolvedFileUnderRoot(root, link)).toBeNull();
  });

  it("readBufferUnderDataDir rejects paths outside data dir", () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, "kit.print-partner-kit"), "{}");
    expect(() => readBufferUnderDataDir(dataDir, "/etc/passwd", 1024)).toThrow();
    expect(
      readBufferUnderDataDir(dataDir, join(dataDir, "kit.print-partner-kit"), 1024).length,
    ).toBeGreaterThan(0);
  });

  it("trimmedString only accepts strings", () => {
    expect(trimmedString("  x  ")).toBe("x");
    expect(trimmedString(null)).toBe("");
    expect(trimmedString(42)).toBe("");
  });

  it("uses lowercase collision-safe export directories for mixed-case tenant ids", () => {
    const root = tempDir();
    const mixed = tenantExportDirectory(root, "Tenant-A");
    const lower = tenantExportDirectory(root, "tenant-a");

    expect(basename(mixed)).toBe(basename(mixed).toLowerCase());
    expect(mixed).not.toBe(lower);
    expect(tenantExportDirectory(root, "Tenant-A")).toBe(mixed);
    expect(tenantExportDirectory(root, "default")).toBe(join(root, "tenant-default"));
  });
});
