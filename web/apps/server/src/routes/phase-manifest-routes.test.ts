import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pp-phase-manifest-"));
  directories.push(directory);
  process.env.PRINT_PARTNER_DATA_DIR = directory;
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  const app = await buildApp(loadConfig(), ports);
  return { app, ports, directory };
}

describe("plan phase manifest route", () => {
  it("answers has_phases false (not 404) for a plan whose sources ship no pp-phases.json", async () => {
    const { app, ports } = await fixture();
    try {
      const repo = ports.repository!;
      const source = repo.createSource({ name: "Plain source", source_kind: "local" });
      const profile = repo.createProfile("Plain Build", source.id);

      const response = await app.inject({ method: "GET", url: `/plans/${profile.id}/phase-manifest` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ profile_id: profile.id, has_phases: false, phases: [] });
    } finally {
      await app.close();
    }
  });

  it("serves normalized phases from the first source carrying a pp-phases.json", async () => {
    const { app, ports, directory } = await fixture();
    try {
      const repo = ports.repository!;
      const sourceRoot = join(directory, "repos", "phased-source");
      mkdirSync(sourceRoot, { recursive: true });
      writeFileSync(
        join(sourceRoot, "pp-phases.json"),
        JSON.stringify({
          phases: [
            { name: "Frame", folders: ["STLs/frame"] },
            { name: "Toolhead", folders: ["STLs/toolhead"], depends_on: ["Frame"], order: 7 },
          ],
        }),
      );
      const source = repo.createSource({
        name: "Phased source",
        source_kind: "local",
        local_path: sourceRoot,
      });
      const profile = repo.createProfile("Phased Build", source.id);

      const response = await app.inject({ method: "GET", url: `/plans/${profile.id}/phase-manifest` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        profile_id: profile.id,
        has_phases: true,
        phases: [
          { name: "Frame", folders: ["STLs/frame"], order: 0, depends_on: [] },
          { name: "Toolhead", folders: ["STLs/toolhead"], depends_on: ["Frame"], order: 7 },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it("ignores a malformed pp-phases.json and falls back to the flat list", async () => {
    const { app, ports, directory } = await fixture();
    try {
      const repo = ports.repository!;
      const sourceRoot = join(directory, "repos", "broken-source");
      mkdirSync(sourceRoot, { recursive: true });
      writeFileSync(join(sourceRoot, "pp-phases.json"), '{"phases": [{"folders": []}]}');
      const source = repo.createSource({
        name: "Broken source",
        source_kind: "local",
        local_path: sourceRoot,
      });
      const profile = repo.createProfile("Broken Build", source.id);

      const response = await app.inject({ method: "GET", url: `/plans/${profile.id}/phase-manifest` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ profile_id: profile.id, has_phases: false, phases: [] });
    } finally {
      await app.close();
    }
  });
});
