import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectStorage } from "./storage-inventory.js";

describe("storage inventory", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories) {
      rmSync(directory, { recursive: true, force: true });
    }
    directories.length = 0;
  });

  it("measures every storage category recursively without following symlinks", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-storage-inventory-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "pp-storage-outside-"));
    directories.push(dataDir, outsideDir);

    mkdirSync(join(dataDir, "repos", "source-1", "revisions", "revision-1"), {
      recursive: true,
    });
    writeFileSync(
      join(dataDir, "repos", "source-1", "revisions", "revision-1", "part.stl"),
      "12345678",
    );
    writeFileSync(join(dataDir, "repos", "source-1", "README.md"), "abc");
    writeFileSync(join(outsideDir, "must-not-count.stl"), "x".repeat(1_024));
    symlinkSync(outsideDir, join(dataDir, "repos", "source-1", "linked-outside"));

    mkdirSync(join(dataDir, "sources"), { recursive: true });
    writeFileSync(join(dataDir, "sources", "working.stl"), "12345");
    mkdirSync(join(dataDir, "exports"), { recursive: true });
    writeFileSync(join(dataDir, "exports", "plate.3mf"), "1234567");
    mkdirSync(join(dataDir, "backups"), { recursive: true });
    writeFileSync(join(dataDir, "backups", "snapshot.tar.gz"), "123456");
    writeFileSync(join(dataDir, "print-partner.db"), "1234");
    writeFileSync(join(dataDir, "print-partner.db-wal"), "12");
    writeFileSync(join(dataDir, "custom_filaments.json"), "123456789");
    mkdirSync(join(dataDir, "assistant-domain"), { recursive: true });
    writeFileSync(join(dataDir, "assistant-domain", "notes.md"), "1234");
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "manifests", "kit-catalog.yaml"), "12345");
    writeFileSync(join(dataDir, "kit-catalog.yaml"), "123456");
    writeFileSync(join(dataDir, "path-hints.yaml"), "1234567");

    const inventory = await inspectStorage(dataDir, {
      readFreeBytes: async () => 50_000,
    });

    expect(inventory.freeBytes).toBe(50_000);
    expect(inventory.categories).toEqual([
      { key: "database", label: "Database", bytes: 6, files: 2 },
      { key: "repos", label: "Source revisions", bytes: 11, files: 2 },
      { key: "sources", label: "Working Source files", bytes: 5, files: 1 },
      { key: "exports", label: "Exports", bytes: 7, files: 1 },
      { key: "thumbs", label: "Thumbnails", bytes: 0, files: 0 },
      { key: "covers", label: "Covers", bytes: 0, files: 0 },
      { key: "assistantDomain", label: "Assistant knowledge", bytes: 4, files: 1 },
      { key: "configuration", label: "Configuration", bytes: 27, files: 4 },
      { key: "backups", label: "Stored backups", bytes: 6, files: 1 },
      { key: "other", label: "Other application data", bytes: 0, files: 0 },
    ]);
    expect(inventory.totalBytes).toBe(66);
    expect(inventory.backupContentBytes).toBe(65_596);
  });
});
