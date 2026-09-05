import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  delete process.env.PRINT_PARTNER_DATA_DIR;
});

describe("DELETE /sources/:id", () => {
  it("returns a conflict instead of a server error when immutable history retains the Source", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pp-source-delete-"));
    process.env.PRINT_PARTNER_DATA_DIR = directory;
    const ports = createSelfHostPorts(directory);
    await ports.db.connect();
    const app = await buildApp(loadConfig(), ports);
    cleanup.push(async () => {
      await app.close();
      await ports.db.close();
      rmSync(directory, { recursive: true, force: true });
    });

    const source = ports.repository!.createSource({ name: "Retained", source_kind: "local" });
    ports.repository!.recordSourceRevision({
      sourceId: source.id,
      upstreamRevisionKey: "retained-a",
      manifestDigest: "a".repeat(64),
      snapshotLocator: "sources/default/retained-a",
      syncedAt: "2026-09-04T00:00:00.000Z",
      completeness: "complete",
    });

    const response = await app.inject({ method: "DELETE", url: `/sources/${source.id}` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      detail: "Source has immutable revision history and cannot be deleted",
    });
    expect(ports.repository!.getSource(source.id)).not.toBeNull();
  });
});
