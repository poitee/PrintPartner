import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import {
  canonicalRoleOrder,
  loadRoleFilamentDefaults,
  saveRoleFilamentDefault,
} from "./role-filament-store.js";

describe("role-filament-store", () => {
  it("round-trips per-role defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-role-store-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const plan = repo.createProfile("StorePlan");

    saveRoleFilamentDefault(repo, plan.id, "accent", {
      filament_color_id: "pla-red",
      filament_custom_hex: null,
      spoolman_spool_id: null,
    });

    const loaded = loadRoleFilamentDefaults(repo, plan.id);
    expect(loaded.accent?.filament_color_id).toBe("pla-red");
    expect(canonicalRoleOrder()).toContain("accent");

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
