import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig } from "../config.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("role filament routes", () => {
  it("saves role colors before the first Plan is published", async () => {
    const root = mkdtempSync(join(tmpdir(), "pp-role-filament-routes-"));
    const previousDataDir = process.env.PRINT_PARTNER_DATA_DIR;
    process.env.PRINT_PARTNER_DATA_DIR = root;
    const ports = createSelfHostPorts(root);
    await ports.db.connect();
    const profile = ports.repository.createProfile("Unpublished color Plan");
    const app = await buildApp(loadConfig(), ports);
    cleanups.push(async () => {
      await app.close();
      await ports.db.close();
      if (previousDataDir === undefined) delete process.env.PRINT_PARTNER_DATA_DIR;
      else process.env.PRINT_PARTNER_DATA_DIR = previousDataDir;
      rmSync(root, { recursive: true, force: true });
    });

    expect(ports.repository.readAcceptedPlanOperationalSnapshot(profile.id).kind).toBe("empty");

    const response = await app.inject({
      method: "PUT",
      url: `/plans/${profile.id}/role-filament`,
      payload: {
        role: "primary",
        filament_color_id: "pla-black",
        filament_custom_hex: null,
        spoolman_spool_id: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      updated: 0,
      thumbnails_cleared: 0,
      roles: expect.arrayContaining([
        expect.objectContaining({
          role: "primary",
          filament_color_id: "pla-black",
        }),
      ]),
    });
    expect(ports.repository.readAcceptedPlanOperationalSnapshot(profile.id).kind).toBe("empty");
    expect(ports.repository.getRoleFilaments(profile.id)[0]?.filament_color_id).toBe("pla-black");

    const applyResponse = await app.inject({
      method: "POST",
      url: `/plans/${profile.id}/apply-role-colors`,
      payload: {},
    });

    expect(applyResponse.statusCode).toBe(200);
    expect(applyResponse.json()).toMatchObject({
      updated: 0,
      thumbnails_cleared: 0,
      roles: expect.arrayContaining([
        expect.objectContaining({
          role: "primary",
          filament_color_id: "pla-black",
        }),
      ]),
    });
  });
});
