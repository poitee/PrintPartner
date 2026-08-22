import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import {
  importReposTxt,
  parseReposTxtLine,
  parseReposTxtText,
  suggestFromCatalog,
} from "./repos-txt.js";

const SAMPLE_REPOS = `LDOVoron2,https://github.com/MotorDynamicsLab/LDOVoron2,main
Voron-Stealthburner,https://github.com/VoronDesign/Voron-Stealthburner,main
LDO-Extras,None,main
# comment
https://github.com/VoronDesign/Voron-Tap
`;

describe("repos-txt parser", () => {
  it("parses CSV lines and bare GitHub URLs", () => {
    const row = parseReposTxtLine("Alpha,https://github.com/a/b.git,dev");
    expect(row).toEqual({ name: "Alpha", url: "https://github.com/a/b.git", branch: "dev" });
    expect(parseReposTxtLine("LDO-Extras,None,main")).toBeNull();
    const urlRow = parseReposTxtLine("https://github.com/VoronDesign/Voron-Tap");
    expect(urlRow).toEqual({
      name: "Voron-Tap",
      url: "https://github.com/VoronDesign/Voron-Tap",
      branch: "main",
    });
  });

  it("parses sample repos.txt text", () => {
    const rows = parseReposTxtText(SAMPLE_REPOS);
    const names = new Set(rows.map((r) => r.name));
    expect(names.has("LDOVoron2")).toBe(true);
    expect(names.has("Voron-Stealthburner")).toBe(true);
    expect(names.has("Voron-Tap")).toBe(true);
    expect(names.has("LDO-Extras")).toBe(false);
  });

  it("suggests roles from kit catalog", () => {
    const catalog = {
      version: 1,
      bases: {
        "ldo_voron_2.4": { source_name: "LDOVoron2" },
      },
      addon_categories: {
        toolhead: {
          sources: [{ name: "Voron-Stealthburner", compatible_bases: ["ldo_voron_2.4"] }],
        },
      },
    };
    expect(suggestFromCatalog("LDOVoron2", catalog)?.role).toBe("base");
    const addon = suggestFromCatalog("Voron-Stealthburner", catalog);
    expect(addon?.role).toBe("addon");
    expect((addon?.metadata.kit as Record<string, unknown>).addon_category).toBe("toolhead");
  });
});

describe("repos-txt import", () => {
  it("creates, updates, and skips lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-repos-txt-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    repo.createSource({
      name: "LDOVoron2",
      url: "https://github.com/old/url.git",
      branch: "old",
      source_kind: "github",
    });

    const catalog = {
      version: 1,
      bases: { "ldo_voron_2.4": { source_name: "LDOVoron2" } },
      addon_categories: {
        toolhead: { sources: [{ name: "Voron-Stealthburner" }] },
        probe: { sources: [{ name: "Voron-Tap" }] },
      },
    };

    const result = importReposTxt(repo, SAMPLE_REPOS, catalog);
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(result.created).toBeGreaterThanOrEqual(2);
    expect(result.skipped).toBe(1);
    expect(result.skipped_names).toContain("LDO-Extras");

    const updated = repo.listSources().find((s) => s.name === "LDOVoron2");
    expect(updated?.url).toContain("MotorDynamicsLab");

    const stealth = repo.listSources().find((s) => s.name === "Voron-Stealthburner");
    expect(stealth?.role).toBe("addon");

    const createdRows = result.results.filter((r) => r.action === "created");
    expect(createdRows.every((r) => r.source_id != null)).toBe(true);

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
