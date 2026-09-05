import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { buildPlanManifestBuilder } from "./plan-manifest-builder.js";
import { inferOptionGroupsFromPaths } from "./path-hints.js";

describe("path hints", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories) {
      rmSync(directory, { recursive: true, force: true });
    }
    directories.length = 0;
  });

  function dataDir(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  }

  it("merges validated custom rules with shipped rules without leaking between data directories", () => {
    const firstDataDir = dataDir("pp-path-hints-first-");
    const secondDataDir = dataDir("pp-path-hints-second-");
    writeFileSync(
      join(firstDataDir, "path-hints.yaml"),
      `version: 1
rules:
  - path: "**/Custom/**"
    option_group: extruder
    variant_id: orbiter
    label: Orbiter
`,
    );
    writeFileSync(
      join(secondDataDir, "path-hints.yaml"),
      `version: 1
rules:
  - path: "**/Custom/**"
    option_group: hotend
    variant_id: dragon
    label: Dragon
`,
    );
    const scannedPaths = [
      "STLs/electronics/board.stl",
      "STLs/Custom/mount.stl",
    ];

    const first = inferOptionGroupsFromPaths(scannedPaths, firstDataDir);
    const second = inferOptionGroupsFromPaths(scannedPaths, secondDataDir);

    expect(first.controller?.variants.map((variant) => variant.id)).toContain("stock");
    expect(first.extruder?.variants.map((variant) => variant.id)).toEqual(["orbiter"]);
    expect(first).not.toHaveProperty("hotend");
    expect(second.hotend?.variants.map((variant) => variant.id)).toEqual(["dragon"]);
    expect(second).not.toHaveProperty("extruder");
  });

  it("reports the exact malformed custom rule instead of silently ignoring user configuration", () => {
    const directory = dataDir("pp-path-hints-invalid-");
    writeFileSync(
      join(directory, "path-hints.yaml"),
      `version: 1
rules:
  - path: 42
    option_group: extruder
    variant_id: orbiter
`,
    );

    expect(() => inferOptionGroupsFromPaths(["STLs/Custom/mount.stl"], directory)).toThrow(
      /path-hints\.yaml.*rules\[0\]\.path must be a non-empty string/i,
    );
  });

  it("rejects unsupported custom rule fields", () => {
    const directory = dataDir("pp-path-hints-unknown-");
    writeFileSync(
      join(directory, "path-hints.yaml"),
      `version: 1
rules:
  - path: "**/Custom/**"
    option_group: extruder
    variant_id: orbiter
    confidence: high
`,
    );

    expect(() => inferOptionGroupsFromPaths(["STLs/Custom/mount.stl"], directory)).toThrow(
      /path-hints\.yaml.*rules\[0\]\.confidence is not supported/i,
    );
  });

  it("rejects unsupported document fields", () => {
    const directory = dataDir("pp-path-hints-document-");
    writeFileSync(
      join(directory, "path-hints.yaml"),
      `version: 1
rules: []
fallback: true
`,
    );

    expect(() => inferOptionGroupsFromPaths([], directory)).toThrow(
      /path-hints\.yaml.*fallback is not supported/i,
    );
  });

  it("rejects rules that cannot produce an option-group suggestion", () => {
    const directory = dataDir("pp-path-hints-noop-");
    writeFileSync(
      join(directory, "path-hints.yaml"),
      `version: 1
rules:
  - path: "**/Custom/**"
    label: Custom parts
`,
    );

    expect(() => inferOptionGroupsFromPaths(["STLs/Custom/mount.stl"], directory)).toThrow(
      /path-hints\.yaml.*rules\[0\]\.option_group must be a non-empty string/i,
    );
  });

  it("threads the explicit data directory through Plan option inference", async () => {
    const directory = dataDir("pp-plan-path-hints-");
    writeFileSync(
      join(directory, "path-hints.yaml"),
      `version: 1
rules:
  - path: "**/Bespoke/**"
    option_group: enclosure
    variant_id: custom
    label: Custom enclosure
`,
    );
    const ports = createSelfHostPorts(directory);
    await ports.db.connect();
    try {
      const repo = ports.repository;
      if (!repo) throw new Error("Repository unavailable");
      const source = repo.createSource({
        name: "Custom project",
        url: "https://example.test/custom-project",
      });
      const sourcePath = join(directory, "repos", String(source.id));
      mkdirSync(join(sourcePath, "STLs", "Bespoke"), { recursive: true });
      writeFileSync(join(sourcePath, "STLs", "Bespoke", "panel.stl"), "solid panel");
      repo.updateSource(source.id, { local_path: sourcePath });
      const plan = repo.createProfile("Custom Plan", source.id);

      const builder = buildPlanManifestBuilder(repo, plan.id, directory);

      expect(builder.merged_option_groups.enclosure?.variants).toEqual([
        expect.objectContaining({ id: "custom", parts: ["**/Bespoke/**"] }),
      ]);
    } finally {
      await ports.db.close();
    }
  });
});
