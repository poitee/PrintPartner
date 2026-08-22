import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";

/**
 * Regression coverage for the Build Tracking (assembly tracking) global setting.
 *
 * Acceptance criteria pinned here:
 *  - defaults to OFF on a fresh install (empty data dir),
 *  - PUT persists both true and false,
 *  - the value survives a full app/process restart (re-opened from the on-disk DB),
 *  - other modules can read it through the settings accessor (repo.getSetting).
 */
async function makeApp(dir: string) {
  process.env.PRINT_PARTNER_DATA_DIR = dir;
  delete process.env.PRINT_PARTNER_API_KEY;
  const config = loadConfig();
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  const app = await buildApp(config, ports);
  return { app, ports };
}

describe("/settings/build-tracking", () => {
  afterEach(() => {
    delete process.env.PRINT_PARTNER_DATA_DIR;
  });

  it("defaults to off on a fresh install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-build-tracking-default-"));
    const { app, ports } = await makeApp(dir);

    const res = await app.inject({ method: "GET", url: "/settings/build-tracking" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ assembly_tracking: false });

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists the toggle across a restart and exposes it via the settings accessor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-build-tracking-persist-"));
    const first = await makeApp(dir);

    const putOn = await first.app.inject({
      method: "PUT",
      url: "/settings/build-tracking",
      payload: { assembly_tracking: true },
    });
    expect(putOn.statusCode).toBe(200);
    expect(putOn.json()).toEqual({ assembly_tracking: true });

    // Readable by other modules through the shared settings accessor.
    expect(first.ports.repository!.getSetting("build_tracking_assembly", "0")).toBe("1");

    await first.app.close();
    first.ports.db.close();

    // Restart: brand new app + ports over the same on-disk data dir.
    const second = await makeApp(dir);
    const afterRestart = await second.app.inject({
      method: "GET",
      url: "/settings/build-tracking",
    });
    expect(afterRestart.statusCode).toBe(200);
    expect(afterRestart.json()).toEqual({ assembly_tracking: true });

    // Turning it back off persists too (not a write-once flag).
    const putOff = await second.app.inject({
      method: "PUT",
      url: "/settings/build-tracking",
      payload: { assembly_tracking: false },
    });
    expect(putOff.statusCode).toBe(200);
    expect(putOff.json()).toEqual({ assembly_tracking: false });
    expect(second.ports.repository!.getSetting("build_tracking_assembly", "0")).toBe("0");

    await second.app.close();
    second.ports.db.close();

    const third = await makeApp(dir);
    const finalRes = await third.app.inject({ method: "GET", url: "/settings/build-tracking" });
    expect(finalRes.json()).toEqual({ assembly_tracking: false });

    await third.app.close();
    third.ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
