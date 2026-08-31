import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";

async function makeApp(dir: string) {
  process.env.PRINT_PARTNER_DATA_DIR = dir;
  delete process.env.PRINT_PARTNER_API_KEY;
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  return { app: await buildApp(loadConfig(), ports), ports };
}

afterEach(() => {
  delete process.env.PRINT_PARTNER_DATA_DIR;
});

describe("/settings/source-update-check", () => {
  it("keeps the schedule and automatic refresh setting independent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-source-monitoring-"));
    const { app, ports } = await makeApp(dir);
    try {
      expect((await app.inject({ method: "GET", url: "/settings/source-update-check" })).json())
        .toEqual({ interval_hours: 24, auto_sync_updates: true, last_checked_at: null });

      const disabled = await app.inject({
        method: "PUT",
        url: "/settings/source-update-check",
        payload: { auto_sync_updates: false },
      });
      expect(disabled.json()).toMatchObject({ interval_hours: 24, auto_sync_updates: false });

      const rescheduled = await app.inject({
        method: "PUT",
        url: "/settings/source-update-check",
        payload: { interval_hours: 12 },
      });
      expect(rescheduled.json()).toMatchObject({ interval_hours: 12, auto_sync_updates: false });
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
