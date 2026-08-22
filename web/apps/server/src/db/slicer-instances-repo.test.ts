import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, SqliteDatabase } from "./client.js";
import { AppRepository } from "./repository.js";

let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pp-slicer-instances-repo-"));
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();
  const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
  cleanup.push(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return repo;
}

describe("slicer instance repository", () => {
  it("CRUD round-trips an instance", () => {
    const repo = makeRepo();
    const created = repo.upsertSlicerInstance({
      name: "My Orca",
      kind: "orca",
      dialect: "orca_json",
      guiUrl: "http://orca.local",
      watchPath: "/profiles/orca",
      enabled: true,
    });
    expect(created.id).toMatch(/^slicer-/);
    expect(repo.getSlicerInstance(created.id)?.name).toBe("My Orca");

    const updated = repo.upsertSlicerInstance({
      id: created.id,
      name: "Orca Renamed",
      kind: "orca",
      dialect: "orca_json",
      guiUrl: "http://orca.local",
      watchPath: "/profiles/orca",
      enabled: false,
    });
    expect(updated.name).toBe("Orca Renamed");
    expect(updated.enabled).toBe(false);
    expect(repo.listSlicerInstances()).toHaveLength(1);

    expect(repo.deleteSlicerInstance(created.id)).toBe(true);
    expect(repo.listSlicerInstances()).toHaveLength(0);
  });

  it("seeds stock presets only when empty", () => {
    const repo = makeRepo();
    expect(
      repo.seedStockSlicerInstancesIfEmpty({
        SLICER_ORCA_DIR: "/custom/orca",
      }),
    ).toBe(3);
    expect(repo.listSlicerInstances()).toHaveLength(3);
    expect(repo.listSlicerInstances().find((r) => r.kind === "orca")?.watchPath).toBe(
      "/custom/orca",
    );
    expect(repo.seedStockSlicerInstancesIfEmpty()).toBe(0);
    expect(repo.listSlicerInstances()).toHaveLength(3);
  });
});
