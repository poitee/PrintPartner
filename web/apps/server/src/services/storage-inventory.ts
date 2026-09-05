import { promises as fs } from "node:fs";
import { join } from "node:path";
import { FULL_BACKUP_ROOTS } from "./backup-scope.js";

const BACKUP_METADATA_ALLOWANCE_BYTES = 64 * 1024;
const DATABASE_FILES = [
  "print-partner.db",
  "print-partner.db-wal",
  "print-partner.db-shm",
] as const;
const BACKUP_DATABASE_FILES = new Set(["print-partner.db", "print-partner.db-wal"]);

const SCOPED_CATEGORY_KEYS = [
  "repos",
  "sources",
  "exports",
  "thumbs",
  "covers",
  "assistantDomain",
  "configuration",
] as const;

type ScopedStorageCategoryKey = (typeof FULL_BACKUP_ROOTS)[number]["category"];

export type StorageCategoryKey =
  | "database"
  | ScopedStorageCategoryKey
  | "backups"
  | "other";

export type StorageCategoryUsage = Readonly<{
  key: StorageCategoryKey;
  label: string;
  bytes: number;
  files: number;
}>;

export type StorageInventory = Readonly<{
  categories: readonly StorageCategoryUsage[];
  totalBytes: number;
  backupContentBytes: number;
  freeBytes: number;
}>;

type PathUsage = Readonly<{ bytes: number; files: number }>;

type StorageInspectionOptions = Readonly<{
  readFreeBytes?: (path: string) => Promise<number>;
}>;

function addUsage(left: PathUsage, right: PathUsage): PathUsage {
  const bytes = left.bytes + right.bytes;
  const files = left.files + right.files;
  if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(files)) {
    throw new Error("Storage inventory exceeds the supported numeric range");
  }
  return { bytes, files };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function measurePath(path: string): Promise<PathUsage> {
  let stats;
  try {
    stats = await fs.lstat(path);
  } catch (error) {
    if (isMissing(error)) return { bytes: 0, files: 0 };
    throw error;
  }

  if (stats.isSymbolicLink()) return { bytes: 0, files: 0 };
  if (stats.isFile()) return { bytes: stats.size, files: 1 };
  if (!stats.isDirectory()) return { bytes: 0, files: 0 };

  let usage: PathUsage = { bytes: 0, files: 0 };
  let entries;
  try {
    entries = await fs.readdir(path);
  } catch (error) {
    if (isMissing(error)) return usage;
    throw error;
  }
  for (const entry of entries) {
    usage = addUsage(usage, await measurePath(join(path, entry)));
  }
  return usage;
}

export async function readFreeDiskBytes(path: string): Promise<number> {
  const stats = await fs.statfs(path, { bigint: true });
  const bytes = stats.bavail * stats.bsize;
  if (bytes < 0n) throw new Error("Filesystem reported negative available space");
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(bytes);
}

export async function inspectStorage(
  dataDir: string,
  options: StorageInspectionOptions = {},
): Promise<StorageInventory> {
  await fs.mkdir(dataDir, { recursive: true });
  const scopedUsage = await Promise.all(
    SCOPED_CATEGORY_KEYS.map(async (key) => {
      const roots = FULL_BACKUP_ROOTS.filter((root) => root.category === key);
      let usage: PathUsage = { bytes: 0, files: 0 };
      for (const root of roots) {
        usage = addUsage(usage, await measurePath(join(dataDir, root.path)));
      }
      const label = roots[0]?.label;
      if (!label) throw new Error(`Storage category has no roots: ${key}`);
      return { key, label, ...usage };
    }),
  );
  const backupsUsage = await measurePath(join(dataDir, "backups"));

  let databaseUsage: PathUsage = { bytes: 0, files: 0 };
  let backupDatabaseBytes = 0;
  for (const filename of DATABASE_FILES) {
    const usage = await measurePath(join(dataDir, filename));
    databaseUsage = addUsage(databaseUsage, usage);
    if (BACKUP_DATABASE_FILES.has(filename)) {
      backupDatabaseBytes = addUsage(
        { bytes: backupDatabaseBytes, files: 0 },
        { bytes: usage.bytes, files: 0 },
      ).bytes;
    }
  }

  const knownEntries = new Set<string>([
    ...FULL_BACKUP_ROOTS.map((root) => root.path),
    "backups",
    ...DATABASE_FILES,
  ]);
  let otherUsage: PathUsage = { bytes: 0, files: 0 };
  for (const entry of await fs.readdir(dataDir)) {
    if (knownEntries.has(entry)) continue;
    otherUsage = addUsage(otherUsage, await measurePath(join(dataDir, entry)));
  }

  const categories: StorageCategoryUsage[] = [
    { key: "database", label: "Database", ...databaseUsage },
    ...scopedUsage,
    { key: "backups", label: "Stored backups", ...backupsUsage },
    { key: "other", label: "Other application data", ...otherUsage },
  ];
  const total = categories.reduce<PathUsage>(addUsage, { bytes: 0, files: 0 });
  const backupDirectoriesBytes = scopedUsage.reduce<PathUsage>(
    addUsage,
    { bytes: 0, files: 0 },
  ).bytes;
  const backupContentBytes = addUsage(
    { bytes: backupDirectoriesBytes, files: 0 },
    {
      bytes: backupDatabaseBytes + BACKUP_METADATA_ALLOWANCE_BYTES,
      files: 0,
    },
  ).bytes;
  const readFreeBytes = options.readFreeBytes ?? readFreeDiskBytes;
  const freeBytes = await readFreeBytes(dataDir);
  if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) {
    throw new Error("Could not determine available disk space");
  }

  return {
    categories,
    totalBytes: total.bytes,
    backupContentBytes,
    freeBytes,
  };
}
