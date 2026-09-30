import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { acceptedPlanBasis } from "../db/accepted-plan-progress.js";
import { AppRepository } from "../db/repository.js";
import { acceptPlanForTest } from "../test/accept-plan.js";
import { loadKitManifest, saveKitManifest } from "./kit-manifest-store.js";
import { createPlanSnapshot, restorePlanSnapshotPayload } from "./plan-snapshots.js";
import { parseRequiredUnitToken } from "./required-units.js";

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
    const basePath = repo.getSource(base.id)?.local_path;
    const addonPath = repo.getSource(addon.id)?.local_path;
    if (!basePath || !addonPath) throw new Error("test Source path is missing");
    mkdirSync(join(basePath, "parts"), { recursive: true });
    mkdirSync(join(addonPath, "parts"), { recursive: true });
    writeFileSync(join(basePath, "parts", "base.stl"), "solid base");
    writeFileSync(join(addonPath, "parts", "addon.stl"), "solid addon");
    repo.updateImportRules(base.id, ["parts/"]);
    repo.updateImportRules(addon.id, ["parts/"]);
    saveKitManifest(repo, plan.id, {
      name: "Configured kit",
      base_source_id: String(base.id),
      addon_source_ids: [String(addon.id)],
      selections: { toolhead: "dragonburner", extras: ["skirts", "panels"] },
      include: ["parts/**"],
      exclude: ["parts/optional/**"],
      replacements: { "parts/default.stl": "parts/custom.stl" },
    });
    expect(acceptPlanForTest(repo, plan.id)).toMatchObject({ merged: true, part_count: 2 });
    const accepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (accepted.kind !== "ready") throw new Error("test accepted Plan is missing");
    const firstUnit = accepted.snapshot.parts.flatMap((part) => part.units)[0];
    if (!firstUnit) throw new Error("test accepted unit is missing");
    expect(
      repo.setAcceptedUnitCompletion({
        expected: acceptedPlanBasis(accepted.snapshot),
        token: parseRequiredUnitToken(firstUnit.token),
        completed: true,
      }),
    ).toMatchObject({ kind: "updated" });
    const acceptedBeforeRestore = repo.readAcceptedPlanOperationalSnapshot(plan.id);
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
    expect(repo.readAcceptedPlanOperationalSnapshot(plan.id)).toEqual(acceptedBeforeRestore);
    expect(repo.getProfileHeader(plan.id)?.freshness).toMatchObject({
      status: "stale",
      reasons: expect.arrayContaining([{ kind: "plan_configuration_changed" }]),
    });
  });

  it("preserves nullable kit fields omitted by a legacy snapshot", () => {
    const plan = repo.createProfile("Legacy snapshot restore");
    saveKitManifest(repo, plan.id, {
      name: "Current kit",
      base_source_id: "current-base",
      selections: { toolhead: "dragonburner" },
    });

    expect(
      restorePlanSnapshotPayload(repo, plan.id, {
        layers: [],
        kit_manifest: {
          selections: {},
          include: [],
          exclude: [],
          replacements: {},
          addon_source_ids: [],
        },
      }),
    ).toMatchObject({ ok: true });

    expect(loadKitManifest(repo, plan.id)).toMatchObject({
      name: "Current kit",
      base_source_id: "current-base",
      selections: {},
    });
  });

  it("preserves current layers when a snapshot add-on is not synced", () => {
    const base = repo.createSource({ name: "Current Base", source_kind: "local" });
    const addon = repo.createSource({ name: "Snapshot Addon", source_kind: "local" });
    const plan = repo.createProfile("Failed snapshot restore");
    repo.updateSource(addon.id, { last_synced_at: "2026-09-30T12:00:00.000Z" });
    repo.addAddonLayer(plan.id, addon.id);
    const snapshot = createPlanSnapshot(repo, plan.id, { name: "Addon only" });
    const addonLayer = repo.getProfileLayers(plan.id)[0];
    if (!addonLayer) throw new Error("test add-on layer is missing");
    repo.removeLayer(addonLayer.id);
    repo.setBaseLayer(plan.id, base.id);
    repo.updateSource(addon.id, { last_synced_at: null });
    const layersBeforeRestore = repo.getProfileLayers(plan.id);

    expect(restorePlanSnapshotPayload(repo, plan.id, snapshot.payload)).toMatchObject({
      ok: false,
      needs_sync: true,
    });
    expect(repo.getProfileLayers(plan.id)).toEqual(layersBeforeRestore);
  });
});
