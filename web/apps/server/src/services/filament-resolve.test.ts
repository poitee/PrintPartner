import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { resolveFilamentDisplaySync } from "./filament-resolve.js";
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
