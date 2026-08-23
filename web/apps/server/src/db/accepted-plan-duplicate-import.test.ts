import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptPlanForTest } from "../test/accept-plan.js";
import { captureAcceptedOperationalExport } from "../services/accepted-operational-export.js";
import { getDb, SqliteDatabase } from "./client.js";
import { acceptedPlanBasis } from "./accepted-plan-progress.js";
import { AppRepository } from "./repository.js";
import { buildKitBundleData } from "../services/export-kit.js";
import { loadKitManifest, saveKitManifest } from "../services/kit-manifest-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function acceptedPlanFixture(name: string, filenames = ["widget.stl"]) {
  const root = mkdtempSync(join(tmpdir(), "pp-accepted-copy-"));
  roots.push(root);
  const database = new SqliteDatabase(root);
  database.connect();
  const repo = new AppRepository(getDb(database), undefined, database.reposDir);
  const source = repo.createSource({
    name: `${name}Repo`,
    url: "https://github.com/a/b",
  });
  const repoPath = join(root, "repos", String(source.id));
  mkdirSync(join(repoPath, "parts"), { recursive: true });
  for (const filename of filenames) {
    writeFileSync(join(repoPath, "parts", filename), `solid ${filename}`);
  }
  repo.updateSource(source.id, { local_path: repoPath });
  repo.updateImportRules(source.id, ["parts/"]);
  const plan = repo.createProfile(name, source.id);
  expect(acceptPlanForTest(repo, plan.id).merged).toBe(true);
  return {
    database,
    repo,
    plan,
    repoPath,
    source,
    raw: (database as unknown as { sqlite: Database.Database }).sqlite,
  };
}

describe("duplicateProfile accepted publish", () => {
  it("publishes a ready accepted copy through Apply instead of inserting working Parts", () => {
    const { database, repo, plan } = acceptedPlanFixture("SourcePlan");
    const source = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    expect(source.kind).toBe("ready");
    if (source.kind !== "ready") throw new Error("source Plan is not ready");
    const part = source.snapshot.parts[0];
    if (!part) throw new Error("source Part is missing");
    expect(
      repo.assignAcceptedFilament({
        expected: acceptedPlanBasis(source.snapshot),
        target: { kind: "part", projectionPartId: part.projectionPartId },
        assignment: {
          color: { kind: "catalog", colorId: "pla-black" },
          spoolmanSpoolId: "spool-9",
        },
      }).kind,
    ).toBe("updated");
    expect(
      repo.setAcceptedPrintedCounts({
        expected: acceptedPlanBasis(source.snapshot),
        rows: [{ partId: part.projectionPartId, printedCount: 1 }],
      }).kind,
    ).toBe("updated");
    saveKitManifest(repo, plan.id, { selections: { head: "sb" } });

    const copy = repo.duplicateProfile(plan.id, "CopiedPlan");
    const accepted = repo.readAcceptedPlanOperationalSnapshot(copy.id);
    expect(accepted.kind).toBe("ready");
    if (accepted.kind !== "ready") throw new Error("copied Plan is not ready");
    expect(accepted.snapshot.revisionId).toBeGreaterThan(0);
    expect(accepted.snapshot.parts[0]?.filename).toBe("widget.stl");
    expect(accepted.snapshot.parts[0]?.projectionPartId).not.toBe(part.projectionPartId);
    expect(accepted.snapshot.parts[0]?.filamentColorId).toBe("pla-black");
    expect(accepted.snapshot.parts[0]?.spoolmanSpoolId).toBe("spool-9");
    expect(accepted.snapshot.parts[0]?.units[0]?.completed).toBe(true);
    expect(loadKitManifest(repo, copy.id).selections.head).toBe("sb");
    database.close();
  });

  it("reports a publication failure instead of returning an empty duplicate", () => {
    const { database, repo, plan, repoPath } = acceptedPlanFixture("MissingDuplicateSource");
    rmSync(join(repoPath, "parts", "widget.stl"));

    expect(() => repo.duplicateProfile(plan.id, "FailedCopy")).toThrow("Failed to publish duplicated Plan");
    database.close();
  });

  it("preserves distinct assignments on Parts that share a role", () => {
    const { database, repo, plan } = acceptedPlanFixture("DistinctAssignments", ["widget-a.stl", "widget-b.stl"]);
    const source = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (source.kind !== "ready") throw new Error("source Plan is not ready");
    const [first, second] = source.snapshot.parts;
    if (!first || !second) throw new Error("source Parts are missing");
    expect(first.effectiveRole).toBe(second.effectiveRole);
    expect(
      repo.assignAcceptedFilament({
        expected: acceptedPlanBasis(source.snapshot),
        target: { kind: "part", projectionPartId: first.projectionPartId },
        assignment: {
          color: { kind: "catalog", colorId: "pla-black" },
          spoolmanSpoolId: null,
        },
      }).kind,
    ).toBe("updated");
    expect(
      repo.assignAcceptedFilament({
        expected: acceptedPlanBasis(source.snapshot),
        target: { kind: "part", projectionPartId: second.projectionPartId },
        assignment: {
          color: { kind: "catalog", colorId: "pla-red" },
          spoolmanSpoolId: null,
        },
      }).kind,
    ).toBe("updated");

    const copy = repo.duplicateProfile(plan.id, "DistinctAssignmentsCopy");
    const accepted = repo.readAcceptedPlanOperationalSnapshot(copy.id);
    if (accepted.kind !== "ready") throw new Error("copied Plan is not ready");
    expect(accepted.snapshot.parts.map((part) => [part.filename, part.filamentColorId])).toEqual([
      ["widget-a.stl", "pla-black"],
      ["widget-b.stl", "pla-red"],
    ]);
    database.close();
  });

  it("rolls back every assignment when an overlay write fails", () => {
    const { database, repo, plan, raw } = acceptedPlanFixture("RollbackAssignments", ["widget-a.stl", "widget-b.stl"]);
    const source = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (source.kind !== "ready") throw new Error("source Plan is not ready");
    const [first, second] = source.snapshot.parts;
    if (!first || !second) throw new Error("source Parts are missing");
    expect(
      repo.assignAcceptedFilament({
        expected: acceptedPlanBasis(source.snapshot),
        target: { kind: "part", projectionPartId: first.projectionPartId },
        assignment: {
          color: { kind: "catalog", colorId: "pla-black" },
          spoolmanSpoolId: null,
        },
      }).kind,
    ).toBe("updated");
    expect(
      repo.assignAcceptedFilament({
        expected: acceptedPlanBasis(source.snapshot),
        target: { kind: "part", projectionPartId: second.projectionPartId },
        assignment: {
          color: { kind: "catalog", colorId: "pla-red" },
          spoolmanSpoolId: null,
        },
      }).kind,
    ).toBe("updated");
    expect(
      repo.setAcceptedPrintedCounts({
        expected: acceptedPlanBasis(source.snapshot),
        rows: [{ partId: first.projectionPartId, printedCount: 1 }],
      }).kind,
    ).toBe("updated");
    raw.exec(`
      CREATE TRIGGER reject_red_overlay
      BEFORE UPDATE OF filament_color_id ON parts
      WHEN NEW.filament_color_id = 'pla-red'
      BEGIN
        SELECT RAISE(ABORT, 'rejected overlay');
      END
    `);

    expect(() => repo.duplicateProfile(plan.id, "RollbackAssignmentsCopy")).toThrow("rejected overlay");
    expect(raw.prepare("SELECT id FROM build_profiles WHERE name = ?").get("RollbackAssignmentsCopy")).toBeUndefined();
    database.close();
  });
});

describe("importKitBundle accepted publish", () => {
  it("leaves unmatched kit Parts unpublished instead of inserting working rows", () => {
    const { database, repo } = acceptedPlanFixture("ImportHost");
    const imported = repo.importKitBundle(
      {
        format: "print-partner-kit",
        version: 3,
        profile: { name: "Imported unmatched" },
        layers: [],
        parts: [
          {
            match_key: "ghost.stl",
            relative_path: "ghost.stl",
            filename: "ghost.stl",
            quantity_effective: 4,
            print_units: [true, true],
          },
        ],
      },
      "Imported unmatched",
    );
    expect(imported.parts_imported).toBe(0);
    expect(repo.readAcceptedPlanOperationalSnapshot(imported.profile_id).kind).toBe("empty");
    expect(repo.listParts(imported.profile_id).parts).toEqual([]);
    database.close();
  });

  it("applies matched kit Sources and copies accepted printed counts", () => {
    const { database, repo, plan } = acceptedPlanFixture("ExportHost");
    const source = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (source.kind !== "ready") throw new Error("source Plan is not ready");
    const part = source.snapshot.parts[0];
    if (!part) throw new Error("source Part is missing");
    expect(
      repo.setAcceptedPrintedCounts({
        expected: acceptedPlanBasis(source.snapshot),
        rows: [{ partId: part.projectionPartId, printedCount: 1 }],
      }).kind,
    ).toBe("updated");
    const captured = captureAcceptedOperationalExport({
      repository: repo,
      profileId: plan.id,
    });
    if (captured.kind !== "ready") throw new Error("captured export is not ready");
    const recipe = repo.readEditableKitRecipe(plan.id);
    const data = buildKitBundleData({
      mode: {
        kind: "accepted_progress",
        recipe,
        accepted: captured.export,
      },
      exportedAt: "2026-08-21T15:00:00.000Z",
    });
    const imported = repo.importKitBundle(data, "Imported matched");
    expect(imported.parts_imported).toBe(1);
    const accepted = repo.readAcceptedPlanOperationalSnapshot(imported.profile_id);
    expect(accepted.kind).toBe("ready");
    if (accepted.kind !== "ready") throw new Error("imported Plan is not ready");
    expect(accepted.snapshot.parts[0]?.filename).toBe("widget.stl");
    expect(accepted.snapshot.parts[0]?.units[0]?.completed).toBe(true);
    database.close();
  });

  it("warns and skips operational state when matched Sources cannot publish", () => {
    const { database, repo, repoPath, source } = acceptedPlanFixture("FailedImportHost");
    rmSync(join(repoPath, "parts", "widget.stl"));

    const imported = repo.importKitBundle(
      {
        format: "print-partner-kit",
        version: 3,
        profile: { name: "Failed import" },
        sources: [{ name: source.name, url: source.url }],
        layers: [
          {
            layer_order: 0,
            layer_type: "base",
            project: { name: source.name, url: source.url },
          },
        ],
        parts: [
          {
            match_key: "widget.stl",
            filament_color_id: "pla-black",
            print_units: [true],
          },
        ],
      },
      "Failed import",
    );

    expect(imported.parts_imported).toBe(0);
    expect(imported.warnings).toContain(
      "Accepted Plan publication failed; imported filament and checkoff state was not applied.",
    );
    expect(repo.readAcceptedPlanOperationalSnapshot(imported.profile_id).kind).toBe("empty");
    database.close();
  });

  it("reports an invalid overlay without applying its filament value", () => {
    const { database, repo, plan, source } = acceptedPlanFixture("InvalidOverlayHost");
    const sourceAccepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (sourceAccepted.kind !== "ready") throw new Error("source Plan is not ready");
    const partKey = sourceAccepted.snapshot.parts[0]?.partKey;
    if (!partKey) throw new Error("source Part is missing");
    const imported = repo.importKitBundle(
      {
        format: "print-partner-kit",
        version: 3,
        profile: { name: "Invalid overlay" },
        layers: [
          {
            layer_order: 0,
            layer_type: "base",
            project: { name: source.name, url: source.url },
          },
        ],
        parts: [
          {
            match_key: partKey,
            filament_color_id: "pla-black",
            print_units: [true, true],
          },
        ],
      },
      "Invalid overlay",
    );

    expect(imported.warnings).toContain(
      "Accepted Plan state was not applied: Printed count is invalid for widget.stl.",
    );
    const accepted = repo.readAcceptedPlanOperationalSnapshot(imported.profile_id);
    if (accepted.kind !== "ready") throw new Error("imported Plan is not ready");
    expect(accepted.snapshot.parts[0]?.filamentColorId).toBeNull();
    expect(accepted.snapshot.parts[0]?.units[0]?.completed).toBe(false);
    database.close();
  });
});
