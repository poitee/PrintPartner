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
  it("applies independent commands without replacing unrelated choices", async () => {
    const { app, ports } = await fixture();
    try {
      const profile = ports.repository.createProfile("Concurrent choices");
      const route = await app.inject({
        method: "PATCH",
        url: `/plans/${profile.id}/production-setup`,
        payload: { kind: "set_route", route: "stl" },
      });
      const rules = await app.inject({
        method: "PATCH",
        url: `/plans/${profile.id}/production-setup`,
        payload: {
          kind: "replace_rules",
          rules: [{ id: "by-color", enabled: true, kind: "separate_by", field: "color" }],
        },
      });

      expect(route.statusCode).toBe(200);
      expect(rules.statusCode).toBe(200);
      expect(rules.json()).toMatchObject({
        route: "stl",
        rules: [{ id: "by-color", enabled: true, kind: "separate_by", field: "color" }],
      });

      const loaded = await app.inject({
        method: "GET",
        url: `/plans/${profile.id}/production-setup`,
      });
      expect(loaded.json()).toEqual(rules.json());

      const replacement = await app.inject({
        method: "PUT",
        url: `/plans/${profile.id}/production-setup`,
        payload: {
          preferred_slicer_instance_id: null,
          selection: { mode: "all_incomplete" },
          printer_assignments: [],
          route: null,
          rules: [],
        },
      });
      expect(replacement.statusCode).toBe(404);
    } finally {
      await app.close();
      ports.db.close();
    }
  });

  it("persists editable production choices per Build", async () => {
    const { app, ports } = await fixture();
    try {
      const first = ports.repository.createProfile("First Build");
      const second = ports.repository.createProfile("Second Build");
      const setup = {
        preferred_slicer_instance_id: "orca-main",
        selection: { mode: "custom", selected_unit_tokens: ["unit:a:1"] },
        printer_assignments: [{ token: "unit:a:1", printer_id: "printer-one" }],
        route: "plates",
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

      const commands = [
        {
          kind: "set_preferred_slicer_instance",
          preferred_slicer_instance_id: setup.preferred_slicer_instance_id,
        },
        { kind: "set_selection", selection: setup.selection },
        { kind: "replace_printer_assignments", printer_assignments: setup.printer_assignments },
        { kind: "set_route", route: setup.route },
        { kind: "replace_rules", rules: setup.rules },
      ];
      let saved = await app.inject({
        method: "GET",
        url: `/plans/${first.id}/production-setup`,
      });
      for (const command of commands) {
        saved = await app.inject({
          method: "PATCH",
          url: `/plans/${first.id}/production-setup`,
          payload: command,
        });
        expect(saved.statusCode).toBe(200);
      }
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
        method: "PATCH",
        url: `/plans/${profile.id}/production-setup`,
        payload: {
          kind: "replace_rules",
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

  it("round-trips every route choice and treats a stored setup without one as unchosen", async () => {
    const { app, ports } = await fixture();
    try {
      const profile = ports.repository.createProfile("Route Build");
      for (const route of ["plates", "stl", "external", null] as const) {
        const saved = await app.inject({
          method: "PATCH",
          url: `/plans/${profile.id}/production-setup`,
          payload: { kind: "set_route", route },
        });
        expect(saved.statusCode).toBe(200);
        expect(saved.json().route).toBe(route);
        const loaded = await app.inject({
          method: "GET",
          url: `/plans/${profile.id}/production-setup`,
        });
        expect(loaded.json().route).toBe(route);
      }

      // A work package saved before the route question existed. The operator
      // has not answered it, so nothing may answer it for them.
      ports.repository.setSetting(
        `production_setup:${profile.id}`,
        JSON.stringify({
          format: "production-setup-v1",
          profile_id: profile.id,
          preferred_slicer_instance_id: "orca-main",
          selection: { mode: "custom", selected_unit_tokens: ["unit:a:1"] },
          printer_assignments: [],
          rules: [],
          updated_at: "2026-01-01T00:00:00.000Z",
        }),
      );
      const legacy = await app.inject({
        method: "GET",
        url: `/plans/${profile.id}/production-setup`,
      });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json()).toMatchObject({
        preferred_slicer_instance_id: "orca-main",
        selection: { mode: "custom", selected_unit_tokens: ["unit:a:1"] },
        route: null,
      });

      const rejected = await app.inject({
        method: "PATCH",
        url: `/plans/${profile.id}/production-setup`,
        payload: { kind: "set_route", route: "plate" },
      });
      expect(rejected.statusCode).toBe(400);
    } finally {
      await app.close();
      ports.db.close();
    }
  });
});
