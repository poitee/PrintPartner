import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";

afterEach(() => {
  delete process.env.PRINT_PARTNER_DATA_DIR;
});

describe("GET /sources/activity", () => {
  it("returns source alerts in an app-facing shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-source-activity-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    delete process.env.PRINT_PARTNER_API_KEY;
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(loadConfig(), ports);
    try {
      ports.repository!.recordAppEvent({
        kind: "source.sync_failed",
        at: "2026-08-31T12:00:00.000Z",
        payload: { source_id: 7, source_name: "Voron", error: "Remote unavailable" },
      });

      const response = await app.inject({ method: "GET", url: "/sources/activity?limit=5" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        events: [
          {
            id: expect.any(Number),
            at: "2026-08-31T12:00:00.000Z",
            kind: "source.sync_failed",
            source_id: 7,
            source_name: "Voron",
            detail: "Remote unavailable",
          },
        ],
      });
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
