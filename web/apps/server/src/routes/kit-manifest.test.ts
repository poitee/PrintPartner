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
  const directory = mkdtempSync(join(tmpdir(), "pp-kit-route-"));
  directories.push(directory);
  process.env.PRINT_PARTNER_DATA_DIR = directory;
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  const sourceDirectory = join(directory, "repos", "extras");
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(
    join(sourceDirectory, "print-partner.manifest.yaml"),
    `format: print-partner-manifest
version: 2
option_groups:
  extras:
    rule: pick_n
    min: 1
    max: 2
    variants:
      - id: skirts
        parts: ["skirts/**"]
      - id: panels
        parts: ["panels/**"]
      - id: screen
        parts: ["screen/**"]
  optional_extras:
    rule: pick_any
    min: 0
    variants:
      - id: badge
        parts: ["badge/**"]
  toolhead:
    rule: pick_one
    variants:
      - id: stock
        parts: ["toolhead/**"]
selections:
  extras: [skirts]
  optional_extras: [badge]
`,
  );
  const source = ports.repository!.createSource({
    name: "Extras",
    source_kind: "local",
    local_path: sourceDirectory,
  });
  const profile = ports.repository!.createProfile("Multi-select Build", source.id);
  const app = await buildApp(loadConfig(), ports);
  return { app, profileId: profile.id };
}

describe("kit manifest route", () => {
  it("round-trips scalar and array selections", async () => {
    const { app, profileId } = await fixture();
    try {
      const save = await app.inject({
        method: "PUT",
        url: `/plans/${profileId}/kit-manifest`,
        payload: {
          kit: {
            selections: {
              toolhead: "stealthburner",
              extras: ["skirts", "panels"],
            },
          },
        },
      });
      expect(save.statusCode).toBe(200);
      expect(save.json().kit.selections).toEqual({
        toolhead: "stealthburner",
        extras: ["skirts", "panels"],
      });

      const read = await app.inject({
        method: "GET",
        url: `/plans/${profileId}/kit-manifest`,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().kit.selections).toEqual({
        toolhead: "stealthburner",
        extras: ["skirts", "panels"],
      });
    } finally {
      await app.close();
    }
  });

  it("persists explicit empty multi-selects instead of restoring defaults", async () => {
    const { app, profileId } = await fixture();
    try {
      const before = await app.inject({
        method: "GET",
        url: `/plans/${profileId}/plan-manifest-builder`,
      });
      expect(before.statusCode).toBe(200);
      expect(before.json().resolved_selections.extras).toEqual(["skirts"]);
      expect(before.json().resolved_selections.optional_extras).toEqual(["badge"]);

      const save = await app.inject({
        method: "PUT",
        url: `/plans/${profileId}/kit-manifest`,
        payload: {
          kit: {
            selections: {
              extras: [],
              optional_extras: [],
              retired_group: [],
            },
          },
        },
      });
      expect(save.statusCode).toBe(200);
      expect(save.json().kit.selections).toEqual({
        extras: [],
        optional_extras: [],
        retired_group: [],
      });

      const read = await app.inject({
        method: "GET",
        url: `/plans/${profileId}/kit-manifest`,
      });
      expect(read.json().kit.selections).toEqual({
        extras: [],
        optional_extras: [],
        retired_group: [],
      });

      const after = await app.inject({
        method: "GET",
        url: `/plans/${profileId}/plan-manifest-builder`,
      });
      expect(after.json().resolved_selections).toEqual({
        extras: [],
        optional_extras: [],
        retired_group: [],
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    { selections: null, path: "kit.selections" },
    {
      selections: { extras: ["skirts", "skirts"] },
      path: "kit.selections.extras",
    },
    { selections: { extras: ["skirts", 4] }, path: "kit.selections.extras" },
    { selections: { extras: 4 }, path: "kit.selections.extras" },
    { selections: { toolhead: [] }, path: "kit.selections.toolhead" },
  ])("rejects malformed selections at the HTTP boundary", async ({ selections, path }) => {
    const { app, profileId } = await fixture();
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/plans/${profileId}/kit-manifest`,
        payload: { kit: { selections } },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().detail).toContain(path);
    } finally {
      await app.close();
    }
  });

  it("rejects a selection above the option group's maximum", async () => {
    const { app, profileId } = await fixture();
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/plans/${profileId}/kit-manifest`,
        payload: { kit: { selections: { extras: ["skirts", "panels", "screen"] } } },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().detail).toBe(
        "kit.selections.extras must contain no more than 2 variant ids",
      );
    } finally {
      await app.close();
    }
  });
});
