import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promises as fs } from "node:fs";
import * as tar from "tar";
import type { Stats } from "node:fs";
import type { ReadEntry } from "tar";
import Database from "better-sqlite3";
import type { SqliteDatabase } from "../db/client.js";

export type BackupMetadata = {
  version: string;
  createdAt: string;
  appVersion: string;
  formatVersion: 1;
};

const BACKUP_FORMAT_VERSION = 1;
const BACKUP_METADATA_FILE = "backup-metadata.json";
const BACKUP_DATABASE_FILE = "print-partner.db";
const BACKUP_WAL_FILE = "print-partner.db-wal";
const BACKUP_DIRECTORIES = ["repos", "sources", "exports", "thumbs", "covers"] as const;
const BACKUP_ROOT_FILES = new Set([
  BACKUP_METADATA_FILE,
  BACKUP_DATABASE_FILE,
  BACKUP_WAL_FILE,
]);
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");
const MAX_METADATA_BYTES = 64 * 1024;
const DEFAULT_MAX_BACKUP_ENTRIES = 100_000;
const DEFAULT_MAX_BACKUP_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_MAX_BACKUP_ENTRY_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_MAX_DECOMPRESSION_RATIO = 200;

export type BackupValidationLimits = {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxEntryBytes?: number;
  maxDecompressionRatio?: number;
};

type ResolvedBackupLimits = Required<BackupValidationLimits>;

type ArchiveGuardState = {
  entries: number;
  totalBytes: number;
  seen: Set<string>;
  error: Error | null;
};

function positiveLimit(value: number | undefined, fallback: number): number {
  return value == null || !Number.isFinite(value) || value < 0 ? fallback : value;
}

function resolveBackupLimits(limits: BackupValidationLimits = {}): ResolvedBackupLimits {
  return {
    maxEntries: positiveLimit(limits.maxEntries, DEFAULT_MAX_BACKUP_ENTRIES),
    maxTotalBytes: positiveLimit(limits.maxTotalBytes, DEFAULT_MAX_BACKUP_TOTAL_BYTES),
    maxEntryBytes: positiveLimit(limits.maxEntryBytes, DEFAULT_MAX_BACKUP_ENTRY_BYTES),
    maxDecompressionRatio: positiveLimit(
      limits.maxDecompressionRatio,
      DEFAULT_MAX_DECOMPRESSION_RATIO,
    ),
  };
}

function normalizedArchivePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function archiveEntryError(entry: ReadEntry, seen: Set<string>): Error | null {
  if (entry.meta) return null;
  const rawPath = entry.path;
  const path = normalizedArchivePath(rawPath);
  const parts = path.split("/");
  if (
    !path ||
    rawPath.includes("\\") ||
    rawPath.includes("\0") ||
    rawPath.startsWith("/") ||
    /^[A-Za-z]:/.test(rawPath) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    return new Error(`Unsafe backup entry path: ${rawPath}`);
  }
  if (BACKUP_ROOT_FILES.has(path)) {
    if (entry.type !== "File" && entry.type !== "OldFile") {
      return new Error(`Backup root entry must be a regular file: ${rawPath}`);
    }
    if (path === BACKUP_METADATA_FILE && entry.size > MAX_METADATA_BYTES) {
      return new Error(`Backup metadata exceeds ${MAX_METADATA_BYTES} byte limit`);
    }
  } else {
    const directory = BACKUP_DIRECTORIES.find(
      (candidate) => path === candidate || path.startsWith(`${candidate}/`),
    );
    if (!directory) return new Error(`Unexpected backup entry: ${rawPath}`);
    if (
      entry.type !== "File" &&
      entry.type !== "OldFile" &&
      entry.type !== "Directory"
    ) {
      return new Error(`Unsupported backup entry type for ${rawPath}: ${entry.type}`);
    }
    if (path === directory && entry.type !== "Directory") {
      return new Error(`Backup directory root has invalid type: ${rawPath}`);
    }
  }
  if (seen.has(path)) return new Error(`Duplicate backup entry: ${rawPath}`);
  seen.add(path);
  return null;
}

function guardArchiveEntry(
  entry: ReadEntry,
  state: ArchiveGuardState,
  limits: ResolvedBackupLimits,
): boolean {
  if (state.error) return false;
  state.entries += 1;
  if (state.entries > limits.maxEntries) {
    state.error = new Error(`Backup archive entry limit exceeded (${limits.maxEntries})`);
    return false;
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    state.error = new Error(`Backup entry has invalid size: ${entry.path}`);
    return false;
  }
  if (entry.size > limits.maxEntryBytes) {
    state.error = new Error(`Backup entry exceeds decompressed size limit: ${entry.path}`);
    return false;
  }
  state.totalBytes += entry.size;
  if (!Number.isSafeInteger(state.totalBytes) || state.totalBytes > limits.maxTotalBytes) {
    state.error = new Error(
      `Backup archive decompressed byte limit exceeded (${limits.maxTotalBytes})`,
    );
    return false;
  }
  state.error = archiveEntryError(entry, state.seen);
  return state.error === null;
}

function assertRequiredArchiveEntries(seen: Set<string>): void {
  if (!seen.has(BACKUP_METADATA_FILE)) {
    throw new Error(`Backup archive is missing ${BACKUP_METADATA_FILE}`);
  }
  if (!seen.has(BACKUP_DATABASE_FILE)) {
    throw new Error(`Backup archive is missing ${BACKUP_DATABASE_FILE}`);
  }
}

function readValidatedMetadata(tempDir: string): BackupMetadata {
  const metadataContent = readFileSync(join(tempDir, BACKUP_METADATA_FILE), "utf-8");
  const metadata = JSON.parse(metadataContent) as Partial<BackupMetadata> | null;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    typeof metadata.version !== "string" ||
    typeof metadata.createdAt !== "string" ||
    Number.isNaN(Date.parse(metadata.createdAt)) ||
    typeof metadata.appVersion !== "string" ||
    !Number.isInteger(metadata.formatVersion) ||
    (metadata.formatVersion as number) < 1
  ) {
    throw new Error("Invalid backup metadata: missing or invalid required fields");
  }
  if ((metadata.formatVersion as number) > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Backup format version ${metadata.formatVersion} is newer than supported ${BACKUP_FORMAT_VERSION}`,
    );
  }
  if (metadata.version !== String(metadata.formatVersion)) {
    throw new Error("Invalid backup metadata: version fields do not match");
  }
  const database = readFileSync(join(tempDir, BACKUP_DATABASE_FILE));
  if (
    database.length < SQLITE_HEADER.length ||
    !database.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)
  ) {
    throw new Error("Backup contains an invalid SQLite database");
  }
  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(join(tempDir, BACKUP_DATABASE_FILE), { fileMustExist: true });
    sqlite.pragma("query_only = ON");
    const result = sqlite.pragma("integrity_check", { simple: true });
    if (result !== "ok") {
      throw new Error(`SQLite integrity_check returned: ${String(result)}`);
    }
  } catch (error) {
    throw new Error(
      `Backup SQLite integrity_check failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    sqlite?.close();
  }
  return metadata as BackupMetadata;
}

async function extractValidatedBackup(
  backupPath: string,
  tempDir: string,
  extractDataDirectories: boolean,
  configuredLimits: BackupValidationLimits = {},
): Promise<BackupMetadata> {
  const limits = resolveBackupLimits(configuredLimits);
  const state: ArchiveGuardState = {
    entries: 0,
    totalBytes: 0,
    seen: new Set(),
    error: null,
  };
  await tar.x({
    file: backupPath,
    gzip: true,
    strict: true,
    cwd: tempDir,
    maxDecompressionRatio: limits.maxDecompressionRatio,
    filter: (_path, entry) => {
      const readEntry = entry as ReadEntry;
      const safe = guardArchiveEntry(readEntry, state, limits);
      if (!safe || readEntry.meta) return false;
      const path = normalizedArchivePath(readEntry.path);
      return extractDataDirectories || BACKUP_ROOT_FILES.has(path);
    },
  });
  if (state.error) throw state.error;
  assertRequiredArchiveEntries(state.seen);
  return readValidatedMetadata(tempDir);
}

/**
 * Creates an application-consistent backup of the SQLite database and critical directories.
 * Uses SQLite's backup API to ensure consistency.
 */
export async function createBackup(
  sqlite: SqliteDatabase | null,
  dataDir: string,
  appVersion: string,
  outputPath: string,
): Promise<void> {
  if (!sqlite) {
    throw new Error("SQLite database not available; backups require self-host mode");
  }

  // Ensure database is connected and healthy
  if (!sqlite.ping()) {
    throw new Error("SQLite database connection failed; cannot create backup");
  }

  const metadata: BackupMetadata = {
    version: String(BACKUP_FORMAT_VERSION),
    createdAt: new Date().toISOString(),
    appVersion,
    formatVersion: BACKUP_FORMAT_VERSION,
  };

  mkdirSync(dataDir, { recursive: true });
  const outputDir = dirname(resolve(outputPath));
  mkdirSync(outputDir, { recursive: true });
  const workDir = mkdtempSync(join(dataDir, ".backup-work-"));
  const temporaryArchivePath = join(
    outputDir,
    `.${basename(outputPath)}.tmp-${randomUUID()}`,
  );

  try {
    const backupDbPath = join(workDir, BACKUP_DATABASE_FILE);
    await sqlite.backupToFile(backupDbPath);
    writeFileSync(
      join(workDir, BACKUP_METADATA_FILE),
      JSON.stringify(metadata, null, 2),
    );

    const archiveEntries: string[] = [];
    for (const directory of BACKUP_DIRECTORIES) {
      const source = join(dataDir, directory);
      try {
        const stats = await fs.lstat(source);
        if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      archiveEntries.push(directory);
    }

    const snapshotRelativePath = join(
      basename(workDir),
      BACKUP_DATABASE_FILE,
    ).replace(/\\/g, "/");
    const metadataRelativePath = join(
      basename(workDir),
      BACKUP_METADATA_FILE,
    ).replace(/\\/g, "/");
    await tar.c(
      {
        file: temporaryArchivePath,
        gzip: true,
        cwd: dataDir,
        strict: true,
        portable: true,
        filter: (_path, value) => {
          const stats = value as Stats;
          return !stats.isSymbolicLink() && (stats.isFile() || stats.isDirectory());
        },
        onWriteEntry: (entry) => {
          if (entry.path === snapshotRelativePath) entry.path = BACKUP_DATABASE_FILE;
          else if (entry.path === metadataRelativePath) entry.path = BACKUP_METADATA_FILE;
        },
      },
      [snapshotRelativePath, metadataRelativePath, ...archiveEntries],
    );
    const archiveHandle = await fs.open(temporaryArchivePath, "r");
    try {
      await archiveHandle.sync();
    } finally {
      await archiveHandle.close();
    }
    await fs.rename(temporaryArchivePath, resolve(outputPath));
  } finally {
    try {
      await fs.rm(temporaryArchivePath, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

/**
 * Validates archive entries, metadata, and SQLite integrity in an isolated
 * temporary directory without mutating live application data.
 */
export async function validateBackup(
  backupPath: string,
  limits: BackupValidationLimits = {},
): Promise<BackupMetadata> {
  const absoluteBackupPath = resolve(backupPath);
  const tempDir = mkdtempSync(join(tmpdir(), "pp-backup-validate-"));

  try {
    // Validation writes only metadata/database files. All other entries are
    // parsed and bounded, but not extracted.
    return await extractValidatedBackup(absoluteBackupPath, tempDir, false, limits);
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Restores a backup archive, replacing current data.
 * Should only be called when the application is stopped or in maintenance mode.
 */
export async function restoreBackup(
  backupPath: string,
  dataDir: string,
  sqlite: SqliteDatabase | null,
): Promise<BackupMetadata> {
  if (!sqlite) {
    throw new Error("SQLite database not available; restore requires self-host mode");
  }

  mkdirSync(dataDir, { recursive: true });
  const tempDir = mkdtempSync(join(dataDir, ".restore-tmp-"));
  let databaseClosed = false;

  try {
    // Parse, validate, and safely extract every entry before mutating live data.
    const metadata = await extractValidatedBackup(resolve(backupPath), tempDir, true);

    // Close the database only after the complete archive has passed validation.
    sqlite.close();
    databaseClosed = true;

    // Backup current data (safety measure)
    const currentBackupDir = join(dataDir, ".pre-restore-backup");
    mkdirSync(currentBackupDir, { recursive: true });

    for (const dir of BACKUP_DIRECTORIES) {
      const currentPath = join(dataDir, dir);
      const backupPath = join(currentBackupDir, dir);
      try {
        await fs.cp(currentPath, backupPath, { recursive: true, force: true });
      } catch {
        // Directory might not exist yet; that's OK
      }
    }

    // Backup current database
    try {
      const currentDb = readFileSync(sqlite.dbPath);
      writeFileSync(join(currentBackupDir, "print-partner.db.bak"), currentDb);
    } catch {
      // Database might not exist yet
    }

    // Restore files
    for (const dir of BACKUP_DIRECTORIES) {
      const restoredPath = join(tempDir, dir);
      const targetPath = join(dataDir, dir);

      try {
        const stats = await fs.stat(restoredPath);
        if (stats.isDirectory()) {
          await fs.rm(targetPath, { recursive: true, force: true });
          await fs.cp(restoredPath, targetPath, { recursive: true });
        }
      } catch {
        // Directory doesn't exist in backup; skip it
      }
    }

    // Restore database
    const restoredDb = join(tempDir, BACKUP_DATABASE_FILE);
    try {
      const dbContent = readFileSync(restoredDb);
      writeFileSync(sqlite.dbPath, dbContent);

      // Never retain journal state from the database being replaced.
      await fs.rm(sqlite.dbPath + "-wal", { force: true });
      await fs.rm(sqlite.dbPath + "-shm", { force: true });

      // Restore the matching WAL when the backup includes one.
      const restoredWal = join(tempDir, BACKUP_WAL_FILE);
      try {
        const walContent = readFileSync(restoredWal);
        writeFileSync(sqlite.dbPath + "-wal", walContent);
      } catch {
        // WAL file doesn't exist; that's OK
      }
    } catch (e) {
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Failed to restore database: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Reconnect to restored database
    sqlite.connect();

    return metadata;
  } catch (e) {
    const capturedError = e instanceof Error ? e : new Error(String(e));
    // Try to reconnect to the database even if restore failed
    if (databaseClosed) {
      try {
        sqlite.connect();
      } catch (reconnectErr) {
        // Reconnect failed; database state is unknown
        console.error("[backup-restore] Failed to reconnect after restore error:", reconnectErr);
      }
    }
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Restore failed: ${capturedError.message}`, { cause: capturedError });
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
