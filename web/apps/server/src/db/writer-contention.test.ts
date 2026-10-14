import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PrinterSendQueueItem } from "@print-partner/contracts";
import { getDb, SqliteDatabase } from "./client.js";
import {
  enqueuePrinterSend,
  loadPrinterSendQueue,
  PRINTER_SEND_QUEUE_SETTINGS_KEY,
  updatePrinterSendQueueItem,
} from "../services/printer-send-queue-store.js";
import { AppRepository } from "./repository.js";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Another runtime's writer on the same file: it holds the write lock with an
// uncommitted setting, then commits after holdMs.
async function foreignWriter(dbPath: string, key: string, value: string, holdMs: number): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import Database from "better-sqlite3";
     const db = new Database(${JSON.stringify(dbPath)});
     db.exec("BEGIN IMMEDIATE");
     db.prepare("INSERT INTO app_settings (tenant_id, key, value) VALUES ('default', ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value")
       .run(${JSON.stringify(key)}, ${JSON.stringify(value)});
     console.log("held");
     setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${holdMs});`]);
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => { throw new Error(`Foreign writer exited before holding the lock: ${stderr}`); }),
  ]);
  return child;
}

function withRepo(fn: (repo: AppRepository, dbPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pp-writer-contention-"));
  roots.push(dir);
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();
  const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
  return fn(repo, sqlite.dbPath).finally(() => sqlite.close());
}

function queued(id: string, state: PrinterSendQueueItem["state"]): PrinterSendQueueItem {
  return {
    id,
    filename: `${id}.gcode`,
    artifact_path: `/data/exports/printer-uploads/${id}/a.gcode`,
    printer_id: "p1",
    wait_for_idle: true,
    start: true,
    state,
    created_at: "2026-10-14T00:00:00.000Z",
    updated_at: "2026-10-14T00:00:00.000Z",
  };
}

describe("Node read-then-write transactions under a foreign writer", () => {
  it("appends to the queue the foreign writer commits instead of failing busy", async () => {
    await withRepo(async (repo, dbPath) => {
      repo.setSetting(PRINTER_SEND_QUEUE_SETTINGS_KEY, JSON.stringify([queued("a", "queued")]));
      const foreignQueue = JSON.stringify([queued("a", "queued"), queued("foreign", "queued")]);
      const writer = await foreignWriter(dbPath, PRINTER_SEND_QUEUE_SETTINGS_KEY, foreignQueue, 300);
      const exited = once(writer, "exit");

      const item = enqueuePrinterSend(repo, {
        filename: "node.gcode",
        artifact_path: "/data/exports/printer-uploads/node/a.gcode",
        printer_id: "p1",
        start: true,
      });

      expect(loadPrinterSendQueue(repo).map((entry) => entry.id)).toEqual(["a", "foreign", item!.id]);
      expect((await exited)[0]).toBe(0);
    });
  });

  it("refuses a queued claim on an item the foreign writer already claimed", async () => {
    await withRepo(async (repo, dbPath) => {
      repo.setSetting(PRINTER_SEND_QUEUE_SETTINGS_KEY, JSON.stringify([queued("a", "queued")]));
      const writer = await foreignWriter(dbPath, PRINTER_SEND_QUEUE_SETTINGS_KEY, JSON.stringify([queued("a", "sending")]), 300);
      const exited = once(writer, "exit");

      const claimed = updatePrinterSendQueueItem(repo, "a", { state: "sending" }, { requireState: "queued" });

      expect(claimed).toBeNull();
      expect(loadPrinterSendQueue(repo).map((entry) => [entry.id, entry.state])).toEqual([["a", "sending"]]);
      expect((await exited)[0]).toBe(0);
    });
  });
});
