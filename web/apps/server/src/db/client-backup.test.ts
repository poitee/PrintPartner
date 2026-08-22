import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteDatabase } from "./client.js";

describe("SqliteDatabase backup snapshot", () => {
  it("uses SQLite backup semantics to include committed WAL data in an integrity-clean snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-sqlite-snapshot-"));
    const database = new SqliteDatabase(dir);
    database.connect();
    const writer = new Database(database.dbPath);
    const snapshotPath = join(dir, "snapshot.db");
    try {
      writer.pragma("journal_mode = WAL");
      writer.exec("CREATE TABLE snapshot_probe (value TEXT NOT NULL)");
      writer.prepare("INSERT INTO snapshot_probe (value) VALUES (?)").run("committed-in-wal");

      const backupToFile = (
        database as unknown as {
          backupToFile?: (destination: string) => Promise<void>;
        }
      ).backupToFile;
      expect(backupToFile).toBeTypeOf("function");
      if (!backupToFile) return;
      await backupToFile.call(database, snapshotPath);

      const snapshot = new Database(snapshotPath, { readonly: true });
      try {
        expect(
          snapshot.prepare("SELECT value FROM snapshot_probe").pluck().get(),
        ).toBe("committed-in-wal");
        expect(snapshot.pragma("integrity_check", { simple: true })).toBe("ok");
      } finally {
        snapshot.close();
      }
    } finally {
      writer.close();
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
