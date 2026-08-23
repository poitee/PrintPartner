import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const directories: string[] = [];

afterEach(() => {
  delete process.env.PRINT_PARTNER_DATA_DIR;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pp-production-setup-"));
  directories.push(directory);
  process.env.PRINT_PARTNER_DATA_DIR = directory;
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  const app = await buildApp(loadConfig(), ports);
  return { app, ports };
}

describe("production setup routes", () => {
  it("persists editable production choices per Build", async () => {
    const { app, ports } = await fixture();
    try {
      const first = ports.repository.createProfile("First Build");
      const second = ports.repository.createProfile("Second Build");
      const setup = {
        preferred_slicer_instance_id: "orca-main",
        selection: { mode: "custom", selected_unit_tokens: ["unit:a:1"] },
        printer_assignments: [{ token: "unit:a:1", printer_id: "printer-one" }],
        rules: [
          {
            id: "rule-xy",
            enabled: true,
            kind: "keep_together",
            field: "source_directory",
            value: "XY",
          },
        ],
      };

      const saved = await app.inject({
        method: "PUT",
        url: `/plans/${first.id}/production-setup`,
        payload: setup,
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({
        format: "production-setup-v1",
        profile_id: first.id,
        ...setup,
      });

      const loaded = await app.inject({ method: "GET", url: `/plans/${first.id}/production-setup` });
      expect(loaded.json()).toEqual(saved.json());
      expect(ports.repository.getSetting(`production_setup:${first.id}`)).not.toBeNull();

      const duplicated = await app.inject({
        method: "POST",
        url: `/plans/${first.id}/duplicate`,
        payload: { name: "First Build copy" },
      });
      const duplicateSetup = await app.inject({
        method: "GET",
        url: `/plans/${duplicated.json().id}/production-setup`,
      });
      expect(ports.repository.getSetting(`production_setup:${duplicated.json().id}`)).not.toBeNull();
      expect(duplicateSetup.json()).toMatchObject({
        profile_id: duplicated.json().id,
        preferred_slicer_instance_id: "orca-main",
        selection: setup.selection,
        printer_assignments: setup.printer_assignments,
        rules: setup.rules,
      });
      const removed = await app.inject({ method: "DELETE", url: `/plans/${duplicated.json().id}` });
      expect(removed.statusCode).toBe(204);
      expect(ports.repository.getSetting(`production_setup:${duplicated.json().id}`)).toBeNull();

      const untouched = await app.inject({ method: "GET", url: `/plans/${second.id}/production-setup` });
      expect(untouched.json()).toMatchObject({
        format: "production-setup-v1",
        profile_id: second.id,
        preferred_slicer_instance_id: null,
        selection: { mode: "all_incomplete" },
        printer_assignments: [],
        rules: [],
      });
    } finally {
      await app.close();
      ports.db.close();
    }
  });

  it("rejects invalid rules without changing the saved setup", async () => {
    const { app, ports } = await fixture();
    try {
      const profile = ports.repository.createProfile("Validation Build");
      const before = await app.inject({ method: "GET", url: `/plans/${profile.id}/production-setup` });
      const rejected = await app.inject({
        method: "PUT",
        url: `/plans/${profile.id}/production-setup`,
        payload: {
          preferred_slicer_instance_id: null,
          selection: { mode: "all_incomplete" },
          rules: [{ id: "bad", enabled: true, kind: "keep_together", field: "unknown" }],
        },
      });
      expect(rejected.statusCode).toBe(400);
      const after = await app.inject({ method: "GET", url: `/plans/${profile.id}/production-setup` });
      expect(after.json()).toEqual(before.json());
    } finally {
      await app.close();
      ports.db.close();
    }
  });
});
