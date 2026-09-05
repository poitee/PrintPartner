import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteDatabase } from "../db/client.js";
import {
  createBackup,
  inspectRestore,
  restoreBackup,
  validateBackup,
} from "./backup-restore.js";

const METADATA = {
  version: "1",
  createdAt: "2026-08-18T00:00:00.000Z",
  appVersion: "3.0.0",
  formatVersion: 1,
};

const FULL_BACKUP_ROOTS = [
  "repos",
  "sources",
  "exports",
  "thumbs",
  "covers",
  "assistant-domain",
  "manifests",
  "custom_filaments.json",
  "kit-catalog.json",
  "kit-catalog.yaml",
  "path-hints.yaml",
] as const;

function v2Metadata(kind: "full" | "database-only") {
  return {
    version: "2",
    createdAt: "2026-08-18T00:00:00.000Z",
    appVersion: "3.0.0",
    formatVersion: 2,
    scope: {
      kind,
      includedRoots: kind === "full" ? [...FULL_BACKUP_ROOTS] : [],
    },
  };
}

describe("backup create, validate, and restore", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pp-backup-integrity-"));
    dirs.push(dir);
    return dir;
  }

  it("round-trips the database and critical data directories", async () => {
    const dataDir = tempDir();
    const outputPath = join(dataDir, "snapshot.tar.gz");
    const dbPath = join(dataDir, "print-partner.db");
    const backupDb = sqliteFile("backed-up");
    writeFileSync(dbPath, sqliteFile("current-before-backup"));
    mkdirSync(join(dataDir, "sources", "repo"), { recursive: true });
    mkdirSync(join(dataDir, "exports", "kit"), { recursive: true });
    writeFileSync(join(dataDir, "sources", "repo", "part.stl"), "original-stl");
    writeFileSync(join(dataDir, "exports", "kit", "plate.3mf"), "original-3mf");
    const sqlite = fakeSqlite(dataDir, backupDb);

    await createBackup(sqlite.value, dataDir, "3.0.0", outputPath);
    const metadata = await validateBackup(outputPath);
    expect(metadata).toMatchObject({
      appVersion: "3.0.0",
      formatVersion: 2,
      scope: { kind: "full", includedRoots: [...FULL_BACKUP_ROOTS] },
    });

    writeFileSync(dbPath, sqliteFile("mutated-db"));
    writeFileSync(`${dbPath}-wal`, "stale-wal");
    writeFileSync(join(dataDir, "sources", "repo", "part.stl"), "mutated-stl");
    writeFileSync(join(dataDir, "exports", "kit", "plate.3mf"), "mutated-3mf");

    await restoreBackup(outputPath, dataDir, sqlite.value);

    expect(readFileSync(dbPath)).toEqual(backupDb);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(readFileSync(join(dataDir, "sources", "repo", "part.stl"), "utf8")).toBe(
      "original-stl",
    );
    expect(readFileSync(join(dataDir, "exports", "kit", "plate.3mf"), "utf8")).toBe(
      "original-3mf",
    );
    expect(sqlite.closeCalls()).toBe(1);
    expect(sqlite.connectCalls()).toBe(1);
    expect(sqlite.snapshotCalls()).toBe(1);
  });

  it("keeps an existing published archive intact and cleans temporary files on snapshot failure", async () => {
    const dataDir = tempDir();
    const outputPath = join(dataDir, "snapshot.tar.gz");
    writeFileSync(outputPath, "previous-good-backup");
    const sqlite = fakeSqlite(dataDir, sqliteFile("unused"), {
      snapshotError: new Error("snapshot failed"),
    });

    await expect(
      createBackup(sqlite.value, dataDir, "3.0.0", outputPath),
    ).rejects.toThrow("snapshot failed");

    expect(readFileSync(outputPath, "utf8")).toBe("previous-good-backup");
    expect(
      readdirSync(dataDir).filter((name) => name.startsWith(".backup-") || name.includes(".tmp-")),
    ).toEqual([]);
  });

  it("does not publish a backup that exceeds its restore validation limits", async () => {
    const dataDir = tempDir();
    const outputPath = join(dataDir, "snapshot.tar.gz");
    writeFileSync(outputPath, "previous-good-backup");
    const sqlite = fakeSqlite(dataDir, sqliteFile("too-large"));

    await expect(
      createBackup(sqlite.value, dataDir, "3.0.0", outputPath, {
        validationLimits: { maxTotalBytes: 100 },
      }),
    ).rejects.toThrow(/decompressed byte limit/i);

    expect(readFileSync(outputPath, "utf8")).toBe("previous-good-backup");
    expect(
      readdirSync(dataDir).filter((name) => name.startsWith(".backup-") || name.includes(".tmp-")),
    ).toEqual([]);
  });

  it("creates a format v2 full backup of every durable root and removes covered paths that were absent", async () => {
    const dataDir = tempDir();
    const outputPath = join(dataDir, "snapshot.tar.gz");
    const dbPath = join(dataDir, "print-partner.db");
    const backupDb = sqliteFile("full-v2");
    writeFileSync(dbPath, sqliteFile("current"));
    mkdirSync(join(dataDir, "assistant-domain", "sources", "voron"), {
      recursive: true,
    });
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(
      join(dataDir, "assistant-domain", "sources", "voron", "pitfalls.md"),
      "original notes",
    );
    writeFileSync(join(dataDir, "manifests", "kit-catalog.yaml"), "catalog: nested");
    writeFileSync(join(dataDir, "custom_filaments.json"), '{"filaments":[]}');
    writeFileSync(join(dataDir, "kit-catalog.yaml"), "catalog: root");
    writeFileSync(join(dataDir, "path-hints.yaml"), "version: 1\nrules: []\n");
    const sqlite = fakeSqlite(dataDir, backupDb);

    await createBackup(sqlite.value, dataDir, "3.0.0", outputPath);

    const metadata = await validateBackup(outputPath);
    expect(metadata).toMatchObject({
      ...v2Metadata("full"),
      createdAt: expect.any(String),
    });
    writeFileSync(
      join(dataDir, "assistant-domain", "sources", "voron", "pitfalls.md"),
      "mutated notes",
    );
    writeFileSync(join(dataDir, "manifests", "kit-catalog.yaml"), "mutated nested");
    writeFileSync(join(dataDir, "custom_filaments.json"), '{"filaments":[{"id":"new"}]}');
    writeFileSync(join(dataDir, "kit-catalog.yaml"), "mutated root");
    writeFileSync(join(dataDir, "path-hints.yaml"), "mutated hints");
    mkdirSync(join(dataDir, "covers"), { recursive: true });
    writeFileSync(join(dataDir, "covers", "stale.png"), "not in backup");
    writeFileSync(join(dataDir, "kit-catalog.json"), '{"stale":true}');

    await restoreBackup(outputPath, dataDir, sqlite.value);

    expect(readFileSync(dbPath)).toEqual(backupDb);
    expect(
      readFileSync(
        join(dataDir, "assistant-domain", "sources", "voron", "pitfalls.md"),
        "utf8",
      ),
    ).toBe("original notes");
    expect(readFileSync(join(dataDir, "manifests", "kit-catalog.yaml"), "utf8")).toBe(
      "catalog: nested",
    );
    expect(readFileSync(join(dataDir, "custom_filaments.json"), "utf8")).toBe(
      '{"filaments":[]}',
    );
    expect(readFileSync(join(dataDir, "kit-catalog.yaml"), "utf8")).toBe(
      "catalog: root",
    );
    expect(readFileSync(join(dataDir, "path-hints.yaml"), "utf8")).toBe(
      "version: 1\nrules: []\n",
    );
    expect(existsSync(join(dataDir, "covers"))).toBe(false);
    expect(existsSync(join(dataDir, "kit-catalog.json"))).toBe(false);
  });

  it("marks a format v2 database-only backup and leaves every durable root untouched", async () => {
    const dataDir = tempDir();
    const outputPath = join(dataDir, "database-only.tar.gz");
    writeFileSync(join(dataDir, "print-partner.db"), sqliteFile("current"));
    mkdirSync(join(dataDir, "sources"), { recursive: true });
    writeFileSync(join(dataDir, "sources", "part.stl"), "before");
    writeFileSync(join(dataDir, "custom_filaments.json"), "before");
    const sqlite = fakeSqlite(dataDir, sqliteFile("database-only"));

    await createBackup(sqlite.value, dataDir, "3.0.0", outputPath, {
      includeDataDirectories: false,
    });

    expect(await validateBackup(outputPath)).toMatchObject({
      ...v2Metadata("database-only"),
      createdAt: expect.any(String),
    });
    writeFileSync(join(dataDir, "sources", "part.stl"), "after");
    writeFileSync(join(dataDir, "custom_filaments.json"), "after");
    await restoreBackup(outputPath, dataDir, sqlite.value);
    expect(readFileSync(join(dataDir, "sources", "part.stl"), "utf8")).toBe("after");
    expect(readFileSync(join(dataDir, "custom_filaments.json"), "utf8")).toBe("after");
  });

  it("keeps paths omitted from a legacy format v1 backup", async () => {
    const dataDir = tempDir();
    const archive = join(dataDir, "legacy-database-only.tar.gz");
    await writeArchive(archive, {
      "backup-metadata.json": JSON.stringify(METADATA),
      "print-partner.db": sqliteFile("legacy"),
    });
    writeFileSync(join(dataDir, "print-partner.db"), sqliteFile("current"));
    mkdirSync(join(dataDir, "sources"), { recursive: true });
    writeFileSync(join(dataDir, "sources", "part.stl"), "keep source");
    writeFileSync(join(dataDir, "custom_filaments.json"), "keep filament");
    const sqlite = fakeSqlite(dataDir, sqliteFile("unused"));

    await restoreBackup(archive, dataDir, sqlite.value);

    expect(readFileSync(join(dataDir, "sources", "part.stl"), "utf8")).toBe(
      "keep source",
    );
    expect(readFileSync(join(dataDir, "custom_filaments.json"), "utf8")).toBe(
      "keep filament",
    );
  });

  it("rejects data entries outside the declared format v2 scope", async () => {
    const dataDir = tempDir();
    const archive = join(dataDir, "invalid-scope.tar.gz");
    await writeArchive(archive, {
      "backup-metadata.json": JSON.stringify(v2Metadata("database-only")),
      "print-partner.db": sqliteFile("invalid-scope"),
      "sources/part.stl": "undeclared",
    });

    await expect(validateBackup(archive)).rejects.toThrow(/scope/i);
  });

  it("rejects a format v2 full scope that omits a durable root", async () => {
    const dataDir = tempDir();
    const archive = join(dataDir, "incomplete-full-scope.tar.gz");
    const metadata = v2Metadata("full");
    await writeArchive(archive, {
      "backup-metadata.json": JSON.stringify({
        ...metadata,
        scope: {
          kind: "full",
          includedRoots: metadata.scope.includedRoots.filter(
            (root) => root !== "custom_filaments.json",
          ),
        },
      }),
      "print-partner.db": sqliteFile("incomplete-full-scope"),
    });

    await expect(validateBackup(archive)).rejects.toThrow(/scope roots do not match/i);
  });

  it("rolls back removal of a covered but absent format v2 root", async () => {
    const dataDir = tempDir();
    const archive = join(dataDir, "v2-rollback.tar.gz");
    await writeArchive(archive, {
      "backup-metadata.json": JSON.stringify(v2Metadata("full")),
      "print-partner.db": sqliteFile("restored"),
    });
    writeFileSync(join(dataDir, "print-partner.db"), sqliteFile("current"));
    writeFileSync(join(dataDir, "custom_filaments.json"), "must survive rollback");
    const sqlite = fakeSqlite(dataDir, sqliteFile("unused"), {
      connectErrors: [new Error("reject restored database")],
    });

    await expect(restoreBackup(archive, dataDir, sqlite.value)).rejects.toThrow(
      "reject restored database",
    );

    expect(readFileSync(join(dataDir, "custom_filaments.json"), "utf8")).toBe(
      "must survive rollback",
    );
  });

  it("preserves the recovery workspace when rollback cannot inspect a live path", async () => {
    const dataDir = tempDir();
    const archive = join(dataDir, "v2-rollback-inspection-failure.tar.gz");
    await writeArchive(archive, {
      "backup-metadata.json": JSON.stringify(v2Metadata("full")),
      "print-partner.db": sqliteFile("restored"),
    });
    writeFileSync(join(dataDir, "print-partner.db"), sqliteFile("current"));
    const filamentPath = join(dataDir, "custom_filaments.json");
    writeFileSync(filamentPath, "recoverable filament data");
    const sqlite = fakeSqlite(dataDir, sqliteFile("unused"), {
      connectErrors: [new Error("reject restored database")],
    });
    const originalLstat = fs.lstat.bind(fs);
    let filamentInspections = 0;
    const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (path, options) => {
      if (String(path) === filamentPath) {
        filamentInspections += 1;
        if (filamentInspections === 2) throw new Error("cannot inspect live filament path");
      }
      return originalLstat(path, options);
    });

    try {
      await expect(restoreBackup(archive, dataDir, sqlite.value)).rejects.toThrow(
        /Recovery also failed.*cannot inspect live filament path/i,
      );
    } finally {
      lstat.mockRestore();
    }

    const recoveryWorkspaces = readdirSync(dataDir).filter((name) =>
      name.startsWith(".restore-tmp-"),
    );
    expect(recoveryWorkspaces).toHaveLength(1);
    expect(
      readFileSync(
        join(
          dataDir,
          recoveryWorkspaces[0] ?? "missing-recovery-workspace",
          ".previous",
          "custom_filaments.json",
        ),
        "utf8",
      ),
    ).toBe("recoverable filament data");
  });

  it("rejects corrupt compressed input", async () => {
    const dir = tempDir();
    const archive = join(dir, "corrupt.tar.gz");
    writeFileSync(archive, "not a gzip stream");

    await expect(validateBackup(archive)).rejects.toThrow();
  });

  it("rejects an archive missing its database before closing or mutating SQLite", async () => {
    const dataDir = tempDir();
    const archive = join(dataDir, "missing-db.tar.gz");
    await writeArchive(archive, {
      "backup-metadata.json": JSON.stringify(METADATA),
    });
    const original = sqliteFile("must-remain");
    writeFileSync(join(dataDir, "print-partner.db"), original);
    const sqlite = fakeSqlite(dataDir, sqliteFile("unused"));

    await expect(restoreBackup(archive, dataDir, sqlite.value)).rejects.toThrow(
      /print-partner\.db/,
    );
    expect(sqlite.closeCalls()).toBe(0);
    expect(readFileSync(join(dataDir, "print-partner.db"))).toEqual(original);
  });

  it("rejects a traversal entry before closing SQLite or writing outside dataDir", async () => {
    const dataDir = tempDir();
    const staging = join(dataDir, "staging");
    mkdirSync(staging);
    writeFileSync(join(staging, "backup-metadata.json"), JSON.stringify(METADATA));
    writeFileSync(join(staging, "print-partner.db"), sqliteFile("backup"));
    writeFileSync(join(dataDir, "escape.txt"), "archive payload");
    const archive = join(dataDir, "traversal.tar.gz");
    await tar.c(
      {
        cwd: staging,
        file: archive,
        gzip: true,
        preservePaths: true,
      },
      ["backup-metadata.json", "print-partner.db", "../escape.txt"],
    );
    rmSync(join(dataDir, "escape.txt"));
    const original = sqliteFile("must-remain");
    writeFileSync(join(dataDir, "print-partner.db"), original);
    const sqlite = fakeSqlite(dataDir, sqliteFile("unused"));

    await expect(restoreBackup(archive, dataDir, sqlite.value)).rejects.toThrow(
      /Unsafe backup entry path/,
    );
    expect(sqlite.closeCalls()).toBe(0);
    expect(readFileSync(join(dataDir, "print-partner.db"))).toEqual(original);
    expect(() => readFileSync(join(dataDir, "escape.txt"))).toThrow();
  });

  it("restores the exact live state when the restored database cannot reconnect", async () => {
    const dataDir = tempDir();
    const archive = join(dataDir, "restore-reconnect-failure.tar.gz");
    const dbPath = join(dataDir, "print-partner.db");
    const originalDatabase = sqliteFile("live-before-restore");
    const originalWal = Buffer.from("live-wal");
    const originalShm = Buffer.from("live-shm");
    writeFileSync(dbPath, originalDatabase);
    writeFileSync(`${dbPath}-wal`, originalWal);
    writeFileSync(`${dbPath}-shm`, originalShm);
    mkdirSync(join(dataDir, "sources", "repo"), { recursive: true });
    mkdirSync(join(dataDir, "exports", "kit"), { recursive: true });
    writeFileSync(join(dataDir, "sources", "repo", "part.stl"), "live-stl");
    writeFileSync(join(dataDir, "exports", "kit", "plate.3mf"), "live-3mf");
    await writeArchive(archive, {
      "backup-metadata.json": JSON.stringify(METADATA),
      "print-partner.db": sqliteFile("restored-backup"),
      "sources/repo/part.stl": "restored-stl",
      "exports/kit/plate.3mf": "restored-3mf",
      "thumbs/restored.png": "restored-thumbnail",
    });
    const sqlite = fakeSqlite(dataDir, sqliteFile("unused"), {
      connectErrors: [new Error("restored database rejected")],
    });

    await expect(restoreBackup(archive, dataDir, sqlite.value)).rejects.toThrow(
      "restored database rejected",
    );

    expect(readFileSync(dbPath)).toEqual(originalDatabase);
    expect(readFileSync(`${dbPath}-wal`)).toEqual(originalWal);
    expect(readFileSync(`${dbPath}-shm`)).toEqual(originalShm);
    expect(readFileSync(join(dataDir, "sources", "repo", "part.stl"), "utf8")).toBe(
      "live-stl",
    );
    expect(readFileSync(join(dataDir, "exports", "kit", "plate.3mf"), "utf8")).toBe(
      "live-3mf",
    );
    expect(existsSync(join(dataDir, "thumbs", "restored.png"))).toBe(false);
    expect(sqlite.connectCalls()).toBe(2);
    expect(sqlite.value.ping()).toBe(true);
    expect(
      readdirSync(dataDir).filter((name) => name.startsWith(".restore-tmp-")),
    ).toEqual([]);

    const reopened = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      expect(reopened.prepare("SELECT value FROM marker").pluck().get()).toBe(
        "live-before-restore",
      );
    } finally {
      reopened.close();
    }
  });

  it("rejects a structurally valid archive with a corrupt SQLite payload", async () => {
    const dir = tempDir();
    const archive = join(dir, "bad-db.tar.gz");
    await writeArchive(archive, {
      "backup-metadata.json": JSON.stringify(METADATA),
      "print-partner.db": "definitely not sqlite",
    });

    await expect(validateBackup(archive)).rejects.toThrow(/SQLite database/);
  });

  it("runs SQLite integrity_check instead of trusting the file header", async () => {
    const dir = tempDir();
    const archive = join(dir, "corrupt-pages.tar.gz");
    await writeArchive(archive, {
      "backup-metadata.json": JSON.stringify(METADATA),
      "print-partner.db": sqliteFile("corrupt").subarray(0, 100),
    });

    await expect(validateBackup(archive)).rejects.toThrow(/integrity|malformed|SQLite/i);
  });

  it("enforces archive entry and total decompressed byte limits", async () => {
    const dir = tempDir();
    const archive = join(dir, "bounded.tar.gz");
    await writeArchive(archive, {
      "backup-metadata.json": JSON.stringify(METADATA),
      "print-partner.db": sqliteFile("bounded"),
      "exports/plate.3mf": "payload",
    });
    await expect(validateBackup(archive, { maxEntries: 2 })).rejects.toThrow(
      /entry limit/i,
    );
    await expect(
      validateBackup(archive, { maxTotalBytes: 100 }),
    ).rejects.toThrow(/decompressed.*limit/i);
  });

  it("reports restore capacity and refuses before extracting or closing SQLite", async () => {
    const dataDir = tempDir();
    const archive = join(dataDir, "capacity.tar.gz");
    await writeArchive(archive, {
      "backup-metadata.json": JSON.stringify(METADATA),
      "print-partner.db": sqliteFile("capacity"),
      "sources/project/part.stl": "payload",
    });
    const original = sqliteFile("must-remain");
    writeFileSync(join(dataDir, "print-partner.db"), original);
    const sqlite = fakeSqlite(dataDir, sqliteFile("unused"));

    const preflight = await inspectRestore(archive, dataDir, {
      readFreeBytes: async () => 1,
    });

    expect(preflight.archiveBytes).toBeGreaterThan(0);
    expect(preflight.requiredBytes).toBeGreaterThan(preflight.archiveBytes);
    expect(preflight.freeBytes).toBe(1);
    expect(preflight.sufficient).toBe(false);
    await expect(
      restoreBackup(archive, dataDir, sqlite.value, {
        readFreeBytes: async () => 1,
      }),
    ).rejects.toThrow(/Insufficient disk space/i);
    expect(sqlite.closeCalls()).toBe(0);
    expect(readFileSync(join(dataDir, "print-partner.db"))).toEqual(original);
    expect(
      readdirSync(dataDir).filter((name) => name.startsWith(".restore-tmp-")),
    ).toEqual([]);
  });
});

function sqliteFile(marker: string): Buffer {
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE marker (value TEXT NOT NULL)");
    database.prepare("INSERT INTO marker (value) VALUES (?)").run(marker);
    return database.serialize();
  } finally {
    database.close();
  }
}

function fakeSqlite(
  dataDir: string,
  backupContent: Buffer,
  options: { snapshotError?: Error; connectErrors?: readonly Error[] } = {},
) {
  let closes = 0;
  let connects = 0;
  let snapshots = 0;
  let connected = true;
  const value = {
    dbPath: join(dataDir, "print-partner.db"),
    ping: () => connected,
    backupToFile: async (destination: string) => {
      snapshots += 1;
      if (options.snapshotError) throw options.snapshotError;
      writeFileSync(destination, backupContent);
    },
    backupFileContent: () => backupContent,
    backupWalFileContent: () => null,
    close: () => {
      closes += 1;
      connected = false;
    },
    connect: () => {
      connects += 1;
      const error = options.connectErrors?.[connects - 1];
      if (error) throw error;
      connected = true;
    },
  } as unknown as SqliteDatabase;
  return {
    value,
    closeCalls: () => closes,
    connectCalls: () => connects,
    snapshotCalls: () => snapshots,
  };
}

async function writeArchive(
  archive: string,
  files: Record<string, string | Buffer>,
): Promise<void> {
  const staging = mkdtempSync(join(tmpdir(), "pp-backup-archive-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(staging, name)), { recursive: true });
      writeFileSync(join(staging, name), contents);
    }
    await tar.c({ cwd: staging, file: archive, gzip: true }, Object.keys(files));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
