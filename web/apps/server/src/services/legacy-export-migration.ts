import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";
import type { AppRepository } from "../db/repository.js";
import { tenantExportDirectory } from "../lib/secure-path.js";
import { migratePrinterSendQueueArtifactPaths } from "./printer-send-queue-store.js";

export type LegacyExportMigrationResult = {
  movedEntries: number;
  migratedQueuePaths: number;
};

function mergeLegacyEntry(source: string, target: string): number {
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink()) return 0;
  if (!existsSync(target)) {
    renameSync(source, target);
    return 1;
  }
  const targetStat = lstatSync(target);
  if (!sourceStat.isDirectory() || !targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    return 0;
  }

  let moved = 0;
  for (const entry of readdirSync(source)) {
    moved += mergeLegacyEntry(join(source, entry), join(target, entry));
  }
  if (readdirSync(source).length === 0) rmdirSync(source);
  return moved;
}

export function migrateLegacySelfHostExports(
  dataDir: string,
  repo: AppRepository,
): LegacyExportMigrationResult {
  const exportsRoot = join(dataDir, "exports");
  const tenantRoot = tenantExportDirectory(exportsRoot, "default");
  if (!existsSync(exportsRoot)) {
    return { movedEntries: 0, migratedQueuePaths: 0 };
  }
  if (existsSync(tenantRoot) && lstatSync(tenantRoot).isSymbolicLink()) {
    return { movedEntries: 0, migratedQueuePaths: 0 };
  }
  mkdirSync(tenantRoot, { recursive: true });

  let movedEntries = 0;
  for (const entry of readdirSync(exportsRoot)) {
    if (entry === "tenant-default" || entry.toLowerCase().startsWith("tenant-")) continue;
    movedEntries += mergeLegacyEntry(join(exportsRoot, entry), join(tenantRoot, entry));
  }

  const migratedQueuePaths = migratePrinterSendQueueArtifactPaths(
    repo,
    exportsRoot,
    tenantRoot,
  );
  return { movedEntries, migratedQueuePaths };
}
