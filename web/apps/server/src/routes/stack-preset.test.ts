import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { registerManifestRoutes } from "./manifest.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("stack preset route", () => {
  it("uses the configured catalog and rejects over-limit defaults", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-stack-route-"));
    directories.push(dataDir);
    const sourceDirectory = join(dataDir, "repos", "bounded-preset");
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(
      join(sourceDirectory, "print-partner.manifest.yaml"),
      `format: print-partner-manifest
version: 2
option_groups:
  extras:
    rule: pick_n
    max: 1
    variants:
      - id: skirts
        parts: ["skirts/**"]
      - id: panels
        parts: ["panels/**"]
`,
    );
    writeFileSync(
      join(dataDir, "kit-catalog.yaml"),
      `version: 1
bases:
  bounded:
    source_name: Bounded-Printer
addon_categories: {}
stack_presets:
  invalid_bundle:
    label: Invalid bundle
    base: bounded
    addon_sources: []
    default_selections:
      extras: [skirts, panels]
`,
    );

    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const repo = ports.repository!;
    const original = repo.createSource({ name: "Original-Printer", source_kind: "local" });
    repo.createSource({
      name: "Bounded-Printer",
      source_kind: "local",
      local_path: sourceDirectory,
    });
    const plan = repo.createProfile("Route plan", original.id);
    const app = Fastify();
    await registerManifestRoutes(app, { repo, dataDir });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/plans/${plan.id}/apply-stack-preset`,
        payload: { preset_id: "invalid_bundle" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().detail).toBe(
        "stack_presets.invalid_bundle.default_selections.extras must contain no more than 1 variant id",
      );
      expect(repo.getProfileLayers(plan.id).map((layer) => layer.project_id)).toEqual([
        original.id,
      ]);
    } finally {
      await app.close();
      await ports.db.close();
    }
  });
});
