import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { parseRegistryIndex, registerManifestRoutes } from "./manifest.js";

describe("parseRegistryIndex", () => {
  it("parses complete entries regardless of YAML field order", () => {
    const registry = parseRegistryIndex(`
entries:
  - title: "LDO 2.4: Stealthburner"
    status: proposed
    manifest_file: ldo/manifest.yaml
    slug: ldo-2.4
    target_repo: LDOVoron2
`);

    expect(registry).toEqual({
      entries: [
        {
          slug: "ldo-2.4",
          target_repo: "LDOVoron2",
          title: "LDO 2.4: Stealthburner",
          manifest_file: "ldo/manifest.yaml",
          status: "proposed",
        },
      ],
    });
  });

  it("rejects malformed or incomplete registry documents", () => {
    expect(() => parseRegistryIndex("entries: nope")).toThrow(/entries array/i);
    expect(() => parseRegistryIndex("entries:\n  - slug: incomplete\n")).toThrow(
      /target_repo/i,
    );
  });
});

describe("manifest registry routes", () => {
  it("reserves registry-index while keeping the embedded registry listing available", async () => {
    const app = Fastify();
    const dataDir = mkdtempSync(join(tmpdir(), "pp-manifest-registry-"));
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    try {
      const repo = ports.repository;
      if (!repo) throw new Error("Self-host repository unavailable");
      await registerManifestRoutes(app, { repo, dataDir: null });

      const manifest = await app.inject({ method: "GET", url: "/manifest-registry/registry-index" });
      expect(manifest.statusCode).toBe(404);
      expect(manifest.json()).toEqual({ detail: "Manifest not found" });

      const registry = await app.inject({ method: "GET", url: "/manifest-registry" });
      expect(registry.statusCode).toBe(200);
      expect(registry.json()).toEqual({ entries: expect.any(Array) });
    } finally {
      await app.close();
      await ports.db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
