import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { loadKitManifest, saveKitManifest } from "./kit-manifest-store.js";
import { createPlanSnapshot, restorePlanSnapshotPayload } from "./plan-snapshots.js";

describe("restorePlanSnapshotPayload", () => {
  let dataDir: string;
  let database: SqliteDatabase;
  let repo: AppRepository;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-plan-snapshot-"));
    database = new SqliteDatabase(dataDir);
    database.connect();
    repo = new AppRepository(getDb(database), undefined, database.reposDir);
  });

  afterEach(() => {
    database.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("restores a snapshot with no attached sources or kit choices", () => {
    const base = repo.createSource({ name: "Base Source", source_kind: "local" });
    const addon = repo.createSource({ name: "Addon Source", source_kind: "local" });
    const plan = repo.createProfile("Empty snapshot restore");
    const snapshot = createPlanSnapshot(repo, plan.id, { name: "Empty configuration" });

    expect(snapshot.payload).toMatchObject({
      layers: [],
      kit_manifest: {
        name: null,
        selections: {},
        include: [],
        exclude: [],
        replacements: {},
        base_source_id: null,
        addon_source_ids: [],
      },
    });

    repo.setBaseLayer(plan.id, base.id);
    repo.addAddonLayer(plan.id, addon.id);
    saveKitManifest(repo, plan.id, {
      name: "Configured kit",
      base_source_id: String(base.id),
      addon_source_ids: [String(addon.id)],
      selections: { toolhead: "dragonburner", extras: ["skirts", "panels"] },
      include: ["parts/**"],
      exclude: ["parts/optional/**"],
      replacements: { "parts/default.stl": "parts/custom.stl" },
    });
    const sourcesBeforeRestore = repo.listSources();

    expect(restorePlanSnapshotPayload(repo, plan.id, snapshot.payload)).toMatchObject({
      ok: true,
    });

    database.close();
    database = new SqliteDatabase(dataDir);
    database.connect();
    repo = new AppRepository(getDb(database), undefined, database.reposDir);

    const restoredKit = loadKitManifest(repo, plan.id);
    expect({
      layers: repo.getProfileLayers(plan.id),
      kit: {
        name: restoredKit.name,
        base_source_id: restoredKit.base_source_id,
        addon_source_ids: restoredKit.addon_source_ids,
        selections: restoredKit.selections,
        include: restoredKit.include,
        exclude: restoredKit.exclude,
        replacements: restoredKit.replacements,
      },
      sources: repo.listSources(),
    }).toEqual({
      layers: [],
      kit: {
        name: null,
        base_source_id: null,
        addon_source_ids: [],
        selections: {},
        include: [],
        exclude: [],
        replacements: {},
      },
      sources: sourcesBeforeRestore,
    });
  });
});
