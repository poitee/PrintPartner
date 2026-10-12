import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "../db/client.js";
import { restoreBackup } from "./backup-restore.js";

const dataDir = process.argv[2];
const archive = process.argv[3];
if (!dataDir || !archive) {
  process.stderr.write("dataDir and archive are required\n");
  process.exit(2);
}

const rename = fs.rename.bind(fs);
Object.defineProperty(fs, "rename", {
  configurable: true,
  writable: true,
  value: async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    const source = String(from);
    const target = String(to);
    if (
      target === join(dataDir, "print-partner.db") &&
      source.includes(".restore-tmp-") &&
      !source.includes(".previous")
    ) {
      process.kill(process.pid, "SIGKILL");
    }
    return rename(from, to);
  },
});

const sqlite = {
  dbPath: join(dataDir, "print-partner.db"),
  ping: () => true,
  backupToFile: async () => {
    throw new Error("unused");
  },
  close: () => undefined,
  connect: () => undefined,
} as unknown as SqliteDatabase;

await restoreBackup(archive, dataDir, sqlite);
process.stderr.write("activation finished without kill\n");
process.exit(1);
