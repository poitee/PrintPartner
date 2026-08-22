import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../db/client.js";
import {
  createBackup,
  restoreBackup,
  validateBackup,
} from "./backup-restore.js";

const METADATA = {
  version: "1",
  createdAt: "2026-08-18T00:00:00.000Z",
  appVersion: "3.0.0",
  formatVersion: 1,
};

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
    expect(metadata).toMatchObject({ appVersion: "3.0.0", formatVersion: 1 });

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
    const validateWithLimits = validateBackup as unknown as (
      path: string,
      limits: { maxEntries?: number; maxTotalBytes?: number },
    ) => Promise<unknown>;

    await expect(validateWithLimits(archive, { maxEntries: 2 })).rejects.toThrow(
      /entry limit/i,
    );
    await expect(
      validateWithLimits(archive, { maxTotalBytes: 100 }),
    ).rejects.toThrow(/decompressed.*limit/i);
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
  options: { snapshotError?: Error } = {},
) {
  let closes = 0;
  let connects = 0;
  let snapshots = 0;
  const value = {
    dbPath: join(dataDir, "print-partner.db"),
    ping: () => true,
    backupToFile: async (destination: string) => {
      snapshots += 1;
      if (options.snapshotError) throw options.snapshotError;
      writeFileSync(destination, backupContent);
    },
    backupFileContent: () => backupContent,
    backupWalFileContent: () => null,
    close: () => {
      closes += 1;
    },
    connect: () => {
      connects += 1;
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
