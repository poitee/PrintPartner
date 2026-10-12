import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import type { SqliteDatabase } from "../db/client.js";
import { restoreBackup } from "./backup-restore.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "..", "..", "..");

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

async function writeArchive(archive: string, files: Record<string, string | Buffer>): Promise<void> {
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

function databaseOnlyArchiveFiles(database: Buffer): Record<string, string | Buffer> {
  return {
    "backup-metadata.json": JSON.stringify({
      version: "2",
      createdAt: "2026-08-18T00:00:00.000Z",
      appVersion: "3.0.0",
      formatVersion: 2,
      scope: { kind: "database-only", includedRoots: [] },
    }),
    "print-partner.db": database,
  };
}

function fakeSqlite(dataDir: string): SqliteDatabase {
  return {
    dbPath: join(dataDir, "print-partner.db"),
    ping: () => true,
    backupToFile: async () => {
      throw new Error("unused");
    },
    close: () => undefined,
    connect: () => undefined,
  } as unknown as SqliteDatabase;
}

describe("restore activation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pp-restore-activation-"));
    dirs.push(dir);
    return dir;
  }

  it("rolls the live database back when activation fails before the new database is published", async () => {
    const dataDir = tempDir();
    const archive = join(dataDir, "database-only.tar.gz");
    const original = sqliteFile("current");
    await writeArchive(archive, databaseOnlyArchiveFiles(sqliteFile("restored")));
    writeFileSync(join(dataDir, "print-partner.db"), original);
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const source = String(from);
      const target = String(to);
      if (
        target === join(dataDir, "print-partner.db") &&
        source.includes(".restore-tmp-") &&
        !source.includes(".previous")
      ) {
        throw new Error("injected activation failure");
      }
      return rename(from, to);
    });

    await expect(restoreBackup(archive, dataDir, fakeSqlite(dataDir))).rejects.toThrow(
      /injected activation failure/,
    );

    expect(readFileSync(join(dataDir, "print-partner.db"))).toEqual(original);
    expect(readdirSync(dataDir).filter((name) => name.startsWith(".restore-tmp-"))).toEqual([]);
  });

  it("leaves the previous database in the recovery workspace when activation is killed", async () => {
    const dataDir = tempDir();
    const archive = join(dataDir, "database-only.tar.gz");
    const original = sqliteFile("current");
    await writeArchive(archive, databaseOnlyArchiveFiles(sqliteFile("restored")));
    writeFileSync(join(dataDir, "print-partner.db"), original);
    const childPath = join(here, "backup-restore-activation-child.ts");
    const child = spawn(process.execPath, ["--import", "tsx", childPath, dataDir, archive], {
      cwd: webRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`activation child timed out: ${Buffer.concat(stderr).toString("utf8")}`));
      }, 20_000);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

    expect(exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(existsSync(join(dataDir, "print-partner.db"))).toBe(false);
    const workspaces = readdirSync(dataDir).filter((name) => name.startsWith(".restore-tmp-"));
    expect(workspaces).toEqual([expect.any(String)]);
    expect(
      readFileSync(join(dataDir, workspaces[0] ?? "missing", ".previous", "print-partner.db")),
    ).toEqual(original);
  });
});
