import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { preloadSpoolmanForColorIds, resolveFilamentDisplay, resolveFilamentDisplaySync } from "./filament-resolve.js";
import { buildSpoolmanFilamentId } from "../integrations/spoolman-client.js";
import { addCustomFilament } from "./custom-filaments.js";

describe("resolveFilamentDisplaySync", () => {
  it("resolves custom filaments before spoolman", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-fil-resolve-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const deps = { repo, dataDir: dir };

    const custom = addCustomFilament(dir, { display_name: "Shop Red", hex: "#cc0000" });
    const resolved = resolveFilamentDisplaySync(deps, custom.id);
    expect(resolved?.combo_label).toBe("Shop Red");
    expect(resolved?.hex).toBe("#cc0000");

    expect(resolveFilamentDisplaySync(deps, buildSpoolmanFilamentId("x", 1))).toBeNull();

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});


describe("Plan-scoped filament enrichment", () => {
  it.each(["default", "disabled", "invalid", "foreign", "revoked"])(
    "keeps bundled and custom display with no live inventory for %s access", async (mode) => {
      const dir = mkdtempSync(join(tmpdir(), "pp-filament-scope-"));
      const sqlite = new SqliteDatabase(dir);
      sqlite.connect();
      const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
      const network = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
        String(url).includes("/filament")
          ? [{ id: 7, name: "Red", color_hex: "ff0000" }]
          : [{ id: 11, filament_id: 7, remaining_weight: 480 }],
      )));
      vi.stubEnv("PP_DESKTOP_REBUILD", "1");
      vi.stubGlobal("fetch", network);
      try {
        const profileId = repo.createProfile("Scoped enrichment").id;
        const deps = { repo, dataDir: dir, profileId: mode === "foreign" ? 999999 : profileId };
        const custom = addCustomFilament(dir, { display_name: "Shop Red", hex: "#cc0000" });
        const color = "spoolman:inventory:filament:7";
        repo.setSetting("default_spoolman_integration_id", "inventory");
        repo.setSetting("integrations", JSON.stringify([{ id: "inventory", type: "spoolman", name: "Inventory",
          config: { base_url: "http://127.0.0.1:7912" } }]));
        if (mode === "disabled") {
          repo.setSetting("feature_toggles", '{"spoolman":true}');
          repo.setSetting(`feature_toggles:plan:${profileId}`, '{"spoolman":false}');
        }
        if (mode === "invalid") repo.setSetting(`feature_toggles:plan:${profileId}`, '{"spoolman":null}');
        if (mode === "foreign") repo.setSetting("feature_toggles", '{"spoolman":true}');
        if (mode === "revoked") repo.setSetting(`feature_toggles:plan:${profileId}`, '{"spoolman":true}');
        const context = await preloadSpoolmanForColorIds(deps, [color]);
        if (mode === "revoked") {
          expect(context.resolve(color)?.display_name).toBe("Red");
          expect(context.spoolSummaries(color)).toEqual([{ spool_id: 11, remaining_g: 480 }]);
          repo.setSetting(`feature_toggles:plan:${profileId}`, '{"spoolman":false}');
          network.mockClear();
        }
        expect(context.resolve(color)).toBeNull();
        expect(context.spoolSummaries(color)).toEqual([]);
        expect(context.spoolSummariesForPart(color, "spoolman:inventory:spool:11")).toEqual([]);
        expect(await resolveFilamentDisplay(deps, color)).toBeNull();
        expect(context.resolve(custom.id)).toEqual({ combo_label: "Shop Red", hex: "#cc0000", display_name: "Shop Red" });
        expect(context.resolve("abs-matte::british-racing-green")?.display_name).toBe("British Racing Green");
        expect(network).not.toHaveBeenCalled();
      } finally {
        sqlite.close();
        rmSync(dir, { recursive: true, force: true });
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    },
  );
});
